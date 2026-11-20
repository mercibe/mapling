// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeSibling, scrollToShow, shortcutOf, shownText, textOffsetAt } from '../src/jsmind-view.ts';

const area = { left: 0, top: 100, right: 400, bottom: 500 };
const box = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height });

test('a node already shown whole, margin included, does not scroll the map', () => {
  assert.deepEqual(scrollToShow(box(100, 200, 150, 30), area, 16), { x: 0, y: 0 });
  assert.deepEqual(scrollToShow(box(16, 116, 368, 368), area, 16), { x: 0, y: 0 }, 'exactly within the margin');
});

test('a node beyond an edge scrolls just enough to be shown with its margin', () => {
  assert.deepEqual(scrollToShow(box(300, 200, 270, 25), area, 16), { x: 186, y: 0 }, 'past the right edge');
  assert.deepEqual(scrollToShow(box(-50, 200, 100, 25), area, 16), { x: -66, y: 0 }, 'before the left edge');
  assert.deepEqual(scrollToShow(box(100, 490, 100, 25), area, 16), { x: 0, y: 31 }, 'below the bottom');
  assert.deepEqual(scrollToShow(box(100, 60, 100, 25), area, 16), { x: 0, y: -56 }, 'above the top');
  assert.deepEqual(scrollToShow(box(900, -300, 100, 25), area, 16), { x: 616, y: -416 }, 'far off, on both axes');
});

test('a node larger than the map shows its start, where its text begins', () => {
  assert.deepEqual(scrollToShow(box(200, 200, 600, 25), area, 16), { x: 184, y: 0 }, 'too wide, starting inside');
  assert.deepEqual(scrollToShow(box(-100, 200, 600, 25), area, 16), { x: -116, y: 0 }, 'too wide, starting before');
  assert.deepEqual(scrollToShow(box(100, 150, 100, 500), area, 16), { x: 0, y: 34 }, 'too tall');
});

test('a node larger than the map shows its end when asked: an editor whose caret is at the end', () => {
  assert.deepEqual(scrollToShow(box(100, 150, 100, 500), area, 16, true), { x: 0, y: 166 }, 'too tall');
  assert.deepEqual(scrollToShow(box(100, -300, 100, 500), area, 16, true), { x: 0, y: -284 }, 'too tall, ending before');
  assert.deepEqual(scrollToShow(box(100, 200, 150, 30), area, 16, true), { x: 0, y: 0 }, 'shown whole: nothing moves');
  assert.deepEqual(scrollToShow(box(300, 200, 270, 25), area, 16, true), scrollToShow(box(300, 200, 270, 25), area, 16),
    'a node that fits is shown whole either way');
});

// textOffsetAt reads the browser's caret APIs: stand-ins for a node holding the text node `text`.
function withCaretAt(found: { node: object; offset: number } | null, api: 'position' | 'range', run: () => void): void {
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, Node: g.Node };
  g.Node = { TEXT_NODE: 3 };
  g.document = api === 'position'
    ? { caretPositionFromPoint: () => found && { offsetNode: found.node, offset: found.offset } }
    : { caretRangeFromPoint: () => found && { startContainer: found.node, startOffset: found.offset } };
  try {
    run();
  } finally {
    Object.assign(g, saved);
  }
}

const text = { nodeType: 3 };
const node = { contains: (other: object) => other === text } as unknown as HTMLElement;

test('a double tap on a node gives the offset of the point in its text', () => {
  withCaretAt({ node: text, offset: 3 }, 'position', () => assert.equal(textOffsetAt(node, 10, 20), 3));
  withCaretAt({ node: text, offset: 0 }, 'position', () => assert.equal(textOffsetAt(node, 10, 20), 0), 'the very start');
  withCaretAt({ node: text, offset: 5 }, 'range', () => assert.equal(textOffsetAt(node, 10, 20), 5), 'Chromium before 128');
});

test('a double tap off the node\'s text gives no offset: the caret goes to the end', () => {
  withCaretAt({ node: { nodeType: 3 }, offset: 2 }, 'position', () => assert.equal(textOffsetAt(node, 10, 20), null), 'another node\'s text');
  withCaretAt({ node, offset: 1 }, 'position', () => assert.equal(textOffsetAt(node, 10, 20), null), 'the node itself: its padding');
  withCaretAt(null, 'position', () => assert.equal(textOffsetAt(node, 10, 20), null), 'nothing under the point');
});

