# mapling

Your Freeplane mind maps on your Android phone or tablet. Open `.mm` files from Google Drive or any storage, view and lightly edit them, and save back without losing anything Freeplane wrote.

## Status

**Work in progress: the Android app does not exist yet.**

- Done: the platform-neutral core. It loads a map, applies edits (text, add, remove, move), undoes them, and writes the file back with no information loss: on our test maps, an unedited map is written back byte for byte.
- Done: a reference web shell, to try mapling in a desktop browser (see below).
- Next: the Android app.

Supported format: maps written by Freeplane 1.12. Older (FreeMind included) and newer formats open read-only.

## Try it in a browser

```
npm install
npm run build
python3 -m http.server 8765    # or any static file server, from the repository root
```

Then open <http://localhost:8765/web/>, and open a `.mm` file (for instance from `fixtures/`).

- Select a node by clicking it; edit its text by double-clicking it (or F2, or the Edit text button); add, delete, undo and redo with the toolbar; drag a node onto another to move it.
- A small lock marks a text that can only be edited in Freeplane (rich or multi-line text); a small dot marks content that is kept but not shown (notes, icons, links…). Select the node to see what it holds.
- A browser cannot write to the file you opened: *Download a copy* saves the result, and the map counts as saved only once you confirm the copy is where you want it. Until then, unsaved changes are kept as a draft in the browser.
- Touch gestures (double tap, long press, pinch) are not handled yet; they will come with the Android app.

## Principles

- The `.mm` file is the only source of truth: only what you edit changes; notes, icons, styles and everything else are kept as they are.
- No network access, no account, no tracking: the app opens and writes your documents through the system's document picker.
- A small core shared by all platforms, with thin native shells around it.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): how the core and its map view work.
- [Bridge contract](docs/BRIDGE.md): everything needed to write a new shell (Android, iOS, web).
- [Contributing](CONTRIBUTING.md): workflow, license of contributions, file headers.

## Development

Requires Node 24 or later.

```
npm install     # dev dependencies only: typescript, @xmldom/xmldom
npm test        # tests: core (round trips on every test map in fixtures/) and web shell drafts
npm run check   # type check
npm run build   # compile the core to core/dist
```

## License

GPL-3.0-or-later, with an additional permission for distribution through app stores: see [LICENSE](LICENSE) and [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md).

Uses [jsMind](https://github.com/hizzgdev/jsmind) (BSD-3-Clause). mapling is not affiliated with the Freeplane project.
