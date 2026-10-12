# BRIDGE.md — Contract between the core and the shells

> Protocol version: **1**.
> This contract may still change until the first release; after that, any incompatible change increments the version.

## 1. Purpose

This document is **everything a developer needs to read to write a new shell** (Android, iOS, Web, desktop). They do not need to know jsMind or the `.mm` format.

Division of responsibilities:

| Core (`core/`, JS) | Shell (native) |
|---|---|
| Decode and encode the file (encoding, XML) | Pick and open a document |
| Display the map and handle interactions | Read and write the document's bytes |
| Apply changes to the DOM | Display the WebView and the native UI (menu, Save button) |
| Report the "modified" state | Detect write conflicts |

The shell never reads or parses the file's content.

## 2. Protocol principles

- **JSON messages only**, in both directions. This works the same way with `addJavascriptInterface` or `WebMessagePort` (Android), `WKScriptMessageHandler` (iOS) and a plain function call (Web).
- **Everything is asynchronous.** A request from the shell carries a `requestId`; the core's response repeats the same `requestId`.
- **Bytes in base64.** File content travels as base64 of the raw bytes, never as a decoded string. The core decodes and encodes them: it supports UTF-8, which Freeplane writes, and keeps a byte order mark if there is one. A file declaring another encoding, in UTF-16 or with invalid UTF-8 is refused with `UNSUPPORTED_ENCODING`.
- Every message carries `"v": 1` (protocol version).

## 3. Entry points

### Shell → core

The core exposes a single global function:

```js
window.MindCore.receive(messageJson: string)
```

### Core → shell

The shell provides, **before the core is loaded**, a single global function:

```js
window.MindShell.send(messageJson: string)
```

Adaptation examples:

- Android (`addJavascriptInterface`): a Kotlin object exposed under the name `MindShell` with a method `@JavascriptInterface fun send(json: String)`. For the other direction: `webView.evaluateJavascript("MindCore.receive(" + jsonQuoted + ")", null)`.
- iOS: a small script injected at startup that defines `MindShell.send = (m) => webkit.messageHandlers.mindShell.postMessage(m)`.
- Web: `MindShell.send` is an ordinary JS function of the reference page.

## 4. Shell → core messages

### `load` — load a map

```json
{ "v": 1, "type": "load", "requestId": "r1",
  "name": "Project.mm", "data": "<base64 of the bytes>", "readOnly": false, "locale": "fr" }
```

Response: `loaded` or `error`.

`locale` (optional, e.g. `"fr"`, `"fr-CA"`) is the user's language. The core shows no interface text, but some map content is provided by Freeplane in the reader's language, such as the root of a new map ("New Mindmap", "Nouvelle carte"): the core displays it in this language, in English by default.

To restore a draft (see section 6), send the draft's bytes with `"restoredDraft": true`: the map is then considered modified from the start, since it differs from the file.

### `save` — get the content to write

```json
{ "v": 1, "type": "save", "requestId": "r2" }
```

Response: `saveData` or `error`. The core does **not** consider the map saved at this point: it only records which revision of the map this content holds, under a `saveId` it creates (see section 6).

### `saved` — confirm a successful write

```json
{ "v": 1, "type": "saved", "saveId": 3 }
```

Send only after a successful write, with the `saveId` of the `saveData` whose bytes were written. The core returns to the "not modified" state and emits `dirtyChanged` **only if the map has not changed since that `save`**; otherwise it stays modified. A `saved` with an unknown or already confirmed `saveId`, or for a map that is no longer loaded, is ignored. If the write fails, the shell sends nothing: the map stays modified.

### `setReadOnly`

```json
{ "v": 1, "type": "setReadOnly", "readOnly": true }
```

Used for example after a detected conflict, to prevent further changes. `"readOnly": false` has no effect on a map that is read-only because of the file itself (format version or duplicate IDs, see `loaded`).

### `flushDraft`

```json
{ "v": 1, "type": "flushDraft" }
```

Asks for a draft of the current state right away, typically when the app goes to the background (`onPause` on Android). The core **always** answers with `draftData`, even if nothing changed since the last one: it cannot know whether that one reached the disk.

### `undo` / `redo`

```json
{ "v": 1, "type": "undo" }
{ "v": 1, "type": "redo" }
```

Undoes or redoes the last change, typically from the native menu. Ignored when there is nothing to undo or redo (see `historyChanged`). Undoing back to the last saved state makes the map unmodified again (`dirtyChanged`).

### `center`

```json
{ "v": 1, "type": "center" }
```

Scrolls the map so that the selected node, or the root when nothing is selected, is in the middle of the view (as far as the map extends). Useful on small screens. Not an edit: also available on a read-only map.

