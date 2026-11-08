// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteDraft, draftKey, draftsNamed, fingerprint, moveDraft, writeDraft } from '../drafts.js';

/** A Web Storage in memory; `failWrites` makes setItem throw, like a full storage. */
class FakeStorage {
  constructor() {
    this.items = new Map();
    this.failWrites = false;
  }
  get length() {
    return this.items.size;
  }
  key(i) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(key) {
    return this.items.has(key) ? this.items.get(key) : null;
  }
  setItem(key, value) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.items.set(key, String(value));
  }
  removeItem(key) {
    this.items.delete(key);
  }
}

const bytes = (text) => new TextEncoder().encode(text);

test('a fingerprint identifies the content, so two files with one name get two keys', async () => {
  assert.equal(
    await fingerprint(bytes('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', // SHA-256("abc")
  );
  const a = draftKey('Projet.mm', await fingerprint(bytes('<map>first</map>')));
  const b = draftKey('Projet.mm', await fingerprint(bytes('<map>second</map>')));
  assert.notEqual(a, b);
});

test('drafts are found by file name; other entries and unreadable ones are ignored', () => {
  const storage = new FakeStorage();
  writeDraft(storage, draftKey('Projet.mm', 'f1'), 'Projet.mm', 'AAA', 1);
  writeDraft(storage, draftKey('Projet.mm', 'f2'), 'Projet.mm', 'BBB', 2);
  writeDraft(storage, draftKey('Autre.mm', 'f3'), 'Autre.mm', 'CCC', 3);
  storage.setItem('mapling.hiddenNotice.Projet.mm', '1');
  storage.setItem(draftKey('Projet.mm', 'broken'), '{not json');
  const found = draftsNamed(storage, 'Projet.mm').map((d) => [d.data, d.savedAt]).sort();
  assert.deepEqual(found, [['AAA', 1], ['BBB', 2]]);
});

test('a null draft deletes it', () => {
  const storage = new FakeStorage();
  const key = draftKey('Projet.mm', 'f1');
  writeDraft(storage, key, 'Projet.mm', 'AAA');
  assert.equal(writeDraft(storage, key, 'Projet.mm', null), true);
  assert.equal(storage.getItem(key), null);
});

test('a failed write is reported, without throwing and without losing the previous draft', () => {
  const storage = new FakeStorage();
  const key = draftKey('Projet.mm', 'f1');
  writeDraft(storage, key, 'Projet.mm', 'OLD', 1);
  storage.failWrites = true;
  assert.equal(writeDraft(storage, key, 'Projet.mm', 'NEW', 2), false);
  assert.equal(JSON.parse(storage.getItem(key)).data, 'OLD');
});

test('moving a draft writes the new copy before deleting the old one', () => {
  const storage = new FakeStorage();
  const from = draftKey('Projet.mm', 'other');
  const to = draftKey('Projet.mm', 'this');
  writeDraft(storage, from, 'Projet.mm', 'CHANGES', 5);
  assert.equal(moveDraft(storage, from, to), true);
  assert.equal(storage.getItem(from), null);
  assert.deepEqual(JSON.parse(storage.getItem(to)), { name: 'Projet.mm', data: 'CHANGES', savedAt: 5 });
});

test('if the new copy cannot be written, the draft stays under its old key', () => {
  const storage = new FakeStorage();
  const from = draftKey('Projet.mm', 'other');
  const to = draftKey('Projet.mm', 'this');
  writeDraft(storage, from, 'Projet.mm', 'CHANGES', 5);
  storage.failWrites = true;
  assert.equal(moveDraft(storage, from, to), false);
  assert.equal(JSON.parse(storage.getItem(from)).data, 'CHANGES');
  assert.equal(storage.getItem(to), null);
});

test('no storage at all: every operation fails quietly', () => {
  assert.equal(writeDraft(null, 'k', 'n', 'x'), false);
  assert.equal(deleteDraft(null, 'k'), false);
  assert.equal(moveDraft(null, 'a', 'b'), false);
  assert.deepEqual(draftsNamed(null, 'n'), []);
});
