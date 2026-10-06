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
  const view = { shown: [] as ViewNode[], readOnly: [] as boolean[], commands: [] as string[] };
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show: (root) => view.shown.push(root),
    setReadOnly: (readOnly) => view.readOnly.push(readOnly),
    command: (name, key) => view.commands.push(`${name} ${key}`),
    center: (key) => view.commands.push(`center ${key}`),
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

test('menu commands go to the view with their target, unless the map is read-only', () => {
  const { bridge, send, take, view } = setup();
  send({ type: 'addChild', id: A, requestId: 'r0' });
  assert.deepEqual(take().map((m) => [m.type, m.code]), [['error', 'NO_MAP_LOADED']]);
  send({ type: 'load', requestId: 'r1', name: 'map.mm', data: base64(original) });
  const revision = bridge.current!.revision;
  for (const type of ['editText', 'addChild', 'addSibling']) send({ type, id: A });
  send({ type: 'deleteNode', id: A, revision });
  assert.deepEqual(view.commands, ['editText ' + A, 'addChild ' + A, 'addSibling ' + A, 'deleteNode ' + A]);
  send({ type: 'setReadOnly', readOnly: true });
  send({ type: 'deleteNode', id: A, revision });
  assert.equal(view.commands.length, 4);
});

test('a command names its target: a selection change cannot redirect it', () => {
  const { bridge, send, take, view } = loaded();
  bridge.select(A);
  const { id, revision } = take()[0].node; // the shell asks for confirmation about A…
  bridge.select('ID_1469196726'); // …while the selection moves to E
  send({ type: 'deleteNode', id, revision });
  assert.deepEqual(view.commands, ['deleteNode ' + A]);
});

test('a deletion confirmed before the map changed is refused', () => {
  const { bridge, send, take, view } = loaded();
  bridge.select(A);
  const { id, revision } = take()[0].node;
  bridge.edit((m) => m.addNode(A, 0, 'new content in the branch', 'right', 1));
  take();
  send({ type: 'deleteNode', id, revision, requestId: 'r2' });
  assert.deepEqual(take().map((m) => [m.type, m.code, m.requestId]), [['error', 'OUTDATED_COMMAND', 'r2']]);
  assert.deepEqual(view.commands, []);
  send({ type: 'deleteNode', id, requestId: 'r3' }); // no revision at all: refused too
  assert.equal(take()[0].code, 'OUTDATED_COMMAND');
});

test('a command on a node that no longer exists is refused', () => {
  const { bridge, send, take, view } = loaded();
  bridge.edit((m) => m.removeNode(A));
  take();
  send({ type: 'addChild', id: A, requestId: 'r2' });
  assert.deepEqual(take().map((m) => [m.type, m.code]), [['error', 'OUTDATED_COMMAND']]);
  assert.deepEqual(view.commands, []);
});

test('selectionChanged tells the shell what it can do with the selected node', () => {
  const { bridge, take } = loaded();
  bridge.select('ID_1964929139'); // D, which has a note
  assert.deepEqual(take(), [{ v: 1, type: 'selectionChanged', node: {
    id: 'ID_1964929139', revision: 0, root: false, textEditable: true,
    hidden: { note: 1 }, branch: { descendants: 0, hidden: { note: 1 } },
  } }]);
  bridge.select('ID_1500080539'); // rich text: its text cannot be edited
  assert.equal(take()[0].node.textEditable, false);
  bridge.select('ID_452131666');
  const root = take()[0].node;
  assert.deepEqual([root.root, root.branch.descendants], [true, 7]);
  bridge.select(null);
  assert.deepEqual(take(), [{ v: 1, type: 'selectionChanged', node: null }]);
  bridge.select(null);
  assert.deepEqual(take(), [], 'nothing new to report');
});

