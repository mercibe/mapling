// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Notes, shown on demand: read as Freeplane writes them (fixture10, saved by Freeplane
// 1.13.5), copied into the page as safe HTML, opened and closed through the bridge;
// Markdown notes edited, created and removed as Freeplane does.

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, copySafeHtml, formatMarkdown, MindMap, type Note, type ViewNode } from '../src/index.ts';

const notes = fixture('fixture10-notes.mm');
const HTML = 'ID_174053484'; // node1: HTML, no CONTENT-TYPE
const XML_HTML = 'ID_173224275'; // children 2: CONTENT-TYPE="xml/html"
const MARKDOWN = 'ID_1048198066'; // CONTENT-TYPE="plain/markdown"
const NO_NOTE = 'ID_823833465'; // right node
const ROOT = 'ID_452131666'; // fixture10, without a note
const LEFT = 'ID_1768884868'; // left node, the last one: HTML note

function html(note: Note | null): Element {
  assert.ok(note && 'html' in note, 'an HTML note');
  return note.html;
}

test('a note is read as Freeplane writes it: HTML, or plain text in <text>', () => {
  const map = new MindMap(notes);
  assert.equal(html(map.note(HTML)).tagName, 'body');
  assert.match(html(map.note(XML_HTML)).textContent ?? '', /Plain text \?/);
  assert.deepEqual(map.note(MARKDOWN), {
    text: '# Main title\n## Subtitle\n**bold** text in Mardown\n\na < b & c > "d"', markdown: true,
  });
  assert.equal(map.note(NO_NOTE), null);
});

test('a node with a note shows its icon, and the note is no longer hidden content', () => {
  const map = new MindMap(notes);
  const byId = new Map<string, ViewNode>();
  const index = (node: ViewNode): void => {
    byId.set(node.id, node);
    node.children.forEach(index);
  };
  index(map.toView());
  assert.equal(byId.get(HTML)?.note, true);
  assert.equal(byId.get(MARKDOWN)?.note, true);
  assert.equal(byId.get(NO_NOTE)?.note, undefined);
  assert.ok(!map.hiddenContent().includes('note'));
  assert.deepEqual(map.nodeHidden(MARKDOWN), {});
  assert.deepEqual(map.branchSummary(MARKDOWN).hidden, { note: 1 }, 'still told before a deletion');
});

/** The safe copy of a note's HTML, as markup. */
function safe(body: string): string {
  const source = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/xml').documentElement;
  const target = new DOMParser().parseFromString('<div/>', 'text/xml').documentElement;
  copySafeHtml(source, target);
  return new XMLSerializer().serializeToString(target);
}

test('a note keeps its formatting, lists, tables and web links', () => {
  assert.equal(
    safe('<p style="text-align: center"><span style="font-weight: bold;">b</span> <a href="https://example.org">x</a></p>' +
      '<ol><li>one</li></ol><table border="0"><tr><td valign="top">c</td></tr></table>'),
    '<div><p style="text-align: center"><span style="font-weight: bold">b</span> <a href="https://example.org">x</a></p>' +
      '<ol><li>one</li></ol><table border="0"><tr><td valign="top">c</td></tr></table></div>');
});

test('a note shows nothing that could run code or reach the network', () => {
  assert.equal(safe('<script>alert(1)</script><style>p{}</style><p onclick="alert(1)">a</p>'), '<div><p>a</p></div>');
  assert.equal(safe('<a href="javascript:alert(1)">a</a><a href="other.mm#ID_1">b</a>'), '<div><a>a</a><a>b</a></div>');
  assert.equal(safe('<p style="background: url(https://example.org/x.png)">a</p><img src="https://example.org/y.png"/>'),
    '<div><p>a</p></div>');
  // An escape is a url() all the same for the browser (audit of 2026-11-21): no escape is kept.
  assert.equal(safe('<p style="color: #c00; background-image: u\\72l(https://audit.invalid/pixel)">a</p>'),
    '<div><p style="color: #c00">a</p></div>');
  assert.equal(safe('<p style="background-color: #fff; border-image: url(x.png) 1; font-family: \'x\' /* c */">a</p>'),
    '<div><p style="background-color: #fff">a</p></div>');
});

test('a note keeps no style that would place it outside its panel', () => {
  assert.equal(safe('<p style="position: fixed; inset: 0; z-index: 99; transform: translate(0); margin-top: 2px">a</p>'),
    '<div><p style="margin-top: 2px">a</p></div>');
  // Freeplane's own styles are kept (fixture10).
  assert.equal(safe('<td style="width: 33%; border-top-style: solid; border-top-width: 1; vertical-align: top">c</td>'),
    '<div><td style="width: 33%; border-top-style: solid; border-top-width: 1; vertical-align: top">c</td></div>');
  // Any other element gives its content only.
  assert.equal(safe('<form><input/><button>ok</button></form>'), '<div>ok</div>');
});

