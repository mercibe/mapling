// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Plain-text rendering of a rich (HTML) node, for display only: the HTML in the
// file is never changed. Blocks and <br> become line breaks; empty lines are dropped.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const BLOCKS = new Set([
  'address', 'blockquote', 'div', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'table', 'tr', 'ul',
]);
const CELLS = new Set(['td', 'th']);
const SKIPPED = new Set(['head', 'script', 'style']);

/** Line breaks, tabs and spaces collapse as in HTML; the no-break space is kept. */
const HTML_WHITESPACE = /[ \t\n\r\f]+/g;

export function htmlToText(root: Element): string {
  let out = '';
  const walk = (node: Node): void => {
    if (node.nodeType === TEXT_NODE) {
      out += (node.nodeValue ?? '').replace(HTML_WHITESPACE, ' ');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const name = (node as Element).tagName.toLowerCase();
    if (SKIPPED.has(name)) return;
    if (name === 'br') {
      out += '\n';
      return;
    }
    const block = BLOCKS.has(name);
    if (block) out += '\n';
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) out += '\n';
    if (CELLS.has(name)) out += ' ';
  };
  walk(root);
  return out
    .split('\n')
    .map((line) => line.replace(/^ +| +$/g, ''))
    .filter((line) => line !== '')
    .join('\n');
}
