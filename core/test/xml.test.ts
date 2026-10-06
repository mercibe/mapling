// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';

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
