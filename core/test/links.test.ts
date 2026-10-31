// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, MindMap, webLink } from '../src/index.ts';

test('only http and https addresses are followed', () => {
  assert.equal(webLink('https://www.google.com'), 'https://www.google.com/');
  assert.equal(webLink('http://example.org/a?b=c#d'), 'http://example.org/a?b=c#d');
  assert.equal(webLink('mailto:someone@example.org'), null);
  assert.equal(webLink('execute:_some.command'), null); // a Freeplane command: never
  assert.equal(webLink('menuitem:_ExportAction'), null);
  assert.equal(webLink('file:/home/user/map.mm'), null);
  assert.equal(webLink('javascript:alert(1)'), null);
  assert.equal(webLink('#ID_123'), null); // inside the map
  assert.equal(webLink('fixture01.mm'), null); // another map, by a relative path
  assert.equal(webLink(''), null);
  assert.equal(webLink(null), null);
});

test('a web link is projected for the view, and no longer counted as hidden content', () => {
  const map = new MindMap(fixture('fixture03-mapWithLinks.mm'));
  const links = (node: ReturnType<MindMap['toView']>): (string | undefined)[] =>
    [node.link, ...node.children.flatMap(links)];
  assert.deepEqual(links(map.toView()).filter(Boolean), ['https://www.google.com/', 'https://x.com/']);
  // The link to another map is kept, not followed: it stays hidden content.
  assert.deepEqual(map.hiddenContent(), ['link']);
});

test('a link touched in the view is sent to the shell to open', () => {
  const sent: any[] = [];
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show() {}, setReadOnly() {}, command() {}, center() {}, editing: () => false,
  });
  bridge.openLink('https://example.org/');
  assert.deepEqual(sent, [{ v: 1, type: 'openLink', url: 'https://example.org/' }]);
});

// ---------- editing a link ----------

const ONE = (attrs: string, text = 'Freeplane') =>
  `<map version="freeplane 1.12.15">\n<node TEXT="root" ID="ID_0">\n<node TEXT="${text}" ID="ID_1" CREATED="1" MODIFIED="2"${attrs}/>\n</node>\n</map>\n`;

test('a new link is written right after MODIFIED, as Freeplane 1.12 does, and MODIFIED changes', () => {
  const map = new MindMap(ONE(' STYLE="x"'));
  assert.equal(map.setLink('ID_1', 'https://www.freeplane.org', 5), true);
  assert.match(map.serialize(), /<node TEXT="Freeplane" ID="ID_1" CREATED="1" MODIFIED="5" LINK="https:\/\/www.freeplane.org" STYLE="x"\/>/);
  const last = new MindMap(ONE(''));
  last.setLink('ID_1', 'https://a.org', 5);
  assert.match(last.serialize(), /MODIFIED="5" LINK="https:\/\/a.org"\/>/);
});

test('a link is replaced in place, removed when blank or null, and kept as typed', () => {
  const map = new MindMap(ONE(' LINK="https://old.org" STYLE="x"'));
  map.setLink('ID_1', 'www.example.com', 5); // not a web address: kept anyway, as typed
  assert.match(map.serialize(), /LINK="www.example.com" STYLE="x"/);
  assert.equal(map.link('ID_1'), 'www.example.com');
  map.setLink('ID_1', '   ', 6);
  assert.equal(map.link('ID_1'), null);
  assert.doesNotMatch(map.serialize(), /LINK=/);
  assert.equal(map.setLink('ID_1', null, 7), false); // nothing to remove: unchanged
});

test('an unchanged link is not an edit', () => {
  const map = new MindMap(ONE(' LINK="https://a.org"'));
  assert.equal(map.setLink('ID_1', 'https://a.org', 5), false);
  assert.match(map.serialize(), /MODIFIED="2"/);
});

test('the first web address in a text is found, as written', () => {
  assert.equal(new MindMap(ONE('', 'see https://x.com/a?b=1 and http://y.org')).textLink('ID_1'), 'https://x.com/a?b=1');
  assert.equal(new MindMap(ONE('', 'www.example.com mailto:a@b.c')).textLink('ID_1'), null);
});

test('setLink edits the selected node, shows it, reports it, and can be undone', () => {
  const sent: any[] = [];
  const shown: unknown[] = [];
  const bridge = new Bridge((json) => sent.push(JSON.parse(json)), {
    show: (root) => shown.push(root), setReadOnly() {}, command() {}, center() {}, editing: () => false,
  });
  const send = (message: object) => bridge.receive(JSON.stringify({ v: 1, ...message }));
  send({ type: 'load', requestId: 'r1', name: 'm.mm', data: Buffer.from(ONE('', 'see https://x.com')).toString('base64') });
  bridge.select('ID_1');
  assert.deepEqual([sent.at(-1).node.link, sent.at(-1).node.textLink], [null, 'https://x.com']);
  sent.length = 0;
  send({ type: 'setLink', id: 'ID_1', link: 'https://x.com' });
  assert.equal(shown.length, 2); // shown again, with its icon
  assert.ok(sent.some((m) => m.type === 'dirtyChanged' && m.dirty));
  assert.equal(sent.find((m) => m.type === 'selectionChanged').node.link, 'https://x.com');
  send({ type: 'undo' });
  assert.equal(sent.filter((m) => m.type === 'selectionChanged').at(-1).node.link, null);
  sent.length = 0;
  send({ type: 'setLink', id: 'ID_9', link: 'https://x.com' });
  assert.equal(sent.find((m) => m.type === 'error').code, 'OUTDATED_COMMAND');
});

// The Android dialog asks the core this very function (MindCore.webLink) for its note, in the
// WebView that shows the links: dialog and map agree whatever the engine. Engines differ at
// the margins: Node rejects a space in a host, Chromium encodes it (https://exa%20mple.org/).
test('what the link dialog is told: the rule the core shows links with (here, in Node)', () => {
  assert.equal(webLink('HTTPS://example.org'), 'https://example.org/'); // shown: the scheme ignores case
  assert.equal(webLink('https://exa mple.org'), null); // in Node: a space in the host
  assert.equal(webLink('https://example.org:abc'), null); // not shown: an invalid port
  assert.equal(webLink('https://example.org/page'), 'https://example.org/page');
  assert.equal(webLink('https://éditeur.fr/clé'), 'https://xn--diteur-9ua.fr/cl%C3%A9'); // diacritics
  assert.equal(webLink(''), null);
  assert.equal(webLink('www.exemple.com'), null); // not a web address: noted, still kept
});

test('a value the core does not show as a link is still kept, trimmed, with diacritics', () => {
  const map = new MindMap(ONE(''));
  map.setLink('ID_1', '  https://exa mple.org/clé  ', 5);
  assert.equal(map.link('ID_1'), 'https://exa mple.org/clé');
  assert.equal(map.toView().children[0].link, undefined); // no icon
});
