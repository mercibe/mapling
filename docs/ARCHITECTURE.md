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
│ jsmind-view.ts + jsMind    │  display and gestures only
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
| `xml.ts` | Parses with the platform `DOMParser` and serializes with `XMLSerializer`, plus the few rules that make the output identical to Freeplane's (no-break space; line breaks and apostrophes in attributes; text around the root element). Comments, CDATA and processing instructions are left untouched. |
| `format.ts` | Classifies the `<map version>`: only Freeplane versions covered by a fixture are editable; older (FreeMind included) and newer ones open read-only. |
| `map.ts` | `MindMap`: indexes `<node>` elements by `ID` (or by an in-memory key for nodes without one), projects them for the view, detects hidden content, and implements the operations: edit text, add, remove, move. |
| `html-text.ts` | Plain-text rendering of rich (HTML) nodes, for display only. |
| `localized-text.ts` | Texts Freeplane provides itself (`LOCALIZED_TEXT`, e.g. the root of a new map), in the user's language. |
| `jsmind-view.ts` | The view: displays the map with jsMind and turns gestures into operations (browser only). |
| `touch.ts` | Touch gestures on top of jsMind: moving only the selected node, after a short hold; pinching to zoom the map. |
| `main.ts` | Entry point in the page: connects the core to the shell's `MindShell`. |
| `session.ts` | `MapSession`: the open map, its undo/redo history and its revisions. |
| `bridge.ts` | `Bridge`: the core side of BRIDGE.md: messages, bytes ↔ text (UTF-8), saves and drafts. |
| `errors.ts` | `MapError` and its codes. |

## Key mechanisms

**Node keys.** A node's key is its `ID` attribute. Nodes without one (old formats) or with a duplicated one get an in-memory key that can never collide with a real `ID`. Maps with duplicated IDs open read-only.

**Operations keep Freeplane's layout.** Each `<node>` stays on its own line; `POSITION` is set only on children of the root and placed before `ID`, as Freeplane orders attributes; new IDs follow Freeplane's `ID_<number>` format and never reuse an existing one, style nodes included.

