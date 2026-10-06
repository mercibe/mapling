// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Texts Freeplane provides itself (LOCALIZED_TEXT), e.g. the root of a new map.
// fixture05 is a new map as Freeplane saved it; fixture06 is the same map after
// renaming its root in Freeplane: they show what Freeplane writes.

import { fixture } from './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MindMap } from '../src/index.ts';

const ROOT = 'ID_452131666';
const newMap = fixture('fixture05-newMapRoot.mm');
const renamedInFreeplane = fixture('fixture06-newMapRootRenamed.mm');
const rootLine = (text: string) => text.split('\n').find((line) => line.includes(`ID="${ROOT}"`))!;

test('a text provided by Freeplane is shown in the user language, English by default', () => {
  const map = new MindMap(newMap);
  assert.equal(map.text(ROOT), 'New Mindmap');
  assert.equal(map.toView('fr').topic, 'Nouvelle carte');
  assert.equal(map.toView('fr-CA').topic, 'Nouvelle carte');
  assert.equal(map.toView('de').topic, 'New Mindmap');
  const unknown = new MindMap('<map version="freeplane 1.12.15">\n<node LOCALIZED_TEXT="some_key" ID="ID_1"/>\n</map>\n');
  assert.equal(unknown.text('ID_1'), 'some_key', 'never an empty node');
});

test('renaming it writes exactly what Freeplane writes', () => {
  const map = new MindMap(newMap);
  assert.equal(map.isReadOnly(ROOT), false);
  map.updateText(ROOT, 'Nouvelle racine', 1791304520493);
  const written = map.serialize();
  assert.equal(rootLine(written), rootLine(renamedInFreeplane));
  // Only the root line changed. (Freeplane itself also reordered the attributes of
  // <properties> in fixture06, unrelated to the renaming.)
  assert.equal(written, newMap.replace(rootLine(newMap), rootLine(renamedInFreeplane)));
});

test('an apostrophe in an attribute is written as Freeplane does', () => {
  const map = new MindMap(newMap);
  map.updateText('ID_414691422', "l'été", 1);
  assert.match(map.serialize(), /TEXT="l&apos;été"/);
});