// ---------- editing Markdown notes ----------

const SMALL =
  '<map version="freeplane 1.12.15">\n<node TEXT="r" ID="ID_0">\n' +
  '<node TEXT="leaf" ID="ID_1" CREATED="1" MODIFIED="1"/>\n' +
  '<node TEXT="parent" ID="ID_2" CREATED="1" MODIFIED="1">\n<icon BUILTIN="yes"/>\n<node TEXT="child" ID="ID_3"/>\n</node>\n' +
  '</node>\n</map>\n';

test('a new note is written as Freeplane writes a Markdown note, before the node\'s children', () => {
  const map = new MindMap(SMALL);
  assert.equal(map.setNote('ID_1', 'It\'s "nice"\r\n- a', 5), true);
  assert.equal(map.setNote('ID_2', '# t', 6), true);
  assert.equal(map.serialize(), SMALL
    .replace('<node TEXT="leaf" ID="ID_1" CREATED="1" MODIFIED="1"/>',
      '<node TEXT="leaf" ID="ID_1" CREATED="1" MODIFIED="5"><richcontent TYPE="NOTE" CONTENT-TYPE="plain/markdown">\n' +
      '<text>It\'s &quot;nice&quot;\n- a</text></richcontent>\n</node>')
    .replace('MODIFIED="1">\n<icon BUILTIN="yes"/>\n<node',
      'MODIFIED="6">\n<icon BUILTIN="yes"/>\n<richcontent TYPE="NOTE" CONTENT-TYPE="plain/markdown">\n<text># t</text></richcontent>\n<node'));
  assert.deepEqual(map.note('ID_1'), { text: 'It\'s "nice"\n- a', markdown: true });
});

test('editing a Markdown note changes its text only; a blank one is removed, as in Freeplane', () => {
  const map = new MindMap(notes);
  assert.equal(map.setNote(MARKDOWN, (map.note(MARKDOWN) as { text: string }).text), false, 'unchanged');
  assert.equal(map.setNote(MARKDOWN, 'new <text>', 7), true);
  const written = map.serialize();
  assert.match(written, /ID="ID_1048198066" CREATED="1795285855252" MODIFIED="7"><richcontent TYPE="NOTE" CONTENT-TYPE="plain\/markdown">\n<text>new &lt;text&gt;<\/text><\/richcontent>/);
  assert.equal(map.setNote(MARKDOWN, '  \n ', 8), true);
  assert.equal(map.note(MARKDOWN), null);
  assert.match(map.serialize(), /<node TEXT="Children with Markdown note" ID="ID_1048198066" CREATED="1795285855252" MODIFIED="8"\/>/);
  assert.equal(map.setNote(NO_NOTE, ' '), false, 'a blank note is not created');
});

test('an HTML note is not changed by setNote', () => {
  assert.throws(() => new MindMap(notes).setNote(HTML, 'x'), /Markdown/);
});

test('the Markdown bar surrounds the selection, or marks the lines it touches', () => {
  const apply = (text: string, start: number, end: number, format: Parameters<typeof formatMarkdown>[3]) => {
    const c = formatMarkdown(text, start, end, format);
    const result = text.slice(0, c.from) + c.insert + text.slice(c.to);
    return [result, result.slice(c.start, c.end)];
  };
  assert.deepEqual(apply('a word here', 2, 6, 'bold'), ['a **word** here', 'word']);
  assert.deepEqual(apply('ab', 1, 1, 'italic'), ['a**b', ''], 'the caret between the marks');
  assert.deepEqual(apply('one\ntwo', 5, 5, 'heading'), ['one\n# two', '']);
  assert.deepEqual(apply('one\ntwo\nthree', 1, 6, 'numberedList'), ['1. one\n2. two\nthree', 'ne\n2. tw']);
  assert.deepEqual(apply('\nx', 0, 0, 'bulletList'), ['- \nx', '']);
  // The end of a selection is excluded: a selection ending with a line break leaves the next line.
  assert.deepEqual(apply('one\ntwo\nthree', 0, 4, 'bulletList'), ['- one\ntwo\nthree', 'one\n']);
  assert.deepEqual(apply('one\ntwo', 4, 4, 'heading'), ['one\n# two', ''], 'a caret alone at a line start');
});

