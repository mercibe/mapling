// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The view: displays the map with jsMind and turns the user's gestures into
// operations on the map. jsMind never owns the map: every change goes through
// the bridge, and what jsMind shows is redrawn from the map when needed.
// Browser only (needs jsMind and a DOM to draw in); verified end to end in a browser.

import type { Bridge, Command, View } from './bridge.ts';
import type { MindMap, Side, ViewNode } from './map.ts';
import { DoubleTap, installTouchGestures, type TouchMap } from './touch.ts';

// ---------- the parts of jsMind 0.9.1 used here (checked in its source) ----------

interface JmNode {
  id: string;
  topic: string;
  isroot: boolean;
  parent: JmNode | null;
  children: JmNode[];
  direction: number; // -1 left, 1 right (children of the root)
  expanded: boolean;
  data: Record<string, unknown>;
  _data: {
    view: { element: HTMLElement | null; width: number; height: number }; // the node as displayed
    layout: { direction: number; offset_x: number; offset_y: number; outer_height: number };
  };
}

/** jsMind's layout engine, the parts replaced by bottomAnchoredLayout (checked in its source). */
interface JmLayout {
  opts: { hspace: number; vspace: number; pspace: number; cousin_space: number };
  set_visible(nodes: JmNode[], visible: boolean): void;
  _should_reserve_cousin_space(node: JmNode): boolean;
  _layout_offset_subnodes(nodes: JmNode[]): number;
  _layout_offset_subnodes_height(nodes: JmNode[]): number;
}

interface JmEditEvent {
  evt?: string;
  data?: unknown[];
  node?: string;
}

interface JsMindInstance extends TouchMap {
  mind: { root: JmNode; nodes: Record<string, JmNode> } | null;
  layout: JmLayout;
  view: TouchMap['view'] & {
    e_panel: HTMLElement;
    e_editor: HTMLInputElement | HTMLTextAreaElement;
    is_node(element: EventTarget | null): boolean;
    get_binded_nodeid(element: EventTarget | null): string | null;
    editing_node: JmNode | null;
    edit_node_end(): void;
    opts: { hmargin: number; vmargin: number };
    expand_size(): void;
    relayout(): void;
    zoom_in(): boolean;
    zoom_out(): boolean;
    resize(): void;
    get_view_offset(): { x: number; y: number };
  };
  show(mind: object, skipCentering?: boolean): void;
  get_node(id: string): JmNode | null;
  get_selected_node(): JmNode | null;
  select_node(id: string): void;
  select_clear(): void;
  begin_edit(target: string | JmNode): void; // given an id, jsMind calls it again with the node
  get_editable(): boolean;
  add_node(parentId: string, id: string, topic: string, data?: object, direction?: number): JmNode | null;
  insert_node_after(afterId: string, id: string, topic: string, data?: object, direction?: number): JmNode | null;
  insert_node_before(beforeId: string, id: string, topic: string, data?: object, direction?: number): JmNode | null;
  remove_node(id: string): boolean;
  enable_edit(): void;
  disable_edit(): void;
  scroll_node_to_center(id: string): void;
  add_event_listener(listener: (type: number, data: JmEditEvent) => void): void;
}

declare const jsMind: {
  new (options: object): JsMindInstance;
  event_type: { show: number; edit: number; select: number };
};

// ---------- the view ----------

/** A zoom (a pinch, the wheel) is over once no step came for this long: the map is sized then. */
const ZOOM_SETTLED_MS = 150;

/** Text of a node being added, until its text is validated (neutral: no language). */
export const PLACEHOLDER = '…';
const PENDING_ID = '_pending';

export class JsMindView implements View {
  private readonly jm: JsMindInstance;
  private bridge: Bridge | null = null;
  /** Height of the node being edited, before its editor (null: root, or not editing). */
  private editedHeight: number | null = null;

