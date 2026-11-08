// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Assembles the web shell into a self-contained static folder (default: web/dist),
// ready to be served under any path: every link is relative, nothing is fetched
// from the network. Run by `npm run build:web`, after `npm run build`.
//
// Layout: the repository's, flattened by one level: the shell at the root, the core
// under core/ (as the Android shell serves it), the licenses and the privacy policy
// beside the shell. jsMind keeps its own license in core/vendor/, the icons theirs in
// android/ (shared with the Android shell). The .htaccess gives Apache the right
// media types.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'web', 'dist');

if (!existsSync(join(root, 'core', 'dist', 'main.js'))) {
  throw new Error('The core is not built: run `npm run build` first.');
}

rmSync(out, { recursive: true, force: true });
for (const file of ['shell.js', 'drafts.js', 'icons.svg', 'favicon.svg', 'i18n', '.htaccess']) {
  cpSync(join(root, 'web', file), join(out, file), { recursive: true });
}
for (const dir of ['dist', 'assets', 'vendor']) {
  cpSync(join(root, 'core', dir), join(out, 'core', dir), { recursive: true });
}
for (const file of ['LICENSE', 'LICENSE-EXCEPTION.md', 'PRIVACY.md', 'android/LICENSE-material-symbols.txt']) {
  cpSync(join(root, file), join(out, file));
}

// The version shown in About, as on Android: "1.0.0 (v1.0.0-3-g2b7e7be*, 2026-11-02)"
// (`*`: uncommitted changes; the date is the commit's). Without Git, the version alone.
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const details = [git('describe', '--tags', '--always', '--dirty=*'), git('log', '-1', '--format=%cs')]
  .filter(Boolean).join(', ');
const fullVersion = details ? `${version} (${details})` : version;

// In the repository, the page reaches the core and the licenses one level up
// (../core/, ../LICENSE); here, beside it.
const page = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  .replaceAll('"../', '"')
  .replace('data-version=""', `data-version="${fullVersion}"`);
writeFileSync(join(out, 'index.html'), page);

const missing = [...page.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1].split('#')[0]) // icons.svg#menu: the file
  .filter((path) => !path.includes(':') && !existsSync(join(out, path))); // links to the Web aside
if (missing.length > 0) throw new Error(`Missing in ${out}: ${missing.join(', ')}`);

console.log(`Web shell assembled in ${out}`);