**Two kinds of read-only.** A *read-only map* cannot change at all (unsupported format, duplicate IDs, or the shell's request). A node with *non-editable text* (rich text, multi-line text, no `TEXT`) can still be moved, removed or given children, since that loses nothing.

**Hidden content.** The core reports content it does not display (notes, details, attributes, links, icons, connectors, images, including images and link targets inside rich text) per node, per map, and per branch before deletion. Formatting is not reported.

**Undo by snapshots.** Before each operation, the session keeps the serialized map; undo reloads it. This is exact by construction, with no inverse operation to write. The history is limited to 50 states and cleared on load.

**Revisions.** Every change creates a new revision number, never reused, even across loaded maps: a revision designates one map and one state, so a deletion confirmed on a map cannot apply to its reloaded version. The map is modified when its revision differs from the saved one, so undoing back to the saved state makes it unmodified again.

**Saves.** Each `save` gets a `saveId` created by the core and tied to the revision it holds. A `saved` confirmation marks the map unmodified only if nothing changed since; unknown, repeated or stale confirmations are ignored.

**Drafts.** At most one second after any change, the core sends the current state as a draft; the shell persists the latest one and retries on failure. This bounds, but does not remove, what can be lost if the app is killed.

## The view (`jsmind-view.ts`)

jsMind 0.9.1 (vendored in `core/vendor/`) draws the map and captures gestures, but never owns the map:

- **Display**: the bridge gives the view a projection of the map (`ViewNode`). After an undo or redo, the view redraws it while keeping selection and scroll position (folding comes from the map itself); after a load, it starts afresh.
- **Gestures**: jsMind reports edits after changing its own model. Only two come from the user: editing a text (`update_node`) and dragging a node (`move_node`). Folding and unfolding (`collapse_node`, `expand_node`) are changes of the map too, as in Freeplane: they are written (`FOLDED="true"` right after the text, removed once unfolded; MODIFIED stays), undone and saved; in a read-only map they only change what is shown. For a move, the view reads the result (new parent, position, side) from jsMind's model, since the event only carries the call's arguments. Every gesture becomes an operation on the map through the bridge; if one is refused, the view redraws from the map.
- **Commands** (add, delete, edit text, center) come from the shell's menu, through the bridge. A new node first exists only in the view, with a neutral placeholder; it is added to the map, in one operation with its text, when that text is validated. Validated unchanged, it simply disappears.
- **Workarounds** for jsMind (checked in its source): non-editable texts are guarded by wrapping `begin_edit`; jsMind's own shortcuts for adding and deleting are disabled, since they bypass these rules; Enter is also recognized by `event.key`, since jsMind only checks the legacy `keyCode` that virtual keyboards may leave at 0 or 229. jsMind sizes the text editor to the node it edits, which leaves a new node's "…" a tiny field: the view clears that width, and the stylesheet gives the editor a minimum of about fifteen characters, growing with the text where the browser supports `field-sizing`. jsMind keeps its zoom when another map is shown: the view sets it back to normal first. jsMind's centering misplaces a node once the map is zoomed (it scales layout coordinates, while the browser applies the CSS `zoom` property differently): the view centers a node from where it is actually displayed. Links join a node's underline, as in Freeplane: jsMind joins them to the middle of a node, so the stylesheet moves each node but the root up by half its height, and the view replaces jsMind's layout of children with the same algorithm reserving a node's whole height above the joint (otherwise a tall node would cover the one above it).
- **Touch** (`touch.ts`): jsMind's drag plugin moves any node a finger lands on, so scrolling would move nodes. On a touch screen, a node moves only if it is the selected one and the finger rests on it for 300 ms; any other slide scrolls the map. Two fingers zoom the map with jsMind's zoom, while CSS (`touch-action: pan-x pan-y`) keeps the browser from zooming the whole page. Moving and zooming never overlap: a move starts only under a single finger, and a second finger or an interrupted touch (`touchcancel`, which jsMind ignores) cancels it without applying it (the plugin's `dragend` applies a move only when `moved` is set; the cancellation also forgets the node and target of the move, which the plugin only clears when it applies one, so that a later move cannot fall back on an abandoned target). While a node is dragged, the map scrolls when the finger comes within 48 px of an edge (16 px per movement), a zone wide enough for a finger; jsMind's plugin reads the position for this zone only from `clientX`/`clientY`, which a touch event lacks, so its `drag` is given the finger's position (`withFinger`). The mouse keeps jsMind's behavior. The gesture state (`TouchGestures`) is tested in Node with a stand-in for the plugin, including these sequences; the gestures were validated on a phone.
- **Marks** are drawn by CSS (`core/assets/mapling.css`): a lock on non-editable texts, a dot on nodes with hidden content. They contain no text.
- **Icons** go before a node's text, the text as a block beside them, as in Freeplane: today only a web link's (`http`, `https`; see `webLink` in `map.ts`). Touching them opens the link through the shell (`openLink`), without selecting the node.
- **New maps**: `core/assets/new-map.mm` is what Freeplane 1.12 writes for a new map (`fixture05` without the nodes added after its creation), its root a text Freeplane provides itself (`new_mindmap`). A shell creates a map by writing these bytes to a new document, then opens it like any other; a test checks that it loads editable and is written back unchanged.

## Browser support

The core and jsMind run in Chromium 85 or later, the oldest version that has every JavaScript feature they use (the latest one being logical assignment, `??=`, in Chromium 85; jsMind itself needs static class fields, Chromium 72). The text editor is a text area that wraps as the node does, its height fitted by script on every version. The stylesheet uses two later CSS features only to size it more finely (`:has()`, Chromium 105; `field-sizing`, Chromium 123): without them, the editor takes a node's full width. DOM methods newer than Chromium 85 are avoided (`replaceChildren`, for instance, is Chromium 86). The Android shell checks the WebView's version at startup (`MIN_CHROMIUM`). Raising this minimum is a deliberate change: update this section and `MIN_CHROMIUM` together.

## Tests (`core/test`)

- Run in Node with `node:test`; xmldom provides `DOMParser`/`XMLSerializer`. Core code therefore uses only DOM Level 2 APIs (no `querySelector`, no `Element.remove()`).
- Every fixture is round-tripped at two levels: same meaning (canonical comparison) always, same bytes for public fixtures. Real maps in the git-ignored `fixtures-private/` are used when present.
- Operation tests compare the whole expected file, so any change outside the intended fragment fails.
- The same scenarios have been checked to give identical results in Chromium, the engine of Android's WebView.
- The view needs a browser, so it is not covered by `npm test`: it was validated end to end in Chromium through the reference web shell (gestures, commands, undo, drafts, all fixtures). Automating these checks would need a browser test tool, not added yet.
