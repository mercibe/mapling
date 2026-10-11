// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// A Freeplane map. The parsed DOM is the only source of truth: operations change
// just the elements and attributes they touch, everything else stays as loaded.

import { MapError } from './errors.ts';
import { formatStatus, type FormatStatus } from './format.ts';
import { htmlToText } from './html-text.ts';
import { localizedText } from './localized-text.ts';
import { parseXml, serializeXml, type Envelope } from './xml.ts';

export type Side = 'left' | 'right';

/** Kinds of content kept in the file but not displayed (formatting is not reported). */
export type HiddenKind = 'note' | 'details' | 'attribute' | 'link' | 'icon' | 'connector' | 'image';

/** All hidden kinds, in the order in which lists of kinds are given. */
const HIDDEN_KINDS: HiddenKind[] = ['note', 'details', 'attribute', 'link', 'icon', 'connector', 'image'];

function kinds(counts: Partial<Record<HiddenKind, number>>): HiddenKind[] {
  return HIDDEN_KINDS.filter((kind) => kind in counts);
}

/** The same counts, with kinds in the usual order. */
function ordered(counts: Partial<Record<HiddenKind, number>>): Partial<Record<HiddenKind, number>> {
  const result: Partial<Record<HiddenKind, number>> = {};
  for (const kind of kinds(counts)) result[kind] = counts[kind];
  return result;
}

/** What a branch holds, to confirm its deletion: descendant nodes and hidden content. */
export interface BranchSummary {
  descendants: number;
  hidden: Partial<Record<HiddenKind, number>>;
}

/** Projection of a node for the view (jsMind `node_tree` format). */
export interface ViewNode {
  id: string;
  topic: string;
  expanded: boolean;
  direction?: Side; // children of the root only
  readOnly?: boolean; // the text cannot be edited; the node can still be moved or deleted
  hidden?: HiddenKind[]; // content of this node that is not displayed
  children: ViewNode[];
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Freeplane 1.12 values of POSITION; older formats (read-only) use left/right.
const POSITION = { left: 'top_or_left', right: 'bottom_or_right' } as const;

function childElements(el: Element, tagName: string): Element[] {
  const result: Element[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === ELEMENT_NODE && (child as Element).tagName === tagName) {
      result.push(child as Element);
    }
  }
  return result;
}

function isWhitespace(n: Node | null): boolean {
  return !!n && n.nodeType === TEXT_NODE && /^\s*$/.test(n.nodeValue ?? '');
}

export class MindMap {
  readonly mapVersion: string;
  readonly formatStatus: FormatStatus;
  /** Two <node> elements share an ID: editing could hit the wrong node, so the map is read-only. */
  readonly hasDuplicateIds: boolean;
  private readonly doc: Document;
  private readonly envelope: Envelope;
  private readonly rootEl: Element;
  private readonly byKey = new Map<string, Element>();
  private readonly keyOf = new WeakMap<Element, string>();
  private syntheticCount = 0;
  private duplicateCount = 0;
  private idsAtLoad?: Set<string>;

  constructor(text: string) {
    const { doc, envelope } = parseXml(text);
    const rootEl = childElements(doc.documentElement, 'node')[0];
    if (doc.documentElement.tagName !== 'map' || !rootEl) {
      throw new MapError('NOT_A_MAP', 'No <map> element with a root <node>');
    }
    this.doc = doc;
    this.envelope = envelope;
    this.rootEl = rootEl;
    this.mapVersion = doc.documentElement.getAttribute('version') ?? '';
    this.formatStatus = formatStatus(this.mapVersion);
    this.indexSubtree(rootEl);
    this.hasDuplicateIds = this.duplicateCount > 0;
  }

  /** The whole map is read-only when its format version is not supported or its IDs are not unique. */
  get readOnly(): boolean {
    return this.formatStatus !== 'supported' || this.hasDuplicateIds;
  }

  get rootKey(): string {
    return this.key(this.rootEl);
  }

  get nodeCount(): number {
    return this.byKey.size;
  }

  get readOnlyNodeCount(): number {
    let count = 0;
    for (const el of this.byKey.values()) if (this.isReadOnlyElement(el)) count++;
    return count;
  }

