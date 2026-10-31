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
