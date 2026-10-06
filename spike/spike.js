// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Milestone 0 spike (throwaway). The .mm DOM is the source of truth; jsMind only
// displays it. Every jsMind edit event is logged and replayed on the DOM by node id.

'use strict';

const EVENT_NAMES = { 1: 'show', 2: 'resize', 3: 'edit', 4: 'select' };

let doc = null;            // the parsed .mm document
let originalText = '';     // file content as loaded, for the round-trip check
let fileName = 'map.mm';
let jm = null;             // jsMind instance
let byKey = new Map();     // jsMind node id -> <node> element
let keyOf = new WeakMap(); // <node> element -> jsMind node id
let syntheticCount = 0;
let positionStyle = { left: 'left', right: 'right' };

// ---------- .mm -> jsMind projection ----------

function childNodes(el) {
  return [...el.children].filter((c) => c.tagName === 'node');
}

function keyFor(el) {
  let key = el.getAttribute('ID');
  if (!key) {
    // Old FreeMind files may have nodes without ID: use an in-memory key only.
    key = '_synthetic_' + ++syntheticCount;
  }
  byKey.set(key, el);
  keyOf.set(el, key);
  return key;
}

function richText(el) {
  const rich = [...el.children].find(
    (c) => c.tagName === 'richcontent' && c.getAttribute('TYPE') === 'NODE');
  return rich ? rich.textContent.replace(/\s+/g, ' ').trim() : null;
}

function readOnlyReason(el) {
  if (richText(el) !== null) return 'rich text (HTML)';
  // jsMind edits with a single-line <input>: editing would drop line breaks.
  if ((el.getAttribute('TEXT') || '').includes('\n')) return 'multi-line text';
  return null;
}

function project(el, isRootChild, isRoot = false) {
  const rich = richText(el);
  const reason = readOnlyReason(el);
  const item = {
    id: keyFor(el),
    topic: rich !== null ? rich : el.getAttribute('TEXT') || '',
    expanded: el.getAttribute('FOLDED') !== 'true',
    children: childNodes(el).map((c) => project(c, isRoot)),
  };
  if (isRootChild) {
    const pos = el.getAttribute('POSITION') || '';
    item.direction = pos === 'left' || pos === 'top_or_left' ? 'left' : 'right';
  }
  if (reason) {
    // Custom data keys understood by jsMind's view: shows read-only nodes in grey italics.
    item.readOnly = reason;
    item['foreground-color'] = '#777';
    item['font-style'] = 'italic';
  }
  return item;
}

function toJsMind(rootEl) {
  return { meta: { name: fileName }, format: 'node_tree', data: project(rootEl, false, true) };
}

// ---------- jsMind events -> DOM operations ----------

function now() {
  return String(Date.now());
}

function newId() {
  let id;
  do {
    id = 'ID_' + Math.floor(Math.random() * 2147483647);
  } while (byKey.has(id));
  return id;
}

// Gives an ID-less node a real ID the first time it is modified.
function ensureRealId(el) {
  if (!el.getAttribute('ID')) el.setAttribute('ID', newId());
}

// Puts the <node> element of a jsMind node at the place jsMind now shows it:
// same parent, just before the element of its next sibling.
function place(key) {
  const node = jm.get_node(key);
  const el = byKey.get(key);
  const parentEl = byKey.get(node.parent.id);
  const siblings = node.parent.children;
  const next = siblings[siblings.indexOf(node) + 1];
  if (next) {
    parentEl.insertBefore(el, byKey.get(next.id));
  } else {
    const lastNode = childNodes(parentEl).filter((c) => c !== el).pop();
    parentEl.insertBefore(el, lastNode ? lastNode.nextSibling : null);
  }
  if (node.parent.isroot) {
    el.setAttribute('POSITION', node.direction === jsMind.direction.left
      ? positionStyle.left : positionStyle.right);
  } else {
    el.removeAttribute('POSITION');
  }
  return {
    newParent: node.parent.id,
    indexAmongSiblings: siblings.indexOf(node),
    siblingCount: siblings.length,
  };
}

function createNodeElement(key, topic) {
  const el = doc.createElement('node');
  el.setAttribute('TEXT', topic);
  el.setAttribute('ID', key);
  el.setAttribute('CREATED', now());
  el.setAttribute('MODIFIED', now());
  byKey.set(key, el);
  keyOf.set(el, key);
  return el;
}

function applyEdit(evt, data) {
  switch (evt) {
    case 'update_node': {
      const [key, topic] = data;
      const el = byKey.get(key);
      ensureRealId(el);
      el.setAttribute('TEXT', topic);
      el.setAttribute('MODIFIED', now());
      return { node: key };
    }
    case 'add_node':
    case 'insert_node_before':
    case 'insert_node_after': {
      const [, key, topic] = data;
      createNodeElement(key, topic);
      return place(key);
    }
    case 'remove_node': {
      const [key] = data;
      const el = byKey.get(key);
      el.remove();
      for (const n of [el, ...el.querySelectorAll('node')]) byKey.delete(keyOf.get(n));
      return { removed: key };
    }
    case 'move_node': {
      const [key] = data;
      ensureRealId(byKey.get(key));
      byKey.get(key).setAttribute('MODIFIED', now());
      return place(key);
    }
    default:
      return { unhandled: evt };
  }
}

