// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoubleTap, type DragPlugin, type Point, STILL_PX, TouchGestures, isStill, mayDrag, pinchZoom, withFinger } from '../src/touch.ts';

test('only the selected node can be moved, and never while a text is edited', () => {
  assert.equal(mayDrag('ID_1', 'ID_1', false), true);
  assert.equal(mayDrag('ID_1', 'ID_2', false), false, 'another node is selected');
  assert.equal(mayDrag('ID_1', null, false), false, 'nothing is selected');
  assert.equal(mayDrag(null, 'ID_1', false), false, 'the finger is not on a node');
  assert.equal(mayDrag('ID_1', 'ID_1', true), false, 'a text is being edited');
});

test('a finger is still within a few pixels, in any direction', () => {
  const start = { x: 100, y: 100 };
  assert.equal(isStill(start, start), true);
  assert.equal(isStill(start, { x: 100 + STILL_PX, y: 100 }), true);
  assert.equal(isStill(start, { x: 107, y: 107 }), true, 'diagonal, about 9.9 px');
  assert.equal(isStill(start, { x: 108, y: 108 }), false, 'diagonal, about 11.3 px');
  assert.equal(isStill(start, { x: 100, y: 100 - STILL_PX - 1 }), false);
});

test('the zoom follows the spread of the fingers, within the limits', () => {
  assert.equal(pinchZoom(1, 100, 150, 0.5, 2), 1.5);
  assert.equal(pinchZoom(1.5, 100, 50, 0.5, 2), 0.75, 'from the zoom at the start of the pinch');
  assert.equal(pinchZoom(1, 100, 400, 0.5, 2), 2, 'not above the maximum');
  assert.equal(pinchZoom(1, 100, 10, 0.5, 2), 0.5, 'not below the minimum');
});

// ---------- sequences of touches ----------

/**
 * jsMind's drag plugin, reduced to what matters (as in its source): dragstart captures
 * the node; while dragging, the target is looked up, and set only when one is found;
 * dragend applies the move if the finger moved, and only then forgets node and target.
 */
class FakePlugin implements DragPlugin {
  capture = false;
  moved = false;
  active_node: unknown = null;
  target_node: unknown = null;
  target_direct: unknown = null;
  applied: string[] = []; // moves applied, as "node → target"
  get movesApplied(): number {
    return this.applied.length;
  }
  dragstart(): void {
    this.active_node = 'ID_1';
    this.capture = true;
  }
  drag(target: string | null): void {
    if (!this.capture) return;
    this.moved = true;
    if (target !== null) {
      this.target_node = target;
      this.target_direct = 1;
    }
  }
  dragend(): void {
    if (this.capture && this.moved) {
      if (this.target_node !== null) this.applied.push(`${this.active_node} → ${this.target_node}`);
      this.active_node = null;
      this.target_node = null;
      this.target_direct = null;
    }
    this.capture = false;
    this.moved = false;
  }
}

/** The selected node ID_1 under one or two fingers, with timers fired by hand. */
function setup() {
  const plugin = new FakePlugin();
  let pending: (() => void) | null = null;
  const gestures = new TouchGestures(
    { get_selected_node: () => ({ id: 'ID_1' }), view: { zoom_current: 1, opts: { zoom: { min: 0.5, max: 2 } }, is_editing: () => false } },
    { set: (callback) => (pending = callback), clear: () => (pending = null) },
  );
  const holdElapses = () => {
    const callback = pending;
    pending = null;
    callback?.();
  };
  // As in a browser: our capture listeners run first, then the plugin's listeners.
  const touchStart = (fingers: Point[]) => {
    gestures.touchStart(fingers);
    gestures.dragstart(plugin, fingers.length, 'ID_1', () => plugin.dragstart());
  };
  /** `target`: the node found under the shadow, or null when the lookup has not run yet. */
  const touchMove = (fingers: Point[], target: string | null = 'ID_2') => {
    const pinch = gestures.touchMove(fingers);
    plugin.drag(target);
    return pinch;
  };
  const touchEnd = (fingersLeft: number) => {
    gestures.touchEnd(fingersLeft);
    plugin.dragend();
  };
  return { plugin, gestures, holdElapses, touchStart, touchMove, touchEnd };
}

const A = { x: 100, y: 100 };
const B = { x: 200, y: 100 };

