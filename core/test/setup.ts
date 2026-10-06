// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Node has no DOMParser/XMLSerializer: install xmldom's, silenced, as globals.
// The round-trip tests check that it writes the fixtures exactly as browsers do.

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const g = globalThis as Record<string, unknown>;
g.DOMParser = class extends DOMParser {
  constructor() {
    super({ onError: () => {} });
  }
};
g.XMLSerializer = XMLSerializer;

/** Every .mm file of fixtures/ and, when present, of the git-ignored fixtures-private/. */
export function fixtures(): { name: string; text: string }[] {
  const result = [];
  for (const dir of ['fixtures', 'fixtures-private']) {
    const path = new URL(`../../${dir}/`, import.meta.url);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path).filter((n) => n.endsWith('.mm')).sort()) {
      result.push({ name: `${dir}/${name}`, text: readFileSync(new URL(name, path), 'utf8') });
    }
  }
  return result;
}

export function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8');
}

/**
 * Canonical form of an XML text, for "same meaning" comparisons: attribute order
 * is ignored, adjacent text and CDATA are merged, everything else is kept.
 */
export function canonical(text: string): string {
  const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml');
  const out: string[] = [];
  let pendingText = '';
  const flush = () => {
    if (pendingText) out.push('#text ' + JSON.stringify(pendingText));
    pendingText = '';
  };
  const walk = (node: any): void => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      pendingText += node.nodeValue;
      return;
    }
    flush();
    if (node.nodeType === 1) {
      const attrs = Array.from(node.attributes as ArrayLike<{ name: string; value: string }>)
        .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
        .sort();
      out.push(`<${node.tagName} ${attrs.join(' ')}>`);
      for (const child of Array.from(node.childNodes)) walk(child);
      flush();
      out.push(`</${node.tagName}>`);
    } else if (node.nodeType === 7) {
      out.push(`<?${node.target} ${node.data}?>`);
    } else if (node.nodeType === 8) {
      out.push(`<!--${node.data}-->`);
    }
  };
  walk(doc.documentElement);
  flush();
  return out.join('\n');
}
