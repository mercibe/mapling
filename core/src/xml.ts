// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// XML parsing and serialization, written to match what Freeplane 1.12 writes.
// Uses the platform DOMParser/XMLSerializer (browser, WebView, or xmldom in tests).

import { MapError } from './errors.ts';

/** Text around the root element, which the DOM does not keep. */
export interface Envelope {
  prolog: string; // optional BOM and XML declaration, with the whitespace after it
  tail: string; // whitespace after the root element
}

// `&nbsp;` is an HTML entity, unknown to XML: Freeplane up to 1.11 wrote it in rich text,
// and reads it back, but browsers reject the whole document. It is read as the same
// character, which Freeplane 1.12 writes `&#xa0;`; except in comments, CDATA sections and
// processing instructions, where it is only text.
const NBSP_ENTITY = /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>)|&nbsp;/g;

export function parseXml(text: string): { doc: Document; envelope: Envelope } {
  let doc: Document;
  try {
    // The byte order mark is kept in the envelope; parsers may reject it in the text.
    const xml = text.replace(/^\uFEFF/, '').replace(NBSP_ENTITY, (_match, verbatim) => verbatim ?? '&#xa0;');
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch (e) {
    // xmldom throws on malformed XML; browsers return a <parsererror> document instead.
    throw new MapError('PARSE_ERROR', String(e));
  }
  if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length > 0) {
    throw new MapError('PARSE_ERROR', 'Invalid XML');
  }
  const prolog = /^\uFEFF?(<\?xml[\s\S]*?\?>\s*)?/.exec(text)?.[0] ?? '';
  const tail = /\s*$/.exec(text)?.[0] ?? '';
  return { doc, envelope: { prolog, tail } };
}

// XMLSerializer output, split into what the Freeplane rules may touch: comments,
// CDATA sections and processing instructions are written verbatim and must stay
// so; element tags hold the attribute values. Since `<` and `>` are always
// escaped elsewhere (in text and attribute values), these parts are found reliably.
const PARTS = /(<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>)|(<[A-Za-z][^>]*>)|\u00a0/g;

/**
 * Serializes the document the way Freeplane does. Verified byte for byte on the
 * fixtures: XMLSerializer differs from Freeplane only by these rules:
 * - in attribute values, a line break is written `&#xa;` (not `&#10;`) and an
 *   apostrophe `&apos;` (whether Freeplane also escapes apostrophes in text,
 *   e.g. in the HTML of notes, is not known yet: no fixture has one);
 * - everywhere, the no-break space is written `&#xa0;` (other characters stay as is).
 */
export function serializeXml(doc: Document, envelope: Envelope): string {
  const body = new XMLSerializer()
    .serializeToString(doc)
    .replace(/^<\?xml[\s\S]*?\?>\s*/, '') // the original prolog is restored as is
    .replace(PARTS, (match: string, verbatim?: string, tag?: string) => {
      if (verbatim) return verbatim;
      if (tag) return tag.replace(/&#10;/g, '&#xa;').replace(/'/g, '&apos;').replace(/\u00a0/g, '&#xa0;');
      return '&#xa0;';
    });
  return envelope.prolog + body + envelope.tail;
}
