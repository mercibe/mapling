// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The bridge is tested as a shell sees it: JSON messages in, JSON messages out.

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, type ViewNode } from '../src/index.ts';

const A = 'ID_27769489';
const original = fixture('fixture01.mm');

function base64(text: string | Uint8Array): string {
  return Buffer.from(typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64');
}

function setup() {
  const sent: any[] = [];
  const view = { shown: [] as ViewNode[], readOnly: [] as boolean[] };
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show: (root) => view.shown.push(root),
    setReadOnly: (readOnly) => view.readOnly.push(readOnly),
  });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  /** Sends `save` and returns the saveId of the resulting saveData. */
  const save = (requestId: string): number => {
    send({ type: 'save', requestId });
    return sent.filter((m) => m.type === 'saveData').at(-1).saveId;
  };
  /** Messages sent by the core since the last call. */
  const take = () => sent.splice(0);
  return { bridge, send, save, take, view };
}

function loaded(text = original) {
  const s = setup();
  s.send({ type: 'load', requestId: 'r1', name: 'map.mm', data: base64(text) });
  s.take();
  return s;
}

test('ready, then load reports the map and shows it', () => {
  const { bridge, send, take, view } = setup();
  bridge.start();
  assert.deepEqual(take(), [{ v: 1, type: 'ready', coreVersion: '0.1.0' }]);
  send({ type: 'load', requestId: 'r1', name: 'fixture01.mm', data: base64(original) });
  assert.deepEqual(take(), [{
    v: 1, type: 'loaded', requestId: 'r1', nodeCount: 8, readOnlyNodes: 2, readOnly: false,
    mapVersion: 'freeplane 1.12.15', hiddenContent: ['note'], warnings: [],
  }]);
  assert.equal(view.shown.length, 1);
  assert.equal(view.shown[0].topic, 'Root node');
});

test('save returns the exact bytes, and saved makes the map unmodified', () => {
  const { bridge, send, save, take } = loaded();
  save('r2');
  const [saveData] = take();
  assert.equal(saveData.type, 'saveData');
  assert.equal(typeof saveData.saveId, 'number');
  assert.equal(Buffer.from(saveData.data, 'base64').toString('utf8'), original);

  bridge.edit((m) => m.updateText(A, 'changed', 1));
  assert.deepEqual(take(), [
    { v: 1, type: 'dirtyChanged', dirty: true },
    { v: 1, type: 'historyChanged', canUndo: true, canRedo: false },
  ]);
  const saveR3 = save('r3');
  take();
  send({ type: 'saved', saveId: saveR3 });
  assert.deepEqual(take(), [{ v: 1, type: 'dirtyChanged', dirty: false }]);
});

test('an edit made while a save is written keeps the map modified', () => {
  const { bridge, send, save, take } = loaded();
  bridge.edit((m) => m.updateText(A, 'first', 1));
  const saveR2 = save('r2'); // holds "first"
  take();
  bridge.edit((m) => m.updateText(A, 'second', 2)); // user edits during the write
  take();
  send({ type: 'saved', saveId: saveR2 });
  assert.deepEqual(take(), [], 'must stay dirty: "second" is not in the file');
  assert.equal(bridge.current!.dirty, true);
  const saveR3 = save('r3');
  take();
  send({ type: 'saved', saveId: saveR3 });
  assert.deepEqual(take(), [{ v: 1, type: 'dirtyChanged', dirty: false }]);
});

test('a save confirmed after another map was opened is ignored', () => {
  const { bridge, send, save, take } = loaded();
  bridge.edit((m) => m.updateText(A, 'first', 1));
  const saveR2 = save('r2');
  send({ type: 'load', requestId: 'r3', name: 'other.mm', data: base64(fixture('fixture02-specialChars.mm')) });
  take();
  bridge.edit((m) => m.updateText('ID_1690683192', 'edited in the new map', 3));
  take();
  send({ type: 'saved', saveId: saveR2 });
  assert.deepEqual(take(), []);
  assert.equal(bridge.current!.dirty, true);
});

test('undo and redo update the view, the history and the modified state', () => {
  const { bridge, send, take, view } = loaded();
  bridge.edit((m) => m.updateText(A, 'changed', 1));
  take();
  send({ type: 'undo' });
  assert.deepEqual(take(), [
    { v: 1, type: 'dirtyChanged', dirty: false },
    { v: 1, type: 'historyChanged', canUndo: false, canRedo: true },
  ]);
  assert.equal(view.shown.at(-1)!.children[0].topic, 'A : first level child');
  send({ type: 'redo' });
  assert.deepEqual(take(), [
    { v: 1, type: 'dirtyChanged', dirty: true },
    { v: 1, type: 'historyChanged', canUndo: true, canRedo: false },
  ]);
  assert.equal(view.shown.at(-1)!.children[0].topic, 'changed');
  send({ type: 'redo' }); // nothing to redo: ignored
  assert.deepEqual(take(), []);
});

