// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WriteCheckTest {
    private val check = WriteCheck()

    @Test
    fun aDocumentStillHoldingWhatTheMapIsBasedOnMayBeWritten() {
        assertTrue(check.unchanged("doc", current = "opened", base = "opened"))
    }

    @Test
    fun aDocumentChangedElsewhereMayNotBeWritten() {
        assertFalse(check.unchanged("doc", current = "changed elsewhere", base = "opened"))
    }

    @Test
    fun aSaveQueuedBehindAnotherAcceptsWhatTheFirstOneWrote() {
        check.wrote("doc", "first save")
        assertTrue(check.unchanged("doc", current = "first save", base = "opened"))
    }

    @Test
    fun aChangeElsewhereAfterASaveIsStillSeen() {
        check.wrote("doc", "first save")
        assertFalse(check.unchanged("doc", current = "changed elsewhere", base = "first save"))
    }

    @Test
    fun whatWasWrittenToADocumentSaysNothingAboutAnother() {
        check.wrote("doc", "first save")
        assertFalse(check.unchanged("other", current = "first save", base = "opened"))
    }
}
