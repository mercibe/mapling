// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

/**
 * Whether a document may be overwritten (docs/BRIDGE.md, section 7): only if it still holds
 * what the map is based on, so that a change made elsewhere (another device, Freeplane on a
 * computer) is never replaced silently. Contents are compared by fingerprint.
 *
 * A save requested before the previous one was written is based on what the document held
 * before: what this process last wrote to the document is accepted too.
 * Used by the save writer's thread only.
 */
class WriteCheck {
    private val written = mutableMapOf<String, String>()

    fun unchanged(document: String, current: String, base: String): Boolean =
        current == base || current == written[document]

    fun wrote(document: String, fingerprint: String) {
        written[document] = fingerprint
    }
}
