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
}
