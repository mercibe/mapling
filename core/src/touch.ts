// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Touch gestures on the map. jsMind was designed for the mouse: on a touch screen,
// its drag plugin moves any node a finger lands on, so scrolling the map moves nodes,
// and pinching zooms the whole page instead of the map. Here:
// - a node moves only if it is the selected one, once a single finger rests on it
//   briefly; any other slide scrolls the map (the browser's own scrolling);
// - two fingers zoom the map with jsMind's zoom (the page zoom is disabled in CSS).
// Moving and zooming never overlap: a second finger, or an interrupted touch, cancels
// the move without applying it. The gestures are plain state, tested in Node; the
// wiring to the DOM needs a browser.

export interface Point {
  x: number;
  y: number;
}

/** How long a finger must rest on the selected node before it can be moved. */
export const HOLD_MS = 300;

/** How far a finger may move while resting (screens are never perfectly still). */
export const STILL_PX = 10;

/** A touch may move a node only if it lands on the selected node, outside text editing. */
export function mayDrag(touched: string | null, selected: string | null, editing: boolean): boolean {
  return !editing && touched !== null && touched === selected;
}

export function isStill(start: Point, current: Point): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) <= STILL_PX;
}

/** The zoom for two fingers now `distance` apart, having started `startDistance` apart. */
export function pinchZoom(startZoom: number, startDistance: number, distance: number, min: number, max: number): number {
  const zoom = startZoom * (distance / startDistance);
  return Math.min(max, Math.max(min, zoom));
}

/** The parts of jsMind 0.9.1 the gestures read (checked in its source). */
export interface GestureMap {
  get_selected_node(): { id: string } | null;
  view: {
    zoom_current: number;
    opts: { zoom: { min: number; max: number } };
    is_editing(): boolean;
  };
}

/**
 * The parts of jsMind's drag plugin used here (checked in its source). Its dragend
 * applies the move only when `moved` is true; everything else is cleanup (timers,
 * guide lines, shadow). The node moved and its target are forgotten only once a move
 * is applied: the target is looked up while dragging, and never cleared otherwise.
 */
export interface DragPlugin {
  capture: boolean;
  moved: boolean;
  active_node: unknown;
  target_node: unknown;
  target_direct: unknown;
  dragstart(event: unknown): void;
  dragend(event: unknown): void;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

/** The state of the fingers on the map, fed by the touch events. */
export class TouchGestures {
  private start: Point | null = null; // the finger, while exactly one touches
  private hold: unknown = null; // pending start of a move
  private pinch: { distance: number; zoom: number } | null = null;
  private plugin: DragPlugin | null = null;

  private readonly jm: GestureMap;
  private readonly timers: Timers;

  constructor(jm: GestureMap, timers: Timers) {
    this.jm = jm;
    this.timers = timers;
  }

  get touching(): boolean {
    return this.start !== null || this.pinch !== null;
  }

  /**
   * Replaces the drag plugin's dragstart for touches: `begin` (the plugin's own
   * dragstart) runs only once a single finger has rested on the selected node.
   */
  dragstart(plugin: DragPlugin, fingers: number, touched: string | null, begin: () => void): void {
    this.plugin = plugin;
    this.cancelHold();
    const selected = this.jm.get_selected_node()?.id ?? null;
    if (fingers !== 1 || !mayDrag(touched, selected, this.jm.view.is_editing())) return;
    this.hold = this.timers.set(() => {
      this.hold = null;
      begin();
    }, HOLD_MS);
  }

  touchStart(fingers: Point[]): void {
    if (fingers.length === 1) {
      this.start = fingers[0];
      return;
    }
    this.start = null;
    this.cancel(); // a second finger turns any move into a pinch
    if (fingers.length === 2) this.pinch = { distance: spread(fingers), zoom: this.jm.view.zoom_current };
  }