function setup(readOnly = false) {
  const sent: any[] = [];
  const shown: [Note | null, boolean][] = [];
  const formats: string[] = [];
  const revealed: string[] = [];
  let typed: string | null = null;
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show() {}, setReadOnly() {}, command() {}, center() {}, zoom() {}, editing: () => false,
    reveal: (key) => revealed.push(key),
    showNote: (note, editing) => {
      shown.push([note, editing]);
      typed = note && editing && 'text' in note ? note.text : null;
    },
    noteText: () => typed,
    formatNote: (format) => formats.push(format),
  });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  const data = Buffer.from(notes, 'utf8').toString('base64');
  send({ type: 'load', requestId: 'r1', name: 'notes.mm', data, readOnly });
  const take = () => sent.splice(0).filter((m) => m.type === 'noteChanged');
  take();
  /** Opens the note of `key`, then edits it. */
  const edit = (key: string) => {
    send({ type: 'openNote', id: key });
    send({ type: 'editNote', editing: true });
  };
  return { bridge, send, take, shown, formats, revealed, data, edit, type: (text: string) => (typed = text), sent };
}

/** What noteChanged tells of a note shown, read and editable unless said otherwise. */
function shownNote(id: string, title: string, previous: string | null, next: string | null, more: object = {}) {
  return { v: 1, type: 'noteChanged', note: { id, title, editable: true, editing: false, previous, next, ...more } };
}

test('the nodes of a map are in pre-order: the root, then each branch in document order', () => {
  assert.deepEqual(new MindMap(notes).nodeKeys(), [ROOT, HTML, 'ID_192583075', XML_HTML, MARKDOWN, NO_NOTE, LEFT]);
});

test('a note opens read over the map, its node selected, with its neighbours, and closes', () => {
  const { send, take, shown, revealed } = setup();
  send({ type: 'openNote', id: MARKDOWN });
  assert.deepEqual(take(), [shownNote(MARKDOWN, 'Children with Markdown note', XML_HTML, NO_NOTE)]);
  assert.ok(shown[0][0] && 'text' in shown[0][0]);
  assert.equal(shown[0][1], false, 'read, not edited');
  assert.deepEqual(revealed, [MARKDOWN]);
  send({ type: 'closeNote' });
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }]);
  assert.deepEqual(shown[1], [null, false]);
  assert.deepEqual(revealed, [MARKDOWN, MARKDOWN], 'shown on the map again');
  send({ type: 'closeNote' });
  assert.deepEqual(take(), [], 'already closed');
});

test('the first and last nodes have no previous or next; stepping goes from one to the other', () => {
  const { bridge, send, take, revealed } = setup();
  send({ type: 'openNote', id: ROOT });
  assert.deepEqual(take(), [shownNote(ROOT, 'fixture10', null, HTML)]);
  bridge.stepNote(-1);
  assert.deepEqual(take(), [], 'nothing before the root');
  bridge.stepNote(1);
  assert.equal(take()[0].note.id, HTML);
  send({ type: 'openNote', id: LEFT });
  assert.deepEqual(take(), [shownNote(LEFT, 'left node', NO_NOTE, null, { editable: false })]);
  bridge.stepNote(1);
  assert.deepEqual(take(), [], 'nothing after the last node');
  assert.deepEqual(revealed, [ROOT, HTML, LEFT]);
});

