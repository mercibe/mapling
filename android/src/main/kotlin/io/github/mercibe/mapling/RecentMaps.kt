// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

/**
 * The last maps opened, most recent first, to open them again in one gesture. Each one
 * also remembers its root's text (shown with the file's name), and whether the user was
 * told about its hidden content, so that this is told once per document and forgotten
 * with it.
 *
 * Stored as text, one map per line: document, time opened, told (0 or 1), title, name.
 * Lines written before titles were kept have no title field.
 */
class RecentMaps(entries: List<Entry> = emptyList()) {
    class Entry(
        val document: String,
        val name: String,
        val opened: Long,
        val hiddenContentTold: Boolean = false,
        val title: String = "", // unknown until the map is opened again
    )

    private val list = entries.take(MAX).toMutableList()

    val entries: List<Entry> get() = list

    /** Puts the document first; returns the documents that no longer fit in the list. */
    fun opened(document: String, name: String, title: String, time: Long): List<String> {
        val told = list.find { it.document == document }?.hiddenContentTold ?: false
        remove(document)
        list.add(0, Entry(document, name, time, told, title))
        val dropped = list.drop(MAX).map { it.document }
        while (list.size > MAX) list.removeAt(list.lastIndex)
        return dropped
    }

    fun remove(document: String) {
        list.removeAll { it.document == document }
    }

    fun hiddenContentTold(document: String): Boolean = list.find { it.document == document }?.hiddenContentTold ?: false

    fun tellHiddenContent(document: String) = update(document) { Entry(it.document, it.name, it.opened, true, it.title) }

    /** The root's text changed in the open map. */
    fun retitle(document: String, title: String) = update(document) { Entry(it.document, it.name, it.opened, it.hiddenContentTold, title) }

    private fun update(document: String, change: (Entry) -> Entry) {
        val index = list.indexOfFirst { it.document == document }
        if (index >= 0) list[index] = change(list[index])
    }

    fun encode(): String = list.joinToString("\n") {
        val fields = listOf(it.document, it.opened, if (it.hiddenContentTold) 1 else 0, it.title.oneLine(), it.name.oneLine())
        fields.joinToString("\t")
    }

    private fun String.oneLine() = replace(SEPARATORS, " ")

    companion object {
        const val MAX = 10
        private val SEPARATORS = Regex("[\t\r\n]")

        /** Lines that cannot be read are left out: the list is a convenience, never a source of truth. */
        fun decode(text: String?): RecentMaps = RecentMaps(
            text.orEmpty().lines().mapNotNull { line ->
                val fields = line.split("\t", limit = 5)
                val opened = fields.getOrNull(1)?.toLongOrNull()
                when {
                    opened == null || fields.size < 4 -> null
                    fields.size == 4 -> Entry(fields[0], fields[3], opened, fields[2] == "1") // no title yet
                    else -> Entry(fields[0], fields[4], opened, fields[2] == "1", fields[3])
                }
            },
        )
    }
}
