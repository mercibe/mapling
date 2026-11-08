// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// An open map with its edit history. Every change creates a new revision; the
// map is "modified" when its revision differs from the last saved one. Undo keeps
// the serialized state before each change and reloads it: exact, with no inverse
// operation to write per case.

import { MindMap } from './map.ts';

interface State {
  text: string;
  revision: number;
}

export const HISTORY_LIMIT = 50;

export class MapSession {
  private current: MindMap;
  private revisionNow: number;
  private lastRevision: number;
  private savedRevision: number;
  private readonly undoStack: State[] = [];
  private readonly redoStack: State[] = [];

  /**
   * `firstRevision` lets successive sessions continue one numbering, so that a
   * revision never designates two different maps (see Bridge.load).
   */
  constructor(text: string, firstRevision = 0) {
    this.current = new MindMap(text);
    this.revisionNow = this.lastRevision = this.savedRevision = firstRevision;
  }

  get map(): MindMap {
    return this.current;
  }

  get revision(): number {
    return this.revisionNow;
  }

  /** The highest revision this session has created; the next session starts after it. */
  get lastCreatedRevision(): number {
    return this.lastRevision;
  }

  get dirty(): boolean {
    return this.revisionNow !== this.savedRevision;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Runs an operation on the map and records it in the history if it changed
   * anything. If it fails, the map is restored to its state before the call.
   */
  edit<T>(operation: (map: MindMap) => T): T {
    const before = this.current.serialize();
    let result: T;
    try {
      result = operation(this.current);
    } catch (error) {
      this.current = new MindMap(before);
      throw error;
    }
    if (this.current.serialize() !== before) {
      this.undoStack.push({ text: before, revision: this.revisionNow });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack.length = 0;
      this.revisionNow = ++this.lastRevision;
    }
    return result;
  }

  /** Returns false when there is nothing to undo. */
  undo(): boolean {
    return this.restore(this.undoStack, this.redoStack);
  }

  /** Returns false when there is nothing to redo. */
  redo(): boolean {
    return this.restore(this.redoStack, this.undoStack);
  }

  /** Records that the file now holds this revision (see `saved` in docs/BRIDGE.md). */
  markSaved(revision: number): void {
    this.savedRevision = revision;
  }

  /** Records that the file holds none of the revisions, e.g. after restoring a draft. */
  markUnsaved(): void {
    this.savedRevision = -1;
  }

  private restore(from: State[], to: State[]): boolean {
    const state = from.pop();
    if (!state) return false;
    to.push({ text: this.current.serialize(), revision: this.revisionNow });
    this.current = new MindMap(state.text);
    this.revisionNow = state.revision;
    return true;
  }
}
