// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Each test states the exact expected file: anything changed outside the
// expected fragment makes it fail (styles, notes, rich content, layout…).

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap, MapError } from '../src/index.ts';

const NOW = 1800000000000;
const original = fixture('fixture01.mm');

const ROOT = 'ID_452131666';
const A = 'ID_27769489';
const B = 'ID_1843157947';
const B_RICH_CHILD = 'ID_1500080539';
const C = 'ID_233098983';
const E = 'ID_1469196726';
const E_MULTILINE_CHILD = 'ID_1873754233';

const A_LINE =
  '<node TEXT="A : first level child" POSITION="bottom_or_right" ID="ID_27769489" CREATED="1791070137892" MODIFIED="1791070190840"/>';
const C_LINE =
  '<node TEXT="C : first level child without children" POSITION="bottom_or_right" ID="ID_233098983" CREATED="1791070172183" MODIFIED="1791070220616"/>';
const E_OPEN =
  '<node TEXT="E : first level child" POSITION="bottom_or_right" ID="ID_1469196726" CREATED="1791070579143" MODIFIED="1791070595360">';
const LONG_ATTRS = /<node TEXT="A long text[^>]*\/>/.exec(original)![0];

/** Replaces exactly one occurrence, so that a wrong expectation cannot pass silently. */
function replaceOnce(text: string, from: string, to: string): string {
  assert.equal(text.split(from).length, 2, `expected exactly one occurrence of: ${from.slice(0, 60)}`);
  return text.replace(from, () => to);
}

function code(error: unknown): string {
  return error instanceof MapError ? error.code : String(error);
}

test('updateText changes TEXT and MODIFIED only', () => {
  const map = new MindMap(original);
  assert.equal(map.updateText(A, 'A edited', NOW), true);
  const expected = replaceOnce(original, A_LINE,
    A_LINE.replace('A : first level child', 'A edited').replace('1791070190840', String(NOW)));
  assert.equal(map.serialize(), expected);
});

test('updateText escapes special characters as Freeplane does', () => {
  const map = new MindMap(original);
  map.updateText(A, 'x < y & "z" > w é\u00a0!', NOW);
  assert.match(map.serialize(), /TEXT="x &lt; y &amp; &quot;z&quot; &gt; w é&#xa0;!"/);
});

test('updateText with the same text changes nothing', () => {
  const map = new MindMap(original);
  assert.equal(map.updateText(A, 'A : first level child', NOW), false);
  assert.equal(map.serialize(), original);
});

test('updateText refuses rich-text and multi-line nodes', () => {
  const map = new MindMap(original);
  assert.throws(() => map.updateText(B_RICH_CHILD, 'x'), (e) => code(e) === 'READ_ONLY_NODE');
  assert.throws(() => map.updateText(E_MULTILINE_CHILD, 'x'), (e) => code(e) === 'READ_ONLY_NODE');
  assert.equal(map.serialize(), original);
});

test('addNode under a leaf opens the element and puts the child on its own line', () => {
  const map = new MindMap(original);
  const key = map.addNode(C, 0, 'New', 'right', NOW);
  assert.match(key, /^ID_\d+$/);
  const expected = replaceOnce(original, C_LINE,
    C_LINE.replace('/>', '>') +
      `\n<node TEXT="New" ID="${key}" CREATED="${NOW}" MODIFIED="${NOW}"/>\n</node>`);
  assert.equal(map.serialize(), expected);
});

test('addNode under the root sets POSITION in Freeplane attribute order', () => {
  const map = new MindMap(original);
  const key = map.addNode(ROOT, 0, 'Left one', 'left', NOW);
  const expected = replaceOnce(original, A_LINE,
    `<node TEXT="Left one" POSITION="top_or_left" ID="${key}" CREATED="${NOW}" MODIFIED="${NOW}"/>\n` + A_LINE);
  assert.equal(map.serialize(), expected);
  assert.deepEqual(map.childKeys(ROOT)[0], key);
});

test('addNode at the end of existing children goes after the last child', () => {
  const map = new MindMap(original);
  const key = map.addNode(E, 1, 'Last', 'right', NOW);
  const expected = replaceOnce(original, LONG_ATTRS,
    LONG_ATTRS + `\n<node TEXT="Last" ID="${key}" CREATED="${NOW}" MODIFIED="${NOW}"/>`);
  assert.equal(map.serialize(), expected);
});

test('removeNode removes the element, its subtree and its line', () => {
  const map = new MindMap(original);
  map.removeNode(A);
  assert.equal(map.serialize(), replaceOnce(original, A_LINE + '\n', ''));
});

test('after a removal, the next sibling is selected, else the previous one, else the parent', () => {
  const map = new MindMap(original);
  const D = 'ID_1964929139';
  assert.equal(map.nodeAfterRemoval(A), B, 'the next sibling');
  assert.equal(map.nodeAfterRemoval(C), D);
  assert.equal(map.nodeAfterRemoval(E), D, 'the last one: the previous sibling');
  assert.equal(map.nodeAfterRemoval(E_MULTILINE_CHILD), E, 'an only child: the parent');
  assert.equal(map.nodeAfterRemoval(ROOT), ROOT, 'the root is never removed');
});

