// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The core side of the contract in docs/BRIDGE.md: JSON messages with the shell.
// Platform-neutral: the shell's `send` function and the view are passed in.

import { MapError } from './errors.ts';
import type { BranchSummary, HiddenKind, MindMap, ViewNode } from './map.ts';
import { MapSession } from './session.ts';

export const PROTOCOL_VERSION = 1;
export const CORE_VERSION = '1.0.0';

/**
 * A draft is sent this long after the first change not yet sent; later changes
 * do not postpone it. So drafts are at most one per period, and never later.
 */
export const DRAFT_DELAY_MS = 1000;

export type BridgeErrorCode =
  | 'PARSE_ERROR'
  | 'NOT_A_MAP'
  | 'UNSUPPORTED_ENCODING'
  | 'NO_MAP_LOADED'
  | 'PROTOCOL_VERSION'
  | 'OUTDATED_COMMAND'
  | 'MAP_MODIFIED'
  | 'INTERNAL';

export type WarningCode = 'FORMAT_TOO_OLD' | 'FORMAT_TOO_NEW' | 'DUPLICATE_IDS';

/** Editing commands from the shell's menu; each names its target node. */
export type Command = 'editText' | 'addChild' | 'addSibling' | 'deleteNode';

/** What the shell needs to know about the selected node to enable its commands. */
export interface SelectedNode {
  id: string;
  /** Revision of the map this report describes; `deleteNode` sends it back. */
  revision: number;
  root: boolean;
  textEditable: boolean;
  /** Content of this node that is not displayed, by kind (what its dot stands for). */
  hidden: Partial<Record<HiddenKind, number>>;
  branch: BranchSummary;
}

/** Messages from the shell. */
export type ShellMessage = { v: number; requestId?: string } & (
  | {
      type: 'load';
      name: string;
      data: string;
      readOnly?: boolean;
      restoredDraft?: boolean;
      locale?: string;
      onlyIfUnmodified?: boolean;
    }
  | { type: 'flushDraft' }
  | { type: 'save' }
  | { type: 'saved'; saveId: number }
  | { type: 'setReadOnly'; readOnly: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'center' }
  | { type: Command; id: string; revision?: number }
);

/** Messages to the shell (`v` is added when sending). */
export type CoreMessage =
  | { type: 'ready'; coreVersion: string }
  | {
      type: 'loaded';
      requestId?: string;
      nodeCount: number;
      readOnlyNodes: number;
      readOnly: boolean;
      mapVersion: string;
      title: string;
      hiddenContent: HiddenKind[];
      warnings: { code: WarningCode }[];
    }
  | { type: 'titleChanged'; title: string }
  | { type: 'saveData'; requestId?: string; saveId: number; data: string }
  | { type: 'dirtyChanged'; dirty: boolean }
  | { type: 'draftData'; revision: number; data: string | null }
  | { type: 'historyChanged'; canUndo: boolean; canRedo: boolean }
  | { type: 'selectionChanged'; node: SelectedNode | null }
  | { type: 'error'; requestId?: string; code: BridgeErrorCode; message: string };

/** What the bridge needs from the display (the jsMind adapter, or a fake in tests). */
export interface View {
  /**
   * Displays the map. `keepViewState` is true when the same map is shown again
   * (undo, redo): folding, selection and scroll position are then kept.
   */
  show(root: ViewNode, readOnly: boolean, keepViewState: boolean): void;
  setReadOnly(readOnly: boolean): void;
  /** Runs a menu command on an existing node (never called when the map is read-only). */
  command(name: Command, key: string): void;
  /** Scrolls so that this node, or the root when null, is in the middle of the view. */
  center(key: string | null): void;
  /** Whether a text is being typed, not validated yet: the map does not hold it. */
  editing(): boolean;
}

