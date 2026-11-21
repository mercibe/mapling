// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// The view: displays the map with jsMind and turns the user's gestures into
// operations on the map. jsMind never owns the map: every change goes through
// the bridge, and what jsMind shows is redrawn from the map when needed.
// Browser only (needs jsMind and a DOM to draw in); verified end to end in a browser.

import type { Bridge, Command, Shortcut, View } from './bridge.ts';
import type { Direction, MindMap, Side, ViewNode } from './map.ts';
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
interface Point {
  x: number;
  y: number;
}

interface JmLayout {
  opts: { hspace: number; vspace: number; pspace: number; cousin_space: number };
  set_visible(nodes: JmNode[], visible: boolean): void;
  is_visible(node: JmNode): boolean;
  layout(): void;
  get_node_offset(node: JmNode): Point; // where its link joins it, in the map
  get_node_point_in(node: JmNode): Point; // the same point
  get_node_point_out(node: JmNode): Point; // where its children's links start

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
    render_node(element: HTMLElement, node: JmNode): void;
    opts: { hmargin: number; vmargin: number };
    expand_size(): void;
    relayout(): void;
    clear_lines(): void;
    show_lines(): void;
    graph: {
      lines: SVGPathElement[];
      draw_line(from: Point, to: Point, offset: Point, color?: string): void;
    };
    init_nodes_size(node: JmNode): void;
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

/** Room left around a node the arrow keys select, when the map scrolls to show it. */
const SHOW_MARGIN_PX = 16;

/** Text of a node being added, until its text is validated (neutral: no language). */
export const PLACEHOLDER = '…';
const PENDING_ID = '_pending';

export class JsMindView implements View {
  private readonly jm: JsMindInstance;
  private bridge: Bridge | null = null;
  private cancelled = false; // Escape: the edit ending now changes nothing
  /** Where the next editing puts the caret: set by a double tap, else the text's end. */
  private caretAt: number | null = null;

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
        // Freeplane's keys added, which jsMind ignores while a text is edited: PageUp and
        // PageDown select the first and last sibling; Home and End edit, the caret at the
        // start or at the end, F2 too (jsMind's own did not check that the map is editable).
        handles: {
          firstsibling: (_jm: unknown, event: KeyboardEvent) => this.selectEdgeSibling(event, false),
          lastsibling: (_jm: unknown, event: KeyboardEvent) => this.selectEdgeSibling(event, true),
          editstart: (_jm: unknown, event: KeyboardEvent) => this.editSelected(event, 0),
          editend: (_jm: unknown, event: KeyboardEvent) => this.editSelected(event, null),
        },
        mapping: {
          addchild: null, addbrother: null, delnode: null, editnode: null,
          firstsibling: 33, lastsibling: 34, editstart: 36, editend: [35, 113], // PageUp, PageDown, Home, End and F2
        },
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
    this.showSelectionOnArrows();
    this.shortcutsToShell();
    bottomAnchoredLayout(this.jm.layout);
    linksUnderNodes(this.jm);
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
    } else {
      // A map just opened: its keys act at once, on its root, as in Freeplane. At the next
      // frame, once the shell has shown it (`loaded`, which clears the shell's selection):
      // a hidden map cannot take the focus.
      requestAnimationFrame(() => {
        panel.focus({ preventScroll: true });
        if (!this.jm.get_selected_node() && this.jm.get_node(root.id)) this.jm.select_node(root.id);
      });
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

  /**
   * jsMind would edit the node of the second tap, wherever the first one was. The caret goes
   * where the node was tapped, read before jsMind replaces its text with the editor. In the
   * node being edited, a double tap is the editor's own: it selects a word.
   */
  private editOnDoubleTap(): void {
    const view = this.jm.view;
    const nodeOf = (target: EventTarget | null) => (view.is_node(target) ? view.get_binded_nodeid(target) : null);
    const taps = new DoubleTap();
    view.e_panel.addEventListener('click', (event) => taps.tap(nodeOf(event.target)));
    view.e_panel.addEventListener('dblclick', (event) => {
      const key = nodeOf(event.target);
      if (!key || key === view.editing_node?.id || !this.jm.get_editable() || !taps.onSameNode(key)) return;
      this.caretAt = textOffsetAt(event.target as HTMLElement, event.clientX, event.clientY);
      this.jm.begin_edit(key);
    });
  }

  /**
   * jsMind selects a node with the arrow keys but never scrolls: the map scrolls just enough
   * to show it whole, as in Freeplane. Keys only: a tap on a node half shown would move the
   * map under the finger. jsMind's listener, set in its constructor, has selected it already.
   */
  private showSelectionOnArrows(): void {
    const panel = this.jm.view.e_panel;
    panel.addEventListener('keydown', (event) => {
      if (!event.key.startsWith('Arrow') || event.ctrlKey || event.altKey || event.metaKey || this.editing()) return;
      const element = this.jm.get_selected_node()?._data.view.element;
      if (element) this.showWhole(element);
    });
  }

  /**
   * The keys of the shell's commands are read here, where the editor is known, and sent to the
   * shell, which runs the command if it can: so that adding or deleting a node keeps the
   * shell's rules (placeholder, confirmation), and that every shell has the same keys.
   * Listened to on the map, as jsMind does: the keys act only while it has the focus.
   */
  private shortcutsToShell(): void {
    this.jm.view.e_panel.addEventListener('keydown', (event) => {
      if (!this.jm.mind || this.editing()) return;
      const shortcut = shortcutOf(event);
      if (!shortcut) return;
      event.preventDefault();
      this.bridge?.shortcut(shortcut);
    });
  }

  /** With no node selected, the key keeps its usual role: it scrolls the map by a page. */
  private selectEdgeSibling(event: KeyboardEvent, last: boolean): void {
    const node = this.jm.get_selected_node();
    if (!node) return;
    event.preventDefault();
    const sibling = edgeSibling(node, last);
    this.jm.select_node(sibling.id);
    const element = sibling._data.view.element;
    if (element) this.showWhole(element);
  }

  /**
   * Edits the selected node, the caret at `caret` (null: at the end), as a double tap or the
   * Edit text command. When nothing can be edited (no selection, a read-only map or text), the
   * key keeps its usual role.
   */
  private editSelected(event: KeyboardEvent, caret: number | null): void {
    const node = this.jm.get_selected_node();
    if (!node || node.data.readOnly || !this.jm.get_editable()) return;
    event.preventDefault();
    this.caretAt = caret;
    this.jm.begin_edit(node);
  }

  /** Scrolls the map just enough to show `element` whole, with a small margin; its end, if too large and `toEnd`. */
  private showWhole(element: HTMLElement, toEnd = false): void {
    const panel = this.jm.view.e_panel;
    const shift = scrollToShow(element.getBoundingClientRect(), panel.getBoundingClientRect(), SHOW_MARGIN_PX, toEnd);
    panel.scrollLeft += shift.x;
    panel.scrollTop += shift.y;
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
        this.measureNodes();
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
   * jsMind measures each node once, when shown, and places it with that size at every zoom.
   * Under a fractional zoom, a text at the width limit may take one line instead of two (the
   * font's rounding): measured again once a zoom is over, and laid out with its true height.
   * Not while a text is typed: the node then holds the editor.
   */
  private measureNodes(): void {
    const jm = this.jm;
    if (!jm.mind || jm.view.editing_node) return;
    for (const node of Object.values(jm.mind.nodes)) {
      if (node._data.view.element && jm.layout.is_visible(node)) jm.view.init_nodes_size(node);
    }
    jm.layout.layout();
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
    const editor = this.textEditor(() => this.fitEditing('caret'));
    const beginEdit = jm.begin_edit.bind(jm);
    jm.begin_edit = (target: string | JmNode) => {
      const node = typeof target === 'string' ? jm.get_node(target) : target;
      const caretAt = this.caretAt;
      this.caretAt = null;
      if (!node || node.data.readOnly) return;
      // jsMind does not edit a node without text (it takes it for an image): given a space
      // to begin with, it opens the editor, emptied at once.
      const empty = node.topic === '';
      if (empty) node.topic = ' ';
      beginEdit(node); // the node itself: given its id, jsMind would call this function again
      if (empty) {
        node.topic = '';
        editor.value = '';
      }
      // jsMind empties the node for its editor: the icons go back in front of it.
      const link = node.data.link as string | undefined;
      if (link && editor.parentElement) editor.before(this.icons(link));
      if (editor.parentElement) editor.after(this.newlineButton(editor));
      // jsMind selects the whole text. Only a new node keeps it so, its "…" replaced by the
      // first key; any other text gets the caret where it was tapped, or at its end.
      const caret = caretAt ?? editor.value.length;
      if (node.id !== PENDING_ID) editor.setSelectionRange(caret, caret);
      // jsMind sizes the editor to the node (a new node's "…" is tiny): let the CSS size it.
      editor.style.width = '';
      fitHeight(editor);
      this.fitEditing(editor.selectionStart === editor.value.length ? 'end' : 'start');
    };
    const editNodeEnd = view.edit_node_end.bind(view);
    view.edit_node_end = () => {
      const node = view.editing_node;
      if (!node) return editNodeEnd(); // also the blur that removing the editor sets off
      // jsMind keeps the old text when the new one is blank: an emptied node, or a new one
      // validated untouched ("…"), gets its empty text here, as in Freeplane.
      const value = view.e_editor.value;
      const empty = !this.cancelled && leftEmpty(value, node.id === PENDING_ID);
      this.cancelled = false;
      this.keepStill(node, () => {
        editNodeEnd();
        if (empty && node.topic !== '') {
          node.topic = '';
          view.render_node(node._data.view.element as HTMLElement, node);
        }
        // A changed text is measured and laid out by jsMind; an unchanged one only drawn again.
        // A new node cancelled is removed next: jsMind then lays out, keeping its parent still.
        const dropped = node.id === PENDING_ID && node.topic === PLACEHOLDER;
        if (this.resized(node) && !dropped) this.layOut(node);
      });
      if (node.id === PENDING_ID) this.completeNewNode(node);
      else if (empty) this.apply((map) => map.updateText(node.id, ''));
    };
    const selectClear = jm.select_clear.bind(jm);
    jm.select_clear = () => {
      selectClear();
      this.bridge?.select(null); // jsMind emits no event for this
    };
  }

  /**
   * As the edited node grows or shrinks: laid out at its new size, and shown whole with its
   * ↵ button (on a narrow screen, they may otherwise go past the edge). A node taller than
   * the map shows the part asked for: its start, or its end, where the ↵ button and a caret
   * at the end are; while typing (`caret`), the browser itself keeps the caret in sight.
   */
  private fitEditing(part: 'start' | 'end' | 'caret'): void {
    const node = this.jm.view.editing_node;
    const element = node?._data.view.element;
    if (!node || !element) return;
    this.layOutEdited(node);
    const tooTall = element.offsetHeight + 2 * SHOW_MARGIN_PX > this.jm.view.e_panel.clientHeight;
    if (!tooTall || part !== 'caret') this.showWhole(element, part === 'end');
  }

  /**
   * jsMind lays a node out with the size it measured; while it is edited, its text changes
   * that size. Measured again and laid out, the node takes its room in the map: its
   * neighbours move aside instead of being covered. The point where its link joins it
   * stays still on screen, and the text being typed with it.
   */
  private layOutEdited(node: JmNode): void {
    if (this.resized(node)) this.keepStill(node, () => this.layOut(node));
  }

  /** Whether the node's displayed size differs from the one jsMind laid it out with. */
  private resized(node: JmNode): boolean {
    const size = node._data.view;
    const element = size.element;
    return !!element && (element.clientWidth !== size.width || element.clientHeight !== size.height);
  }

  /** The node measured again, and the map laid out and drawn for that size. */
  private layOut(node: JmNode): void {
    const { layout, view } = this.jm;
    view.init_nodes_size(node);
    layout.layout();
    view.relayout();
  }

  /** Runs `change`, then scrolls so that the point where the node's link joins it has not moved on screen. */
  private keepStill(node: JmNode, change: () => void): void {
    const { layout, view } = this.jm;
    const joint = () => {
      const inMap = layout.get_node_offset(node);
      const map = view.get_view_offset();
      return { x: inMap.x + map.x, y: inMap.y + map.y };
    };
    const before = joint();
    change();
    const after = joint();
    view.e_panel.scrollLeft += (after.x - before.x) * view.zoom_current;
    view.e_panel.scrollTop += (after.y - before.y) * view.zoom_current;
  }

  /**
   * A text area instead of jsMind's one-line field, which jsMind only fills, places, selects
   * and reads (checked in its source): a long text wraps while it is edited, as in the node.
   * As in Freeplane, Enter validates and Shift+Enter starts a new line, written `&#xa;` in
   * the file. A virtual keyboard shows ✓ for Enter; the ↵ button starts a new line.
   */
  private textEditor(fitted: () => void): HTMLTextAreaElement {
    const view = this.jm.view;
    const editor = document.createElement('textarea');
    editor.className = 'jsmind-editor';
    editor.rows = 1;
    editor.enterKeyHint = 'done';
    // Shift+Enter seen in keydown: the line break that follows is wanted (beforeinput does
    // not tell whether Shift is down).
    let newLine = false;
    // `key`, not only the legacy keyCode 13 jsMind checks: virtual keyboards (Android) and
    // synthetic events may leave it at 0 or 229.
    // Escape cancels, as in Freeplane: the editor gets the node's text back, and jsMind
    // changes nothing for an unchanged text (a new node: no node is added).
    editor.addEventListener('keydown', (event) => {
      const escape = event.key === 'Escape';
      const enter = event.key === 'Enter' || event.keyCode === 13;
      newLine = enter && event.shiftKey;
      if ((!escape && !enter) || newLine) return; // a new line: the text area inserts it
      event.preventDefault();
      event.stopPropagation();
      if (escape && view.editing_node) {
        editor.value = view.editing_node.topic;
        this.cancelled = true;
      }
      view.edit_node_end();
    });
    // A virtual keyboard that sends no Enter key, only the line break: it validates too.
    editor.addEventListener('beforeinput', (event) => {
      if (event.inputType !== 'insertLineBreak' || newLine) return;
      event.preventDefault();
      view.edit_node_end();
    });
    editor.addEventListener('input', () => {
      newLine = false;
      // Line breaks pasted from elsewhere: written as Freeplane does, `\n` only.
      if (/\r/.test(editor.value)) editor.value = editor.value.replace(/\r\n|\r/g, '\n');
      fitHeight(editor);
      fitted();
    });
    editor.addEventListener('blur', () => view.edit_node_end());
    view.e_editor = editor;
    return editor;
  }

  /**
   * Beside the editor, a button that starts a new line, for a finger (the keyboard's ✓
   * validates). It never takes the focus, so the keyboard stays open. Drawn by the
   * stylesheet, with no text: screen readers skip it; Shift+Enter does the same.
   */
  private newlineButton(editor: HTMLTextAreaElement): HTMLElement {
    const button = document.createElement('span');
    button.className = 'mapling-newline-button';
    button.setAttribute('aria-hidden', 'true');
    // Before it can move the focus, or start a gesture on the node (touch.ts); the click
    // synthesized after a touch would come too late, and is prevented with the touch.
    const keep = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const type of ['mousedown', 'touchstart', 'click', 'dblclick']) button.addEventListener(type, keep);
    button.addEventListener('pointerdown', (event) => {
      keep(event);
      // After the selection, not in its place: a text just opened is all selected.
      editor.setRangeText('\n', editor.selectionEnd, editor.selectionEnd, 'end');
      fitHeight(editor);
      this.fitEditing('end'); // the button is at the node's end: so is the finger
    });
    return button;
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
      // Cancelled (Escape): nothing to add.
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
      text.textContent = shownText(node.topic);
      element.textContent = ''; // not replaceChildren: Chromium 86, one past the minimum
      element.append(this.icons(link), text);
    } else {
      element.textContent = shownText(node.topic);
    }
    element.classList.toggle('mapling-locked', !!node.data.readOnly);
    element.classList.toggle('mapling-hidden-content', !!node.data.hidden);
    return true;
  }
}

/** Whether an edit leaves the node without text: blank, or a new node's "…" validated untouched. */
export function leftEmpty(value: string, isNew: boolean): boolean {
  return value.trim() === '' || (isNew && value === PLACEHOLDER);
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

/**
 * A node's underline is its link, drawn on under it: one SVG path from the node's far end,
 * along its bottom, then jsMind's curve to its parent. Drawn apart, a CSS border never quite
 * met the link: the browser rounds a border's width and place to whole pixels, not a
 * drawing's. This is jsMind 0.9.1's show_lines and SVG draw_line (checked in its source),
 * with that one segment more.
 */
function linksUnderNodes(jm: JsMindInstance): void {
  const { view, layout } = jm;
  view.show_lines = () => {
    view.clear_lines();
    const offset = view.get_view_offset();
    for (const node of Object.values(jm.mind?.nodes ?? {})) {
      if (node.isroot || !layout.is_visible(node)) continue;
      const from = layout.get_node_point_out(node.parent as JmNode);
      const to = layout.get_node_point_in(node);
      view.graph.draw_line(from, to, offset, node.data['leading-line-color'] as string | undefined);
      const [x, y, px, py] = [to.x + offset.x, to.y + offset.y, from.x + offset.x, from.y + offset.y];
      const end = x + node._data.view.width * node._data.layout.direction;
      const path = view.graph.lines[view.graph.lines.length - 1];
      path.setAttribute('d', `M ${end} ${y} H ${x} C ${x + (2 * (px - x)) / 3} ${y}, ${x} ${py}, ${px} ${py}`);
    }
  };
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * How far to scroll so that `box` is wholly inside `area`, with `margin` around it: not at
 * all when it already is, else just enough. A box too large for the area shows its start
 * (left, top), where its text begins; or its end (right, bottom), when `toEnd`.
 */
export function scrollToShow(box: Box, area: Box, margin: number, toEnd = false): { x: number; y: number } {
  const along = (start: number, end: number, areaStart: number, areaEnd: number): number => {
    const back = start - margin - areaStart; // negative when the box begins before the area
    const forth = end + margin - areaEnd; // positive when it ends after the area
    if (toEnd) return forth > 0 ? forth : Math.max(Math.min(back, 0), forth);
    return back < 0 ? back : Math.min(Math.max(forth, 0), back);
  };
  return { x: along(box.left, box.right, area.left, area.right), y: along(box.top, box.bottom, area.top, area.bottom) };
}

/**
 * As tall as its lines, on every WebView (field-sizing is recent: Chromium 123). Some fonts
 * overflow the line by a pixel: rounded to whole lines, the node keeps the height it is
 * shown with, and the map is not laid out again for that pixel.
 */
function fitHeight(editor: HTMLTextAreaElement): void {
  editor.style.height = 'auto';
  const line = parseFloat(getComputedStyle(editor).lineHeight);
  editor.style.height = `${Math.max(1, Math.round(editor.scrollHeight / line)) * line}px`;
}

/**
 * The offset, in the text of the node `element`, of the point (x, y) on screen; null off
 * its text (padding, icons). The node shows its topic as one text node, so the offset in it
 * is the offset in the topic (past its end after shownText's mark: the editor brings it back).
 * caretRangeFromPoint: Chromium before 128, which lacks the other.
 */
export function textOffsetAt(element: HTMLElement, x: number, y: number): number | null {
  const position = document.caretPositionFromPoint?.(x, y);
  const range = position ? null : document.caretRangeFromPoint?.(x, y);
  const text = position?.offsetNode ?? range?.startContainer;
  if (!text || text.nodeType !== Node.TEXT_NODE || !element.contains(text)) return null;
  return position?.offset ?? range?.startOffset ?? null;
}

/**
 * The text a node shows. A browser draws no line after a final line break, where the editor
 * does: a zero-width space gives it one, so that a blank line the user typed at the end is
 * seen, and the node keeps its height when edited.
 */
export function shownText(topic: string): string {
  return topic.endsWith('\n') ? topic + '\u200b' : topic;
}

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/**
 * The shell's command for a key, as in Freeplane (read in its menus, mindmapmodemenu.xml);
 * null for any other key. Ctrl+arrows move the node, Alt+Up and Alt+Down zoom; Tab adds a
 * child, as Insert does.
 */
export function shortcutOf(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): Shortcut | null {
  const ctrl = event.ctrlKey || event.metaKey;
  const plain = !ctrl && !event.altKey && !event.shiftKey;
  const key = event.key.toLowerCase();
  const arrow = ARROWS[event.key];
  if (ctrl && !event.altKey && !event.shiftKey && arrow) return { command: 'moveNode', direction: arrow };
  if (event.altKey && !ctrl && !event.shiftKey && arrow === 'up') return { command: 'zoomIn' };
  if (event.altKey && !ctrl && !event.shiftKey && arrow === 'down') return { command: 'zoomOut' };
  if (ctrl && key === 'k') return { command: 'editLink' };
  if (ctrl && event.key === 'Enter') return { command: 'followLink' };
  if (ctrl && key === 's') return { command: 'save' };
  if (ctrl && key === 'z' && !event.shiftKey) return { command: 'undo' };
  if (ctrl && (key === 'y' || (key === 'z' && event.shiftKey))) return { command: 'redo' };
  if (plain && (event.key === 'Insert' || event.key === 'Tab')) return { command: 'addChild' };
  if (plain && event.key === 'Enter') return { command: 'addSibling' };
  if (plain && event.key === 'Delete') return { command: 'deleteNode' };
  return null;
}

/**
 * The first or the last of a node's siblings (itself, if it is that one or the root). Among
 * the root's children, only those on the node's side: the others are on the opposite side
 * of the map.
 */
export function edgeSibling<T extends { isroot: boolean; parent: T | null; children: T[]; direction: number }>(
  node: T, last: boolean,
): T {
  const parent = node.parent;
  if (!parent) return node;
  const siblings = parent.isroot ? parent.children.filter((s) => s.direction === node.direction) : parent.children;
  return siblings[last ? siblings.length - 1 : 0];
}

function side(node: JmNode): Side {
  return node.direction === -1 ? 'left' : 'right';
}