test('a dragging finger is given to the edge zone as the event position', () => {
  let prevented = false;
  const touches = [{ clientX: 12, clientY: 640 }];
  const event = withFinger({ touches, preventDefault: () => (prevented = true) });
  assert.equal(event.clientX, 12);
  assert.equal(event.clientY, 640);
  assert.equal(event.touches, touches, 'the plugin still finds the finger where it looks for it');
  event.preventDefault();
  assert.equal(prevented, true, 'the page still does not scroll by itself');
});

test('a finger resting on the selected node moves it; the plugin applies the move when it is lifted', () => {
  const { plugin, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  holdElapses();
  assert.equal(plugin.capture, true);
  touchMove([{ x: 100, y: 180 }]);
  touchEnd(0);
  assert.equal(plugin.movesApplied, 1);
});

test('two fingers on the selected node zoom, and never start a move', () => {
  const { plugin, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  touchStart([A, B]); // the second finger arrives before the hold elapses
  holdElapses();
  assert.equal(plugin.capture, false, 'no move started');
  const pinch = touchMove([A, { x: 250, y: 100 }]);
  assert.deepEqual(pinch, { zoom: 1.5, center: { x: 175, y: 100 } });
  touchEnd(1);
  touchEnd(0);
  assert.equal(plugin.movesApplied, 0);
});

test('a second finger during a move cancels it, without applying it, and pinches', () => {
  const { plugin, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  holdElapses();
  touchMove([{ x: 100, y: 180 }]);
  assert.equal(plugin.moved, true, 'the move is under way');
  touchStart([{ x: 100, y: 180 }, B]);
  assert.equal(plugin.capture, false, 'the move is cancelled');
  assert.notEqual(touchMove([{ x: 100, y: 180 }, { x: 300, y: 100 }]), null, 'the fingers now zoom');
  touchEnd(1);
  touchEnd(0);
  assert.equal(plugin.movesApplied, 0, 'the cancelled move is never applied');
});

test('an interrupted touch cancels the move without applying it; the next gesture works', () => {
  const { plugin, gestures, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  holdElapses();
  touchMove([{ x: 100, y: 180 }]);
  gestures.touchCancel(); // jsMind does not listen to touchcancel: only our handler runs
  assert.equal(plugin.capture, false);
  assert.equal(plugin.movesApplied, 0);
  assert.equal(gestures.touching, false);

  touchStart([A]);
  holdElapses();
  touchMove([{ x: 100, y: 180 }]);
  touchEnd(0);
  assert.equal(plugin.movesApplied, 1, 'a new move works normally');
});

test('a finger sliding before the hold elapses scrolls: no move starts', () => {
  const { plugin, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  touchMove([{ x: 100, y: 100 + STILL_PX + 5 }]);
  holdElapses();
  assert.equal(plugin.capture, false);
  touchEnd(0);
  assert.equal(plugin.movesApplied, 0);
});

test('a cancelled move leaves no target behind for the next one', () => {
  const { plugin, gestures, holdElapses, touchStart, touchMove, touchEnd } = setup();
  touchStart([A]);
  holdElapses();
  touchMove([{ x: 100, y: 180 }], 'ID_B'); // the shadow is over B…
  gestures.touchCancel(); // …when the move is cancelled
  assert.equal(plugin.target_node, null);

  touchStart([A]);
  holdElapses();
  touchMove([{ x: 100, y: 120 }], null); // lifted before any target is looked up
  touchEnd(0);
  assert.deepEqual(plugin.applied, [], 'never moved under B');
});

test('a double tap edits a node only if both taps were on it', () => {
  const taps = new DoubleTap();
  taps.tap('A');
  taps.tap('A');
  assert.equal(taps.onSameNode('A'), true);
});

test('a quick tap on a node, then on its neighbour, edits neither', () => {
  const taps = new DoubleTap();
  taps.tap('A');
  taps.tap('B');
  assert.equal(taps.onSameNode('B'), false);
});

test('a tap in the void, then on a node, does not edit it', () => {
  const taps = new DoubleTap();
  taps.tap(null);
  taps.tap('A');
  assert.equal(taps.onSameNode('A'), false);
});

test('only the last two taps count', () => {
  const taps = new DoubleTap();
  taps.tap('B');
  taps.tap('A');
  taps.tap('A');
  assert.equal(taps.onSameNode('A'), true);
});