### `editText` / `addChild` / `addSibling` / `deleteNode`

```json
{ "v": 1, "type": "addChild", "id": "ID_1964929139" }
{ "v": 1, "type": "deleteNode", "id": "ID_1964929139", "revision": 12, "requestId": "r7" }
```

Editing commands from the native menu. Each names its target node, `id`, taken from the latest `selectionChanged`: a selection change between the menu and the command cannot redirect it. They are ignored when the map is read-only. A command whose node no longer exists is refused with `OUTDATED_COMMAND`.

- `editText` opens the text editor on the selected node, if its text can be edited.
- `addChild` and `addSibling` add a node and open its editor at once. The node is created in the map only when its text is validated: validating the placeholder unchanged removes it, and the map stays unmodified.
- `deleteNode` removes the node and its whole branch, without asking: **the shell asks for confirmation first** when `selectionChanged` reports hidden content in the branch, with a summary such as "Delete this node, 3 sub-nodes, 1 note and 2 icons?". Deleting can be undone.
- `deleteNode` also sends back the `revision` of the `selectionChanged` the decision was based on. If the map changed since (an undo may have put a note back into the branch, for instance), the deletion is refused with `OUTDATED_COMMAND`: the shell then uses the latest `selectionChanged` and asks again if needed. The check is deliberately strict: any change invalidates it.

## 5. Core → shell messages

### `ready` — core loaded, ready to receive

```json
{ "v": 1, "type": "ready", "coreVersion": "1.0.0" }
```

The shell sends no message before `ready`.

### `loaded`

```json
{ "v": 1, "type": "loaded", "requestId": "r1",
  "nodeCount": 412, "readOnlyNodes": 7, "readOnly": false,
  "mapVersion": "freeplane 1.12.15", "hiddenContent": ["note", "icon"], "warnings": [] }
```

- `readOnlyNodes`: number of nodes whose **text** cannot be edited (rich text, multi-line text). These nodes can still be moved, deleted, or given children.
- `readOnly`: whether the **whole map** is read-only: nothing can be changed, either because the shell asked for it in `load` or because of its format version (see below).
- `mapVersion`: the `version` attribute of `<map>`, as found in the file.
- `hiddenContent`: kinds of content present in the map but not displayed by Mapling, and kept intact. The shell tells the user once when opening the map (e.g. "This map contains notes and icons that are not shown. They are kept."). Kinds, always in this order: `note`, `details`, `attribute`, `link`, `icon`, `connector`, `image`. Images and link targets inside rich text count too, since rich text is shown as plain text. Formatting (fonts, colors, clouds, edge styles) is not reported.
- `warnings`: non-blocking notices, each an object with a stable `code`. The shell displays them translated from the `code`.

| Warning code | Meaning | Effect |
|---|---|---|
| `FORMAT_TOO_OLD` | Written by FreeMind or by a Freeplane version older than the supported range | Map opened read-only. Suggest opening and saving it with a recent Freeplane |
| `FORMAT_TOO_NEW` | Written by a Freeplane version newer than the supported range | Map opened read-only. Suggest checking for a Mapling update |
| `DUPLICATE_IDS` | Two nodes share the same `ID`, so edits could reach the wrong node | Map opened read-only. Suggest opening and saving it with Freeplane |

Example:

```json
{ "v": 1, "type": "loaded", "requestId": "r1",
  "nodeCount": 35, "readOnlyNodes": 0, "readOnly": true, "mapVersion": "0.9.0",
  "hiddenContent": [], "warnings": [ { "code": "FORMAT_TOO_OLD" } ] }
```

The core only modifies format versions it has been tested against, and only maps whose node IDs are unique. A read-only state caused by the file itself cannot be lifted by the shell.

### `saveData`

```json
{ "v": 1, "type": "saveData", "requestId": "r2", "saveId": 3, "data": "<base64 of the bytes>" }
```

`saveId` identifies this content. The core creates it and never reuses it, even across maps, so a confirmation can never apply to content it did not produce, whatever the shell's `requestId` values. The shell sends it back unchanged in `saved`.

### `dirtyChanged`

```json
{ "v": 1, "type": "dirtyChanged", "dirty": true }
```

Emitted on every state change. The shell uses it to enable "Save" and to warn before quitting.

### `draftData`

```json
{ "v": 1, "type": "draftData", "revision": 7, "data": "<base64 of the bytes>" }
{ "v": 1, "type": "draftData", "revision": 8, "data": null }
```

The current state of the loaded map, to be kept as a local draft (see section 6). Sent one second after the first change not yet sent (later changes do not postpone it, so drafts keep coming during continuous editing, at most one per second), and at once on `flushDraft`. `data: null` means the map is no longer modified: delete the draft. A `draftData` always concerns the map currently loaded.

