// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Touch gestures on the map. jsMind was designed for the mouse: on a touch screen,
// its drag plugin moves any node a finger lands on, so scrolling the map moves nodes,
// and pinching zooms the whole page instead of the map. Here:
// - a node moves only if it is the selected one, once a single finger rests on it
//   briefly; any other slide scrolls the map (the browser's own scrolling);
// - two fingers zoom the map: scaled while pinching, then jsMind's zoom once the fingers
//   are lifted (the page zoom is disabled in CSS).
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
/**
 * A double tap edits a node only if both taps were on it. Browsers report a double click
 * for two quick taps close enough, with a wide tolerance for fingers: on two neighbouring
 * nodes, or in the void then on a node, the second one would be edited.
 */
export class DoubleTap {
  private taps: (string | null)[] = [null, null];

  /** Each tap (a click), with the node it touched, or null outside any node. */
  tap(key: string | null): void {
    this.taps = [this.taps[1], key];
  }

  /** On the browser's double click: whether its two taps were both on this node. */
  onSameNode(key: string): boolean {
    return this.taps[0] === key && this.taps[1] === key;
  }
}

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
  drag(event: unknown): void;
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

/** What jsMind's drag reads from its event (checked in its source). */
export interface DragInput {
  clientX: number;
  clientY: number;
  touches: ArrayLike<{ clientX: number; clientY: number }>;
  preventDefault(): void;
}

/**
 * jsMind's drag finds the finger in `touches`, but its edge zone (scrolling the map
 * while a node is dragged near an edge) reads only `clientX` and `clientY`, which a
 * touch event lacks: the zone worked only with the mouse. This gives it the finger.
 */
export function withFinger(event: Omit<DragInput, 'clientX' | 'clientY'>): DragInput {
  const finger = event.touches[0];
  return { clientX: finger.clientX, clientY: finger.clientY, touches: event.touches, preventDefault: () => event.preventDefault() };
}

/**
 * Once jsMind's zoom is applied, the scrolling (on one axis) that leaves the map where the
 * pinch showed it: scaled from `from` to `to` around `origin` (in the map's own pixels) and
 * moved by `shift` (the fingers' slide, on screen), the map having moved by `moved` (in its
 * own pixels) in its area, sized again for the new zoom.
 */
export function scrollAfterPinch(scroll: number, origin: number, from: number, to: number, shift: number, moved: number): number {
  return scroll + origin * (to - from) + moved * to - shift;
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
    e_panel: HTMLElement; // scrolls; holds the layers: the links' drawing and the nodes
    set_zoom(zoom: number, center?: Point): boolean;
    relayout(): void;
    get_view_offset(): Point;
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
  const drag = prototype.drag;
  prototype.drag = function (this: DragPlugin, event: unknown) {
    if (!(event as Event).type.startsWith('touch')) return drag.call(this, event);
    drag.call(this, withFinger(event as TouchEvent));
  };

  // While pinching, the map's layers are only scaled (by the graphics card); jsMind's zoom,
  // which lays out every text again, is applied once, when the fingers are lifted. At each
  // frame, a node at the width limit could otherwise jump between one and two lines.
  const panel = jm.view.e_panel;
  let frame = 0;
  // origin: in the layers' own pixels; start: the middle of the fingers at first, on screen; shift: how far it slid
  let preview: { from: number; zoom: number; origin: Point; start: Point; shift: Point } | null = null;
  const scale = (transform: string, origin: string) => {
    for (const layer of Array.from(panel.children) as HTMLElement[]) {
      layer.style.transformOrigin = origin;
      layer.style.transform = transform;
    }
  };
  const endPinch = () => {
    cancelAnimationFrame(frame);
    const done = preview;
    preview = null;
    if (!done) return;
    scale('', '');
    // jsMind's zoom, then the scrolling that leaves every point where the scaling showed it.
    // The map's area is sized for the new zoom first (which moves the map inside it): the
    // browser would otherwise cut the scrolling down to the area's former limits.
    const scroll = { left: panel.scrollLeft, top: panel.scrollTop };
    const before = jm.view.get_view_offset();
    jm.view.set_zoom(done.zoom);
    jm.view.relayout();
    const after = jm.view.get_view_offset();
    const zoom = jm.view.zoom_current;
    panel.scrollLeft = scrollAfterPinch(scroll.left, done.origin.x, done.from, zoom, done.shift.x, after.x - before.x);
    panel.scrollTop = scrollAfterPinch(scroll.top, done.origin.y, done.from, zoom, done.shift.y, after.y - before.y);
  };

  // Capture phase: these run before the plugin's own listeners on the same element.
  const options = { capture: true, passive: true };
  container.addEventListener('touchstart', (event) => gestures.touchStart(points(event.touches)), options);
  container.addEventListener('touchmove', (event) => {
    const pinch = gestures.touchMove(points(event.touches));
    if (!pinch) return;
    if (!preview) {
      // The point between the fingers when the pinch starts follows them, as in Chrome.
      const from = jm.view.zoom_current;
      const box = panel.getBoundingClientRect();
      const origin = { x: (panel.scrollLeft + pinch.center.x - box.left) / from, y: (panel.scrollTop + pinch.center.y - box.top) / from };
      preview = { from, zoom: from, origin, start: pinch.center, shift: { x: 0, y: 0 } };
    }
    const shown = preview;
    shown.zoom = pinch.zoom;
    shown.shift = { x: pinch.center.x - shown.start.x, y: pinch.center.y - shown.start.y };
    cancelAnimationFrame(frame);
    // The layers' pixels are zoomed: the slide is given in them.
    const move = `translate(${shown.shift.x / shown.from}px, ${shown.shift.y / shown.from}px)`;
    frame = requestAnimationFrame(() => scale(`${move} scale(${shown.zoom / shown.from})`, `${shown.origin.x}px ${shown.origin.y}px`));
  }, options);
  container.addEventListener('touchend', (event) => {
    gestures.touchEnd(event.touches.length);
    if (event.touches.length < 2) endPinch();
  }, options);
  container.addEventListener('touchcancel', () => {
    gestures.touchCancel();
    endPinch();
  }, options);
  // A finger resting on a node must not open the browser's context menu.
  container.addEventListener('contextmenu', (event) => {
    if (gestures.touching) event.preventDefault();
  });
}

function points(touches: TouchList): Point[] {
  return Array.from(touches, (touch) => ({ x: touch.clientX, y: touch.clientY }));
}