test('setReadOnly blocks edits and history until lifted', () => {
  const { bridge, send, take, view } = loaded();
  bridge.edit((m) => m.updateText(A, 'changed', 1));
  take();
  send({ type: 'setReadOnly', readOnly: true });
  assert.deepEqual(take(), [{ v: 1, type: 'historyChanged', canUndo: false, canRedo: false }]);
  assert.deepEqual(view.readOnly, [true]);
  assert.throws(() => bridge.edit((m) => m.updateText(A, 'again', 2)));
  send({ type: 'undo' });
  assert.equal(bridge.current!.map.text(A), 'changed');
  send({ type: 'setReadOnly', readOnly: false });
  assert.deepEqual(take(), [{ v: 1, type: 'historyChanged', canUndo: true, canRedo: false }]);
});

test('a map that is read-only because of its file stays so', () => {
  const { send, take } = setup();
  send({ type: 'load', requestId: 'r1', name: 'old.mm', data: base64('<map version="0.9.0">\n<node TEXT="r"/>\n</map>\n') });
  const [message] = take();
  assert.equal(message.readOnly, true);
  assert.deepEqual(message.warnings, [{ code: 'FORMAT_TOO_OLD' }]);
  send({ type: 'setReadOnly', readOnly: false });
  send({ type: 'load', requestId: 'r2', name: 'dup.mm', data: base64(
    '<map version="freeplane 1.12.15">\n<node TEXT="r" ID="ID_1">\n<node TEXT="a" ID="ID_2"/>\n<node TEXT="b" ID="ID_2"/>\n</node>\n</map>\n') });
  assert.deepEqual(take()[0].warnings, [{ code: 'DUPLICATE_IDS' }]);
});

test('errors carry the bridge codes and the request id', () => {
  const { send, take, bridge } = setup();
  const errorOf = (message: object | string) => {
    if (typeof message === 'string') bridge.receive(message);
    else send(message);
    const [reply] = take();
    return [reply.type, reply.code, reply.requestId];
  };
  assert.deepEqual(errorOf('not json'), ['error', 'INTERNAL', undefined]);
  assert.deepEqual(errorOf({ v: 2, type: 'save', requestId: 'r1' }), ['error', 'PROTOCOL_VERSION', 'r1']);
  assert.deepEqual(errorOf({ type: 'save', requestId: 'r2' }), ['error', 'NO_MAP_LOADED', 'r2']);
  assert.deepEqual(errorOf({ type: 'nope', requestId: 'r3' }), ['error', 'INTERNAL', 'r3']);
  const load = (data: string) => errorOf({ type: 'load', requestId: 'r4', name: 'x.mm', data });
  assert.deepEqual(load('%%%'), ['error', 'PARSE_ERROR', 'r4']);
  assert.deepEqual(load(base64('<map><node>')), ['error', 'PARSE_ERROR', 'r4']);
  assert.deepEqual(load(base64('<html/>')), ['error', 'NOT_A_MAP', 'r4']);
  assert.deepEqual(load(base64('<?xml version="1.0" encoding="ISO-8859-1"?><map/>')), ['error', 'UNSUPPORTED_ENCODING', 'r4']);
  assert.deepEqual(load(base64(new Uint8Array([0x3c, 0x6d, 0xe9, 0x3e]))), ['error', 'UNSUPPORTED_ENCODING', 'r4']);
  assert.deepEqual(load(base64(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))), ['error', 'UNSUPPORTED_ENCODING', 'r4']);
});

test('a failed load keeps the open map', () => {
  const { bridge, send, take } = loaded();
  bridge.edit((m) => m.updateText(A, 'kept', 1));
  take();
  send({ type: 'load', requestId: 'r2', name: 'bad.mm', data: base64('<map>') });
  assert.equal(take()[0].code, 'PARSE_ERROR');
  assert.equal(bridge.current!.map.text(A), 'kept');
  assert.equal(bridge.current!.dirty, true);
});

test('a byte order mark and an XML declaration are written back', () => {
  const text = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n' + original;
  const { send, save, take } = loaded(text);
  save('r2');
  const bytes = Buffer.from(take()[0].data, 'base64');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), text);
});

test('a reused requestId cannot confirm a save it did not produce', () => {
  const { bridge, save, send, take } = loaded();
  bridge.edit((m) => m.updateText(A, 'first', 1));
  const first = save('same'); // file being written with "first"
  bridge.edit((m) => m.updateText(A, 'second', 2));
  const second = save('same'); // the shell reuses the requestId
  assert.notEqual(first, second);
  take();
  send({ type: 'saved', saveId: first }); // the first write completes
  assert.deepEqual(take(), [], '"second" is not in the file yet');
  assert.equal(bridge.current!.dirty, true);
  send({ type: 'saved', saveId: second });
  assert.deepEqual(take(), [{ v: 1, type: 'dirtyChanged', dirty: false }]);
});

test('unknown or already confirmed saveIds are ignored', () => {
  const { bridge, save, send, take } = loaded();
  bridge.edit((m) => m.updateText(A, 'one', 1));
  const id = save('r2');
  take();
  send({ type: 'saved', saveId: 999 });
  assert.equal(bridge.current!.dirty, true);
  send({ type: 'saved', saveId: id });
  take();
  bridge.edit((m) => m.updateText(A, 'two', 2));
  take();
  send({ type: 'saved', saveId: id }); // confirmed twice: must not mark "two" as saved
  assert.deepEqual(take(), []);
  assert.equal(bridge.current!.dirty, true);
});