  constructor(container: HTMLElement | string) {
    this.jm = new jsMind({
      container,
      editable: true,
      support_html: false, // topics are plain text, never HTML
      log_level: 'warn',
      view: {
        // Lines as SVG: jsMind's default canvas is drawn at CSS pixels, so lines look blurred
        // on dense screens, and more so once zoomed.
        engine: 'svg',
        draggable: true, // pan the map with the mouse
        node_overflow: 'wrap',
        custom_node_render: (_jm: unknown, element: HTMLElement, node: JmNode) => this.render(element, node),
      },
      // Siblings closer together, as in Freeplane (jsMind's default gap: 20 px); groups of
      // children set apart from the next ones (cousin_space, 0 by default).
      layout: { vspace: 6, cousin_space: 12 },
      // Double taps are handled here, on a single node (see DoubleTap).
      default_event_handle: { enable_dblclick_handle: false },
      shortcut: {
        // Adding and deleting go through the shell's commands (placeholder rule,
        // confirmation of deletions); jsMind's own shortcuts would bypass them.
        mapping: { addchild: null, addbrother: null, delnode: null },
      },
      plugin: {
        // Dragging a node near an edge scrolls the map; the default 20 px zone
        // is too narrow for a finger.
        draggable_node: { scrolling_trigger_width: 48, scrolling_step_length: 16 },
      },
    });
    this.guardEditing();
    this.roomAroundTheMap();
    this.editOnDoubleTap();
    bottomAnchoredLayout(this.jm.layout);
    installTouchGestures(this.jm);
    this.jm.add_event_listener((type, event) => this.onJsMindEvent(type, event));
  }

  /** Connects the view to the bridge it reports to (they need each other). */
  connect(bridge: Bridge): void {
    this.bridge = bridge;
  }

  // ---------- View (called by the bridge) ----------

  show(root: ViewNode, readOnly: boolean, keepViewState: boolean): void {
    const panel = this.jm.view.e_panel;
    const scroll = { left: panel.scrollLeft, top: panel.scrollTop };
    const selected = this.jm.get_selected_node()?.id;
    // Another map starts at the normal size: jsMind would keep the previous map's zoom.
    if (!keepViewState && this.jm.mind && this.jm.view.zoom_current !== 1) this.jm.view.set_zoom(1);
    this.jm.show({ meta: { name: 'mapling' }, format: 'node_tree', data: root }, keepViewState);
    this.setReadOnly(readOnly);
    if (keepViewState) {
      panel.scrollLeft = scroll.left;
      panel.scrollTop = scroll.top;
      if (selected && this.jm.get_node(selected)) this.jm.select_node(selected);
      else this.bridge?.select(null);
    }
  }

  editing(): boolean {
    return this.jm.view.editing_node !== null;
  }

  setReadOnly(readOnly: boolean): void {
    if (readOnly) this.jm.disable_edit();
    else this.jm.enable_edit();
  }

  command(name: Command, key: string): void {
    switch (name) {
      case 'editText':
        this.jm.select_node(key);
        return this.jm.begin_edit(key);
      case 'addChild':
        return this.startNewNode(this.jm.add_node(key, PENDING_ID, PLACEHOLDER, {}));
      case 'addSibling': {
        const sibling = this.jm.get_node(key);
        if (!sibling || sibling.isroot) return;
        const node = this.jm.insert_node_after(key, PENDING_ID, PLACEHOLDER, {}, sibling.direction);
        return this.startNewNode(node);
      }
      case 'deleteNode': {
        const node = this.jm.get_node(key);
        if (!node || node.isroot) return;
        let next = key;
        const removed = this.apply((map) => {
          next = map.nodeAfterRemoval(key);
          map.removeNode(key);
          return true;
        });
        if (!removed) return;
        this.jm.remove_node(key);
        this.jm.select_node(next);
      }
    }
  }

  /**
   * Scrolls so that the node (the root by default) is in the middle of the map, from where
   * it is displayed: jsMind's own centering misplaces it once the map is zoomed.
   */
  center(key: string | null): void {
    const root = this.jm.mind?.root;
    const element = root && this.jm.get_node(key ?? root.id)?._data.view.element;
    if (!element) return;
    const panel = this.jm.view.e_panel;
    const node = element.getBoundingClientRect();
    const view = panel.getBoundingClientRect();
    panel.scrollLeft += node.left + node.width / 2 - (view.left + view.width / 2);
    panel.scrollTop += node.top + node.height / 2 - (view.top + view.height / 2);
  }

  /** One step of jsMind's zoom, around the middle of the map (no point given). */
  zoom(direction: 'in' | 'out'): void {
    if (direction === 'in') this.jm.view.zoom_in();
    else this.jm.view.zoom_out();
  }

  // ---------- gestures in jsMind ----------

