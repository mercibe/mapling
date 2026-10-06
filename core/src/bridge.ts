// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The core side of the contract in docs/BRIDGE.md: JSON messages with the shell.
// Platform-neutral: the shell's `send` function and the view are passed in.

import { MapError } from './errors.ts';
import type { HiddenKind, MindMap, ViewNode } from './map.ts';
import { MapSession } from './session.ts';

export const PROTOCOL_VERSION = 1;
export const CORE_VERSION = '0.1.0';

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
  | 'INTERNAL';

export type WarningCode = 'FORMAT_TOO_OLD' | 'FORMAT_TOO_NEW' | 'DUPLICATE_IDS';

/** Messages from the shell. */
export type ShellMessage = { v: number; requestId?: string } & (
  | { type: 'load'; name: string; data: string; readOnly?: boolean; restoredDraft?: boolean }
  | { type: 'flushDraft' }
  | { type: 'save' }
  | { type: 'saved'; saveId: number }
  | { type: 'setReadOnly'; readOnly: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
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
      hiddenContent: HiddenKind[];
      warnings: { code: WarningCode }[];
    }
  | { type: 'saveData'; requestId?: string; saveId: number; data: string }
  | { type: 'dirtyChanged'; dirty: boolean }
  | { type: 'draftData'; revision: number; data: string | null }
  | { type: 'historyChanged'; canUndo: boolean; canRedo: boolean }
  | { type: 'error'; requestId?: string; code: BridgeErrorCode; message: string };

/** What the bridge needs from the display (the jsMind adapter, or a fake in tests). */
export interface View {
  show(root: ViewNode, readOnly: boolean): void;
  setReadOnly(readOnly: boolean): void;
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
  /** Revision held by the content of each save not yet confirmed, by saveId. */
  private readonly pendingSaves = new Map<number, number>();
  /** Save identities come from the core, never reused, even across maps. */
  private lastSaveId = 0;
  private reported = { dirty: false, canUndo: false, canRedo: false };
  /** Revision of the last draft sent (not necessarily written: the shell owns that); null when none. */
  private draftRevision: number | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

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

  /** The open map, for the view adapter; null before the first successful load. */
  get current(): MapSession | null {
    return this.session;
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
        return this.load(message.requestId, message.data, !!message.readOnly, !!message.restoredDraft);
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
      default:
        throw new BridgeError('INTERNAL', `Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  private load(requestId: string | undefined, data: string, readOnly: boolean, restoredDraft: boolean): void {
    // A failed load leaves the open map and its pending saves untouched.
    const session = new MapSession(decode(data));
    this.session = session;
    this.shellReadOnly = readOnly;
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
    this.view.show(map.toView(), this.readOnly);
    this.post({
      type: 'loaded',
      requestId,
      nodeCount: map.nodeCount,
      readOnlyNodes: map.readOnlyNodeCount,
      readOnly: this.readOnly,
      mapVersion: map.mapVersion,
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

  private history(direction: 'undo' | 'redo'): void {
    const session = this.session;
    if (!session || this.readOnly) return;
    if (direction === 'undo' ? session.undo() : session.redo()) {
      this.view.show(session.map.toView(), this.readOnly);
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
    this.updateDraft();
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
