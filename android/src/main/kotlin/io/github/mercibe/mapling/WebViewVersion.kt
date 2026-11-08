// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

/** The oldest Chromium the core runs on (docs/ARCHITECTURE.md, "Browser support"). */
const val MIN_CHROMIUM = 85

/**
 * Whether a WebView runs the core, from its package's version name ("154.0.7559.59").
 * A version that cannot be read is given its chance: the check only exists to replace
 * a blank page with a clear message.
 */
fun runsCore(versionName: String?): Boolean {
    val major = versionName?.substringBefore('.')?.toIntOrNull() ?: return true
    return major >= MIN_CHROMIUM
}
