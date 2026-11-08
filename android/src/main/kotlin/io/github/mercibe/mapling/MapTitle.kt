// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

/**
 * A map's name as shown to the user: its file name without ".mm", in any case. Any other
 * extension stays: it may be part of the name ("Budget v1.2"), or tell that the file is
 * not an ordinary map ("map.mm.bak").
 */
fun mapTitle(fileName: String): String {
    val title = if (fileName.endsWith(".mm", ignoreCase = true)) fileName.dropLast(3) else fileName
    return title.ifEmpty { fileName }
}

/** The root's text on one line: line breaks and runs of spaces become single spaces. */
fun oneLine(title: String): String = title.trim().replace(Regex("\\s+"), " ")

/**
 * A map as named on one line: "Root text (File.mm)", so that the user sees both what it is
 * about and which file holds it. A long root text is shortened, so that the file's name
 * always shows. Without a known root text, the file's name alone.
 */
fun mapLabel(title: String, fileName: String, maxTitle: Int = 40): String {
    val text = oneLine(title)
    return if (text.isEmpty()) fileName else "${shortenEnd(text, maxTitle)} ($fileName)"
}

/** At most `max` characters: the end gives way to "…". */
fun shortenEnd(text: String, max: Int): String = if (text.length <= max) text else text.take(max - 1).trimEnd() + "…"

/** At most `max` characters: the middle gives way to "…", so that a file's extension stays. */
fun shortenMiddle(text: String, max: Int): String {
    if (text.length <= max) return text
    val end = (max - 1) / 2
    return text.take(max - 1 - end) + "…" + text.takeLast(end)
}
