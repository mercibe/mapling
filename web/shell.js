// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Reference web shell (docs/BRIDGE.md). It knows nothing of jsMind or of the .mm
// format: it opens a local file, passes its bytes to the core, downloads what the
// core gives back, and shows the core's state in its own (translated) interface,
// made to look like the Android shell's.
//
// Web limits: saving is a download, and the browser cannot tell whether the file
// was really written (the user may cancel it). So the shell offers "Download a
// copy", and sends `saved` only when the user confirms the copy is saved; until
// then the map stays modified and its draft is kept. There is no conflict
// detection, and drafts are kept in localStorage, which may be cleared.

import { deleteDraft, draftKey, draftsNamed, fingerprint, moveDraft, writeDraft } from './drafts.js';

// ---------- state ----------

const state = {
  map: null, // { name, draftKey, readOnly, title, version, size, modified } of the open map, once loaded
  opening: null, // map being loaded: { name, draftKey, draftsToDelete, transferFrom, size, modified }
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
    case 'titleChanged':
      if (state.map) state.map.title = message.title;
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
  const { name, draftKey, draftsToDelete, transferFrom, size, modified } = state.opening;
  for (const key of draftsToDelete) deleteDraft(storage, key);
  // A draft restored from another file of this name now belongs to this one: it is
  // moved, and stays under its old key if writing the new one fails.
  if (transferFrom && !moveDraft(storage, transferFrom, draftKey)) state.draftFailed = true;
  state.map = { name, draftKey, readOnly: message.readOnly, title: message.title ?? '', version: message.mapVersion, size, modified };
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

// ---------- dialogs ----------

/**
 * Shows `text` with `buttons` ([value, label], the main one last) and resolves with the
 * value of the button chosen, or '' when the dialog is dismissed (Escape).
 */
function ask(text, buttons, title = '') {
  const dialog = document.getElementById('ask');
  const heading = dialog.querySelector('h2');
  heading.textContent = title;
  heading.hidden = !title;
  dialog.querySelector('p').textContent = text;
  dialog.querySelector('form').replaceChildren(...buttons.map(([value, label]) =>
    Object.assign(document.createElement('button'), { value, textContent: label })));
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

/** Before the open map is left: with unsaved changes, the user agrees to give them up. */
async function mayLeaveMap() {
  if (!state.dirty) return true;
  return (await ask(t('confirm.discard'), [['', t('dialog.cancel')], ['discard', t('confirm.discardButton')]])) === 'discard';
}

// ---------- opening and saving ----------

const fileInput = document.getElementById('file');

async function openFile() {
  if (await mayLeaveMap()) fileInput.click();
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) openBytes(file.name, await file.arrayBuffer(), file.lastModified);
});

/** A new map, as Freeplane writes it (the core's template), under a name the user changes on download. */
async function newMap() {
  if (!(await mayLeaveMap())) return;
  const template = await fetch(document.getElementById('new-map-template').href);
  openBytes(t('newMap.fileName'), await template.arrayBuffer(), null);
}

