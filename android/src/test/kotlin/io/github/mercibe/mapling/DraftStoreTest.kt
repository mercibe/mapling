// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import io.github.mercibe.mapling.DraftStore.Draft
import io.github.mercibe.mapling.DraftStore.Found
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException

class DraftStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    /** Runs the writer's tasks by hand: `runNow` for immediate ones, `elapse` for retries. */
    private class ManualScheduler : DraftStore.Scheduler {
        val now = ArrayDeque<() -> Unit>()
        val later = mutableListOf<Pair<Long, () -> Unit>>()

        override fun execute(task: () -> Unit) {
            now.addLast(task)
        }

        override fun schedule(delayMs: Long, task: () -> Unit) {
            later += delayMs to task
        }

        override fun <T> await(task: () -> T): T = task()

        fun runNow() {
            while (now.isNotEmpty()) now.removeFirst()()
        }

        /** Runs the pending retry (there is at most one), then what it scheduled now. */
        fun elapse(): Long {
            val (delay, task) = later.removeFirst()
            task()
            runNow()
            return delay
        }
    }

    private val uri = "content://drive/document/1"
    private val scheduler = ManualScheduler()

    /** Writes that fail while `failing` is true; every write attempted is recorded. */
    private var failing = false

    /** Runs during the next write, as the main thread may while the writer works. */
    private var duringWrite: (() -> Unit)? = null
    private val attempts = mutableListOf<String>()
    private val protection = mutableListOf<Boolean>()

    private fun store(): DraftStore {
        val dir = File(folder.root, "drafts")
        return DraftStore(
            dir, scheduler,
            writeFile = { file, bytes ->
                attempts += "write " + String(DraftStore.decode(bytes).bytes)
                duringWrite?.also { duringWrite = null }?.invoke()
                if (failing) throw IOException("disk full")
                DraftStore.writeAtomically(file, bytes)
            },
            deleteFile = { file ->
                attempts += "delete"
                if (failing) throw IOException("disk full")
                file.delete()
            },
        ).also {
            it.watchProtection { protected -> protection += protected }
            scheduler.runNow()
            protection.clear() // only the changes matter in most tests
        }
    }

    private fun draft(text: String, base: String = "base") = Draft(uri, "Map.mm", base, 1234L, text.toByteArray())

    private fun DraftStore.text(): String? = (read(uri) as? Found.Present)?.draft?.bytes?.let { String(it) }

    private fun draftFiles() = File(folder.root, "drafts").listFiles { file -> file.name.endsWith(".draft") }.orEmpty()

    @Test
    fun aDraftIsWrittenAndReadBackExactly() {
        val store = store()
        store.submit(uri, Draft(uri, "Projet.mm", "abc123", 1791654204091L, byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), 60)))
        scheduler.runNow()

        val found = DraftStore(File(folder.root, "drafts"), scheduler).read(uri) as Found.Present
        assertEquals("Projet.mm", found.draft.name)
        assertEquals("abc123", found.draft.base)
        assertEquals(1791654204091L, found.draft.time)
        assertArrayEquals(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), 60), found.draft.bytes)
    }

    @Test
    fun onlyTheLatestStateIsWritten() {
        val store = store()
        store.submit(uri, draft("first"))
        store.submit(uri, draft("second"))
        scheduler.runNow()
        assertEquals(listOf("write second"), attempts)
        assertEquals("second", store.text())
    }

    @Test
    fun aNewerStateArrivingDuringAWriteIsWrittenNext() {
        val store = store()
        duringWrite = { store.submit(uri, draft("newer")) }
        store.submit(uri, draft("older"))
        scheduler.runNow()
        assertEquals(listOf("write older", "write newer"), attempts)
        assertEquals("newer", DraftStore(File(folder.root, "drafts"), scheduler).text())
    }

    @Test
    fun aDeletionArrivingDuringAWriteIsAppliedNext() {
        val store = store()
        duringWrite = { store.submit(uri, null) }
        store.submit(uri, draft("unsaved"))
        scheduler.runNow()
        assertEquals(listOf("write unsaved", "delete"), attempts)
        assertEquals(0, draftFiles().size)
    }

    @Test
    fun aNewerStateArrivingDuringAFailingWriteLeavesASingleRetry() {
        val store = store()
        failing = true
        duringWrite = { store.submit(uri, draft("newer")) }
        store.submit(uri, draft("older"))
        scheduler.runNow()
        assertEquals("one write attempted, no second pass at once", listOf("write older"), attempts)
        assertEquals("a single retry", 1, scheduler.later.size)

        // While writing keeps failing, still one retry at a time, at the normal pace.
        assertEquals(listOf(1000L, 2000L, 4000L), List(3) { scheduler.elapse().also { assertEquals(1, scheduler.later.size) } })
        failing = false
        scheduler.elapse()
        assertEquals("newer", store.text())
        assertTrue(scheduler.later.isEmpty())
    }

    @Test
    fun aDraftNotWrittenYetIsReadFromMemory() {
        val store = store()
        store.submit(uri, draft("pending"))
        assertEquals("pending", store.text())
        store.submit(uri, null)
        assertEquals(Found.None, store.read(uri))
    }

    @Test
    fun aFailedWriteIsRetriedWithTheLatestState() {
        val store = store()
        failing = true
        store.submit(uri, draft("old"))
        scheduler.runNow()
        store.submit(uri, draft("new")) // replaces the state waiting for a retry
        failing = false
        assertEquals(1000L, scheduler.elapse())
        assertEquals(listOf("write old", "write new"), attempts)
        assertEquals("new", DraftStore(File(folder.root, "drafts"), scheduler).text())
    }

    @Test
    fun aDeletionDuringARetryWinsOverTheFailedWrite() {
        val store = store()
        store.submit(uri, draft("saved before"))
        scheduler.runNow()
        failing = true
        store.submit(uri, draft("unsaved"))
        scheduler.runNow()
        store.submit(uri, null) // the map was saved meanwhile
        failing = false
        scheduler.elapse()
        assertEquals(listOf("write saved before", "write unsaved", "delete"), attempts)
        assertEquals(0, draftFiles().size)
        assertTrue(scheduler.later.isEmpty())
    }

    @Test
    fun retriesSlowDownThenTheUserIsWarnedAndToldWhenDraftsWorkAgain() {
        val store = store()
        failing = true
        store.submit(uri, draft("text"))
        scheduler.runNow()
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 10_000L, 10_000L), List(6) { scheduler.elapse() })
        assertEquals(listOf(false), protection) // after the third failure, once
        failing = false
        scheduler.elapse()
        assertEquals(listOf(false, true), protection)
        assertEquals("text", store.text())
        assertTrue(scheduler.later.isEmpty())
    }

    @Test
    fun aScreenThatStartsWatchingIsToldTheCurrentState() {
        val store = store()
        failing = true
        store.submit(uri, draft("text"))
        scheduler.runNow()
        repeat(2) { scheduler.elapse() } // three failures: drafts are not protected
        assertEquals(listOf(false), protection)

        // Android recreates the activity, the process lives on: the new screen must know.
        val newScreen = mutableListOf<Boolean>()
        store.watchProtection { protected -> newScreen += protected }
        scheduler.runNow()
        assertEquals(listOf(false), newScreen)

        failing = false
        scheduler.elapse()
        assertEquals(listOf(false, true), newScreen)
    }

    @Test
    fun aScreenThatStoppedWatchingIsNotTold() {
        val store = store()
        val screen = mutableListOf<Boolean>()
        store.watchProtection { protected -> screen += protected }
        store.watchProtection(null) // gone before the writer's thread got to it
        scheduler.runNow()
        assertEquals(listOf<Boolean>(), screen)
    }

    @Test
    fun eachDocumentHasItsOwnDraft() {
        val store = store()
        store.submit(uri, draft("one"))
        store.submit("content://drive/document/2", Draft("content://drive/document/2", "Other.mm", "b", 1L, "two".toByteArray()))
        scheduler.runNow()
        assertEquals(2, draftFiles().size)
        assertEquals("one", store.text())
    }

    @Test
    fun aTruncatedDraftIsSetAsideAndReportedNeverDeleted() {
        val store = store()
        store.submit(uri, draft("a long enough text"))
        scheduler.runNow()
        val file = draftFiles().single()
        file.writeBytes(file.readBytes().copyOf(file.length().toInt() - 5))
        val kept = file.readBytes()

        val found = store.read(uri) as Found.Unreadable
        assertArrayEquals(kept, found.keptAs.readBytes())
        assertFalse(file.exists())

        store.submit(uri, draft("new"))
        scheduler.runNow()
        assertArrayEquals("the new draft never overwrites it", kept, found.keptAs.readBytes())
    }

    @Test
    fun aDraftOfAnUnknownVersionIsSetAsideAndReported() {
        val store = store()
        store.submit(uri, draft("text"))
        scheduler.runNow()
        val file = draftFiles().single()
        val bytes = file.readBytes().also { it[3] = 99 } // format version 99
        file.writeBytes(bytes)

        val found = store.read(uri) as Found.Unreadable
        assertArrayEquals(bytes, found.keptAs.readBytes())
    }
}