  serialize(): string {
    return serializeXml(this.doc, this.envelope);
  }

  // ---------- reading ----------

  /** Whether a node with this key exists in the map. */
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /**
   * Text of a node, as displayed: rich (HTML) nodes as plain text, and texts that
   * Freeplane provides itself (LOCALIZED_TEXT) in the given language.
   */
  text(key: string, locale = 'en'): string {
    const el = this.element(key);
    const rich = this.richContent(el);
    if (rich) return htmlToText(rich);
    const text = el.getAttribute('TEXT');
    if (text !== null) return text;
    const localized = el.getAttribute('LOCALIZED_TEXT');
    return localized === null ? '' : localizedText(localized, locale);
  }

  /** A node is read-only when editing its text with a single-line editor would lose information. */
  isReadOnly(key: string): boolean {
    return this.readOnly || this.isReadOnlyElement(this.element(key));
  }

  parentKey(key: string): string | null {
    const parent = this.element(key).parentNode as Element;
    return parent === this.doc.documentElement ? null : this.key(parent);
  }

  childKeys(key: string): string[] {
    return childElements(this.element(key), 'node').map((el) => this.key(el));
  }

  /** Projection for the view. FOLDED is read here and never written (folding is in memory only). */
  toView(locale = 'en', key: string = this.rootKey): ViewNode {
    const el = this.element(key);
    const view: ViewNode = {
      id: key,
      topic: this.text(key, locale),
      expanded: el.getAttribute('FOLDED') !== 'true',
      children: this.childKeys(key).map((child) => this.toView(locale, child)),
    };
    if (this.parentKey(key) === this.rootKey) view.direction = this.side(el);
    if (this.isReadOnly(key)) view.readOnly = true;
    const hidden = kinds(this.hiddenCounts([el]));
    if (hidden.length > 0) view.hidden = hidden;
    return view;
  }

  /** Kinds of hidden content present anywhere in the map, for a notice when it opens. */
  hiddenContent(): HiddenKind[] {
    return kinds(this.hiddenCounts([...this.byKey.values()]));
  }

  /** Hidden content carried by the node itself (not its descendants), by kind. */
  nodeHidden(key: string): Partial<Record<HiddenKind, number>> {
    return ordered(this.hiddenCounts([this.element(key)]));
  }

  /**
   * What deleting this node would remove. Connectors count when they start in the
   * branch or point into it from elsewhere (they would be left dangling).
   */
  branchSummary(key: string): BranchSummary {
    const el = this.element(key);
    const branch = [el, ...Array.from(el.getElementsByTagName('node'))];
    const hidden = this.hiddenCounts(branch);
    const ids = new Set(branch.map((n) => n.getAttribute('ID')).filter((id) => id));
    let incoming = 0;
    for (const link of Array.from(this.rootEl.getElementsByTagName('arrowlink'))) {
      const fromBranch = branch.includes(link.parentNode as Element);
      if (!fromBranch && ids.has(link.getAttribute('DESTINATION'))) incoming++;
    }
    if (incoming > 0) hidden.connector = (hidden.connector ?? 0) + incoming;
    return { descendants: branch.length - 1, hidden: ordered(hidden) };
  }

  // ---------- operations ----------

  /** Sets the plain text of a node. Returns false when the text is unchanged. */
  updateText(key: string, text: string, now = Date.now()): boolean {
    this.checkEditable(key);
    const el = this.element(key);
    if (el.getAttribute('TEXT') === text) return false;
    this.ensureId(el);
    if (el.hasAttribute('TEXT')) {
      el.setAttribute('TEXT', text);
    } else {
      // A text Freeplane provided (LOCALIZED_TEXT) becomes the user's own TEXT,
      // at the same place among the attributes, as Freeplane does when renaming it.
      this.setAttributeBefore(el, 'TEXT', text, 'LOCALIZED_TEXT');
      el.removeAttribute('LOCALIZED_TEXT');
    }
    el.setAttribute('MODIFIED', String(now));
    return true;
  }

