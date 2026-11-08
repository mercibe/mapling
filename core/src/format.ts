// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Map format versions. Mapling only edits versions covered by a fixture; the
// others open read-only (see docs/BRIDGE.md, `loaded` warnings).

export type FormatStatus = 'supported' | 'too-old' | 'too-new';

/** Editable Freeplane versions, as [major, minor]. Widen only with a new fixture. */
const OLDEST_SUPPORTED = [1, 12];
const NEWEST_SUPPORTED = [1, 12];

function compare(a: number[], b: number[]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Classifies the `version` attribute of `<map>`, e.g. "freeplane 1.12.15". */
export function formatStatus(mapVersion: string): FormatStatus {
  const match = /^freeplane (\d+)\.(\d+)/.exec(mapVersion);
  if (!match) return 'too-old'; // FreeMind ("0.9.0", "1.0.1"…) or unknown
  const version = [Number(match[1]), Number(match[2])];
  if (compare(version, OLDEST_SUPPORTED) < 0) return 'too-old';
  if (compare(version, NEWEST_SUPPORTED) > 0) return 'too-new';
  return 'supported';
}
