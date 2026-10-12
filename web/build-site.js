// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Assembles the web shell into a self-contained static folder (default: web/dist),
// ready to be served under any path: every link is relative, nothing is fetched
// from the network. Run by `npm run build:web`, after `npm run build`.
//
// Layout: the repository's, flattened by one level: the shell at the root, the core
// under core/ (as the Android shell serves it), the licenses and the privacy policy
// beside the shell. jsMind keeps its own license in core/vendor/. The .htaccess
// gives Apache the right media types.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'web', 'dist');

if (!existsSync(join(root, 'core', 'dist', 'main.js'))) {
  throw new Error('The core is not built: run `npm run build` first.');
}

rmSync(out, { recursive: true, force: true });
for (const file of ['shell.js', 'drafts.js', 'i18n', '.htaccess']) {
  cpSync(join(root, 'web', file), join(out, file), { recursive: true });
}
for (const dir of ['dist', 'assets', 'vendor']) {
  cpSync(join(root, 'core', dir), join(out, 'core', dir), { recursive: true });
}
for (const file of ['LICENSE', 'LICENSE-EXCEPTION.md', 'PRIVACY.md']) {
  cpSync(join(root, file), join(out, file));
}

// In the repository, the page reaches the core and the licenses one level up
// (../core/, ../LICENSE); here, beside it.
const page = readFileSync(join(root, 'web', 'index.html'), 'utf8').replaceAll('"../', '"');
writeFileSync(join(out, 'index.html'), page);

const missing = [...page.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((path) => !path.includes(':') && !existsSync(join(out, path))); // links to the Web aside
if (missing.length > 0) throw new Error(`Missing in ${out}: ${missing.join(', ')}`);

console.log(`Web shell assembled in ${out}`);
