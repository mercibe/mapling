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

/**
 * The file name offered when a new map is first saved: its root's text on one line, without
 * the characters file names refuse; `fallback` when nothing is left.
 */
fun newFileName(title: String, fallback: String): String {
    val name = oneLine(title).replace(Regex("[\\\\/:*?\"<>|]"), "-").take(100).trim()
    return name.ifEmpty { fallback } + ".mm"
}

/** The root's text on one line: line breaks and runs of spaces become single spaces. */
fun oneLine(title: String): String = title.trim().replace(Regex("\\s+"), " ")
