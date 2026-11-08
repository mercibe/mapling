// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RecentMapsTest {
    private fun documents(recent: RecentMaps) = recent.entries.map { it.document }

    @Test
    fun theLastOpenedComesFirstAndAppearsOnce() {
        val recent = RecentMaps()
        recent.opened("a", "A.mm", "", 1)
        recent.opened("b", "B.mm", "", 2)
        recent.opened("a", "A.mm", "", 3)
        assertEquals(listOf("a", "b"), documents(recent))
        assertEquals(3L, recent.entries[0].opened)
    }

    @Test
    fun onlyTheLastTenAreKeptAndTheOthersAreReturned() {
        val recent = RecentMaps()
        for (i in 1..RecentMaps.MAX) assertEquals(emptyList<String>(), recent.opened("d$i", "$i.mm", "", i.toLong()))
        assertEquals(listOf("d1"), recent.opened("new", "New.mm", "", 99))
        assertEquals(RecentMaps.MAX, recent.entries.size)
        assertEquals("new", recent.entries.first().document)
        assertEquals("d2", recent.entries.last().document)
    }

    @Test
    fun theHiddenContentNoticeIsRememberedPerDocumentAndForgottenWithIt() {
        val recent = RecentMaps()
        recent.opened("a", "A.mm", "", 1)
        assertFalse(recent.hiddenContentTold("a"))
        recent.tellHiddenContent("a")
        recent.opened("b", "B.mm", "", 2)
        recent.opened("a", "A.mm", "", 3)
        assertTrue("kept when opened again", recent.hiddenContentTold("a"))
        recent.remove("a")
        assertFalse(recent.hiddenContentTold("a"))
    }

    @Test
    fun theListSurvivesItsTextForm() {
        val recent = RecentMaps()
        recent.opened("content://drive/a%20b", "Réunion\tlundi.mm", "Ordre\ndu jour", 1791761596843)
        recent.opened("content://local/c", "C.mm", "", 2)
        recent.tellHiddenContent("content://local/c")
        val decoded = RecentMaps.decode(recent.encode())
        assertEquals(listOf("content://local/c", "content://drive/a%20b"), documents(decoded))
        assertEquals("Réunion lundi.mm", decoded.entries[1].name)
        assertEquals("Ordre du jour", decoded.entries[1].title)
        assertEquals(1791761596843L, decoded.entries[1].opened)
        assertTrue(decoded.hiddenContentTold("content://local/c"))
    }

    @Test
    fun unreadableLinesAreLeftOut() {
        assertEquals(emptyList<String>(), documents(RecentMaps.decode(null)))
        assertEquals(listOf("ok"), documents(RecentMaps.decode("broken\nok\t5\t0\tOK.mm\nbad\tnot a time\t0\tX.mm")))
    }

    @Test
    fun theRootTextFollowsTheMapAndOldLinesHaveNone() {
        val recent = RecentMaps.decode("doc\t5\t1\tOld.mm")
        assertEquals("", recent.entries[0].title)
        assertTrue("an old line keeps what it knew", recent.hiddenContentTold("doc"))
        recent.retitle("doc", "Renamed root")
        assertEquals("Renamed root", RecentMaps.decode(recent.encode()).entries[0].title)
        recent.opened("doc", "Old.mm", "Opened again", 9)
        assertEquals("Opened again", recent.entries[0].title)
        assertTrue("still told", recent.hiddenContentTold("doc"))
    }
}
