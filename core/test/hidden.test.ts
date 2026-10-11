// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';

const MAP =
  '<map version="freeplane 1.12.15">\n' +
  '<node TEXT="root" ID="ID_0">\n' +
  '<font SIZE="18"/>\n<hook NAME="MapStyle"/>\n' + // formatting and map properties: not reported
  '<node TEXT="branch" ID="ID_1" LINK="https://example.org">\n' +
  '<icon BUILTIN="yes"/>\n<icon BUILTIN="idea"/>\n<cloud COLOR="#f0f0f0"/>\n' +
  '<node TEXT="child" ID="ID_2">\n' +
  '<richcontent TYPE="NOTE"><html><body><p>note</p></body></html></richcontent>\n' +
  '<richcontent TYPE="DETAILS"><html><body><p>details</p></body></html></richcontent>\n' +
  '<attribute NAME="k" VALUE="v"/>\n<attribute NAME="k2" VALUE="v2"/>\n' +
  '<hook URI="photo.png" NAME="ExternalObject"/>\n' +
  '<arrowlink DESTINATION="ID_3"/>\n' +
  '</node>\n</node>\n' +
  '<node TEXT="other" ID="ID_3">\n<arrowlink DESTINATION="ID_2"/>\n</node>\n' +
  '<node TEXT="plain" ID="ID_4"/>\n' +
  '</node>\n</map>\n';

test('each node reports its own hidden content; formatting is not reported', () => {
  const view = new MindMap(MAP).toView();
  assert.equal(view.hidden, undefined);
  const [branch, other, plain] = view.children;
  assert.deepEqual(branch.hidden, ['link', 'icon']);
  assert.deepEqual(branch.children[0].hidden, ['note', 'details', 'attribute', 'connector', 'image']);
  assert.deepEqual(other.hidden, ['connector']);
  assert.equal(plain.hidden, undefined);
});

test('the map lists every kind of hidden content it holds', () => {
  assert.deepEqual(new MindMap(MAP).hiddenContent(),
    ['note', 'details', 'attribute', 'link', 'icon', 'connector', 'image']);
  assert.deepEqual(new MindMap(fixture('fixture01.mm')).hiddenContent(), ['note']);
  assert.deepEqual(new MindMap(fixture('fixture02-specialChars.mm')).hiddenContent(), []);
});

test('a branch summary counts descendants, hidden content and incoming connectors', () => {
  const map = new MindMap(MAP);
  assert.deepEqual(map.branchSummary('ID_1'), {
    descendants: 1,
    // 1 connector from the branch, 1 from "other" pointing into it
    hidden: { link: 1, icon: 2, note: 1, details: 1, attribute: 2, connector: 2, image: 1 },
  });
  assert.deepEqual(map.branchSummary('ID_3'), { descendants: 0, hidden: { connector: 2 } });
  assert.deepEqual(map.branchSummary('ID_4'), { descendants: 0, hidden: {} });
});

test('images and link targets inside rich text are reported, as they are not displayed', () => {
  const map = new MindMap(
    '<map version="freeplane 1.12.15">\n<node TEXT="r" ID="ID_0">\n' +
    '<node ID="ID_1"><richcontent TYPE="NODE"><html><body>' +
    '<p>see <a href="https://example.org">this</a> <img src="a.png"/><img src="b.png"/></p>' +
    '<p><a name="anchor">not a link</a></p>' +
    '</body></html></richcontent>\n</node>\n' +
    '<node TEXT="with note" ID="ID_2"><richcontent TYPE="NOTE"><html><body><img src="n.png"/></body></html></richcontent>\n</node>\n' +
    '</node>\n</map>\n');
  const [rich, withNote] = map.toView().children;
  assert.equal(rich.topic, 'see this\nnot a link');
  assert.deepEqual(rich.hidden, ['link', 'image']);
  assert.deepEqual(map.branchSummary('ID_1').hidden, { link: 1, image: 2 });
  assert.deepEqual(withNote.hidden, ['note']); // the note covers what it contains
});
