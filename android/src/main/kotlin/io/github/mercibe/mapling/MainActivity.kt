// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * The only screen: the map in a WebView, and a native menu.
 *
 * The core runs in the WebView and talks to this shell through JSON messages
 * (docs/BRIDGE.md). The shell opens documents and passes their bytes untouched.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var coreReady = false
    private var requestCount = 0

    /** The open document: changes only when the core has accepted a new one. */
    private var document: Uri? = null
    private var dirty = false

    /** Document and name of each pending `load`, by requestId: a refused load changes nothing. */
    private val pendingLoads = mutableMapOf<String, Pair<Uri, String>>()

    /** Document each pending `save` request belongs to, by requestId (docs/BRIDGE.md, section 7). */
    private val saveTargets = mutableMapOf<String, Uri>()

    /** Writes one save at a time, in request order. */
    private val writer = Executors.newSingleThreadExecutor()

    @SuppressLint("SetJavaScriptEnabled") // the core is JavaScript; the page only runs our own code
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        keepClearOfSystemBars()
        WebView.setWebContentsDebuggingEnabled(isDebuggable())

        webView.settings.apply {
            javaScriptEnabled = true
            // The page needs nothing but what AssetServer serves.
            blockNetworkLoads = true
            allowFileAccess = false
            allowContentAccess = false
        }
        val server = AssetServer(assets)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                server.respond(request)

            // The page exposes the native bridge: it never navigates anywhere.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        // Defined before the page loads, as docs/BRIDGE.md requires.
        webView.addJavascriptInterface(CoreToShell(), "MindShell")
        webView.loadUrl(AssetServer.PAGE_URL)
    }

    override fun onDestroy() {
        writer.shutdown() // pending writes still complete
        webView.destroy()
        super.onDestroy()
    }

    // ---------- menu ----------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(Menu.NONE, MENU_SAVE, Menu.NONE, R.string.save)
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(Menu.NONE, MENU_OPEN, Menu.NONE, R.string.open)
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
        menu.add(Menu.NONE, MENU_RELOAD, Menu.NONE, R.string.reload)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        menu.findItem(MENU_OPEN).isEnabled = coreReady
        menu.findItem(MENU_SAVE).isEnabled = dirty
        // Until the shell warns about unsaved changes (step 5), reloading needs an unmodified map.
        menu.findItem(MENU_RELOAD).isEnabled = document != null && !dirty
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            MENU_OPEN -> {
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*") // providers disagree on the type of .mm files
                startActivityForResult(intent, REQUEST_OPEN)
            }
            MENU_SAVE -> save()
            MENU_RELOAD -> document?.let(::open)
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    // ---------- opening a document ----------

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val uri = data?.data
        if (requestCode == REQUEST_OPEN && resultCode == RESULT_OK && uri != null) open(uri)
    }

    /** Reads the document off the main thread: a provider such as Drive may download it first. */
    private fun open(uri: Uri) {
        thread {
            try {
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                val name = displayName(uri)
                Log.i(TAG, "Opened $name: ${bytes.size} bytes, ${describe(uri)}, $uri")
                runOnUiThread { load(uri, name, bytes) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read $uri", e)
                runOnUiThread { toast(getString(R.string.error_read)) }
            }
        }
    }

    private fun displayName(uri: Uri): String =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment.orEmpty()

    private fun load(uri: Uri, name: String, bytes: ByteArray) {
        val requestId = "r${++requestCount}"
        pendingLoads[requestId] = uri to name
        sendToCore(
            JSONObject()
                .put("type", "load")
                .put("requestId", requestId)
                .put("name", name)
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("readOnly", false)
                .put("locale", resources.configuration.locales[0].toLanguageTag()),
        )
    }

    // ---------- saving (docs/BRIDGE.md, section 6) ----------

    private fun save() {
        val uri = document ?: return
        val requestId = "r${++requestCount}"
        saveTargets[requestId] = uri
        sendToCore(JSONObject().put("type", "save").put("requestId", requestId))
    }

    /** Writes the bytes of a `saveData` to its own document, then confirms with `saved`. */
    private fun write(message: JSONObject) {
        val uri = saveTargets.remove(message.getString("requestId")) ?: return
        val saveId = message.getLong("saveId")
        val bytes = Base64.decode(message.getString("data"), Base64.NO_WRAP)
        writer.execute {
            val start = System.currentTimeMillis()
            try {
                contentResolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot write $uri", e)
                runOnUiThread { toast(getString(R.string.error_write)) }
                return@execute
            }
            runOnUiThread {
                sendToCore(JSONObject().put("type", "saved").put("saveId", saveId))
                toast(getString(R.string.saved))
            }
            Log.i(TAG, "Wrote ${bytes.size} bytes in ${System.currentTimeMillis() - start} ms: ${describe(uri)}")
        }
    }

    /**
     * Size, modification date and write support, as the provider reports them (test traces).
     * A trace never decides anything: if the provider cannot tell, it says so and goes on.
     */
    private fun describe(uri: Uri): String {
        val columns = arrayOf(
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
        )
        return try {
            contentResolver.query(uri, columns, null, null, null)?.use {
                if (!it.moveToFirst()) return@use null
                val writable = it.getInt(2) and DocumentsContract.Document.FLAG_SUPPORTS_WRITE != 0
                "size=${it.getLong(0)}, lastModified=${it.getLong(1)}, writable=$writable"
            } ?: "no metadata"
        } catch (e: Exception) {
            "no metadata ($e)"
        }
    }

    // ---------- bridge (docs/BRIDGE.md, section 3) ----------

    private fun sendToCore(message: JSONObject) {
        message.put("v", 1)
        webView.evaluateJavascript("MindCore.receive(${JSONObject.quote(message.toString())})", null)
    }

    /** Exposed to the page as `window.MindShell`. */
    private inner class CoreToShell {
        /** Called by the core on a WebView thread: the message is handled on the main thread. */
        @JavascriptInterface
        fun send(json: String) {
            runOnUiThread { receive(JSONObject(json)) }
        }
    }

    private fun receive(message: JSONObject) {
        when (message.getString("type")) {
            "ready" -> {
                coreReady = true
                invalidateOptionsMenu()
            }
            "loaded" -> pendingLoads.remove(message.getString("requestId"))?.let { (uri, name) ->
                document = uri
                title = name
            }
            "saveData" -> write(message)
            "dirtyChanged" -> {
                dirty = message.getBoolean("dirty")
                invalidateOptionsMenu()
            }
            "error" -> {
                // A refused load leaves the previous map, and so the previous document, open.
                val requestId = message.optString("requestId")
                pendingLoads.remove(requestId)
                saveTargets.remove(requestId)
                toast(getString(R.string.error_core, message.getString("code")))
            }
            else -> Log.d(TAG, "Core: ${message.toString().take(200)}")
        }
    }

    // ---------- helpers ----------

    /**
     * Since Android 15, the app draws under the system bars, and the action bar lies over
     * the content: pad the content so the map stays clear of them and of the keyboard.
     * The top inset received here already includes the action bar. The insets are then
     * consumed: passed on, the keyboard would be subtracted a second time by the WebView,
     * leaving it a visible area of zero height (the map jumped at each key typed).
     */
    private fun keepClearOfSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
        findViewById<View>(android.R.id.content).setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
    }

    private fun isDebuggable() = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    private companion object {
        const val TAG = "mapling"
        const val MENU_OPEN = 1
        const val MENU_SAVE = 2
        const val MENU_RELOAD = 3
        const val REQUEST_OPEN = 1
    }
}
