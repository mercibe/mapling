// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class FileSnapshotTest {
    /** Like Drive: serves its cached version, and fetches the newer one while it is read. */
    private class Provider {
        var content = "cached"
        var date = 1L
        var newer: Pair<String, Long>? = null

        fun read(): ByteArray {
            val served = content
            newer?.let { (text, time) ->
                content = text
                date = time
            }
            return served.toByteArray()
        }
    }

    @Test
    fun aRefreshDuringTheReadLeavesTheDateOfTheBytesRead() {
        val drive = Provider().apply { newer = "made elsewhere" to 2L }
        val file = FileSnapshot.take({ drive.date }, drive::read)
        assertEquals("cached", String(file.bytes))
        assertEquals(1L, file.modified)
        // Watching the date then sees the newer version.
        assertNotEquals(file.modified, drive.date)
    }

    @Test
    fun withNoRefreshTheDateIsThatOfTheBytes() {
        val drive = Provider()
        val file = FileSnapshot.take({ drive.date }, drive::read)
        assertEquals("cached", String(file.bytes))
        assertEquals(drive.date, file.modified)
    }
}
