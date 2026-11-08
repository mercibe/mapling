// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap, MapError, formatStatus } from '../src/index.ts';

function code(error: unknown): string {
  return error instanceof MapError ? error.code : String(error);
}

test('invalid XML and non-maps are rejected with bridge error codes', () => {
  assert.throws(() => new MindMap('<map><node></map>'), (e) => code(e) === 'PARSE_ERROR');
  assert.throws(() => new MindMap(''), (e) => code(e) === 'PARSE_ERROR');
  assert.throws(() => new MindMap('<html/>'), (e) => code(e) === 'NOT_A_MAP');
  assert.throws(() => new MindMap('<map version="freeplane 1.12.15"/>'), (e) => code(e) === 'NOT_A_MAP');
});

test('format versions: only the tested Freeplane range is editable', () => {
  assert.equal(formatStatus('freeplane 1.12.15'), 'supported');
  assert.equal(formatStatus('freeplane 1.12.0'), 'supported');
  assert.equal(formatStatus('freeplane 1.11.14'), 'too-old');
  assert.equal(formatStatus('freeplane 1.13.0'), 'too-new');
  assert.equal(formatStatus('freeplane 2.0.0'), 'too-new');
  assert.equal(formatStatus('1.0.1'), 'too-old'); // FreeMind
  assert.equal(formatStatus('0.9.0'), 'too-old');
  assert.equal(formatStatus(''), 'too-old');
});

test('an old FreeMind map opens read-only, displayable, and is never changed', () => {
  const text =
    '<map version="0.9.0">\n' +
    '<node TEXT="Root">\n' +
    '<node TEXT="Left" POSITION="left">\n<node TEXT="Child"/>\n</node>\n' +
    '<node TEXT="Right" POSITION="right"/>\n' +
    '</node>\n</map>\n';
  const map = new MindMap(text);
  assert.equal(map.formatStatus, 'too-old');
  assert.equal(map.readOnly, true);
  const view = map.toView();
  assert.deepEqual(view.children.map((c) => [c.topic, c.direction]), [['Left', 'left'], ['Right', 'right']]);
  assert.equal(view.children[0].children[0].topic, 'Child');
  const [left] = map.childKeys(map.rootKey);
  assert.throws(() => map.updateText(left, 'x'), (e) => code(e) === 'READ_ONLY_MAP');
  assert.throws(() => map.addNode(left, 0, 'x'), (e) => code(e) === 'READ_ONLY_MAP');
  assert.throws(() => map.removeNode(left), (e) => code(e) === 'READ_ONLY_MAP');
  assert.throws(() => map.moveNode(left, map.rootKey, 1), (e) => code(e) === 'READ_ONLY_MAP');
  assert.equal(map.serialize(), text);
});

test('a map from a newer Freeplane opens read-only', () => {
  const map = new MindMap('<map version="freeplane 1.13.0">\n<node TEXT="r" ID="ID_1"/>\n</map>\n');
  assert.equal(map.formatStatus, 'too-new');
  assert.equal(map.readOnly, true);
});

test('projection of fixture01: topics, sides, read-only nodes', () => {
  const map = new MindMap(fixture('fixture01.mm'));
  assert.equal(map.nodeCount, 8);
  assert.equal(map.readOnlyNodeCount, 2);
  const view = map.toView();
  assert.equal(view.topic, 'Root node');
  assert.equal(view.direction, undefined);
  assert.deepEqual(view.children.map((c) => c.direction), ['right', 'right', 'right', 'right', 'right']);
  const rich = view.children[1].children[0];
  assert.deepEqual([rich.topic, rich.readOnly], ['Some text in bold\u00a0and italic.', true]);
  const multiline = view.children[4].children[0];
  assert.equal(multiline.readOnly, true);
  assert.ok(multiline.topic.startsWith('A long text... with a new line.\nLorem ipsum'));
  assert.equal(view.children[0].readOnly, undefined);
});

test('projection of fixture02: folded nodes and special characters', () => {
  const map = new MindMap(fixture('fixture02-specialChars.mm'));
  const view = map.toView();
  const quoted = view.children[2];
  assert.equal(quoted.topic, 'Un "autre" type de guillemet');
  assert.equal(quoted.expanded, false);
  assert.equal(quoted.children[0].expanded, false);
  assert.equal(quoted.children[0].children[0].expanded, true);
  assert.equal(view.children[0].topic, 'Un nœud avec un symbole plut petit (<) et plus grand (>)');
});

test('duplicate node IDs make the map read-only, with distinct keys for display', () => {
  const text = '<map version="freeplane 1.12.15">\n<node TEXT="r" ID="ID_1">\n<node TEXT="a" ID="ID_2"/>\n<node TEXT="b" ID="ID_2"/>\n</node>\n</map>\n';
  const map = new MindMap(text);
  assert.equal(map.hasDuplicateIds, true);
  assert.equal(map.readOnly, true);
  const keys = map.childKeys(map.rootKey);
  assert.equal(new Set(keys).size, 2);
  assert.deepEqual(keys.map((k) => map.text(k)), ['a', 'b']);
  assert.throws(() => map.updateText(keys[0], 'x'), (e) => code(e) === 'READ_ONLY_MAP');
  assert.equal(map.serialize(), text);
});

test('in-memory keys never collide with real IDs, even unusual ones', () => {
  const text = '<map version="0.9.0">\n<node TEXT="r">\n<node TEXT="a"/>\n<node TEXT="b" ID="_node_1"/>\n</node>\n</map>\n';
  const map = new MindMap(text);
  const keys = [map.rootKey, ...map.childKeys(map.rootKey)];
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys.map((k) => map.text(k)), ['r', 'a', 'b']);
});
