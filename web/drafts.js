// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drafts of the web shell, kept in a Web Storage (localStorage in the page, a fake
// in tests). A browser gives no path to an opened file, so a draft is tied to the
// file's name and to a fingerprint of the content it was opened with.
//
// Every function returns whether it succeeded instead of throwing: storage may be
// full or unavailable, and a failure must never lose what is already stored.

export const DRAFT_PREFIX = 'mapling.draft.';

/** The storage key of the draft of a file with this name and content fingerprint. */
export function draftKey(name, fingerprint) {
  return `${DRAFT_PREFIX}${fingerprint}.${name}`;
}

/** SHA-256 of the file's content, in hexadecimal. */
export async function fingerprint(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stores a draft (`data`: base64 of the map), or deletes it when `data` is null. */
export function writeDraft(storage, key, name, data, savedAt = Date.now()) {
  try {
    if (data === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ name, data, savedAt }));
    return true;
  } catch {
    return false;
  }
}

export function deleteDraft(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves a draft to another key. The old copy is deleted only once the new one is
 * written: if writing fails, the draft stays where it was.
 */
export function moveDraft(storage, fromKey, toKey) {
  try {
    const value = storage.getItem(fromKey);
    if (value === null) return false;
    storage.setItem(toKey, value);
  } catch {
    return false;
  }
  return deleteDraft(storage, fromKey);
}

/** Drafts kept for files with this name: [{ key, data, savedAt }]; unreadable entries are skipped. */
export function draftsNamed(storage, name) {
  const drafts = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      try {
        const draft = JSON.parse(storage.getItem(key));
        if (draft && draft.name === name) drafts.push({ key, data: draft.data, savedAt: draft.savedAt });
      } catch {
        // corrupted entry: not offered, and left untouched
      }
    }
  } catch {
    // storage unavailable: no draft to offer
  }
  return drafts;
}
