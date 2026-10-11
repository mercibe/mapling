// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import android.content.res.AssetManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream

/**
 * Serves the page and the core, bundled in the app's assets, to the WebView.
 *
 * Browsers refuse ES modules from `file://`, so the page gets an `https` origin of
 * its own, answered here and never on the network. Every request gets an explicit
 * response: answering `null` would let the WebView load the URL itself.
 */
class AssetServer(private val assets: AssetManager) {

    /** The only files served: exactly those bundled under [SERVED_ROOTS]. */
    private val files: Set<String> = SERVED_ROOTS.flatMap(::listFiles).toSet()

    fun respond(request: WebResourceRequest): WebResourceResponse {
        val url = request.url
        if (url.scheme != "https" || url.encodedAuthority != HOST || request.method != "GET") {
            return error(403, "Forbidden")
        }
        val path = url.path.orEmpty().removePrefix("/")
        val type = TYPES[path.substringAfterLast('.')]
        if (path !in files || type == null) return error(404, "Not Found")
        return WebResourceResponse(type, "utf-8", 200, "OK", emptyMap(), assets.open(path))
    }

    /** Asset paths under [path]: the path itself if it is a file, else its files, recursively. */
    private fun listFiles(path: String): List<String> {
        val children = assets.list(path).orEmpty()
        return if (children.isEmpty()) listOf(path) else children.flatMap { listFiles("$path/$it") }
    }

    private fun error(status: Int, reason: String) =
        WebResourceResponse("text/plain", "utf-8", status, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val PAGE_URL = "https://$HOST/index.html"

        private val SERVED_ROOTS = listOf("index.html", "core")

        /** Correct types matter: the WebView refuses an ES module not served as JavaScript. */
        private val TYPES = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "css" to "text/css",
        )
    }
}
