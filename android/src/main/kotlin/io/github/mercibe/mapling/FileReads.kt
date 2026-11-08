// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

/**
 * Whether a read of the open map's file, started off the main thread, still applies when
 * its result comes back: only to the document read, and not once the map was loaded again
 * (even the same document), saved or closed since, nor once the activity is gone.
 * Otherwise an older read, or a read of another document (the original of a saved copy),
 * could be taken for a change made elsewhere. Used by the main thread only.
 */
class FileReads {
    class Ticket internal constructor(val document: String, val count: Int)

    private var count = 0

    /** Taken when a read of [document] starts. */
    fun ticket(document: String) = Ticket(document, count)

    /** The map's session or base changed: reads started before no longer apply. */
    fun invalidate() {
        count++
    }

    /** [document]: the one open now, if any. */
    fun applies(ticket: Ticket, document: String?): Boolean = ticket.count == count && ticket.document == document
}

/**
 * A file's content, with the date its provider gave for it. The date is asked first: Drive
 * may fetch a newer version while the content is read, then report its date. Asked after,
 * that date would describe a version the bytes do not hold, and watching for a newer date
 * would miss it; asked before, it is at worst older than the bytes, and the file is read
 * again for nothing.
 */
class FileSnapshot(val bytes: ByteArray, val modified: Long?) {
    companion object {
        fun take(modified: () -> Long?, read: () -> ByteArray): FileSnapshot {
            val date = modified()
            return FileSnapshot(read(), date)
        }
    }
}
