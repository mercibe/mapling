// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Drafts protect unsaved changes if the app is killed (see "Drafts" in docs/BRIDGE.md).
// Time is mocked: a draft is sent DRAFT_DELAY_MS after the first change not yet sent.

import { fixture } from './setup.ts';
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, DRAFT_DELAY_MS } from '../src/index.ts';

const A = 'ID_27769489';
const original = fixture('fixture01.mm');

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

function loaded(options: { restoredDraft?: boolean; text?: string } = {}) {
  const sent: any[] = [];
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), { show() {}, setReadOnly() {}, command() {}, center() {} });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  const data = Buffer.from(options.text ?? original, 'utf8').toString('base64');
  send({ type: 'load', requestId: 'r1', name: 'map.mm', data, restoredDraft: options.restoredDraft });
  const atLoad = sent.splice(0);
  const drafts = () => sent.splice(0).filter((m) => m.type === 'draftData');
  /** Sends `save` and returns the saveId of the resulting saveData. */
  const save = (requestId: string): number => {
    send({ type: 'save', requestId });
    return sent.filter((m) => m.type === 'saveData').at(-1).saveId;
  };
  return { bridge, send, save, drafts, atLoad };
}

const text = (draft: { data: string }) => Buffer.from(draft.data, 'base64').toString('utf8');

test('a draft is sent once the user stops editing for a moment', () => {
  const { bridge, drafts } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  mock.timers.tick(DRAFT_DELAY_MS - 1);
  assert.deepEqual(drafts(), []);
  mock.timers.tick(1);
  const [draft] = drafts();
  assert.equal(draft.revision, bridge.current!.revision);
  assert.equal(text(draft), bridge.current!.map.serialize());
});

test('continuous editing cannot postpone drafts: every change is in a draft within the delay', () => {
  const { bridge, drafts } = loaded();
  const edits: { at: number; revision: number }[] = [];
  const sent: { at: number; revision: number }[] = [];
  for (let now = 0; now <= 4000; now += 100) {
    if (now < 3000 && now % 300 === 0) {
      bridge.edit((m) => m.updateText(A, `edit at ${now}`, now)); // one change every 300 ms for 3 s
      edits.push({ at: now, revision: bridge.current!.revision });
    }
    for (const d of drafts()) sent.push({ at: now, revision: d.revision });
    mock.timers.tick(100);
  }
  assert.ok(sent.length >= 3, 'drafts keep coming during continuous editing');
  for (const edit of edits) {
    const covering = sent.find((d) => d.revision >= edit.revision);
    assert.ok(covering && covering.at - edit.at <= DRAFT_DELAY_MS, `change at ${edit.at} ms saved in time`);
  }
  assert.equal(sent.at(-1)!.revision, bridge.current!.revision, 'the last draft holds the last change');
});

test('flushDraft always answers with the current state, even when nothing changed since', () => {
  const { bridge, send, drafts } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  send({ type: 'flushDraft' });
  const [first] = drafts();
  assert.match(text(first), /TEXT="one"/);
  mock.timers.tick(DRAFT_DELAY_MS);
  assert.deepEqual(drafts(), [], 'the flush replaced the scheduled draft');
  send({ type: 'flushDraft' }); // the shell may have failed to write the previous one
  const [again] = drafts();
  assert.equal(again.revision, first.revision);
  assert.equal(again.data, first.data);
  send({ type: 'undo' });
  drafts();
  send({ type: 'flushDraft' });
  assert.deepEqual(drafts().map((d) => d.data), [null]);
});

test('the draft is deleted when the map is saved or changes are undone', () => {
  const { bridge, send, save, drafts } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  mock.timers.tick(DRAFT_DELAY_MS);
  drafts();
  const saveR2 = save('r2');
  send({ type: 'saved', saveId: saveR2 });
  assert.deepEqual(drafts().map((d) => d.data), [null]);

  bridge.edit((m) => m.updateText(A, 'two', 2));
  mock.timers.tick(DRAFT_DELAY_MS);
  assert.equal(drafts().length, 1);
  send({ type: 'undo' }); // back to the saved state
  assert.deepEqual(drafts().map((d) => d.data), [null]);
});

test('no draft is sent if the map is saved before the delay', () => {
  const { bridge, send, save, drafts } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  const saveR2 = save('r2');
  send({ type: 'saved', saveId: saveR2 });
  mock.timers.tick(DRAFT_DELAY_MS);
  assert.deepEqual(drafts(), []);
});

test('a restored draft is modified from the start, and deleted once saved', () => {
  const draftText = original.replace('A : first level child', 'restored');
  const { bridge, send, save, drafts, atLoad } = loaded({ restoredDraft: true, text: draftText });
  assert.deepEqual(atLoad.map((m) => m.type), ['loaded', 'dirtyChanged']);
  assert.equal(atLoad[1].dirty, true);
  assert.equal(bridge.current!.map.serialize(), draftText);
  mock.timers.tick(DRAFT_DELAY_MS);
  assert.deepEqual(drafts(), [], 'the shell already holds this draft');
  const saveR2 = save('r2');
  send({ type: 'saved', saveId: saveR2 });
  assert.deepEqual(drafts().map((d) => d.data), [null]);
});

test('loading another map cancels a pending draft of the previous one', () => {
  const { bridge, send, drafts } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  send({ type: 'load', requestId: 'r2', name: 'other.mm', data: Buffer.from(original).toString('base64') });
  mock.timers.tick(DRAFT_DELAY_MS);
  assert.deepEqual(drafts(), []);
});