async function openBytes(name, bytes, modified) {
  // Drafts the user chose to give up are deleted only once the new map is loaded:
  // if loading fails, the open map stays, and so must the protection of its changes.
  const draftsToDelete = [];
  const discarded = state.dirty ? state.map.draftKey : null; // agreed in mayLeaveMap()
  if (discarded) draftsToDelete.push(discarded);
  const ownKey = draftKey(name, await fingerprint(bytes));
  state.opening = { name, draftKey: ownKey, draftsToDelete, transferFrom: null, size: bytes.byteLength, modified };
  // A browser gives no path, so a draft is tied to the file's name and content: the
  // draft of this very version is offered first; one made on another file with this
  // name (or an earlier version of this one) is offered with a warning, and kept if
  // declined, since it may belong to another document.
  const drafts = draftsNamed(storage, name)
    .filter((draft) => draft.key !== discarded) // just given up: not offered back
    .sort((a, b) => (b.key === ownKey) - (a.key === ownKey) || b.savedAt - a.savedAt);
  for (const draft of drafts) {
    const own = draft.key === ownKey;
    const date = new Date(draft.savedAt).toLocaleString(lang);
    const declined = own ? ['', t('draft.discardButton')] : ['', t('draft.ignoreButton')];
    const answer = await ask(t(own ? 'draft.restore' : 'draft.restoreOther', { name, date }),
      [declined, ['restore', t('draft.restoreButton')]], t('draft.title'));
    if (answer === 'restore') {
      if (!own) state.opening.transferFrom = draft.key; // its changes now continue under this file
      request({ type: 'load', name, data: draft.data, restoredDraft: true, locale: lang });
      return;
    }
    if (own) draftsToDelete.push(draft.key);
  }
  request({ type: 'load', name, data: toBase64(bytes), locale: lang });
}

/** Back to the home screen; unsaved changes given up lose their draft. */
async function closeMap() {
  if (!(await mayLeaveMap())) return;
  if (state.dirty) deleteDraft(storage, state.map.draftKey);
  // The core keeps the map until the next one is loaded: drafts it may still send
  // concern no open map, and are ignored (see draftData).
  Object.assign(state, { map: null, dirty: false, history: { canUndo: false, canRedo: false }, selection: null, messages: [], downloadToConfirm: null });
  render();
}

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

// ---------- the map's information and the node's link ----------

/** One line per thing known; what is not known is left out. */
function showMapInfo() {
  const { title, name, size, modified, version, readOnly } = state.map;
  const lines = [
    title && t('info.map', { value: oneLine(title) }),
    t('info.file', { value: name }),
    t('info.size', { value: fileSize(size) }),
    modified && t('info.modified', { value: new Date(modified).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) }),
    version && t('info.format', { value: version.charAt(0).toUpperCase() + version.slice(1) }),
  ].filter(Boolean);
  const text = lines.join('\n') + (readOnly ? `\n\n${t('info.readOnly')}` : '');
  ask(text, [['', t('dialog.ok')]], t('action.mapInfo'));
}

/** "15 kB", as Android writes sizes (powers of 1000). */
function fileSize(bytes) {
  const [value, unit] = bytes < 1000 ? [bytes, 'byte'] : bytes < 1e6 ? [bytes / 1e3, 'kilobyte'] : [bytes / 1e6, 'megabyte'];
  return new Intl.NumberFormat(lang, { style: 'unit', unit, maximumFractionDigits: value < 10 ? 1 : 0 }).format(value);
}

/**
 * Adds, changes or removes the selected node's link. A web address found in its text is
 * offered as the link to add. A text that is not a web address is kept, but the user is
 * told it will not be shown as a link, by the core's own rule (MindCore.webLink).
 */
function editLink() {
  const { id, link, textLink } = state.selection;
  const dialog = document.getElementById('link');
  const field = document.getElementById('link-field');
  const note = document.getElementById('link-note');
  const check = () => {
    const text = field.value.trim();
    note.hidden = !text || window.MindCore.webLink(text) !== null;
  };
  dialog.querySelector('h2').textContent = t(link === null ? 'link.addTitle' : 'link.editTitle');
  document.getElementById('link-remove').hidden = link === null;
  field.value = link ?? textLink ?? '';
  field.oninput = check;
  // Enter confirms (the form's first button is Remove).
  field.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      dialog.close('ok');
    }
  };
  check();
  dialog.returnValue = '';
  dialog.showModal();
  field.select();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'ok') send({ type: 'setLink', id, link: field.value });
    if (dialog.returnValue === 'remove') send({ type: 'setLink', id, link: null });
  }, { once: true });
}

// ---------- drawer and ⋮ menu ----------

const app = document.getElementById('app');
const more = document.getElementById('more');