function onJsMindEvent(type, payload) {
  const name = EVENT_NAMES[type] || type;
  if (name !== 'edit') {
    console.log('[jsMind]', name, payload);
    return;
  }
  const result = applyEdit(payload.evt, payload.data);
  console.log('[jsMind] edit:', payload.evt, { data: payload.data, node: payload.node },
    '-> DOM:', result);
  setStatus('modified');
}

// ---------- read-only nodes and logging of non-evented actions ----------

function guardEditing() {
  const beginEdit = jm.begin_edit.bind(jm);
  jm.begin_edit = (node) => {
    const n = jm.get_node(node);
    if (n && n.data.readOnly) {
      console.warn('[spike] refused to edit read-only node', n.id, '-', n.data.readOnly);
      return false;
    }
    return beginEdit(node);
  };
  // Fold/unfold emits no jsMind event: wrap the API to observe it.
  for (const method of ['toggle_node', 'expand_node', 'collapse_node']) {
    const original = jm[method].bind(jm);
    jm[method] = (node) => {
      original(node);
      const n = jm.get_node(node);
      if (n) console.log('[spike] (no jsMind event)', method, n.id, 'expanded =', n.expanded);
    };
  }
}

// ---------- load / save ----------

function load(text, name) {
  const parsed = new DOMParser().parseFromString(text, 'application/xml');
  if (parsed.querySelector('parsererror')) {
    setStatus('XML parse error');
    console.error(parsed.querySelector('parsererror').textContent);
    return;
  }
  const rootEl = childNodes(parsed.documentElement)[0];
  if (parsed.documentElement.tagName !== 'map' || !rootEl) {
    setStatus('not a map');
    return;
  }
  doc = parsed;
  originalText = text;
  fileName = name;
  byKey = new Map();
  keyOf = new WeakMap();
  syntheticCount = 0;
  positionStyle = doc.querySelector('node[POSITION$="_or_right"], node[POSITION$="_or_left"]')
    ? { left: 'top_or_left', right: 'bottom_or_right' }
    : { left: 'left', right: 'right' };

  const mind = toJsMind(rootEl);
  if (!jm) {
    jm = new jsMind({
      container: 'map',
      editable: true,
      support_html: false, // topics are plain text, never HTML
      view: { draggable: true, node_overflow: 'wrap' },
      shortcut: { id_generator: newId },
    });
    jm.add_event_listener(onJsMindEvent);
    guardEditing();
  }
  jm.show(mind);
  console.log('[spike] loaded', name, '-', byKey.size, 'nodes; POSITION style:', positionStyle);
  setStatus(name + ' — ' + byKey.size + ' nodes');
}

function serialize() {
  return new XMLSerializer().serializeToString(doc);
}

function download() {
  const blob = new Blob([serialize()], { type: 'application/xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName.replace(/\.mm$/, '') + '.rewritten.mm';
  a.click();
  URL.revokeObjectURL(a.href);
}

function roundTripCheck() {
  const out = serialize();
  const a = originalText.split('\n');
  const b = out.split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diffs.push({ line: i + 1, original: a[i], rewritten: b[i] });
  }
  console.log('[spike] round-trip:', out === originalText ? 'IDENTICAL' : diffs.length + ' differing lines',
    diffs);
  return { identical: out === originalText, diffs };
}

// ---------- toolbar ----------

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function selected() {
  const node = jm && jm.get_selected_node();
  if (!node) setStatus('select a node first');
  return node;
}

function on(id, handler) {
  document.getElementById(id).addEventListener('click', handler);
}

on('load', async () => {
  const name = document.getElementById('fixture').value;
  const response = await fetch('../fixtures/' + name);
  load(await response.text(), name);
});
document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) load(await file.text(), file.name);
});
on('edit', () => { const n = selected(); if (n) jm.begin_edit(n); });
on('add-child', () => {
  const n = selected();
  if (!n) return;
  const id = newId();
  jm.add_node(n, id, 'New node');
  jm.begin_edit(id);
});
on('add-sibling', () => {
  const n = selected();
  if (!n || n.isroot) return;
  const id = newId();
  jm.insert_node_after(n, id, 'New node');
  jm.begin_edit(id);
});
on('delete', () => { const n = selected(); if (n && !n.isroot) jm.remove_node(n); });
on('roundtrip', roundTripCheck);
on('download', download);

// Exposed for console experiments.
window.spike = { get doc() { return doc; }, get jm() { return jm; }, serialize, roundTripCheck, load };