  /** Adds a node under `parentKey` at `index` among its siblings, and returns its key. */
  addNode(parentKey: string, index: number, text: string, side: Side = 'right', now = Date.now()): string {
    this.checkMapEditable();
    const parent = this.element(parentKey);
    const el = this.doc.createElement('node');
    el.setAttribute('TEXT', text);
    if (parent === this.rootEl) el.setAttribute('POSITION', POSITION[side]);
    el.setAttribute('ID', this.newId());
    el.setAttribute('CREATED', String(now));
    el.setAttribute('MODIFIED', String(now));
    this.insertChild(parent, el, index);
    return this.indexSubtree(el);
  }

  /** Removes a node and its whole subtree. */
  removeNode(key: string): void {
    this.checkMapEditable();
    const el = this.element(key);
    if (el === this.rootEl) throw new MapError('INVALID_OPERATION', 'The root cannot be removed');
    this.detach(el);
    for (const n of [el, ...Array.from(el.getElementsByTagName('node'))]) {
      const k = this.keyOf.get(n);
      if (k) this.byKey.delete(k);
    }
  }

  /**
   * Moves a node under `parentKey`, at `index` among its new siblings (the moved
   * node excluded). `side` applies when the new parent is the root.
   */
  moveNode(key: string, parentKey: string, index: number, side: Side = 'right'): void {
    this.checkMapEditable();
    const el = this.element(key);
    const parent = this.element(parentKey);
    if (el === this.rootEl) throw new MapError('INVALID_OPERATION', 'The root cannot be moved');
    for (let p: Node | null = parent; p; p = p.parentNode) {
      if (p === el) throw new MapError('INVALID_OPERATION', 'A node cannot move into its own subtree');
    }
    this.ensureId(el);
    this.detach(el);
    this.insertChild(parent, el, index);
    if (parent === this.rootEl) {
      this.setAttributeBefore(el, 'POSITION', POSITION[side], 'ID');
    } else {
      el.removeAttribute('POSITION');
    }
  }

  // ---------- internals ----------

  private element(key: string): Element {
    const el = this.byKey.get(key);
    if (!el) throw new MapError('UNKNOWN_NODE', `Unknown node: ${key}`);
    return el;
  }

  private key(el: Element): string {
    const key = this.keyOf.get(el);
    if (!key) throw new MapError('UNKNOWN_NODE', 'Element is not an indexed node');
    return key;
  }

  /** Indexes a node and its descendants; returns the node's key. */
  private indexSubtree(el: Element): string {
    // Nodes without ID (old formats) or with a duplicate ID get an in-memory key;
    // the file is not changed.
    const id = el.getAttribute('ID');
    if (id && this.byKey.has(id)) this.duplicateCount++;
    const key = id && !this.byKey.has(id) ? id : this.syntheticKey();
    this.byKey.set(key, el);
    this.keyOf.set(el, key);
    for (const child of childElements(el, 'node')) this.indexSubtree(child);
    return key;
  }

  /** Counts the hidden content carried by these nodes themselves (not their descendants). */
  private hiddenCounts(nodes: Element[]): Partial<Record<HiddenKind, number>> {
    const counts: Partial<Record<HiddenKind, number>> = {};
    const add = (kind: HiddenKind, n: number) => {
      if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
    };
    for (const el of nodes) {
      const rich = (type: string) => childElements(el, 'richcontent').filter((r) => r.getAttribute('TYPE') === type).length;
      add('note', rich('NOTE'));
      add('details', rich('DETAILS'));
      add('attribute', childElements(el, 'attribute').length);
      add('link', el.hasAttribute('LINK') ? 1 : 0);
      add('icon', childElements(el, 'icon').length);
      add('connector', childElements(el, 'arrowlink').length);
      add('image', childElements(el, 'hook').filter((h) => h.getAttribute('NAME') === 'ExternalObject').length);
      // Rich text is shown as plain text: its images and link targets are not visible.
      const richText = this.richContent(el);
      if (richText) {
        add('image', richText.getElementsByTagName('img').length);
        add('link', Array.from(richText.getElementsByTagName('a')).filter((a) => a.hasAttribute('href')).length);
      }
    }
    return counts;
  }