### `selectionChanged`

```json
{ "v": 1, "type": "selectionChanged", "node": {
    "id": "ID_1964929139", "revision": 12, "root": false, "textEditable": true,
    "hidden": { "note": 1 },
    "branch": { "descendants": 3, "hidden": { "note": 1, "icon": 2 } } } }
{ "v": 1, "type": "selectionChanged", "node": null }
```

Sent whenever what the shell knows about the selected node changes: another node is selected, the map changed (new `revision`), or the node was removed or became read-only. `node` is `null` when nothing is selected; every successfully loaded map starts with no selection (a failed load keeps the current one). The shell uses it to enable its commands:

| Field | Use |
|---|---|
| `id` | Target of the editing commands |
| `revision` | Revision of the map described here; sent back with `deleteNode` |
| `root` | The root cannot be deleted, and has no siblings: disable Delete and Add sibling |
| `textEditable` | Enable Edit text (false for rich or multi-line text, or a read-only map). In an editable map, false means the node shows a lock: explain it while it is selected (its text can only be edited in Freeplane; the node can still be moved or deleted) |
| `hidden` | Content of the node itself that is not displayed, by kind: what its dot stands for. Explain it while the node is selected (e.g. "1 note, 2 icons, kept") |
| `branch.descendants` | Number of nodes under the selected one, removed with it |
| `branch.hidden` | Content of the branch that is not displayed, by kind (same kinds as `hiddenContent`), including connectors from elsewhere pointing into the branch. Ask for confirmation before `deleteNode` when it is not empty |

### `historyChanged`

```json
{ "v": 1, "type": "historyChanged", "canUndo": true, "canRedo": false }
```

Emitted whenever the possibility to undo or redo changes. The shell uses it to enable its Undo and Redo commands. The history is cleared on every `load`.

### `error`

```json
{ "v": 1, "type": "error", "requestId": "r1",
  "code": "PARSE_ERROR", "message": "…" }
```

`requestId` is absent for an error not tied to a request.

`code` is stable and is what the shell uses to display a translated message to the user. `message` is a technical detail in English, intended for logs.

| Code | Meaning |
|---|---|
| `PARSE_ERROR` | Unreadable file or invalid XML |
| `NOT_A_MAP` | Valid XML but not a map (`<map>` missing) |
| `UNSUPPORTED_ENCODING` | Unsupported encoding |
| `NO_MAP_LOADED` | `save` received with no map loaded |
| `PROTOCOL_VERSION` | Unsupported `v` version |
| `OUTDATED_COMMAND` | An editing command targets a node that no longer exists, or a deletion was confirmed before the map changed |
| `INTERNAL` | Unexpected core error |

## 6. Typical lifecycle

```
Shell                            Core
   │  (loads the WebView)          │
   │ ◄──────────── ready ──────────│
   │── load (r1) ─────────────────►│
   │ ◄─────────── loaded (r1) ─────│
   │          … the user edits …
   │ ◄──── dirtyChanged(true) ─────│
   │── save (r2) ─────────────────►│
   │ ◄────────── saveData (r2) ────│
   │  checks for conflict, writes   │
   │  the bytes                     │
   │── saved (saveId) ────────────►│
   │ ◄──── dirtyChanged(false) ────│
```

### Saves, concurrent edits and map changes

The user may keep editing while a save is being written, or open another map before it completes. The core therefore ties each `save` to the revision it holds:

- the core counts revisions: every change to the map creates a new one, and numbering continues across loaded maps, so a revision never designates two different maps (even a reloaded version of the same document);
- `save` records the current revision under a new `saveId`, returned in `saveData`;
- `saved` marks the map unmodified only if its revision is still the one recorded; any later change keeps it modified;
- every `load` starts a new session: confirmations of saves made in a previous session are ignored.

```
Shell                            Core
   │── save (r2) ─────────────────►│  revision 5 recorded as saveId 3
   │ ◄──── saveData (r2, saveId 3) │
   │  writing…    (user edits)     │  revision 6, still dirty
   │── saved (saveId 3) ──────────►│  5 ≠ 6: stays dirty, no dirtyChanged
```

### Drafts: recovering unsaved changes

A mobile system may kill a backgrounded app without notice, and a phone may crash or run out of battery. Unsaved changes are therefore kept in a local draft, without ever writing the document itself. What can be recovered is **the last draft actually written**: the window of loss is reduced to about a second plus the write time, not removed.

