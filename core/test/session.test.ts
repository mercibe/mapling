// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MapSession, HISTORY_LIMIT, MapError } from '../src/index.ts';

const A = 'ID_27769489';
const C = 'ID_233098983';
const E = 'ID_1469196726';
const original = fixture('fixture01.mm');

test('each undo gives back exactly the previous serialized state, and redo the next', () => {
  const session = new MapSession(original);
  const states = [session.map.serialize()];
  session.edit((m) => m.updateText(A, 'one', 1));
  states.push(session.map.serialize());
  session.edit((m) => m.addNode(C, 0, 'two', 'right', 2));
  states.push(session.map.serialize());
  session.edit((m) => m.moveNode(A, E, 0));
  states.push(session.map.serialize());
  session.edit((m) => m.removeNode(C));
  states.push(session.map.serialize());

  for (let i = states.length - 2; i >= 0; i--) {
    assert.equal(session.undo(), true);
    assert.equal(session.map.serialize(), states[i]);
  }
  assert.equal(session.map.serialize(), original);
  assert.equal(session.undo(), false);
  for (let i = 1; i < states.length; i++) {
    assert.equal(session.redo(), true);
    assert.equal(session.map.serialize(), states[i]);
  }
  assert.equal(session.redo(), false);
});

test('an edit after undo clears the redo history', () => {
  const session = new MapSession(original);
  session.edit((m) => m.updateText(A, 'one', 1));
  session.undo();
  assert.equal(session.canRedo, true);
  session.edit((m) => m.updateText(A, 'other', 2));
  assert.equal(session.canRedo, false);
});

test('an operation that changes nothing is not recorded', () => {
  const session = new MapSession(original);
  assert.equal(session.edit((m) => m.updateText(A, 'A : first level child', 1)), false);
  assert.equal(session.canUndo, false);
  assert.equal(session.dirty, false);
});

test('a failing operation leaves the map as it was', () => {
  const session = new MapSession(original);
  assert.throws(() => session.edit((m) => {
    m.updateText(A, 'changed', 1);
    m.moveNode(E, E, 0); // refused after a first change in the same operation
  }), (e) => e instanceof MapError && e.code === 'INVALID_OPERATION');
  assert.equal(session.map.serialize(), original);
  assert.equal(session.canUndo, false);
});

test('dirty follows revisions: undoing back to the saved state makes the map unmodified', () => {
  const session = new MapSession(original);
  assert.equal(session.dirty, false);
  session.edit((m) => m.updateText(A, 'one', 1));
  session.markSaved(session.revision);
  assert.equal(session.dirty, false);
  session.edit((m) => m.updateText(A, 'two', 2));
  assert.equal(session.dirty, true);
  session.undo();
  assert.equal(session.dirty, false); // back to the saved revision
  session.undo();
  assert.equal(session.dirty, true); // before the saved revision
  session.redo();
  assert.equal(session.dirty, false);
});

test('a new edit never reuses the revision of an undone one', () => {
  const session = new MapSession(original);
  session.edit((m) => m.updateText(A, 'one', 1));
  const saved = session.revision;
  session.markSaved(saved);
  session.undo();
  session.edit((m) => m.updateText(A, 'other', 2));
  assert.notEqual(session.revision, saved);
  assert.equal(session.dirty, true);
});

test(`the history keeps the last ${HISTORY_LIMIT} changes`, () => {
  const session = new MapSession(original);
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) session.edit((m) => m.updateText(A, `t${i}`, i));
  let undone = 0;
  while (session.undo()) undone++;
  assert.equal(undone, HISTORY_LIMIT);
  assert.equal(session.map.text(A), 't4');
});
