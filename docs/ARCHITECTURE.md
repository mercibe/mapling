# Architecture

This page describes the inside of the core (`core/`). To write a shell, read [BRIDGE.md](BRIDGE.md) instead: it is all a shell needs.

```
┌────────────────────────────┐
│ Shell (Android, iOS, Web)  │  opens and writes documents, native UI, drafts on disk
└─────────────▲──────────────┘
              │ JSON messages (BRIDGE.md)
┌─────────────┴──────────────┐
│ bridge.ts                  │  protocol, saves, drafts, modified state
│ session.ts                 │  open map + undo history + revisions
│ map.ts                     │  the .mm DOM: index, projection, operations
│ xml.ts · format.ts · …     │  parsing/serialization, format versions
├────────────────────────────┤
│ jsMind (view adapter)      │  display and gestures only (milestone 2)
└────────────────────────────┘
```

## Principles

- **The DOM of the `.mm` file is the only source of truth.** The file is parsed into a full DOM; every change is an operation on that DOM, and saving serializes it. jsMind only receives a projection to display, and its own export is never used.
- **Only what an operation touches changes.** Unknown elements and attributes (styles, notes, icons, connectors, hooks…) stay exactly as loaded.
- **The core knows no platform.** It runs in any browser engine and in Node (tests). The shell's `send` function and the view are passed to the bridge.
- **Simplicity first**: few modules, no build step beyond `tsc`, no runtime dependency besides jsMind.

## Modules (`core/src`)

| Module | Role |
|---|---|
| `xml.ts` | Parses with the platform `DOMParser` and serializes with `XMLSerializer`, plus the few rules that make the output identical to Freeplane's (no-break space and line breaks in attributes, text around the root element). Comments, CDATA and processing instructions are left untouched. |
| `format.ts` | Classifies the `<map version>`: only Freeplane versions covered by a fixture are editable; older (FreeMind included) and newer ones open read-only. |
| `map.ts` | `MindMap`: indexes `<node>` elements by `ID` (or by an in-memory key for nodes without one), projects them for the view, detects hidden content, and implements the operations: edit text, add, remove, move. |
| `html-text.ts` | Plain-text rendering of rich (HTML) nodes, for display only. |
| `session.ts` | `MapSession`: the open map, its undo/redo history and its revisions. |
| `bridge.ts` | `Bridge`: the core side of BRIDGE.md: messages, bytes ↔ text (UTF-8), saves and drafts. |
| `errors.ts` | `MapError` and its codes. |

## Key mechanisms

**Node keys.** A node's key is its `ID` attribute. Nodes without one (old formats) or with a duplicated one get an in-memory key that can never collide with a real `ID`. Maps with duplicated IDs open read-only.

**Operations keep Freeplane's layout.** Each `<node>` stays on its own line; `POSITION` is set only on children of the root and placed before `ID`, as Freeplane orders attributes; new IDs follow Freeplane's `ID_<number>` format and never reuse an existing one, style nodes included.

**Two kinds of read-only.** A *read-only map* cannot change at all (unsupported format, duplicate IDs, or the shell's request). A node with *non-editable text* (rich text, multi-line text, no `TEXT`) can still be moved, removed or given children, since that loses nothing.

**Hidden content.** The core reports content it does not display (notes, details, attributes, links, icons, connectors, images, including images and link targets inside rich text) per node, per map, and per branch before deletion. Formatting is not reported.

**Undo by snapshots.** Before each operation, the session keeps the serialized map; undo reloads it. This is exact by construction, with no inverse operation to write. The history is limited to 50 states and cleared on load.

**Revisions.** Every change creates a new revision number, never reused. The map is modified when its revision differs from the saved one, so undoing back to the saved state makes it unmodified again.

**Saves.** Each `save` gets a `saveId` created by the core and tied to the revision it holds. A `saved` confirmation marks the map unmodified only if nothing changed since; unknown, repeated or stale confirmations are ignored.

**Drafts.** At most one second after any change, the core sends the current state as a draft; the shell persists the latest one and retries on failure. This bounds, but does not remove, what can be lost if the app is killed.

## Tests (`core/test`)

- Run in Node with `node:test`; xmldom provides `DOMParser`/`XMLSerializer`. Core code therefore uses only DOM Level 2 APIs (no `querySelector`, no `Element.remove()`).
- Every fixture is round-tripped at two levels: same meaning (canonical comparison) always, same bytes for public fixtures. Real maps in the git-ignored `fixtures-private/` are used when present.
- Operation tests compare the whole expected file, so any change outside the intended fragment fails.
- The same scenarios have been checked to give identical results in Chromium, the engine of Android's WebView.
