// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Notes, shown on demand: read as Freeplane writes them (fixture10, saved by Freeplane
// 1.13.5), copied into the page as safe HTML, opened and closed through the bridge.

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, copySafeHtml, MindMap, type Note, type ViewNode } from '../src/index.ts';

const notes = fixture('fixture10-notes.mm');
const HTML = 'ID_174053484'; // node1: HTML, no CONTENT-TYPE
const XML_HTML = 'ID_173224275'; // children 2: CONTENT-TYPE="xml/html"
const MARKDOWN = 'ID_1048198066'; // CONTENT-TYPE="plain/markdown"
const NO_NOTE = 'ID_823833465'; // right node

function html(note: Note | null): Element {
  assert.ok(note && 'html' in note, 'an HTML note');
  return note.html;
}

test('a note is read as Freeplane writes it: HTML, or plain text in <text>', () => {
  const map = new MindMap(notes);
  assert.equal(html(map.note(HTML)).tagName, 'body');
  assert.match(html(map.note(XML_HTML)).textContent ?? '', /Plain text \?/);
  assert.deepEqual(map.note(MARKDOWN), {
    text: '# Main title\n## Subtitle\n**bold** text in Mardown\n\na < b & c > "d"',
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

function setup() {
  const sent: any[] = [];
  const shown: (Note | null)[] = [];
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show() {}, setReadOnly() {}, command() {}, center() {}, zoom() {}, editing: () => false,
    showNote: (note) => shown.push(note),
  });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  const data = Buffer.from(notes, 'utf8').toString('base64');
  send({ type: 'load', requestId: 'r1', name: 'notes.mm', data });
  const take = () => sent.splice(0).filter((m) => m.type === 'noteChanged');
  take();
  return { bridge, send, take, shown, data };
}

test('a note opens over the map, with its node text for the shell, and closes', () => {
  const { bridge, send, take, shown } = setup();
  bridge.openNote(MARKDOWN);
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: { id: MARKDOWN, title: 'Children with Markdown note' } }]);
  assert.ok(shown[0] && 'text' in shown[0]);
  send({ type: 'closeNote' });
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }]);
  assert.equal(shown[1], null);
  send({ type: 'closeNote' });
  assert.deepEqual(take(), [], 'already closed');
});

test('a node without a note opens nothing; a note closes with its map or its node', () => {
  const { bridge, send, take, data } = setup();
  bridge.openNote(NO_NOTE);
  bridge.openNote('ID_unknown');
  assert.deepEqual(take(), []);
  bridge.openNote(HTML);
  take();
  send({ type: 'load', requestId: 'r2', name: 'notes.mm', data });
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }], 'another map');
  bridge.openNote(MARKDOWN);
  take();
  bridge.edit((map) => map.removeNode(MARKDOWN));
  assert.deepEqual(take(), [{ v: 1, type: 'noteChanged', note: null }], 'its node removed');
});
