// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';
import { DOMParser as XmldomParser } from '@xmldom/xmldom';

test('comments, CDATA and processing instructions are written back verbatim', () => {
  const text =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<map version="freeplane 1.12.15">\n' +
    '<!-- no-break\u00a0space and &#10; in a comment -->\n' +
    '<?app data with\u00a0no-break space?>\n' +
    '<node TEXT="r" ID="ID_1"><richcontent TYPE="NOTE"><![CDATA[a\u00a0b &#10; c]]></richcontent>\n</node>\n' +
    '</map>\n';
  assert.equal(new MindMap(text).serialize(), text);
});

test('the Freeplane rules still apply to text and attributes', () => {
  const text = '<map version="freeplane 1.12.15">\n<node TEXT="a&#xa;b&#xa0;c" ID="ID_1">x&#xa0;y</node>\n</map>\n';
  assert.equal(new MindMap(text).serialize(), text);
});

// Freeplane up to 1.11 wrote the HTML entity `&nbsp;` in rich text; browsers reject it in XML.
const withNbsp =
  '<map version="freeplane 1.9.13">\n' +
  '<node TEXT="a&nbsp;b" ID="ID_1"><richcontent TYPE="NODE"><html><body><p>c&nbsp;d</p></body></html></richcontent>\n' +
  '<!-- &nbsp; in a comment --><node ID="ID_2"><richcontent TYPE="NOTE"><![CDATA[&nbsp; in CDATA]]></richcontent></node>\n' +
  '</node>\n</map>\n';

test('&nbsp; is read as a no-break space, in text and attributes', () => {
  const map = new MindMap(withNbsp);
  const xml = map.serialize();
  assert.ok(!/<p>c&nbsp;d|TEXT="a&nbsp;b"/.test(xml), 'the entity is no longer kept as text');
  assert.ok(xml.includes('TEXT="a&#xa0;b"'));
  assert.ok(xml.includes('<p>c&#xa0;d</p>'));
});

test('&nbsp; in comments and CDATA sections is only text: kept verbatim', () => {
  const xml = new MindMap(withNbsp).serialize();
  assert.ok(xml.includes('<!-- &nbsp; in a comment -->'));
  assert.ok(xml.includes('<![CDATA[&nbsp; in CDATA]]>'));
});

test('a map with &nbsp; opens with a parser as strict as browsers', () => {
  // The tests' parser tolerates unknown entities; made strict, it rejects them as browsers do.
  const g = globalThis as Record<string, unknown>;
  const tolerant = g.DOMParser;
  g.DOMParser = class extends XmldomParser {
    constructor() {
      super({ onError: (level, message) => {
        if (level !== 'warning') throw new Error(message);
      } });
    }
  };
  try {
    assert.throws(() => new MindMap('<map>&eacute;</map>'), /entity/); // the parser is strict
    assert.doesNotThrow(() => new MindMap(withNbsp));
  } finally {
    g.DOMParser = tolerant;
  }
});