class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class Bridge {
  private readonly send: (json: string) => void;
  private readonly view: View;
  private session: MapSession | null = null;
  private shellReadOnly = false;
  /** The user's language, for the texts Freeplane provides itself (e.g. a new map's root). */
  private locale = 'en';
  /** Revision held by the content of each save not yet confirmed, by saveId. */
  private readonly pendingSaves = new Map<number, number>();
  /** Save identities come from the core, never reused, even across maps. */
  private lastSaveId = 0;
  private reported = { dirty: false, canUndo: false, canRedo: false };
  private reportedTitle: string | null = null; // the root's text, last told to the shell
  /** Revision of the last draft sent (not necessarily written: the shell owns that); null when none. */
  private draftRevision: number | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  /** Key of the node selected in the view, and what was last reported about it. */
  private selectedKey: string | null = null;
  private reportedSelection = 'null'; // as JSON, to compare with the next report

  constructor(send: (json: string) => void, view: View) {
    this.send = send;
    this.view = view;
  }

  /** Tells the shell that the core is ready to receive messages. */
  start(): void {
    this.post({ type: 'ready', coreVersion: CORE_VERSION });
  }

  /** Entry point for the shell (window.MindCore.receive). */
  receive(json: string): void {
    let message: ShellMessage | undefined;
    try {
      message = JSON.parse(json) as ShellMessage;
      if (message.v !== PROTOCOL_VERSION) {
        throw new BridgeError('PROTOCOL_VERSION', `Unsupported protocol version: ${message.v}`);
      }
      this.handle(message);
    } catch (error) {
      this.post({ type: 'error', requestId: message?.requestId, ...describe(error) });
    }
    this.reportState();
  }

  /** The whole map is read-only, because of the file or at the shell's request. */
  get readOnly(): boolean {
    return !!this.session && (this.session.map.readOnly || this.shellReadOnly);
  }

  /** The root's text, as displayed: shells show it with the file's name. */
  private title(): string | null {
    return this.session ? this.session.map.text(this.session.map.rootKey, this.locale) : null;
  }

  /** What the view displays for the open map, in the user's language. */
  projection(): ViewNode | null {
    return this.session ? this.session.map.toView(this.locale) : null;
  }

  /** The open map, for the view adapter; null before the first successful load. */
  get current(): MapSession | null {
    return this.session;
  }

  /** Records the node selected in the view (null: none); the shell is told what it can do with it. */
  select(key: string | null): void {
    this.selectedKey = key;
    this.reportState();
  }

  /** Applies an edit coming from the view, then reports the new state to the shell. */
  edit<T>(operation: (map: MindMap) => T): T {
    const session = this.session;
    if (!session) throw new MapError('UNKNOWN_NODE', 'No map loaded');
    if (this.readOnly) throw new MapError('READ_ONLY_MAP', 'The map is read-only');
    const result = session.edit(operation);
    this.reportState();
    return result;
  }

