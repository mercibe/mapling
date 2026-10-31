// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reference web shell (docs/BRIDGE.md). It knows nothing of jsMind or of the .mm
// format: it opens a local file, passes its bytes to the core, downloads what the
// core gives back, and shows the core's state in its own (translated) interface.
//
// Web limits: saving is a download, and the browser cannot tell whether the file
// was really written (the user may cancel it). So the shell offers "Download a
// copy", and sends `saved` only when the user confirms the copy is saved; until
// then the map stays modified and its draft is kept. There is no conflict
// detection, and drafts are kept in localStorage, which may be cleared.

import { deleteDraft, draftKey, draftsNamed, fingerprint, moveDraft, writeDraft } from './drafts.js';

// ---------- state ----------

const state = {
  map: null, // { name, draftKey, readOnly } of the open map, once loaded
  opening: null, // map being loaded: { name, draftKey, draftsToDelete, transferFrom }
  dirty: false,
  history: { canUndo: false, canRedo: false },
  selection: null, // node reported by selectionChanged
  messages: [], // { kind: 'info' | 'warning' | 'error', text }
  draftFailed: false,
  downloadToConfirm: null, // saveId of the last copy downloaded, until the user confirms it
};
let requestCount = 0;

// ---------- translation ----------

const lang = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
let strings = {};
fetch(`i18n/${lang}.json`)
  .then((response) => response.json())
  .then((loaded) => {
    strings = loaded;
    render();
  });

/** Translated text for `key`, with `{name}` placeholders replaced by `params`. */
function t(key, params = {}) {
  return (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

/** "3 notes", with the plural form of the language. */
function counted(what, count) {
  const form = new Intl.PluralRules(lang).select(count) === 'one' ? 'one' : 'other';
  return t(`count.${what}.${form}`, { count });
}

function list(items) {
  return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items);
}

// ---------- bridge (docs/BRIDGE.md, section 3) ----------

window.MindShell = { send: (json) => receive(JSON.parse(json)) };

function send(message) {
  window.MindCore.receive(JSON.stringify({ v: 1, ...message }));
}

function request(message) {
  send({ ...message, requestId: `r${++requestCount}` });
}

function receive(message) {
  switch (message.type) {
    case 'ready':
      break;
    case 'loaded':
      onLoaded(message);
      break;
    case 'saveData':
      download(message.data, state.map.name);
      state.downloadToConfirm = message.saveId; // `saved` waits for the user's confirmation
      break;
    case 'dirtyChanged':
      state.dirty = message.dirty;
      break;
    case 'historyChanged':
      state.history = message;
      break;
    case 'selectionChanged':
      state.selection = message.node;
      break;
    case 'draftData': {
      const map = state.map ?? state.opening; // drafts always concern the map in the core
      if (map) state.draftFailed = !writeDraft(storage, map.draftKey, map.name, message.data);
      break;
    }
    case 'openLink':
      // Checked by the core (http or https only); opened apart, without access to this page.
      window.open(message.url, '_blank', 'noopener,noreferrer');
      break;
    case 'error':
      state.opening = null;
      showMessage('error', t(`error.${message.code}`));
      break;
  }
  render();
}

function onLoaded(message) {
  const { name, draftKey, draftsToDelete, transferFrom } = state.opening;
  for (const key of draftsToDelete) deleteDraft(storage, key);
  // A draft restored from another file of this name now belongs to this one: it is
  // moved, and stays under its old key if writing the new one fails.
  if (transferFrom && !moveDraft(storage, transferFrom, draftKey)) state.draftFailed = true;
  state.map = { name, draftKey, readOnly: message.readOnly };
  state.opening = null;
  state.selection = null;
  state.downloadToConfirm = null;
  state.messages = [];
  for (const warning of message.warnings) showMessage('warning', t(`readOnly.${warning.code}`));
  if (message.hiddenContent.length > 0 && !hiddenNoticeShown(state.map.name)) {
    const kinds = list(message.hiddenContent.map((kind) => t(`kind.${kind}`)));
    showMessage('info', t('hidden.notice', { kinds }));
  }
}

// ---------- opening and saving ----------

const fileInput = document.getElementById('file');

function openFile() {
  if (state.dirty && !confirm(t('confirm.discard'))) return;
  fileInput.click();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  const bytes = await file.arrayBuffer();
  // Drafts the user chose to give up are deleted only once the new map is loaded:
  // if loading fails, the open map stays, and so must the protection of its changes.
  const draftsToDelete = [];
  const discarded = state.dirty ? state.map.draftKey : null; // confirmed in openFile()
  if (discarded) draftsToDelete.push(discarded);
  const ownKey = draftKey(file.name, await fingerprint(bytes));
  state.opening = { name: file.name, draftKey: ownKey, draftsToDelete, transferFrom: null };
  // A browser gives no path, so a draft is tied to the file's name and content: the
  // draft of this very version is offered first; one made on another file with this
  // name (or an earlier version of this one) is offered with a warning, and kept if
  // declined, since it may belong to another document.
  const drafts = draftsNamed(storage, file.name)
    .filter((draft) => draft.key !== discarded) // just given up: not offered back
    .sort((a, b) => (b.key === ownKey) - (a.key === ownKey) || b.savedAt - a.savedAt);
  for (const draft of drafts) {
    const own = draft.key === ownKey;
    const date = new Date(draft.savedAt).toLocaleString(lang);
    if (confirm(t(own ? 'draft.restore' : 'draft.restoreOther', { name: file.name, date }))) {
      if (!own) state.opening.transferFrom = draft.key; // its changes now continue under this file
      request({ type: 'load', name: file.name, data: draft.data, restoredDraft: true, locale: lang });
      return;
    }
    if (own) draftsToDelete.push(draft.key);
  }
  request({ type: 'load', name: file.name, data: toBase64(bytes), locale: lang });
});

