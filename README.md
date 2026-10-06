# mapling

Your Freeplane mind maps on your Android phone or tablet. Open `.mm` files from Google Drive or any storage, view and lightly edit them, and save back without losing anything Freeplane wrote.

## Status

**Work in progress: the app is not usable yet.**

- Done: the platform-neutral core. It loads a map, applies edits (text, add, remove, move), undoes them, and writes the file back with no information loss: on our test maps, an unedited map is written back byte for byte.
- Next: a reference web shell with the map display (milestone 2), then the Android app.

Supported format: maps written by Freeplane 1.12. Older (FreeMind included) and newer formats open read-only.

## Principles

- The `.mm` file is the only source of truth: only what you edit changes; notes, icons, styles and everything else are kept as they are.
- No network access, no account, no tracking: the app opens and writes your documents through the system's document picker.
- A small core shared by all platforms, with thin native shells around it.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): how the core works.
- [Bridge contract](docs/BRIDGE.md): everything needed to write a new shell (Android, iOS, web).
- [Contributing](CONTRIBUTING.md): workflow, license of contributions, file headers.

## Development

Requires Node 24 or later.

```
npm install     # dev dependencies only: typescript, @xmldom/xmldom
npm test        # core tests, including round trips on every test map in fixtures/
npm run check   # type check
npm run build   # compile the core to core/dist
```

## License

GPL-3.0-or-later, with an additional permission for distribution through app stores: see [LICENSE](LICENSE) and [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md).

Uses [jsMind](https://github.com/hizzgdev/jsmind) (BSD-3-Clause). mapling is not affiliated with the Freeplane project.