test('a Markdown note is edited on demand, then read again, as one edit undone like the others', () => {
  const { bridge, send, take, shown, type } = setup();
  send({ type: 'openNote', id: MARKDOWN });
  send({ type: 'editNote', editing: true });
  assert.deepEqual(take().at(-1), shownNote(MARKDOWN, 'Children with Markdown note', XML_HTML, NO_NOTE, { editing: true }));
  assert.equal(shown.at(-1)?.[1], true, 'in a text area');
  type('changed');
  send({ type: 'editNote', editing: false });
  assert.deepEqual(take(), [shownNote(MARKDOWN, 'Children with Markdown note', XML_HTML, NO_NOTE)]);
  assert.deepEqual(shown.at(-1), [{ text: 'changed', markdown: true }, false], 'read as written');
  assert.deepEqual(bridge.current?.map.note(MARKDOWN), { text: 'changed', markdown: true });
  send({ type: 'undo' });
  assert.match((bridge.current?.map.note(MARKDOWN) as { text: string }).text, /^# Main title/);
});

test('a note typed is kept on closing, or on going to another node, which is then read', () => {
  const { bridge, send, take, shown, edit, type } = setup();
  edit(MARKDOWN);
  type('closed');
  send({ type: 'closeNote' });
  assert.deepEqual(bridge.current?.map.note(MARKDOWN), { text: 'closed', markdown: true });
  assert.deepEqual(take().at(-1), { v: 1, type: 'noteChanged', note: null }, 'closed at once');
  edit(MARKDOWN);
  type('stepped');
  send({ type: 'openNote', id: NO_NOTE });
  assert.deepEqual(bridge.current?.map.note(MARKDOWN), { text: 'stepped', markdown: true });
  assert.deepEqual(take().at(-1), shownNote(NO_NOTE, 'right node', MARKDOWN, LEFT));
  assert.deepEqual(shown.at(-1), [{ text: '', markdown: true }, false], 'no note yet: empty, read');
});

test('a node without a note opens empty; a note is written only once something is typed', () => {
  const { bridge, send, take, edit, type } = setup();
  edit(NO_NOTE);
  send({ type: 'closeNote' });
  assert.equal(bridge.current?.map.note(NO_NOTE), null, 'left empty: no note');
  assert.equal(bridge.current?.dirty, false);
  edit(NO_NOTE);
  type('A **new** note');
  send({ type: 'closeNote' });
  assert.deepEqual(bridge.current?.map.note(NO_NOTE), { text: 'A **new** note', markdown: true });
  take();
});

test('a note being typed is in the drafts and the saves, without being closed', () => {
  const { bridge, send, take, edit, type, sent } = setup();
  edit(NO_NOTE);
  type('draft');
  send({ type: 'flushDraft' });
  const draft = sent.find((m) => m.type === 'draftData');
  assert.match(Buffer.from(draft.data, 'base64').toString('utf8'), /<text>draft<\/text>/);
  type('saved');
  send({ type: 'save', requestId: 's1' });
  const save = sent.find((m) => m.type === 'saveData');
  assert.match(Buffer.from(save.data, 'base64').toString('utf8'), /<text>saved<\/text>/);
  assert.deepEqual(take().filter((m) => m.note === null), [], 'still open');
  assert.equal(bridge.current?.map.note(NO_NOTE) !== null, true);
});

test('an HTML note, or any note of a read-only map, is only read; formats reach an edited note only', () => {
  const { send, take, formats, edit } = setup();
  edit(HTML);
  assert.deepEqual(take().map((m) => [m.note.editable, m.note.editing]), [[false, false]], 'editNote ignored');
  send({ type: 'formatNote', format: 'bold' });
  send({ type: 'openNote', id: MARKDOWN });
  send({ type: 'formatNote', format: 'bold' });
  assert.deepEqual(formats, [], 'read, not edited');
  send({ type: 'editNote', editing: true });
  send({ type: 'formatNote', format: 'bold' });
  assert.deepEqual(formats, ['bold']);
  const readOnly = setup(true);
  readOnly.edit(MARKDOWN);
  assert.deepEqual(readOnly.take().map((m) => [m.note.editable, m.note.editing]), [[false, false]]);
  readOnly.send({ type: 'openNote', id: NO_NOTE });
  assert.deepEqual(readOnly.take(), [shownNote(NO_NOTE, 'right node', MARKDOWN, LEFT, { editable: false })], 'empty, read');
});

test('a note closes with its map or its node; an unknown node is an outdated command', () => {
  const { bridge, send, take, data, sent } = setup();
  send({ type: 'openNote', id: 'ID_unknown' });
  assert.equal(sent.at(-1).code, 'OUTDATED_COMMAND');
  send({ type: 'openNote', id: HTML });
  take();
  send({ type: 'load', requestId: 'r2', name: 'notes.mm', data });
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }], 'another map');
  bridge.openNote(MARKDOWN);
  take();
  bridge.edit((map) => map.removeNode(MARKDOWN));
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }], 'its node removed');
});

test('a note being typed is kept when the map becomes read-only, then read; editable again after', () => {
  const { bridge, send, take, edit, type } = setup();
  edit(NO_NOTE);
  take();
  type('kept');
  send({ type: 'setReadOnly', readOnly: true });
  assert.deepEqual(bridge.current?.map.note(NO_NOTE), { text: 'kept', markdown: true });
  assert.deepEqual(take(), [shownNote(NO_NOTE, 'right node', MARKDOWN, LEFT, { editable: false })]);
  send({ type: 'setReadOnly', readOnly: false });
  assert.deepEqual(take(), [shownNote(NO_NOTE, 'right node', MARKDOWN, LEFT)], 'still read, editable again');
  send({ type: 'editNote', editing: true });
  send({ type: 'setReadOnly', readOnly: false });
  assert.equal(take().at(-1).note.editing, true, 'an editable map leaves the note edited');
});

test('a note kept on loading another map does not lend its revision to the new map', () => {
  const { bridge, send, type, data, sent, edit } = setup();
  edit(NO_NOTE);
  type('typed');
  const previous = bridge.current!;
  send({ type: 'load', requestId: 'bad', name: 'x.mm', data: Buffer.from('not a map').toString('base64') });
  assert.equal(sent.at(-1).code, 'PARSE_ERROR');
  assert.equal(previous.map.note(NO_NOTE), null, 'a refused file changes nothing: the note stays open, unwritten');
  send({ type: 'load', requestId: 'r2', name: 'notes.mm', data });
  assert.deepEqual(previous.map.note(NO_NOTE), { text: 'typed', markdown: true }, 'kept in its own map');
  assert.ok(bridge.current!.revision > previous.lastCreatedRevision);
});
