// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The view: displays the map with jsMind and turns the user's gestures into
// operations on the map. jsMind never owns the map: every change goes through
// the bridge, and what jsMind shows is redrawn from the map when needed.
// Browser only (needs jsMind and a DOM to draw in); verified end to end in a browser.

import type { Bridge, Command, View } from './bridge.ts';
import type { MindMap, Side, ViewNode } from './map.ts';
import { installTouchGestures, type TouchMap } from './touch.ts';

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
    e_editor: HTMLInputElement;
    editing_node: JmNode | null;
    edit_node_end(): void;
  };
  show(mind: object, skipCentering?: boolean): void;
  get_node(id: string): JmNode | null;
  get_selected_node(): JmNode | null;
  select_node(id: string): void;
  select_clear(): void;
  begin_edit(id: string): void;
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

/** Text of a node being added, until its text is validated (neutral: no language). */
export const PLACEHOLDER = '…';
const PENDING_ID = '_pending';

export class JsMindView implements View {
  private readonly jm: JsMindInstance;
  private bridge: Bridge | null = null;

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
        return this.startNewNode(this.jm.add_node(key, PENDING_ID, PLACEHOLDER, { pending: true }));
      case 'addSibling': {
        const sibling = this.jm.get_node(key);
        if (!sibling || sibling.isroot) return;
        const node = this.jm.insert_node_after(key, PENDING_ID, PLACEHOLDER, { pending: true }, sibling.direction);
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

  /** Read-only texts cannot be edited; the end of editing completes a new node. */
  private guardEditing(): void {
    const jm = this.jm;
    const beginEdit = jm.begin_edit.bind(jm);
    jm.begin_edit = (id: string) => {
      const node = jm.get_node(id);
      if (node && node.data.readOnly) return;
      beginEdit(id);
      // jsMind sizes the editor to the node (a new node's "…" is tiny): let the CSS size it.
      jm.view.e_editor.style.width = '';
    };
    const view = jm.view;
    const editNodeEnd = view.edit_node_end.bind(view);
    view.edit_node_end = () => {
      const node = view.editing_node;
      editNodeEnd();
      if (node && node.id === PENDING_ID) this.completeNewNode(node);
    };
    // jsMind ends editing on Enter by the legacy `keyCode` 13 only; virtual keyboards
    // (Android) and synthetic events may leave it at 0 or 229, while `key` is reliable.
    view.e_editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.keyCode !== 13) view.edit_node_end();
    });
    const selectClear = jm.select_clear.bind(jm);
    jm.select_clear = () => {
      selectClear();
      this.bridge?.select(null); // jsMind emits no event for this
    };
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

  /** Text, plus marks for CSS: lock (text not editable), dot (hidden content), new node. */
  private render(element: HTMLElement, node: JmNode): boolean {
    element.textContent = node.topic;
    element.classList.toggle('mapling-locked', !!node.data.readOnly);
    element.classList.toggle('mapling-hidden-content', !!node.data.hidden);
    element.classList.toggle('mapling-pending', !!node.data.pending);
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
      const cousins = layout._should_reserve_cousin_space(node) ? cousin_space / 2 : 0;
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

function side(node: JmNode): Side {
  return node.direction === -1 ? 'left' : 'right';
}