  private handle(message: ShellMessage): void {
    switch (message.type) {
      case 'load':
        if (message.onlyIfUnmodified) return this.loadIfUnmodified(message);
        return this.load(message.requestId, message.data, !!message.readOnly, !!message.restoredDraft, message.locale);
      case 'flushDraft':
        // Always answered: the core cannot know whether the last draft reached the disk.
        if (this.session) this.sendDraft();
        return;
      case 'save':
        return this.save(message.requestId);
      case 'saved':
        return this.saved(message.saveId);
      case 'setReadOnly':
        this.shellReadOnly = !!message.readOnly;
        if (this.session) this.view.setReadOnly(this.readOnly);
        return;
      case 'undo':
      case 'redo':
        return this.history(message.type);
      case 'center':
        // Not an edit: also available on a read-only map.
        if (this.session) this.view.center(this.selection()?.id ?? null);
        return;
      case 'editText':
      case 'addChild':
      case 'addSibling':
      case 'deleteNode':
        return this.command(message.type, message.id, message.revision);
      default:
        throw new BridgeError('INTERNAL', `Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Replaces the map only if nothing would be lost: not modified, and no text being typed.
   * Decided in a later task: jsMind reports a validated text a moment later (setTimeout 0),
   * and the map is modified only then; reports already on their way come first.
   */
  private loadIfUnmodified(message: ShellMessage & { type: 'load' }): void {
    setTimeout(() => {
      try {
        if (this.session?.dirty || this.view.editing()) {
          throw new BridgeError('MAP_MODIFIED', 'The open map is modified or a text is being edited');
        }
        this.load(message.requestId, message.data, !!message.readOnly, !!message.restoredDraft, message.locale);
      } catch (error) {
        this.post({ type: 'error', requestId: message.requestId, ...describe(error) });
      }
      this.reportState();
    }, 0);
  }

  private load(
    requestId: string | undefined,
    data: string,
    readOnly: boolean,
    restoredDraft: boolean,
    locale: string | undefined,
  ): void {
    // A failed load leaves the open map and its pending saves untouched.
    // Revisions continue from the previous map: a revision then designates one map
    // and one state, so a deletion confirmed on a map cannot apply to its reloaded
    // version, even with the same IDs.
    const firstRevision = this.session ? this.session.lastCreatedRevision + 1 : 0;
    const session = new MapSession(decode(data), firstRevision);
    this.session = session;
    this.shellReadOnly = readOnly;
    this.locale = locale ?? 'en';
    // Confirmations of saves and drafts from the previous map no longer apply to anything.
    this.pendingSaves.clear();
    this.cancelDraftTimer();
    this.draftRevision = null;
    if (restoredDraft) {
      session.markUnsaved(); // the map differs from the file
      this.draftRevision = session.revision; // and the shell already holds this draft
    }
    const map = session.map;
    const warnings: { code: WarningCode }[] = [];
    if (map.formatStatus === 'too-old') warnings.push({ code: 'FORMAT_TOO_OLD' });
    if (map.formatStatus === 'too-new') warnings.push({ code: 'FORMAT_TOO_NEW' });
    if (map.hasDuplicateIds) warnings.push({ code: 'DUPLICATE_IDS' });
    // The new map starts with no selection, even if it shares IDs with the previous one;
    // the view reports its own selection, if any, while showing the map.
    this.selectedKey = null;
    this.view.show(map.toView(this.locale), this.readOnly, false);
    this.reportedTitle = map.text(map.rootKey, this.locale);
    this.post({
      type: 'loaded',
      requestId,
      nodeCount: map.nodeCount,
      readOnlyNodes: map.readOnlyNodeCount,
      readOnly: this.readOnly,
      mapVersion: map.mapVersion,
      title: this.reportedTitle,
      hiddenContent: map.hiddenContent(),
      warnings,
    });
  }

  private save(requestId: string | undefined): void {
    if (!this.session) throw new BridgeError('NO_MAP_LOADED', 'No map loaded');
    const data = encode(this.session.map.serialize());
    const saveId = ++this.lastSaveId;
    this.pendingSaves.set(saveId, this.session.revision);
    this.post({ type: 'saveData', requestId, saveId, data });
  }

  /** The file now holds the revision of that save; the map stays modified if it changed since. */
  private saved(saveId: number): void {
    const revision = this.pendingSaves.get(saveId);
    // Unknown, already confirmed, or from a previous map: nothing to record.
    if (revision === undefined || !this.session) return;
    this.pendingSaves.delete(saveId);
    this.session.markSaved(revision);
  }

  /**
   * A command names its target, so that a selection change cannot redirect it.
   * A deletion also names the revision its confirmation was based on: if the
   * map changed since, what the user confirmed may no longer be what would go.
   */
  private command(name: Command, key: string, revision: number | undefined): void {
    const session = this.session;
    if (!session) throw new BridgeError('NO_MAP_LOADED', 'No map loaded');
    if (this.readOnly) return;
    if (!session.map.has(key)) throw new BridgeError('OUTDATED_COMMAND', `Unknown node: ${key}`);
    if (name === 'deleteNode' && revision !== session.revision) {
      throw new BridgeError('OUTDATED_COMMAND', 'The map changed since the deletion was confirmed');
    }
    this.view.command(name, key);
  }

  private history(direction: 'undo' | 'redo'): void {
    const session = this.session;
    if (!session || this.readOnly) return;
    if (direction === 'undo' ? session.undo() : session.redo()) {
      this.view.show(session.map.toView(this.locale), this.readOnly, true);
    }
  }

  /** Sends dirtyChanged and historyChanged when, and only when, they change. */
  private reportState(): void {
    const session = this.session;
    const editable = !!session && !this.readOnly;
    const now = {
      dirty: !!session && session.dirty,
      canUndo: editable && session.canUndo,
      canRedo: editable && session.canRedo,
    };
    if (now.dirty !== this.reported.dirty) this.post({ type: 'dirtyChanged', dirty: now.dirty });
    if (now.canUndo !== this.reported.canUndo || now.canRedo !== this.reported.canRedo) {
      this.post({ type: 'historyChanged', canUndo: now.canUndo, canRedo: now.canRedo });
    }
    this.reported = now;
    const title = this.title();
    if (title !== null && title !== this.reportedTitle) {
      this.reportedTitle = title;
      this.post({ type: 'titleChanged', title });
    }
    this.updateDraft();
    this.reportSelection();
  }

  /** Sends selectionChanged when what the shell knows about the selection changes. */
  private reportSelection(): void {
    const node = this.selection();
    const json = JSON.stringify(node);
    if (json === this.reportedSelection) return;
    this.reportedSelection = json;
    this.post({ type: 'selectionChanged', node });
  }

  private selection(): SelectedNode | null {
    const session = this.session;
    const key = this.selectedKey;
    if (!session || key === null || !session.map.has(key)) return null;
    const map = session.map;
    return {
      id: key,
      revision: session.revision,
      root: key === map.rootKey,
      textEditable: !this.readOnly && !map.isReadOnly(key),
      hidden: map.nodeHidden(key),
      branch: map.branchSummary(key),
    };
  }

  // ---------- drafts (see "Drafts" in docs/BRIDGE.md) ----------

  /** After a change: schedules a draft, or deletes it when the map is no longer modified. */
  private updateDraft(): void {
    const session = this.session;
    if (!session) return;
    if (!session.dirty) {
      this.cancelDraftTimer(); // nothing to protect any more
      if (this.draftRevision !== null) this.sendDraft(); // tells the shell to delete it
      return;
    }
    // Already sent, or already scheduled: a scheduled draft will carry the latest state.
    if (session.revision === this.draftRevision || this.draftTimer) return;
    this.draftTimer = setTimeout(() => this.sendDraft(), DRAFT_DELAY_MS);
  }

  /** Sends the current state as a draft, or `null` (delete it) when the map is not modified. */
  private sendDraft(): void {
    this.cancelDraftTimer();
    const session = this.session as MapSession;
    const data = session.dirty ? encode(session.map.serialize()) : null;
    this.draftRevision = data === null ? null : session.revision;
    this.post({ type: 'draftData', revision: session.revision, data });
  }

  private cancelDraftTimer(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
  }

  private post(message: CoreMessage): void {
    this.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
  }
}

function describe(error: unknown): { code: BridgeErrorCode; message: string } {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  if (error instanceof MapError && (error.code === 'PARSE_ERROR' || error.code === 'NOT_A_MAP')) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof SyntaxError) return { code: 'INTERNAL', message: `Invalid JSON: ${error.message}` };
  return { code: 'INTERNAL', message: String(error) };
}

// ---------- bytes <-> text ----------

/**
 * Decodes the file's bytes. Only UTF-8 is supported, which is what Freeplane
 * writes; a byte order mark is kept so that it is written back.
 */
function decode(base64: string): string {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new BridgeError('PARSE_ERROR', 'The file data is not valid base64');
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new BridgeError('UNSUPPORTED_ENCODING', 'UTF-16 is not supported');
  }
  const declared = /^(?:\xef\xbb\xbf)?<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/.exec(binary.slice(0, 200));
  if (declared && !/^utf-?8$/i.test(declared[1])) {
    throw new BridgeError('UNSUPPORTED_ENCODING', `Unsupported encoding: ${declared[1]}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BridgeError('UNSUPPORTED_ENCODING', 'The file is not valid UTF-8');
  }
}

function encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
