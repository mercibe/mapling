// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// For some texts it provides itself, such as the root of a new map, Freeplane
// writes a key in LOCALIZED_TEXT instead of a TEXT, and translates it on display.
// This is map content, so the core shows it in the user's language like Freeplane.
// Values from Freeplane 1.12 (translations/Resources_<lang>.properties); English
// is the fallback, and an unknown key is shown as is rather than as an empty node.

const TEXTS: Record<string, Record<string, string>> = {
  new_mindmap: { en: 'New Mindmap', fr: 'Nouvelle carte' },
};

/** The text Freeplane shows for `key` in `locale` (e.g. "fr", "fr-CA"). */
export function localizedText(key: string, locale: string): string {
  const texts = TEXTS[key];
  if (!texts) return key;
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return texts[language] ?? texts.en;
}
