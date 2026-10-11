# AGENTS.md

Mapling: a minimalist viewer/editor for Freeplane/FreeMind mind maps (`.mm`) on Android, built on a platform-neutral JS core that renders with jsMind inside a WebView.

Read `docs/BRIDGE.md` (core ↔ shell contract) before working on the core or a shell. `docs/ARCHITECTURE.md` describes the internals of the core.

## Non-negotiable rules

- The DOM of the `.mm` file is the only source of truth. jsMind only displays the map and captures interactions; its export is never used.
- No information loss on save. Only change what the operation touches; every other element and attribute stays intact.
- `core/` contains no reference to any platform (Android, iOS, native objects). It only knows the contract in `docs/BRIDGE.md`.
- No network access at runtime: all resources are bundled locally.
- Never modify files in `fixtures/` or `fixtures-private/`.
- Code, identifiers, comments, commit messages and documentation are in English.
- License: GPL-3.0-or-later with the App Store exception (`LICENSE`, `LICENSE-EXCEPTION.md`). Every source file starts with the SPDX header described in `CONTRIBUTING.md`. Any bundled third-party code keeps its own license and copyright notice.
- No hard-coded user-facing text: every visible string goes through translation. The core aims to display no UI text at all (errors are codes, menus are native).

## Guiding principle: simplicity is the ultimate sophistication

- Prefer the simplest solution that fully works. Less code, fewer layers, fewer dependencies.
- Reuse before writing: the platform, the standard library, existing code in the repository.
- Write code a newcomer can understand at first reading: clear names, small functions, obvious data flow. No cleverness for its own sake.
- No speculative abstraction or configuration: build what the current milestone needs.
- When a change makes code more complex, look for a simpler design first.

## Working method

- For any library API (jsMind in particular), check the documentation or the source code of the pinned version; do not assume.
- Ask before adding a dependency.
- Every change to `core/` comes with tests; round-trip tests on the fixtures must always pass.

## Repository layout

```
core/              core: .mm model, operations, bridge, jsMind view; Node tests
  vendor/          jsMind 0.9.1, pinned (BSD-3-Clause, keeps its license)
  assets/          stylesheet of the map view
web/               reference web shell (open a local file, download a copy); drafts tested in Node
android/           Kotlin shell (WebView + Storage Access Framework), see android/README.md
ios/               not started, contributions welcome
docs/              public documentation (English)
fixtures/          public test maps (never modify)
fixtures-private/  real user maps, git-ignored; tests use them only if present
```

## Commands

Requires Node 24 or later (runs TypeScript tests natively).

```
npm install     # dev dependencies only: typescript, @xmldom/xmldom
npm test        # tests (node:test): core, with round trips on every fixture, and web shell drafts
npm run check   # type check (tsc --noEmit)
npm run build   # compile core/src to core/dist (ES modules for the WebView)
```

Core code uses only DOM Level 2 APIs (`childNodes`, `getAttribute`, `insertBefore`…), so that it runs both in browsers and on xmldom in tests: no `querySelector`, no `Element.remove()`.