function download(base64, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([fromBase64(base64)], { type: 'application/xml' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

// ---------- drafts (see drafts.js) ----------

// localStorage is synchronous, so draft writes and deletions happen in order.
// Accessing it may throw (storage disabled): drafts then fail, and the user is told.
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

/** The notice about hidden content is shown once per map. */
function hiddenNoticeShown(name) {
  try {
    const key = `mapling.hiddenNotice.${name}`;
    if (localStorage.getItem(key)) return true;
    localStorage.setItem(key, '1');
  } catch {
    // shown again next time: harmless
  }
  return false;
}

// The last moment a page is sure to run: ask the core for a draft right away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.map) send({ type: 'flushDraft' });
});

window.addEventListener('beforeunload', (event) => {
  if (state.dirty) event.preventDefault();
});

// ---------- commands ----------

const actions = {
  open: openFile,
  save: () => request({ type: 'save' }),
  undo: () => send({ type: 'undo' }),
  redo: () => send({ type: 'redo' }),
  editText: () => send({ type: 'editText', id: state.selection.id }),
  addChild: () => send({ type: 'addChild', id: state.selection.id }),
  addSibling: () => send({ type: 'addSibling', id: state.selection.id }),
  deleteNode,
  center: () => send({ type: 'center' }),
  about: () => document.getElementById('about').showModal(),
};

function confirmDownload() {
  send({ type: 'saved', saveId: state.downloadToConfirm });
  state.downloadToConfirm = null;
  render();
}

function deleteNode() {
  const { id, revision, branch } = state.selection;
  const hidden = Object.entries(branch.hidden);
  if (hidden.length > 0) {
    const items = [];
    if (branch.descendants > 0) items.push(counted('descendants', branch.descendants));
    for (const [kind, count] of hidden) items.push(counted(kind, count));
    if (!confirm(t('confirm.delete', { items: list(items) }))) return;
  }
  request({ type: 'deleteNode', id, revision });
}

/** Whether each command can be used now. */
function enabled(action) {
  const editable = !!state.map && !state.map.readOnly;
  const node = state.selection;
  switch (action) {
    case 'open':
    case 'about':
      return true;
    case 'center':
      return !!state.map;
    case 'save':
      return !!state.map;
    case 'undo':
      return state.history.canUndo;
    case 'redo':
      return state.history.canRedo;
    case 'editText':
      return editable && !!node && node.textEditable;
    case 'addChild':
      return editable && !!node;
    case 'addSibling':
    case 'deleteNode':
      return editable && !!node && !node.root;
  }
}

function run(action) {
  if (enabled(action)) actions[action]();
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => run(button.dataset.action));
}

// Keyboard shortcuts of the web shell (jsMind keeps F2, Space and the arrow keys).
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return; // typing in the node editor
  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const action =
    ctrl && key === 'o' ? 'open'
    : ctrl && key === 's' ? 'save'
    : ctrl && key === 'z' && !event.shiftKey ? 'undo'
    : ctrl && (key === 'y' || (key === 'z' && event.shiftKey)) ? 'redo'
    : !ctrl && event.key === 'Insert' ? 'addChild'
    : !ctrl && event.key === 'Delete' ? 'deleteNode'
    : null;
  if (!action) return;
  event.preventDefault();
  run(action);
});

// ---------- display ----------

function showMessage(kind, text) {
  state.messages.push({ kind, text });
}

/**
 * What the marks of the selected node mean, shown only while it is selected:
 * no room is taken when there is nothing to explain.
 */
function selectionHints() {
  const node = state.selection;
  if (!node) return [];
  const hint = (markClass, text) => {
    const line = Object.assign(document.createElement('p'), { className: 'hint' });
    line.append(Object.assign(document.createElement('span'), { className: markClass }), ' ', text);
    return line;
  };
  const hints = [];
  // A lock is shown on a node whose own text cannot be edited, in an editable map.
  if (!node.textEditable && state.map && !state.map.readOnly) {
    hints.push(hint('mapling-lock-mark', t('hint.locked')));
  }
  const hidden = Object.entries(node.hidden);
  if (hidden.length > 0) {
    const items = list(hidden.map(([kind, count]) => counted(kind, count)));
    hints.push(hint('mapling-dot-mark', t('hint.hidden', { items })));
  }
  return hints;
}

function render() {
  for (const button of document.querySelectorAll('[data-action]')) {
    button.textContent = t(`action.${button.dataset.action}`);
    button.disabled = !enabled(button.dataset.action);
  }
  for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = t(element.dataset.text);
  }
  const status = document.getElementById('status');
  status.textContent = state.map ? `${state.map.name} · ${t(state.dirty ? 'status.modified' : 'status.unmodified')}` : '';
  status.className = state.dirty ? 'modified' : '';
  document.getElementById('empty').textContent = state.map ? '' : t('status.noMap');
  document.getElementById('empty').hidden = !!state.map;
  const messages = [...state.messages];
  if (state.draftFailed) messages.push({ kind: 'warning', text: t('draft.failed') });
  const paragraphs = messages.map(({ kind, text }) =>
    Object.assign(document.createElement('p'), { className: kind, textContent: text }));
  paragraphs.push(...selectionHints());
  if (state.downloadToConfirm !== null) {
    const confirmation = Object.assign(document.createElement('p'), { className: 'info', textContent: t('download.confirm') + ' ' });
    const button = Object.assign(document.createElement('button'), { textContent: t('download.confirmButton') });
    button.addEventListener('click', confirmDownload);
    confirmation.append(button);
    paragraphs.push(confirmation);
  }
  document.getElementById('messages').replaceChildren(...paragraphs);
}

render();