test('the selection report follows edits, undo and read-only changes', () => {
  const { bridge, send, take } = loaded();
  bridge.select(A);
  take();
  bridge.edit((m) => m.addNode(A, 0, 'child', 'right', 1));
  const report = take().find((m) => m.type === 'selectionChanged');
  assert.equal(report.node.branch.descendants, 1);
  send({ type: 'setReadOnly', readOnly: true });
  assert.equal(take().find((m) => m.type === 'selectionChanged').node.textEditable, false);
  send({ type: 'setReadOnly', readOnly: false });
  take();
  bridge.edit((m) => m.removeNode(A));
  assert.deepEqual(take().find((m) => m.type === 'selectionChanged'), { v: 1, type: 'selectionChanged', node: null });
  send({ type: 'undo' }); // the selected node is back
  assert.equal(take().find((m) => m.type === 'selectionChanged').node.id, A);
});

test('a new map starts with no selection, even if it shares IDs with the previous one', () => {
  const { bridge, send, take } = loaded();
  bridge.select(A);
  take();
  // Same file again: every ID exists in the new map too.
  send({ type: 'load', requestId: 'r2', name: 'same.mm', data: base64(original) });
  assert.deepEqual(take().filter((m) => m.type === 'selectionChanged'), [
    { v: 1, type: 'selectionChanged', node: null },
  ]);
});

test('the view can report its selection while a map is shown', () => {
  const sent: any[] = [];
  let bridge: Bridge;
  bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show: () => bridge.select(A), // e.g. the view restores a selection when it renders
    setReadOnly() {},
    command() {},
  });
  bridge.receive(JSON.stringify({ v: 1, type: 'load', requestId: 'r1', name: 'm.mm', data: base64(original) }));
  assert.equal(sent.find((m) => m.type === 'selectionChanged').node.id, A);
});

test('a failed load keeps the selection', () => {
  const { bridge, send, take } = loaded();
  bridge.select(A);
  take();
  send({ type: 'load', requestId: 'r2', name: 'bad.mm', data: base64('<map>') });
  assert.deepEqual(take().map((m) => m.type), ['error'], 'no selection change reported');
  bridge.edit((m) => m.addNode(A, 0, 'child', 'right', 1));
  assert.equal(take().find((m) => m.type === 'selectionChanged').node.id, A);
});

test('a deletion confirmed on a map cannot apply to its reloaded version', () => {
  const { bridge, send, take, view } = loaded();
  bridge.select(A);
  const { id, revision } = take()[0].node; // confirmation shown for A, in the first version
  // The same document is reloaded (e.g. a newer version from the cloud): same IDs.
  send({ type: 'load', requestId: 'r2', name: 'map.mm', data: base64(original) });
  take();
  assert.notEqual(bridge.current!.revision, revision, 'revisions never restart');
  send({ type: 'deleteNode', id, revision, requestId: 'r3' });
  assert.deepEqual(take().map((m) => [m.type, m.code]), [['error', 'OUTDATED_COMMAND']]);
  assert.deepEqual(view.commands, []);
});

test('the language given with load is used for texts Freeplane provides', () => {
  const { send, take, view, bridge } = setup();
  send({ type: 'load', requestId: 'r1', name: 'new.mm', data: base64(fixture('fixture05-newMapRoot.mm')), locale: 'fr' });
  assert.equal(view.shown[0].topic, 'Nouvelle carte');
  assert.equal(bridge.projection()!.topic, 'Nouvelle carte');
  take();
  bridge.select('ID_452131666');
  assert.equal(take()[0].node.textEditable, true);
  send({ type: 'load', requestId: 'r2', name: 'new.mm', data: base64(fixture('fixture05-newMapRoot.mm')) });
  assert.equal(view.shown[1].topic, 'New Mindmap', 'English when no language is given');
});

test('center goes to the view with the selected node, or the root, even when read-only', () => {
  const { bridge, send, view } = loaded();
  send({ type: 'center' });
  bridge.select(A);
  send({ type: 'setReadOnly', readOnly: true });
  send({ type: 'center' });
  assert.deepEqual(view.commands, ['center null', 'center ' + A]);
});

test('the selection reports the hidden content of the node itself, apart from its branch', () => {
  const { bridge, take } = loaded();
  bridge.select('ID_452131666'); // the root: nothing of its own; a note in its branch (D)
  const root = take()[0].node;
  assert.deepEqual([root.hidden, root.branch.hidden], [{}, { note: 1 }]);
});
