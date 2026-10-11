// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';

/** Text shown for a rich node whose HTML body is `body`. */
function shown(body: string): string {
  const map = new MindMap(
    '<map version="freeplane 1.12.15">\n<node ID="ID_1"><richcontent TYPE="NODE">' +
      `<html><head><title>ignored</title><style>p {}</style></head><body>${body}</body></html>` +
      '</richcontent>\n</node>\n</map>\n');
  return map.text(map.rootKey);
}

test('paragraphs and line breaks are kept as line breaks', () => {
  assert.equal(shown('<p>First</p><p>Second</p>'), 'First\nSecond');
  assert.equal(shown('<p>one<br/>two</p>'), 'one\ntwo');
  assert.equal(shown('<ul><li>a</li><li>b</li></ul>'), 'a\nb');
});

test('HTML whitespace collapses, but the no-break space is kept', () => {
  assert.equal(shown('<p>\n      Some   text\n    </p>'), 'Some text');
  assert.equal(shown('<p>a&#xa0;&#xa0;b</p>'), 'a\u00a0\u00a0b');
});

test('inline elements do not break lines; table cells are separated', () => {
  assert.equal(shown('<p>in <b>bold</b> and <span>span</span></p>'), 'in bold and span');
  assert.equal(shown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'), 'a b\nc');
});

test('empty paragraphs and the head are not shown', () => {
  assert.equal(shown('<p>a</p><p>  </p><p></p><p>b</p>'), 'a\nb');
});
