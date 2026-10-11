// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebViewVersionTest {
    @Test
    fun aRecentWebViewRunsTheCore() {
        assertTrue(runsCore("154.0.7559.59"))
        assertTrue(runsCore("$MIN_CHROMIUM.0.4183.81"))
    }

    @Test
    fun anOlderWebViewDoesNot() {
        assertFalse(runsCore("${MIN_CHROMIUM - 1}.0.4147.125"))
        assertFalse(runsCore("58.0.3029.125"))
    }

    @Test
    fun anUnreadableVersionIsGivenItsChance() {
        assertTrue(runsCore(null))
        assertTrue(runsCore(""))
        assertTrue(runsCore("unknown"))
    }
}
