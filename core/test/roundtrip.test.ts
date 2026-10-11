// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Round trip without edit, at two levels:
// - same meaning (canonical comparison): required for every fixture;
// - same bytes: required for public fixtures; for private ones, a difference
//   is reported without failing, as it reveals a Freeplane writing rule to add.

import { canonical, fixtures } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';

for (const { name, text } of fixtures()) {
  test(`round trip without edit: ${name}`, (t) => {
    const written = new MindMap(text).serialize();
    assert.equal(canonical(written), canonical(text), 'meaning changed');
    if (name.startsWith('fixtures/')) {
      assert.equal(written, text, 'bytes changed');
    } else if (written !== text) {
      const at = [...written].findIndex((c, i) => c !== text[i]);
      t.diagnostic(`same meaning but different bytes from offset ${at}: ` +
        JSON.stringify(text.slice(at, at + 40)) + ' became ' + JSON.stringify(written.slice(at, at + 40)));
    }
  });
}

test('the canonical comparison ignores attribute order and catches real changes', () => {
  const base = '<map><node TEXT="a" ID="1"><![CDATA[x]]>y</node></map>';
  assert.equal(canonical('<map><node ID="1" TEXT="a">xy</node></map>'), canonical(base));
  assert.notEqual(canonical('<map><node TEXT="b" ID="1">xy</node></map>'), canonical(base));
  assert.notEqual(canonical('<map><node TEXT="a" ID="1">xy<x/></node></map>'), canonical(base));
});