- The core sends `draftData` at most one second after any change, and on `flushDraft`.
- **The shell owns persistence.** It keeps only the latest `draftData` received, and a single writer persists it (write or delete) until it succeeds; a newer message replaces the pending one. So a failed write is retried with the latest state, and an older write can never recreate a deleted draft. No acknowledgement goes back to the core.
- Each write is atomic (temporary file, then rename) and stored in private storage with the document it belongs to, the time of the draft, and what the draft is based on: the document's content as last read or successfully saved. A fingerprint of that content is more reliable than a modification date, which some providers (Google Drive) only update once their upload ends, minutes later when offline.
- A restored draft keeps what it was based on, so that a change made elsewhere is still reported if it is restored again. After a successful save, the shell takes the bytes written as the new basis and sends `flushDraft`: a draft left by later changes is then rewritten on that basis, even if no further change follows.
- `draftData` with `data: null` means the map is unmodified again (saved, or changes undone): the draft is deleted.
- If drafts cannot be written for a while (e.g. storage full), the shell tells the user that unsaved changes are not protected.
- When a document with a draft is opened again, the shell offers to restore or discard it, and says so if the document changed since. Restoring is a `load` of the draft with `"restoredDraft": true`.

## 7. Shell obligations

- [ ] Define `window.MindShell.send` before the core is loaded.
- [ ] Wait for `ready` before sending any message.
- [ ] Pass the file's bytes **untransformed** (no decoding, no line-ending normalization).
- [ ] Before writing: check that the document still holds what the map is based on (its content as last read or saved, compared by fingerprint: modification dates are unreliable, see section 6). If it was changed elsewhere, do not write: let the user save a copy elsewhere (keeping both versions), overwrite, or cancel.
- [ ] Send `saved` only after a confirmed write, with the `saveId` of the `saveData` whose bytes were written.
- [ ] Remember which document each `save` belongs to, and write its bytes to that document only, even if another map was opened meanwhile.
- [ ] Write one save at a time per document, in request order, and send the `saved` confirmations in that order: the last confirmation must match what the file holds.
- [ ] Warn the user before quitting, closing the map or opening another one if `dirty` is true.
- [ ] Keep only the latest `draftData`; persist it with a single writer (atomic write, or delete on `data: null`), retrying until it succeeds; delete the draft when the user discards the changes.
- [ ] Tell the user when drafts cannot be written.
- [ ] Send `flushDraft` when the app goes to the background.
- [ ] When opening a document that has a draft, offer to restore or discard it, and warn if the document changed since the draft.
- [ ] Display error messages from the `code`, translated in the user's language; never show `message` as-is.
- [ ] Display `loaded` warnings from their `code`, translated; when `readOnly` is true, hide or disable editing and saving.
- [ ] Tell the user once, when a map opens, about its `hiddenContent` (kept but not displayed).
- [ ] Enable the Undo and Redo commands according to `historyChanged`, and the editing commands according to `selectionChanged`.
- [ ] While a node with a lock or a dot is selected, explain what the mark means (`textEditable`, `hidden`), without taking room otherwise. The core's stylesheet offers the same marks for that (`.mapling-lock-mark`, `.mapling-dot-mark`).
- [ ] Ask for confirmation before `deleteNode` when the selected branch holds hidden content, with a translated summary; send the node's `id` and the `revision` the confirmation was based on, and ask again on `OUTDATED_COMMAND`.
- [ ] Serve the core's resources locally; no network access.

## 8. Reference implementation

The web shell in [`web/`](../web/) implements this contract end to end, in a desktop browser: when in doubt, its behavior is the reference. It is plain JavaScript, with no build step:

| File | Role |
|---|---|
| `web/index.html` | The page: toolbar, messages, and the `#mapling` element the core draws in. It loads `shell.js` (which defines `window.MindShell`), then jsMind, then the core (`core/dist/main.js`). |
| `web/shell.js` | Opening a file, the messages of sections 4 and 5, enabling commands, confirmations, explanations of the marks, translations. |
| `web/drafts.js` | Draft storage, tested in Node (`web/test/drafts.test.js`). |
| `web/i18n/*.json` | The shell's texts, in English and French. |

What a browser cannot do, and how the web shell deals with it (a native shell does better):

- **Writing the opened file**: a page can only offer a download. The shell calls it *Download a copy*, and sends `saved` only when the user confirms the copy is saved: until then the map stays modified and its draft is kept.
- **Identifying a document**: a page gets a file's name, not its path. Drafts are tied to the name and to a SHA-256 fingerprint of the opened content; a draft made on another file with the same name is offered with a warning, and kept if declined.
- **Durable storage**: drafts are kept in `localStorage`, which the user or the browser may clear.
- **Conflicts**: there is no document to check, so section 7's obligation about them does not apply.