function openDrawer() {
  app.classList.add('drawer-open');
}

function closeDrawer() {
  app.classList.remove('drawer-open');
}

document.getElementById('scrim').addEventListener('click', closeDrawer);
// A click on the sheet's backdrop closes it.
more.addEventListener('click', (event) => {
  if (event.target === more) more.close();
});

// ---------- commands ----------

const actions = {
  menu: openDrawer,
  open: openFile,
  newMap,
  close: closeMap,
  save: () => request({ type: 'save' }),
  saveCopy: () => request({ type: 'save' }),
  undo: () => send({ type: 'undo' }),
  redo: () => send({ type: 'redo' }),
  editText: () => send({ type: 'editText', id: state.selection.id }),
  addChild: () => send({ type: 'addChild', id: state.selection.id }),
  addSibling: () => send({ type: 'addSibling', id: state.selection.id }),
  deleteNode,
  more: () => more.showModal(),
  center: () => send({ type: 'center' }),
  zoomIn: () => send({ type: 'zoomIn' }),
  zoomOut: () => send({ type: 'zoomOut' }),
  moveNode: (direction) => send({ type: 'moveNode', id: state.selection.id, direction }),
  mapInfo: showMapInfo,
  editLink,
  // Opened apart, as a click on the link's icon (openLink); only web links, by the core's rule.
  followLink: () => window.open(window.MindCore.webLink(state.selection.link), '_blank', 'noopener,noreferrer'),
  about: () => document.getElementById('about').showModal(),
};

function confirmDownload() {
  send({ type: 'saved', saveId: state.downloadToConfirm });
  state.downloadToConfirm = null;
  render();
}

async function deleteNode() {
  const { id, revision, branch } = state.selection;
  const hidden = Object.entries(branch.hidden);
  if (hidden.length > 0) {
    const items = [];
    if (branch.descendants > 0) items.push(counted('descendants', branch.descendants));
    for (const [kind, count] of hidden) items.push(counted(kind, count));
    const answer = await ask(t('confirm.delete', { items: list(items) }), [['', t('dialog.cancel')], ['delete', t('action.deleteNode')]]);
    if (answer !== 'delete') return;
  }
  request({ type: 'deleteNode', id, revision });
}

/** Whether each command can be used now. */
function enabled(action) {
  const editable = !!state.map && !state.map.readOnly;
  const node = state.selection;
  switch (action) {
    case 'menu':
    case 'open':
    case 'newMap':
    case 'about':
      return true;
    case 'close':
    case 'saveCopy':
    case 'more':
    case 'center':
    case 'zoomIn':
    case 'zoomOut':
    case 'mapInfo':
      return !!state.map;
    case 'followLink':
      return !!node && node.link !== null && window.MindCore.webLink(node.link) !== null;
    case 'save':
      return !!state.map && state.dirty;
    case 'undo':
      return state.history.canUndo;
    case 'redo':
      return state.history.canRedo;
    case 'editText':
      return editable && !!node && node.textEditable;
    case 'addChild':
    case 'editLink':
      return editable && !!node;
    case 'addSibling':
    case 'deleteNode':
    case 'moveNode':
      return editable && !!node && !node.root;
  }
}

function run(action, argument) {
  if (enabled(action)) actions[action](argument);
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    // An entry of the drawer or of the ⋮ menu closes it first.
    closeDrawer();
    if (more.open) more.close();
    run(button.dataset.action);
  });
}

