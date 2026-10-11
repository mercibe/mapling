// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Local drafts of unsaved maps (docs/BRIDGE.md, section 6), one file per document.
 *
 * A single writer persists, for each document, only the latest state received: a draft,
 * or its deletion. A failed write is retried with the latest state, so an older write
 * can never bring back a deleted draft. Plain Java and Kotlin only: tested on the JVM.
 */
class DraftStore(
    private val dir: File,
    private val scheduler: Scheduler,
    private val writeFile: (File, ByteArray) -> Unit = ::writeAtomically,
    private val deleteFile: (File) -> Unit = { Files.deleteIfExists(it.toPath()) },
) {
    /** The unsaved map of one document, as written to disk. */
    class Draft(
        val uri: String,
        val name: String,
        /** Fingerprint of the document content this draft is based on (see [fingerprint]). */
        val base: String,
        val time: Long,
        val bytes: ByteArray,
    )

    sealed interface Found {
        object None : Found
        class Present(val draft: Draft) : Found
        /** Truncated, or written by another version: set aside, never deleted silently. */
        class Unreadable(val keptAs: File) : Found
    }

    /** Runs the writer's tasks one at a time, on one thread for the whole process. */
    interface Scheduler {
        fun execute(task: () -> Unit)
        fun schedule(delayMs: Long, task: () -> Unit)
        fun <T> await(task: () -> T): T
    }

    /** Called on the writer's thread when drafts stop, or start again, being written. */
    @Volatile
    var onProtectionChanged: ((protected: Boolean) -> Unit)? = null
        private set

    /**
     * Watches whether drafts are written (null: stops watching), starting with the current
     * state: a screen recreated while the process lives on must know about a failure under
     * way. Told on the writer's thread, like every change, so always in order.
     */
    fun watchProtection(listener: ((protected: Boolean) -> Unit)?) {
        onProtectionChanged = listener
        if (listener != null) scheduler.execute { if (onProtectionChanged === listener) listener(protected) }
    }

    private val lock = Any()
    private val pending = LinkedHashMap<String, Draft?>() // latest state per document; null deletes

    /** A flush is running, queued or waiting to retry: there is never more than one. */
    private var flushScheduled = false
    private var failures = 0
    private var protected = true

    /** Records the latest state of a document's draft (null: delete it), to be written soon. */
    fun submit(uri: String, draft: Draft?) {
        synchronized(lock) {
            pending[uri] = draft
            if (flushScheduled) return // the flush under way, or its retry, will take it
            flushScheduled = true
        }
        scheduler.execute(::flush)
    }

    /** The draft of a document, including one not written yet. Call off the main thread. */
    fun read(uri: String): Found = scheduler.await {
        synchronized(lock) {
            if (pending.containsKey(uri)) return@await pending[uri]?.let { Found.Present(it) } ?: Found.None
        }
        val file = fileFor(uri)
        if (!file.exists()) return@await Found.None
        try {
            Found.Present(decode(file.readBytes()).also { check(it.uri == uri) })
        } catch (e: Exception) {
            Found.Unreadable(setAside(file))
        }
    }

    private fun flush() {
        val batch = synchronized(lock) { LinkedHashMap(pending) }
        var failed = false
        for ((uri, draft) in batch) {
            try {
                if (draft == null) deleteFile(fileFor(uri)) else writeFile(fileFor(uri), encode(draft))
                synchronized(lock) {
                    // Done, unless a newer state arrived meanwhile.
                    if (pending.containsKey(uri) && pending[uri] === draft) pending.remove(uri)
                }
            } catch (e: Exception) {
                failed = true
            }
        }
        // The only place where the next flush is decided: a retry after a failure, another
        // flush at once for a state submitted meanwhile, or none.
        val next = synchronized(lock) {
            failures = if (failed) failures + 1 else 0
            when {
                failed -> retryDelay(failures)
                pending.isNotEmpty() -> 0L
                else -> null.also { flushScheduled = false }
            }
        }
        when (next) {
            null -> {}
            0L -> scheduler.execute(::flush)
            else -> scheduler.schedule(next, ::flush)
        }
        reportProtection(failures < FAILURES_BEFORE_WARNING)
    }

    private fun reportProtection(now: Boolean) {
        if (now == protected) return
        protected = now
        onProtectionChanged?.invoke(now)
    }

    private fun fileFor(uri: String) = File(dir, fingerprint(uri.toByteArray()) + ".draft")

    /**
     * Moves an unreadable file out of the way, so that new drafts never overwrite it.
     * If even that fails, the file stays where it is, and is reported as such.
     */
    private fun setAside(file: File): File {
        val aside = File(File(dir, "unreadable"), "${file.nameWithoutExtension}-${System.currentTimeMillis()}.draft")
        return try {
            aside.parentFile?.mkdirs()
            Files.move(file.toPath(), aside.toPath(), StandardCopyOption.ATOMIC_MOVE)
            aside
        } catch (e: Exception) {
            file
        }
    }

    companion object {
        const val FORMAT_VERSION = 1
        const val FAILURES_BEFORE_WARNING = 3

        /** 1 s, 2 s, 4 s, then every 10 s. */
        fun retryDelay(failures: Int): Long = minOf(1000L shl (failures - 1).coerceIn(0, 4), 10_000L)

        fun fingerprint(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        fun encode(draft: Draft): ByteArray {
            val out = ByteArrayOutputStream()
            DataOutputStream(out).use {
                it.writeInt(FORMAT_VERSION)
                it.writeUTF(draft.uri)
                it.writeUTF(draft.name)
                it.writeUTF(draft.base)
                it.writeLong(draft.time)
                it.writeInt(draft.bytes.size)
                it.write(draft.bytes)
            }
            return out.toByteArray()
        }

        /** Throws on a truncated file, an unknown version or trailing bytes. */
        fun decode(bytes: ByteArray): Draft {
            val input = DataInputStream(ByteArrayInputStream(bytes))
            val version = input.readInt()
            if (version != FORMAT_VERSION) throw IOException("Unknown draft format version $version")
            val draft = Draft(input.readUTF(), input.readUTF(), input.readUTF(), input.readLong(),
                ByteArray(input.readInt()).also { input.readFully(it) })
            if (input.read() != -1) throw IOException("Trailing bytes after the draft")
            return draft
        }

        /** Temporary file, forced to disk, then renamed: a crash leaves the old or the new draft. */
        fun writeAtomically(file: File, bytes: ByteArray) {
            file.parentFile?.mkdirs()
            val temporary = File(file.parentFile, file.name + ".tmp")
            FileOutputStream(temporary).use {
                it.write(bytes)
                it.fd.sync()
            }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

/** The writer's thread, shared by the whole process. */
class WriterThread : DraftStore.Scheduler {
    private val executor = Executors.newSingleThreadScheduledExecutor()

    override fun execute(task: () -> Unit) {
        executor.execute(task)
    }

    override fun schedule(delayMs: Long, task: () -> Unit) {
        executor.schedule(task, delayMs, TimeUnit.MILLISECONDS)
    }

    override fun <T> await(task: () -> T): T = executor.submit(Callable(task)).get()
}
