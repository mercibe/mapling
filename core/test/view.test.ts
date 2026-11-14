// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollToShow } from '../src/jsmind-view.ts';

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