// Keyboard shortcuts of the web shell, Freeplane's (read in its menus, mindmapmodemenu.xml):
// Ctrl+arrows move the node, Alt+Up and Alt+Down zoom (jsMind keeps F2, Space and the arrows). Caught before jsMind's: with no map open, the keys never reach
// the map behind the home screen.
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, dialog')) return; // typing a node's text, or in a dialog
  if (event.key === 'Escape' && app.classList.contains('drawer-open')) return closeDrawer();
  const ctrl = event.ctrlKey || event.metaKey;
  const plain = !ctrl && !event.altKey && !event.shiftKey;
  const onButton = !!event.target.closest('button, a'); // Enter and Tab keep their usual role there
  const key = event.key.toLowerCase();
  const arrow = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[event.key];
  const action =
    ctrl && !event.altKey && !event.shiftKey && arrow ? 'moveNode'
    : event.altKey && !ctrl && !event.shiftKey && arrow === 'up' ? 'zoomIn'
    : event.altKey && !ctrl && !event.shiftKey && arrow === 'down' ? 'zoomOut'
    : ctrl && key === 'k' ? 'editLink'
    : ctrl && event.key === 'Enter' ? 'followLink'
    : ctrl && key === 'o' ? 'open'
    : ctrl && key === 's' ? 'save'
    : ctrl && key === 'z' && !event.shiftKey ? 'undo'
    : ctrl && (key === 'y' || (key === 'z' && event.shiftKey)) ? 'redo'
    : plain && (event.key === 'Insert' || (event.key === 'Tab' && !onButton)) ? 'addChild'
    : plain && event.key === 'Enter' && !onButton ? 'addSibling' // none for the root, as in Freeplane
    : plain && event.key === 'Delete' ? 'deleteNode'
    : null;
  if (!state.map) event.stopPropagation();
  // Without a node to act on, Tab (and Shift+Tab) moves the focus as usual: jsMind, which
  // cancels every Tab, must not get it.
  if (event.key === 'Tab' && !(action && enabled(action))) return event.stopPropagation();
  if (!action) return;
  event.preventDefault();
  run(action, arrow);
}, true);

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
  const map = state.map;
  for (const button of document.querySelectorAll('[data-action]')) {
    button.disabled = !enabled(button.dataset.action);
    if (button.classList.contains('icon-button')) {
      button.title = t(`action.${button.dataset.action}`);
      button.setAttribute('aria-label', button.title);
    }
  }
  for (const element of document.querySelectorAll('[data-text]')) {
    element.textContent = t(element.dataset.text);
  }
  for (const element of document.querySelectorAll('[data-with-map]')) element.hidden = !map;
  document.getElementById('home').hidden = !!map;
  document.getElementById('mapling').style.visibility = map ? '' : 'hidden';
  document.title = map ? `${oneLine(map.title) || map.name} – Mapling` : 'Mapling';

  // The drawer's header: the root's text, then the file.
  const header = document.getElementById('drawer-header');
  header.querySelector('strong').textContent = map ? oneLine(map.title) || map.name : '';
  header.querySelector('span').textContent = map && oneLine(map.title) ? map.name : '';

  // The ⋮ menu: the selected node's commands only with one; Center then goes with them.
  const node = state.selection;
  document.getElementById('more-node').hidden = !node;
  document.getElementById('center-map').hidden = !!node;
  document.querySelector('[data-action="editLink"]').hidden = !enabled('editLink');
  document.getElementById('link-entry').textContent = t(node?.link == null ? 'action.addLink' : 'action.editLink');

  const messages = [...state.messages];
  if (state.draftFailed) messages.push({ kind: 'warning', text: t('draft.failed') });
  const paragraphs = messages.map(({ kind, text }) =>
    Object.assign(document.createElement('p'), { className: kind, textContent: text }));
  if (state.downloadToConfirm !== null) {
    const confirmation = Object.assign(document.createElement('p'), { className: 'info', textContent: t('download.confirm') });
    const button = Object.assign(document.createElement('button'), { textContent: t('download.confirmButton') });
    button.addEventListener('click', confirmDownload);
    confirmation.append(button);
    paragraphs.push(confirmation);
  }
  document.getElementById('messages').replaceChildren(...paragraphs);
  document.getElementById('hints').replaceChildren(...selectionHints());
}

/** A text on several lines, on one. */
function oneLine(text) {
  return (text ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

render();
