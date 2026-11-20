// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollToShow, shownText, textOffsetAt } from '../src/jsmind-view.ts';

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