  /**
   * jsMind reports edits after changing its own model, asynchronously. Only two
   * come from the user's gestures: editing a text and dragging a node. The others
   * (add, insert, remove) are echoes of this view's own calls and are ignored.
   */
  private onJsMindEvent(type: number, event: JmEditEvent): void {
    if (type === jsMind.event_type.select && event.node) {
      this.bridge?.select(event.node === PENDING_ID ? null : event.node);
      return;
    }
    if (type === jsMind.event_type.show && (event.evt === 'expand_node' || event.evt === 'collapse_node')) {
      // Folding is a change of the map, as in Freeplane (saved, undone); in a read-only
      // map it only changes what is shown.
      const key = event.node;
      if (key && key !== PENDING_ID && !this.bridge?.readOnly) {
        this.apply((map) => map.setFolded(key, event.evt === 'collapse_node'));
      }
      return;
    }
    if (type !== jsMind.event_type.edit || event.node === PENDING_ID) return;
    if (event.evt === 'update_node') {
      const [key, text] = event.data as [string, string];
      this.apply((map) => map.updateText(key, text));
    } else if (event.evt === 'move_node') {
      const key = (event.data as [string])[0];
      const node = this.jm.get_node(key);
      if (!node || !node.parent) return;
      // jsMind's event gives the call's arguments; its model gives the result.
      const parent = node.parent;
      const index = parent.children.indexOf(node);
      this.apply((map) => map.moveNode(key, parent.id, index, side(node)));
    }
  }

  /**
   * The icons before a node's text: today the link's only, room for more (task icons…).
   * As in Freeplane, touching them opens the link; it neither selects the node nor starts
   * a gesture on it.
   */
  private icons(link: string): HTMLElement {
    const icons = document.createElement('span');
    icons.className = 'mapling-icons';
    const icon = document.createElement('span');
    icon.className = 'mapling-link-icon';
    icon.title = link;
    icons.append(icon);
    const keep = (event: Event) => event.stopPropagation();
    for (const type of ['mousedown', 'touchstart', 'dblclick']) icons.addEventListener(type, keep);
    icons.addEventListener('click', (event) => {
      event.stopPropagation();
      this.bridge?.openLink(link);
    });
    return icons;
  }

  /** jsMind would edit the node of the second tap, wherever the first one was. */
  private editOnDoubleTap(): void {
    const view = this.jm.view;
    const nodeOf = (target: EventTarget | null) => (view.is_node(target) ? view.get_binded_nodeid(target) : null);
    const taps = new DoubleTap();
    view.e_panel.addEventListener('click', (event) => taps.tap(nodeOf(event.target)));
    view.e_panel.addEventListener('dblclick', (event) => {
      const key = nodeOf(event.target);
      if (key && this.jm.get_editable() && taps.onSameNode(key)) this.jm.begin_edit(key);
    });
  }

  /**
   * jsMind keeps only a fixed margin (100 px) beyond the outermost nodes: the root of a map
   * whose nodes are all on one side sits near the edge, and cannot be centered. A margin of
   * the whole visible area, at the current zoom, lets any node go as far as the opposite
   * edge, as in Freeplane. jsMind reads its margins when it sizes the map (expand_size), which
   * it does not do on zooming (set_zoom only draws) nor when the map's area changes size:
   * then the view does it, and keeps what is on screen in place. Not at each step of a pinch:
   * resizing the map's whole area at each frame made it less fluid; once, when it ends.
   */
  private roomAroundTheMap(): void {
    const view = this.jm.view;
    const panel = view.e_panel;
    const expandSize = view.expand_size.bind(view);
    view.expand_size = () => {
      view.opts.hmargin = Math.round(panel.clientWidth / view.zoom_current);
      view.opts.vmargin = Math.round(panel.clientHeight / view.zoom_current);
      expandSize();
    };
    const setZoom = view.set_zoom.bind(view);
    let zoomEnd: ReturnType<typeof setTimeout> | undefined;
    view.set_zoom = (zoom, center) => {
      if (!setZoom(zoom, center)) return false;
      clearTimeout(zoomEnd);
      zoomEnd = setTimeout(() => {
        if (!this.jm.mind) return;
        const before = view.get_view_offset();
        const scroll = { left: panel.scrollLeft, top: panel.scrollTop };
        view.relayout(); // sizes, then draws
        this.followMap(before, scroll);
      }, ZOOM_SETTLED_MS);
      return true;
    };
    // The point of the map in the middle of the area stays in the middle. It is noted at each
    // scroll, in the map's own units: once the area has changed size, the browser may already
    // have cut the scrolling down to the new limits, and it can no longer be read.
    let size = { width: panel.clientWidth, height: panel.clientHeight };
    let middle: { x: number; y: number } | null = null;
    panel.addEventListener('scroll', () => {
      if (panel.clientWidth !== size.width || panel.clientHeight !== size.height) return; // being resized
      const offset = view.get_view_offset();
      middle = {
        x: (panel.scrollLeft + size.width / 2) / view.zoom_current - offset.x,
        y: (panel.scrollTop + size.height / 2) / view.zoom_current - offset.y,
      };
    });
    new ResizeObserver(() => {
      const { clientWidth: width, clientHeight: height } = panel;
      if (width === 0 || (width === size.width && height === size.height)) return; // hidden, or unchanged
      size = { width, height };
      if (!this.jm.mind) return;
      const point = middle;
      view.resize();
      if (!point) return;
      const offset = view.get_view_offset();
      panel.scrollLeft = (point.x + offset.x) * view.zoom_current - width / 2;
      panel.scrollTop = (point.y + offset.y) * view.zoom_current - height / 2;
    }).observe(panel);
  }