test('a text ending with a line break shows its last line, blank, as the editor does', () => {
  assert.equal(shownText('a\n'), 'a\n​');
  assert.equal(shownText('a\n\n'), 'a\n\n​');
});

test('any other text is shown as it is, spaces and inner line breaks included', () => {
  for (const text of ['a', 'a\nb', '\na', '  a  ', '']) assert.equal(shownText(text), text);
});

// A root with three children on the right (r1, r2, r3) and two on the left (l1, l2), in jsMind's
// order, interleaved; r2 has two children of its own.
interface TreeNode { id: string; isroot: boolean; parent: TreeNode | null; children: TreeNode[]; direction: number }
function tree(): Record<string, TreeNode> {
  const nodes: Record<string, TreeNode> = {};
  const add = (id: string, parent: TreeNode | null, direction: number) => {
    const node = { id, isroot: !parent, parent, children: [], direction };
    parent?.children.push(node);
    return (nodes[id] = node);
  };
  const root = add('root', null, 0);
  add('r1', root, 1); add('l1', root, -1); const r2 = add('r2', root, 1); add('l2', root, -1); add('r3', root, 1);
  add('a', r2, 1); add('b', r2, 1);
  return nodes;
}

test('PageUp and PageDown go to the first and last sibling', () => {
  const nodes = tree();
  assert.equal(edgeSibling(nodes.b, false).id, 'a');
  assert.equal(edgeSibling(nodes.a, true).id, 'b');
  assert.equal(edgeSibling(nodes.a, false).id, 'a', 'already the first');
});

test('among the root\'s children, only those on the same side count', () => {
  const nodes = tree();
  assert.equal(edgeSibling(nodes.r2, false).id, 'r1');
  assert.equal(edgeSibling(nodes.r1, true).id, 'r3');
  assert.equal(edgeSibling(nodes.l2, false).id, 'l1');
  assert.equal(edgeSibling(nodes.l1, true).id, 'l2');
});

test('the root has no siblings: it stays selected', () => {
  const nodes = tree();
  assert.equal(edgeSibling(nodes.root, true).id, 'root');
});

// ---------- shortcuts (sent to the shell) ----------

const press = (key: string, modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  shortcutOf({ key, ctrlKey: !!modifiers.ctrl, metaKey: !!modifiers.meta, altKey: !!modifiers.alt, shiftKey: !!modifiers.shift });

test('Enter, Insert, Tab and Delete add a sibling, add a child and delete the node', () => {
  assert.deepEqual(press('Enter'), { command: 'addSibling' });
  assert.deepEqual(press('Insert'), { command: 'addChild' });
  assert.deepEqual(press('Tab'), { command: 'addChild' });
  assert.deepEqual(press('Delete'), { command: 'deleteNode' });
});

test('Ctrl+arrows move the node, Alt+Up and Alt+Down zoom', () => {
  assert.deepEqual(press('ArrowLeft', { ctrl: true }), { command: 'moveNode', direction: 'left' });
  assert.deepEqual(press('ArrowUp', { ctrl: true }), { command: 'moveNode', direction: 'up' });
  assert.deepEqual(press('ArrowUp', { alt: true }), { command: 'zoomIn' });
  assert.deepEqual(press('ArrowDown', { alt: true }), { command: 'zoomOut' });
});

test('Ctrl (or Cmd) with S, Z, Y, K and Enter: save, undo, redo, link', () => {
  assert.deepEqual(press('s', { ctrl: true }), { command: 'save' });
  assert.deepEqual(press('z', { meta: true }), { command: 'undo' });
  assert.deepEqual(press('y', { ctrl: true }), { command: 'redo' });
  assert.deepEqual(press('Z', { ctrl: true, shift: true }), { command: 'redo' });
  assert.deepEqual(press('k', { ctrl: true }), { command: 'editLink' });
  assert.deepEqual(press('Enter', { ctrl: true }), { command: 'followLink' });
});

test('other keys, and these keys with other modifiers, are not shortcuts', () => {
  assert.equal(press('a'), null);
  assert.equal(press('ArrowUp'), null); // jsMind's: select the node above
  assert.equal(press('Enter', { shift: true }), null);
  assert.equal(press('Tab', { shift: true }), null);
  assert.equal(press('ArrowUp', { ctrl: true, shift: true }), null);
  assert.equal(press('ArrowLeft', { alt: true }), null);
  assert.equal(press('s'), null);
});
