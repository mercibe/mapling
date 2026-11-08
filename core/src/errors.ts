// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

/** Error codes shared with the shells (see docs/BRIDGE.md) and internal ones. */
export type ErrorCode =
  | 'PARSE_ERROR'
  | 'NOT_A_MAP'
  | 'READ_ONLY_MAP'
  | 'READ_ONLY_NODE'
  | 'UNKNOWN_NODE'
  | 'INVALID_OPERATION';

export class MapError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'MapError';
    this.code = code;
  }
}