  /**
   * Sizing the map again moves it inside its area (by the change of its offset): scrolls by
   * as much from `scroll`, so that the map stays where it was on screen.
   */
  private followMap(before: { x: number; y: number }, scroll: { left: number; top: number }): void {
    const view = this.jm.view;
    const after = view.get_view_offset();
    view.e_panel.scrollLeft = scroll.left + (after.x - before.x) * view.zoom_current;
    view.e_panel.scrollTop = scroll.top + (after.y - before.y) * view.zoom_current;
  }

  /** Read-only texts cannot be edited; the end of editing completes a new node. */
  private guardEditing(): void {
    const jm = this.jm;
    const view = jm.view;
    const editor = this.textEditor(() => this.keepOnItsLink());
    const beginEdit = jm.begin_edit.bind(jm);
    jm.begin_edit = (target: string | JmNode) => {
      const node = typeof target === 'string' ? jm.get_node(target) : target;
      if (!node || node.data.readOnly) return;
      const element = node._data.view.element;
      this.editedHeight = element && !node.isroot ? element.offsetHeight : null;
      beginEdit(node); // the node itself: given its id, jsMind would call this function again
      // jsMind empties the node for its editor: the icons go back in front of it.
      const link = node.data.link as string | undefined;
      if (link && editor.parentElement) editor.before(this.icons(link));
      // jsMind sizes the editor to the node (a new node's "…" is tiny): let the CSS size it.
      editor.style.width = '';
      fitHeight(editor);
      this.keepOnItsLink();
    };
    const editNodeEnd = view.edit_node_end.bind(view);
    view.edit_node_end = () => {
      const node = view.editing_node;
      if (node?._data.view.element) node._data.view.element.style.transform = ''; // back to the CSS
      this.editedHeight = null;
      editNodeEnd();
      if (node && node.id === PENDING_ID) this.completeNewNode(node);
    };
    const selectClear = jm.select_clear.bind(jm);
    jm.select_clear = () => {
      selectClear();
      this.bridge?.select(null); // jsMind emits no event for this
    };
  }

  /**
   * jsMind placed the node for its height before editing; the CSS lifts it by half its
   * height so that its bottom meets its link. While the editor changes that height, the
   * lift is set from both heights, so that the bottom stays on the link.
   */
  private keepOnItsLink(): void {
    const element = this.jm.view.editing_node?._data.view.element;
    if (!element || this.editedHeight === null) return;
    element.style.transform = `translateY(${this.editedHeight / 2 - element.offsetHeight}px)`;
  }

  /**
   * A text area instead of jsMind's one-line field, which jsMind only fills, places, selects
   * and reads (checked in its source): a long text wraps while it is edited, as in the node
   * and in Freeplane. The text stays on one line: Enter validates, and line breaks pasted
   * become spaces (a text on several lines could no longer be edited here).
   */
  private textEditor(fitted: () => void): HTMLTextAreaElement {
    const view = this.jm.view;
    const editor = document.createElement('textarea');
    editor.className = 'jsmind-editor';
    editor.rows = 1;
    // `key`, not only the legacy keyCode 13 jsMind checks: virtual keyboards (Android) and
    // synthetic events may leave it at 0 or 229.
    // Escape cancels, as in Freeplane: the editor gets the node's text back, and jsMind
    // changes nothing for an unchanged text (a new node's placeholder: no node is added).
    editor.addEventListener('keydown', (event) => {
      const escape = event.key === 'Escape';
      if (!escape && event.key !== 'Enter' && event.keyCode !== 13) return;
      event.preventDefault(); // no line break
      event.stopPropagation();
      if (escape && view.editing_node) editor.value = view.editing_node.topic;
      view.edit_node_end();
    });
    editor.addEventListener('input', () => {
      if (/[\r\n]/.test(editor.value)) editor.value = editor.value.replace(/\r\n|\r|\n/g, ' ');
      fitHeight(editor);
      fitted();
    });
    editor.addEventListener('blur', () => view.edit_node_end());
    view.e_editor = editor;
    return editor;
  }

  // ---------- adding a node: created in the map only once its text is validated ----------

  private startNewNode(node: JmNode | null): void {
    if (!node) return;
    this.jm.select_node(node.id);
    this.jm.begin_edit(node.id);
  }

