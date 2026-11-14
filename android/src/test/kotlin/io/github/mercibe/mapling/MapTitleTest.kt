// SPDX-FileCopyrightText: 2026 Benoit Mercier
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
    fun aRootOnSeveralLinesIsShownOnOne() {
        assertEquals("Budget 2027 draft", oneLine("Budget\n2027   draft "))
        assertEquals("", oneLine("  \n "))
    }

    @Test
    fun aNewMapIsOfferedItsRootsTextAsFileName() {
        assertEquals("Vacances d'été.mm", newFileName(" Vacances\nd'été ", "New map"))
        assertEquals("Budget 2027-2028.mm", newFileName("Budget 2027/2028", "New map"))
        assertEquals("a-b-c-d-e-f-g-h-i.mm", newFileName("a\\b:c*d?e\"f<g>h|i", "New map"))
        assertEquals(103, newFileName("x".repeat(150), "New map").length)
    }

    @Test
    fun aNewMapWithNoUsableRootTextGetsTheFallback() {
        assertEquals("New map.mm", newFileName("", "New map"))
        assertEquals("New map.mm", newFileName("  \n ", "New map"))
    }
}
