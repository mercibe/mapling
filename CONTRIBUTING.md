# Contributing to Mapling

Contributions are welcome. This file will be expanded as the project takes shape.

## Workflow

Mapling follows the [GitHub flow](https://docs.github.com/en/get-started/using-github/github-flow):

- `main` is always stable: all tests pass and it could be released at any time. Nobody commits to it directly.
- Work happens on a short-lived branch per milestone or feature (e.g. `milestone-2-web-shell`, `task-icons`).
- Contributions reach `main` through a pull request, reviewed before merging. The maintainer may also merge their own branches locally, as a fast-forward (`git merge --ff-only`), once the work is validated.
- Releases are tags on `main` (`v0.1.0`, …).
- Commit messages are in English, in the imperative mood ("Add …", "Fix …"), with small, readable commits.
- Before opening a pull request or merging, run `npm test` and `npm run check`: every commit should pass them.

## License of contributions

Mapling is licensed under the GNU General Public License v3.0 or later
(`LICENSE`), with an additional permission that allows distribution through
application stores (`LICENSE-EXCEPTION.md`).

By submitting a contribution (pull request, patch or any other form), you agree
that it is licensed under these same terms, including the additional
permission. Do not submit code you are not entitled to license this way.

## Source file headers

Every source file starts with:

```
SPDX-FileCopyrightText: <year> <author>
SPDX-License-Identifier: GPL-3.0-or-later
```

The App Store exception applies to the whole repository (see
`LICENSE-EXCEPTION.md`); it is not repeated in each file.
