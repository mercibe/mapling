// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FileReadsTest {
    private val reads = FileReads()

    @Test
    fun aReadWithNothingInBetweenApplies() {
        val ticket = reads.ticket("map")
        assertTrue(reads.applies(ticket, "map"))
    }

    @Test
    fun aReadStartedBeforeASaveNoLongerApplies() {
        val ticket = reads.ticket("map") // reads the version before the save
        reads.invalidate() // the save wrote a newer one: the map is based on it
        assertFalse(reads.applies(ticket, "map"))
    }

    @Test
    fun aReadStartedBeforeTheSameDocumentWasLoadedAgainNoLongerApplies() {
        val ticket = reads.ticket("map")
        reads.invalidate() // loaded again, same document
        assertFalse(reads.applies(ticket, "map"))
    }

    @Test
    fun aReadStartedBeforeTheActivityWasDestroyedNoLongerApplies() {
        val ticket = reads.ticket("map")
        reads.invalidate() // onDestroy
        assertFalse(reads.applies(ticket, "map"))
    }

    @Test
    fun aReadStartedAfterAChangeApplies() {
        reads.invalidate()
        val ticket = reads.ticket("map")
        assertTrue(reads.applies(ticket, "map"))
    }

    @Test
    fun aReadOfTheOriginalStartedOnceTheCopyIsOpenDoesNotApply() {
        reads.invalidate() // the copy is written: the map is now the copy, based on it
        val ticket = reads.ticket("original") // a late watch of the original reads it
        assertFalse(reads.applies(ticket, "copy"))
    }

    @Test
    fun aReadOnceTheMapIsClosedDoesNotApply() {
        val ticket = reads.ticket("map")
        assertFalse(reads.applies(ticket, null))
    }
}