  private completeNewNode(node: JmNode): void {
    const parent = node.parent as JmNode;
    const text = node.topic;
    if (text === PLACEHOLDER) {
      // Validated unchanged (or emptied, which jsMind refuses): nothing to add.
      this.jm.remove_node(PENDING_ID);
      this.jm.select_node(parent.id);
      return;
    }
    const index = parent.children.indexOf(node);
    const key = this.apply((map) => map.addNode(parent.id, index, text, side(node)));
    if (key === null) return;
    // Replace the pending node by the real one, at the same place.
    this.jm.insert_node_before(PENDING_ID, key, text, {}, node.direction);
    this.jm.remove_node(PENDING_ID);
    this.jm.select_node(key);
  }

  // ---------- helpers ----------

  /**
   * Applies an operation to the map through the bridge. If it fails, the display
   * may no longer match the map: it is redrawn from the map, the only truth.
   */
  private apply<T>(operation: (map: MindMap) => T): T | null {
    const bridge = this.bridge;
    if (!bridge) return null;
    try {
      return bridge.edit(operation);
    } catch (error) {
      console.error('mapling: operation refused, redrawing from the map', error);
      const projection = bridge.projection();
      if (projection) this.show(projection, bridge.readOnly, true);
      return null;
    }
  }

  /** Icons, then the text, plus marks for CSS: lock (text not editable), dot (hidden content). */
  private render(element: HTMLElement, node: JmNode): boolean {
    const link = node.data.link as string | undefined;
    element.classList.toggle('mapling-with-icons', !!link);
    if (link) {
      // Icons on the left, the text as a block beside them, as in Freeplane.
      const text = document.createElement('span');
      text.className = 'mapling-text';
      text.textContent = node.topic;
      element.textContent = ''; // not replaceChildren: Chromium 86, one past the minimum
      element.append(this.icons(link), text);
    } else {
      element.textContent = node.topic;
    }
    element.classList.toggle('mapling-locked', !!node.data.readOnly);
    element.classList.toggle('mapling-hidden-content', !!node.data.hidden);
    return true;
  }
}

/**
 * Links join a node's underline, as in Freeplane: jsMind joins them to the middle of the
 * node, so the stylesheet moves each node (but the root) up by half its height. A node
 * then stands entirely above the point its links join; jsMind's layout, which reserves half
 * of it above and half below, would let a tall node cover the one above it. This is
 * jsMind 0.9.1's own layout of children (_layout_offset_subnodes, checked in its source)
 * with that one difference: each node gets its whole height above the joint, and below it
 * half of its children's block. Nodes on one line keep the very same spacing.
 */
function bottomAnchoredLayout(layout: JmLayout): void {
  const place = (nodes: JmNode[], hideFolded: boolean): number => {
    const { hspace, vspace, pspace, cousin_space } = layout.opts;
    let total = 0;
    let bottom = 0; // nodes are placed from the last one up, as jsMind does
    for (let n = nodes.length - 1; n >= 0; n--) {
      const node = nodes[n];
      const box = node._data.layout;
      const parent = (node.parent as JmNode)._data;
      let children = place(node.children, hideFolded);
      if (!node.expanded) {
        children = 0;
        if (hideFolded) layout.set_visible(node.children, false);
      }
      // Around a group of children shown: none to set apart when they are folded.
      const cousins = node.expanded && layout._should_reserve_cousin_space(node) ? cousin_space / 2 : 0;
      const above = Math.max(node._data.view.height, children / 2) + cousins;
      const below = children / 2 + cousins;
      box.outer_height = above + below;
      box.offset_y = bottom - below;
      box.offset_x = hspace * box.direction + (parent.view.width * (parent.layout.direction + box.direction)) / 2;
      if (!(node.parent as JmNode).isroot) box.offset_x += pspace * box.direction;
      bottom -= box.outer_height + vspace;
      total += box.outer_height;
    }
    if (nodes.length > 1) total += vspace * (nodes.length - 1);
    for (const node of nodes) node._data.layout.offset_y += total / 2;
    return total;
  };
  layout._layout_offset_subnodes = (nodes) => place(nodes, true);
  layout._layout_offset_subnodes_height = (nodes) => place(nodes, false);
}

/** As tall as its text, on every WebView (field-sizing is recent: Chromium 123). */
function fitHeight(editor: HTMLTextAreaElement): void {
  editor.style.height = 'auto';
  editor.style.height = `${editor.scrollHeight}px`;
}

function side(node: JmNode): Side {
  return node.direction === -1 ? 'left' : 'right';
}

