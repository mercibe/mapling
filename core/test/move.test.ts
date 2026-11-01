// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Moving a node with Freeplane's Ctrl+arrows (MindMap.moveInDirection), as read in
// Freeplane 1.12's code: NodeUpAction, NodeDownAction, ChangeNodeLevelController.

import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, MindMap, MapError, type ViewNode } from '../src/index.ts';

// root: on the right R1 (with a1, a2), R2 (folded, with b1), R3; on the left L1 (with l1), L2.
const MAP = `<map version="freeplane 1.12.15">
<node TEXT="root" ID="root">
<node TEXT="R1" POSITION="bottom_or_right" ID="R1">
<node TEXT="a1" ID="a1"/>
<node TEXT="a2" ID="a2"/>
</node>
<node TEXT="L1" POSITION="top_or_left" ID="L1">
<node TEXT="l1" ID="l1"/>
</node>
<node TEXT="R2" FOLDED="true" POSITION="bottom_or_right" ID="R2">
<node TEXT="b1" ID="b1"/>
</node>
<node TEXT="L2" POSITION="top_or_left" ID="L2"/>
<node TEXT="R3" POSITION="bottom_or_right" ID="R3"/>
</node>
</map>
`;

/** "R1(a1 a2)": the map's shape; < for the left side, + for a folded node. */
function shape(node: ViewNode): string {
  const name = `${node.direction === 'left' ? '<' : ''}${node.topic}${node.expanded ? '' : '+'}`;
  return node.children.length ? `${name}(${node.children.map(shape).join(' ')})` : name;
}

function moved(key: string, direction: 'up' | 'down' | 'left' | 'right'): { moved: boolean; shape: string } {
  const map = new MindMap(MAP);
  const result = map.moveInDirection(key, direction);
  return { moved: result, shape: shape(new MindMap(map.serialize()).toView()) };
}

const START = 'root(R1(a1 a2) <L1(l1) R2+(b1) <L2 R3)';

test('the test map, as written', () => {
  assert.equal(shape(new MindMap(MAP).toView()), START);
});

test('up and down: before or after the sibling', () => {
  assert.deepEqual(moved('a2', 'up'), { moved: true, shape: 'root(R1(a2 a1) <L1(l1) R2+(b1) <L2 R3)' });
  assert.deepEqual(moved('a1', 'down'), { moved: true, shape: 'root(R1(a2 a1) <L1(l1) R2+(b1) <L2 R3)' });
});

test('up and down: from one end to the other', () => {
  assert.deepEqual(moved('a1', 'up'), { moved: true, shape: 'root(R1(a2 a1) <L1(l1) R2+(b1) <L2 R3)' });
  assert.deepEqual(moved('a2', 'down'), { moved: true, shape: 'root(R1(a2 a1) <L1(l1) R2+(b1) <L2 R3)' });
});

test("among the root's children, only those on the node's side count", () => {
  assert.deepEqual(moved('R2', 'up'), { moved: true, shape: 'root(R2+(b1) R1(a1 a2) <L1(l1) <L2 R3)' });
  assert.deepEqual(moved('R1', 'up'), { moved: true, shape: 'root(<L1(l1) R2+(b1) <L2 R3 R1(a1 a2))' }, 'to the end of its side');
  assert.deepEqual(moved('L2', 'down'), { moved: true, shape: 'root(R1(a1 a2) <L2 <L1(l1) R2+(b1) R3)' }, 'to the start of its side');
});

test('right side: left goes up a level, after the parent', () => {
  assert.deepEqual(moved('a1', 'left'), { moved: true, shape: 'root(R1(a2) a1 <L1(l1) R2+(b1) <L2 R3)' });
});

test("a child of the root going toward it changes sides, keeping its place", () => {
  assert.deepEqual(moved('R1', 'left'), { moved: true, shape: 'root(<R1(a1 a2) <L1(l1) R2+(b1) <L2 R3)' });
  assert.deepEqual(moved('L1', 'right'), { moved: true, shape: 'root(R1(a1 a2) L1(l1) R2+(b1) <L2 R3)' });
});

test('right side: right goes into the sibling before, else after, as its last child', () => {
  assert.deepEqual(moved('a2', 'right'), { moved: true, shape: 'root(R1(a1(a2)) <L1(l1) R2+(b1) <L2 R3)' });
  assert.deepEqual(moved('a1', 'right'), { moved: true, shape: 'root(R1(a2(a1)) <L1(l1) R2+(b1) <L2 R3)' }, 'the first one: into the next');
});

test('a folded sibling is unfolded, so that the moved node stays in sight', () => {
  assert.deepEqual(moved('R3', 'right'), { moved: true, shape: 'root(R1(a1 a2) <L1(l1) R2(b1 R3) <L2)' });
});

test('left side: the other way round', () => {
  assert.deepEqual(moved('l1', 'right'), { moved: true, shape: 'root(R1(a1 a2) <L1 <l1 R2+(b1) <L2 R3)' }, 'up a level, on the left');
  assert.deepEqual(moved('L2', 'left'), { moved: true, shape: 'root(R1(a1 a2) <L1(l1 L2) R2+(b1) R3)' }, 'into the sibling before on its side');
});

test('nothing moves: the root, an only child going away from the root, a node alone on its side', () => {
  assert.deepEqual(moved('root', 'up'), { moved: false, shape: START });
  assert.deepEqual(moved('l1', 'left'), { moved: false, shape: START });
  assert.deepEqual(moved('l1', 'up'), { moved: false, shape: START });
});

test('a read-only map refuses to move', () => {
  const map = new MindMap(MAP.replace('freeplane 1.12.15', 'freeplane 1.9.0'));
  assert.throws(() => map.moveInDirection('a1', 'up'), (e) => e instanceof MapError && e.code === 'READ_ONLY_MAP');
});

test('moveNode through the bridge: shown again, undone like any edit; zoom goes to the view', () => {
  const sent: any[] = [];
  const shown: ViewNode[] = [];
  const zooms: string[] = [];
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show: (root) => shown.push(root), setReadOnly() {}, command() {}, center() {}, editing: () => false,
    zoom: (direction) => zooms.push(direction),
  });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  send({ type: 'load', name: 'm.mm', data: Buffer.from(MAP).toString('base64') });
  send({ type: 'moveNode', id: 'a2', direction: 'up' });
  assert.equal(shape(shown.at(-1)!), 'root(R1(a2 a1) <L1(l1) R2+(b1) <L2 R3)');
  assert.ok(sent.some((m) => m.type === 'historyChanged' && m.canUndo));
  send({ type: 'undo' });
  assert.equal(shape(shown.at(-1)!), START);
  const count = shown.length;
  send({ type: 'moveNode', id: 'root', direction: 'up' });
  assert.equal(shown.length, count, 'nothing moved: nothing shown again');
  send({ type: 'moveNode', id: 'gone', direction: 'up' });
  assert.equal(sent.at(-1).code, 'OUTDATED_COMMAND');
  send({ type: 'setReadOnly', readOnly: true });
  send({ type: 'zoomIn' });
  send({ type: 'zoomOut' });
  assert.deepEqual(zooms, ['in', 'out'], 'zooming is not an edit: also on a read-only map');
});
