// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertEquals
import org.junit.Test

class MapTitleTest {
    @Test
    fun theMapExtensionIsLeftOutInAnyCase() {
        assertEquals("Réunion lundi", mapTitle("Réunion lundi.mm"))
        assertEquals("Réunion", mapTitle("Réunion.MM"))
    }

    @Test
    fun anyOtherExtensionStays() {
        assertEquals("Budget v1.2", mapTitle("Budget v1.2"))
        assertEquals("map.mm.bak", mapTitle("map.mm.bak"))
        assertEquals("map.xml", mapTitle("map.xml"))
    }

    @Test
    fun aNameIsNeverEmpty() {
        assertEquals(".mm", mapTitle(".mm"))
    }

    @Test
    fun aMapIsNamedByItsRootAndItsFile() {
        assertEquals("Team meeting (Réunion.mm)", mapLabel("Team meeting", "Réunion.mm"))
        assertEquals("Same name (Same name.mm)", mapLabel("Same name", "Same name.mm"))
    }

    @Test
    fun aRootOnSeveralLinesIsShownOnOne() {
        assertEquals("Budget 2027 draft (b.mm)", mapLabel("Budget\n2027   draft ", "b.mm"))
    }

    @Test
    fun aLongRootIsShortenedSoThatTheFileStillShows() {
        val label = mapLabel("A".repeat(60), "File.mm", maxTitle = 40)
        assertEquals("A".repeat(39) + "… (File.mm)", label)
    }

    @Test
    fun withoutARootTextTheFileNameAlone() {
        assertEquals("File.mm", mapLabel("", "File.mm"))
        assertEquals("File.mm", mapLabel("  \n ", "File.mm"))
    }

    @Test
    fun aLongTextLosesItsEndAndAFileNameItsMiddle() {
        assertEquals("Short", shortenEnd("Short", 10))
        assertEquals("Long text…", shortenEnd("Long text that goes on", 10))
        assertEquals("Réunion.mm", shortenMiddle("Réunion.mm", 10))
        assertEquals("Réuni…e.mm", shortenMiddle("Réunion d'équipe.mm", 10))
        assertEquals(10, shortenMiddle("Réunion d'équipe.mm", 10).length)
    }
}