  private richContent(el: Element): Element | undefined {
    return childElements(el, 'richcontent').find((r) => r.getAttribute('TYPE') === 'NODE');
  }

  private isReadOnlyElement(el: Element): boolean {
    const text = el.getAttribute('TEXT') ?? (el.hasAttribute('LOCALIZED_TEXT') ? '' : null);
    return text === null || text.includes('\n') || !!this.richContent(el);
  }

  private side(el: Element): Side {
    const position = el.getAttribute('POSITION');
    return position === 'left' || position === POSITION.left ? 'left' : 'right';
  }

  /** An in-memory key that is not, and will not become, the ID of any element. */
  private syntheticKey(): string {
    this.idsAtLoad ??= this.allIds(); // later IDs come from newId(), which avoids keys in use
    let key: string;
    do {
      key = `_node_${++this.syntheticCount}`;
    } while (this.idsAtLoad.has(key));
    return key;
  }

  private checkMapEditable(): void {
    if (this.hasDuplicateIds) throw new MapError('READ_ONLY_MAP', 'Duplicate node IDs');
    if (this.readOnly) {
      throw new MapError('READ_ONLY_MAP', `Format version not editable: ${this.mapVersion}`);
    }
  }

  private checkEditable(key: string): void {
    this.checkMapEditable();
    if (this.isReadOnly(key)) throw new MapError('READ_ONLY_NODE', `Read-only node: ${key}`);
  }

  /** Gives a real ID to a modified node that has none, keeping its key valid. */
  private ensureId(el: Element): void {
    if (!el.getAttribute('ID')) el.setAttribute('ID', this.newId());
  }

  /** A new ID in Freeplane's format, unique among all IDs of the document (style nodes included). */
  private newId(): string {
    const used = this.allIds();
    let id: string;
    do {
      id = 'ID_' + Math.floor(Math.random() * 2147483647);
    } while (used.has(id) || this.byKey.has(id));
    return id;
  }

  /** IDs of all elements of the document, style nodes included. */
  private allIds(): Set<string> {
    const ids = new Set<string>();
    for (const el of Array.from(this.doc.getElementsByTagName('*'))) {
      const id = el.getAttribute('ID');
      if (id) ids.add(id);
    }
    return ids;
  }

  // Freeplane writes each <node> on its own line; insertions and removals keep that layout.

  private insertChild(parent: Element, el: Element, index: number): void {
    const siblings = childElements(parent, 'node');
    const before = siblings[index];
    if (before) {
      parent.insertBefore(el, before);
      parent.insertBefore(this.doc.createTextNode('\n'), before);
    } else if (siblings.length > 0) {
      const last = siblings[siblings.length - 1];
      const newline = this.doc.createTextNode('\n');
      parent.insertBefore(newline, last.nextSibling);
      parent.insertBefore(el, newline.nextSibling);
    } else {
      if (!/\n$/.test(parent.lastChild?.nodeValue ?? '')) {
        parent.appendChild(this.doc.createTextNode('\n'));
      }
      parent.appendChild(el);
      parent.appendChild(this.doc.createTextNode('\n'));
    }
  }

  private detach(el: Element): void {
    const parent = el.parentNode as Element;
    if (isWhitespace(el.nextSibling)) parent.removeChild(el.nextSibling as Node);
    parent.removeChild(el);
    // A node left with only whitespace is written back as an empty element, as Freeplane does.
    if (Array.from(parent.childNodes).every(isWhitespace)) {
      while (parent.firstChild) parent.removeChild(parent.firstChild);
    }
  }

  /** Sets an attribute, placing a new one before `beforeName` to follow Freeplane's attribute order. */
  private setAttributeBefore(el: Element, name: string, value: string, beforeName: string): void {
    if (el.hasAttribute(name) || !el.hasAttribute(beforeName)) {
      el.setAttribute(name, value);
      return;
    }
    const attrs = Array.from(el.attributes).map((a) => [a.name, a.value]);
    const at = attrs.findIndex(([n]) => n === beforeName);
    const moved = attrs.slice(at);
    for (const [n] of moved) el.removeAttribute(n);
    el.setAttribute(name, value);
    for (const [n, v] of moved) el.setAttribute(n, v);
  }
}