test('removing the selected node again and again clears the branch, then reaches the parent', () => {
  const map = new MindMap(original);
  const removed = [];
  for (let selected = B; selected !== ROOT; ) {
    const next = map.nodeAfterRemoval(selected);
    map.removeNode(selected);
    removed.push(selected);
    selected = next;
  }
  assert.deepEqual(removed, [B, C, 'ID_1964929139', E, A]);
  assert.deepEqual(map.childKeys(ROOT), []);
});

test('among the root children, only those on the same side count', () => {
  const map = new MindMap(
    '<map version="freeplane 1.12.15">\n<node TEXT="Root" ID="ID_1">\n' +
      '<node TEXT="Left 1" POSITION="top_or_left" ID="ID_2"/>\n' +
      '<node TEXT="Right" POSITION="bottom_or_right" ID="ID_3"/>\n' +
      '<node TEXT="Left 2" POSITION="top_or_left" ID="ID_4"/>\n' +
      '</node>\n</map>\n',
  );
  assert.equal(map.nodeAfterRemoval('ID_2'), 'ID_4', 'the next one on the left, not the right node');
  assert.equal(map.nodeAfterRemoval('ID_4'), 'ID_2', 'the previous one on the left');
  assert.equal(map.nodeAfterRemoval('ID_3'), 'ID_1', 'alone on its side: the root');
});

test('removing the last child turns the parent back into an empty element', () => {
  const map = new MindMap(original);
  map.removeNode(E_MULTILINE_CHILD);
  const expected = replaceOnce(original, `${E_OPEN}\n${LONG_ATTRS}\n</node>`, E_OPEN.replace('>', '/>'));
  assert.equal(map.serialize(), expected);
  assert.throws(() => map.text(E_MULTILINE_CHILD), (e) => code(e) === 'UNKNOWN_NODE');
});

test('moveNode from the root to another parent removes POSITION', () => {
  const map = new MindMap(original);
  map.moveNode(A, E, 0);
  let expected = replaceOnce(original, A_LINE + '\n', '');
  expected = replaceOnce(expected, `${E_OPEN}\n`,
    `${E_OPEN}\n${A_LINE.replace(' POSITION="bottom_or_right"', '')}\n`);
  assert.equal(map.serialize(), expected);
  assert.deepEqual(map.childKeys(E), [A, E_MULTILINE_CHILD]);
});

test('moveNode to the root inserts POSITION before ID, as Freeplane orders it', () => {
  const map = new MindMap(original);
  map.moveNode(E_MULTILINE_CHILD, ROOT, 0, 'left');
  let expected = replaceOnce(original, `${E_OPEN}\n${LONG_ATTRS}\n</node>`, E_OPEN.replace('>', '/>'));
  expected = replaceOnce(expected, A_LINE,
    LONG_ATTRS.replace(' ID=', ' POSITION="top_or_left" ID=') + '\n' + A_LINE);
  assert.equal(map.serialize(), expected);
  assert.equal(map.toView().children[0].direction, 'left');
});

test('moveNode reorders among the same siblings', () => {
  const map = new MindMap(original);
  map.moveNode(A, ROOT, 4);
  assert.deepEqual(map.childKeys(ROOT), [B, C, 'ID_1964929139', E, A]);
  const expected = replaceOnce(replaceOnce(original, A_LINE + '\n', ''),
    `${LONG_ATTRS}\n</node>\n`, `${LONG_ATTRS}\n</node>\n${A_LINE}\n`);
  assert.equal(map.serialize(), expected);
});

test('invalid operations are refused without changing the map', () => {
  const map = new MindMap(original);
  assert.throws(() => map.removeNode(ROOT), (e) => code(e) === 'INVALID_OPERATION');
  assert.throws(() => map.moveNode(E, E_MULTILINE_CHILD, 0), (e) => code(e) === 'INVALID_OPERATION');
  assert.throws(() => map.moveNode(E, E, 0), (e) => code(e) === 'INVALID_OPERATION');
  assert.throws(() => map.updateText('ID_nope', 'x'), (e) => code(e) === 'UNKNOWN_NODE');
  assert.equal(map.serialize(), original);
});

test('a node without ID gets one only when modified', () => {
  const text = '<map version="freeplane 1.12.15">\n<node TEXT="root">\n<node TEXT="a"/>\n<node TEXT="b"/>\n</node>\n</map>\n';
  const map = new MindMap(text);
  assert.equal(map.serialize(), text);
  const [a] = map.childKeys(map.rootKey);
  map.updateText(a, 'a2', NOW);
  assert.match(map.serialize(), /<node TEXT="a2" ID="ID_\d+" MODIFIED="1800000000000"\/>\n<node TEXT="b"\/>/);
  assert.equal(map.text(a), 'a2'); // the in-memory key stays valid
});

test('new IDs never collide with style node IDs', () => {
  const map = new MindMap(original);
  const styleIds = new Set(['ID_207122690', 'ID_3752836']);
  for (let i = 0; i < 50; i++) assert.ok(!styleIds.has(map.addNode(C, 0, 'n', 'right', NOW)));
});
