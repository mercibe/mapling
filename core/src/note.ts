// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// The HTML of a note, copied into the page to be shown: only what can neither run code
// nor reach the network. The note in the file is never changed.

import { webLink } from './map.ts';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// What a note may show: text formatting, lists, tables, web links. Any other element
// gives its content only (an image, which Mapling cannot reach, gives nothing); these
// give nothing at all.
const KEPT = new Set([
  'a', 'b', 'big', 'blockquote', 'br', 'caption', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em',
  'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'small', 'span',
  'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul',
]);
const DROPPED = new Set(['head', 'script', 'style', 'title']);
const ATTRIBUTES = new Set([
  'align', 'valign', 'colspan', 'rowspan', 'width', 'border', 'cellpadding', 'cellspacing',
  'color', 'face', 'size', 'start', 'type', 'style', 'href',
]);

// Styles a note may keep: text, colors, sizes and boxes, nothing that places an element
// elsewhere (position, transform…), so that it stays inside the note's panel.
const SIDES = ['', '-top', '-right', '-bottom', '-left'];
const STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-align', 'text-decoration', 'vertical-align', 'width',
  ...SIDES.flatMap((side) => [`margin${side}`, `padding${side}`, `border${side}`,
    `border${side}-style`, `border${side}-width`, `border${side}-color`]),
]);
// Words, numbers with units, #colors, commas: no function (url(), var()…), escape, quote or comment.
const STYLE_VALUE = /^[\w\s#%.,-]+$/;

/** The declarations of a style attribute that STYLE_PROPERTIES and STYLE_VALUE allow. */
function safeStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (colon > 0 && STYLE_PROPERTIES.has(property) && STYLE_VALUE.test(value)) kept.push(`${property}: ${value}`);
  }
  return kept.join('; ');
}

/**
 * Copies the HTML of a note into `target`, an element of the page, keeping only what KEPT
 * and ATTRIBUTES allow: a link keeps its address only if it is a web one (http, https), a
 * style only its safe declarations (safeStyle).
 */
export function copySafeHtml(source: Element, target: Element): void {
  const doc = target.ownerDocument as Document;
  for (const node of Array.from(source.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      target.appendChild(doc.createTextNode(node.nodeValue ?? ''));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const el = node as Element;
    const name = el.tagName.toLowerCase();
    if (DROPPED.has(name)) continue;
    if (!KEPT.has(name)) {
      copySafeHtml(el, target);
      continue;
    }
    const copy = doc.createElement(name);
    for (const { name: attribute, value } of Array.from(el.attributes)) {
      const key = attribute.toLowerCase();
      if (!ATTRIBUTES.has(key)) continue;
      if (key === 'href' && (name !== 'a' || !webLink(value))) continue;
      const kept = key === 'style' ? safeStyle(value) : value;
      if (kept) copy.setAttribute(key, kept);
    }
    copySafeHtml(el, copy);
    target.appendChild(copy);
  }
}

/** The formats of the Markdown bar (docs/BRIDGE.md, formatNote). */
export type NoteFormat = 'bold' | 'italic' | 'heading' | 'bulletList' | 'numberedList';

/** A change of a text: [from, to) replaced by `insert`, then [start, end) selected. */
export interface TextChange {
  from: number;
  to: number;
  insert: string;
  start: number;
  end: number;
}

/**
 * Markdown for `format` on the selection [start, end) of `text`: bold and italic surround it
 * (an empty selection gets the caret between the marks); a heading or a list mark goes at the
 * start of each line it touches, lists numbered from 1.
 */
export function formatMarkdown(text: string, start: number, end: number, format: NoteFormat): TextChange {
  if (format === 'bold' || format === 'italic') {
    const mark = format === 'bold' ? '**' : '*';
    const insert = mark + text.slice(start, end) + mark;
    return { from: start, to: end, insert, start: start + mark.length, end: end + mark.length };
  }
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  // `end` is excluded: a selection ending with a line break does not touch the next line.
  const lineEnd = text.indexOf('\n', end > start ? end - 1 : end);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const lines = text.slice(from, to).split('\n');
  const mark = (i: number) => (format === 'heading' ? '# ' : format === 'bulletList' ? '- ' : `${i + 1}. `);
  const insert = lines.map((line, i) => mark(i) + line).join('\n');
  return { from, to, insert, start: start + mark(0).length, end: end + insert.length - (to - from) };
}