  /** Returns the zoom to apply, if the fingers are pinching. */
  touchMove(fingers: Point[]): { zoom: number; center: Point } | null {
    if (this.start && !isStill(this.start, fingers[0])) this.cancelHold();
    if (!this.pinch || fingers.length !== 2) return null;
    const { min, max } = this.jm.view.opts.zoom;
    const zoom = pinchZoom(this.pinch.zoom, this.pinch.distance, spread(fingers), min, max);
    return { zoom, center: middle(fingers) };
  }

  /** A finger was lifted: the plugin's own touchend completes a move in progress. */
  touchEnd(fingersLeft: number): void {
    if (fingersLeft === 0) {
      this.start = null;
      this.cancelHold();
    }
    if (fingersLeft < 2) this.pinch = null;
  }

  /** The system interrupted the touch (jsMind does not listen to touchcancel). */
  touchCancel(): void {
    this.start = null;
    this.pinch = null;
    this.cancel();
  }

  /** The only way a move stops without being applied. */
  private cancel(): void {
    this.cancelHold();
    const plugin = this.plugin;
    if (plugin?.capture) {
      plugin.moved = false;
      plugin.dragend(null);
      // Forgotten, so that the next move cannot fall back on this one's target.
      plugin.active_node = null;
      plugin.target_node = null;
      plugin.target_direct = null;
    }
  }

  private cancelHold(): void {
    if (this.hold !== null) this.timers.clear(this.hold);
    this.hold = null;
  }
}

function spread(fingers: Point[]): number {
  return Math.hypot(fingers[1].x - fingers[0].x, fingers[1].y - fingers[0].y);
}

function middle(fingers: Point[]): Point {
  return { x: (fingers[0].x + fingers[1].x) / 2, y: (fingers[0].y + fingers[1].y) / 2 };
}

// ---------- wiring (browser only) ----------

export interface TouchMap extends GestureMap {
  view: GestureMap['view'] & {
    container: HTMLElement;
    set_zoom(zoom: number, center?: Point): boolean;
  };
}

declare const jsMindDraggableNode: { DraggableNode: { prototype: DragPlugin } };

export function installTouchGestures(jm: TouchMap): void {
  // Wrapped: called on another object than window, the browser's setTimeout throws.
  const timers = { set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (timer: unknown) => clearTimeout(timer as number) };
  const gestures = new TouchGestures(jm, timers);
  const container = jm.view.container;

  // The plugin calls dragstart on every touchstart; the mouse keeps jsMind's behavior.
  const prototype = jsMindDraggableNode.DraggableNode.prototype;
  const dragstart = prototype.dragstart;
  prototype.dragstart = function (this: DragPlugin, event: unknown) {
    // By type, not instanceof: desktop browsers without touch support have no TouchEvent.
    if (!(event as Event).type.startsWith('touch')) return dragstart.call(this, event);
    const touch = event as TouchEvent;
    const touched = (touch.target as Element).closest('jmnode')?.getAttribute('nodeid') ?? null;
    gestures.dragstart(this, touch.touches.length, touched, () => dragstart.call(this, event));
  };

  // Capture phase: these run before the plugin's own listeners on the same element.
  const options = { capture: true, passive: true };
  let frame = 0;
  container.addEventListener('touchstart', (event) => gestures.touchStart(points(event.touches)), options);
  container.addEventListener('touchmove', (event) => {
    const pinch = gestures.touchMove(points(event.touches));
    if (!pinch) return;
    // Redrawing the map is costly: at most once per displayed frame.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => jm.view.set_zoom(pinch.zoom, pinch.center));
  }, options);
  container.addEventListener('touchend', (event) => gestures.touchEnd(event.touches.length), options);
  container.addEventListener('touchcancel', () => gestures.touchCancel(), options);
  // A finger resting on a node must not open the browser's context menu.
  container.addEventListener('contextmenu', (event) => {
    if (gestures.touching) event.preventDefault();
  });
}

function points(touches: TouchList): Point[] {
  return Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }));
}
