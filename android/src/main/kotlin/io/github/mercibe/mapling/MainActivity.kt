// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
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
import io.github.mercibe.mapling.DraftStore.Draft
import io.github.mercibe.mapling.DraftStore.Found
import org.json.JSONObject
import java.io.File
import java.text.DateFormat
import java.util.Date
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
    private lateinit var drafts: DraftStore
    private var coreReady = false
    private var requestCount = 0

    /** The open document: changes only when the core has accepted a new one. */
    private var document: Uri? = null
    private var documentName = ""

    /**
     * Fingerprint of the content the open map is based on: the bytes read, then the bytes
     * of each successful save. A restored draft keeps its own, so that a change made
     * elsewhere is still reported next time.
     */
    private var base = ""
    private var dirty = false

    /** Document to reopen once the core is ready, after Android recreated the activity. */
    private var reopen: Uri? = null

    /** What each pending `load` will open, by requestId: a refused load changes nothing. */
    private class PendingLoad(val uri: Uri, val name: String, val base: String, val discardDraft: Boolean)

    private val pendingLoads = mutableMapOf<String, PendingLoad>()

    /** Document each pending `save` request belongs to, by requestId (docs/BRIDGE.md, section 7). */
    private val saveTargets = mutableMapOf<String, Uri>()

    /** Tells the user when unsaved changes stop, or start again, being protected by drafts. */
    private val protectionListener: (Boolean) -> Unit = { protected ->
        runOnUiThread { toast(getString(if (protected) R.string.drafts_protected else R.string.drafts_not_protected)) }
    }

    @SuppressLint("SetJavaScriptEnabled") // the core is JavaScript; the page only runs our own code
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        keepClearOfSystemBars()
        WebView.setWebContentsDebuggingEnabled(isDebuggable())

        drafts = draftStore(applicationContext)
        drafts.onProtectionChanged = protectionListener
        reopen = savedInstanceState?.getString(STATE_DOCUMENT)?.let(Uri::parse)

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

    /**
     * The app may be killed at any time once in the background: ask for a draft now.
     * Only a precaution: the answer and its writing are asynchronous, and Android may stop
     * the process before they end. What is protected is the last draft actually written.
     */
    override fun onPause() {
        super.onPause()
        if (document != null) sendToCore(JSONObject().put("type", "flushDraft"))
    }

    /** Only the document: the map itself is protected by its draft on disk. */
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        (document ?: reopen)?.let { outState.putString(STATE_DOCUMENT, it.toString()) }
    }

    override fun onDestroy() {
        // Unless a newer activity has already taken over.
        if (drafts.onProtectionChanged === protectionListener) drafts.onProtectionChanged = null
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
        if (requestCode != REQUEST_OPEN || resultCode != RESULT_OK || uri == null) return
        keepAccess(uri, data.flags)
        open(uri)
    }

    /** Keeps the right to read and write the document after the process dies or the phone restarts. */
    private fun keepAccess(uri: Uri, flags: Int) {
        val modes = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        try {
            contentResolver.takePersistableUriPermission(uri, modes)
        } catch (e: SecurityException) {
            Log.w(TAG, "No persistable access to $uri", e)
        }
    }

    /**
     * Reads the document off the main thread (a provider such as Drive may download it
     * first), with its draft if it has one, and offers to restore it.
     */
    private fun open(uri: Uri) {
        thread {
            try {
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                val name = displayName(uri)
                val base = DraftStore.fingerprint(bytes)
                val found = drafts.read(uri.toString())
                Log.i(TAG, "Opened $name: ${bytes.size} bytes, ${describe(uri)}, draft: ${found.javaClass.simpleName}, $uri")
                runOnUiThread {
                    when (found) {
                        is Found.Present -> offerDraft(uri, name, bytes, base, found.draft)
                        is Found.Unreadable -> {
                            toast(getString(R.string.draft_unreadable))
                            load(uri, name, bytes, base)
                        }
                        Found.None -> load(uri, name, bytes, base)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read $uri", e)
                runOnUiThread { toast(getString(R.string.error_read)) }
            }
        }
    }

    /** Restore or discard: either way, the draft is deleted only once a map is loaded. */
    private fun offerDraft(uri: Uri, name: String, bytes: ByteArray, base: String, draft: Draft) {
        val time = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(draft.time))
        var message = getString(R.string.draft_message, time)
        if (base != draft.base) message += "\n\n" + getString(R.string.draft_document_changed)
        AlertDialog.Builder(this)
            .setTitle(R.string.draft_title)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton(R.string.restore) { _, _ -> load(uri, name, draft.bytes, draft.base, restoredDraft = true) }
            .setNegativeButton(R.string.discard) { _, _ -> load(uri, name, bytes, base, discardDraft = true) }
            .show()
    }

    private fun displayName(uri: Uri): String =
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: uri.lastPathSegment.orEmpty()

    private fun load(
        uri: Uri,
        name: String,
        bytes: ByteArray,
        base: String,
        restoredDraft: Boolean = false,
        discardDraft: Boolean = false,
    ) {
        val requestId = "r${++requestCount}"
        pendingLoads[requestId] = PendingLoad(uri, name, base, discardDraft)
        sendToCore(
            JSONObject()
                .put("type", "load")
                .put("requestId", requestId)
                .put("name", name)
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("readOnly", false)
                .put("restoredDraft", restoredDraft)
                .put("locale", resources.configuration.locales[0].toLanguageTag()),
        )
    }

    private fun loaded(load: PendingLoad) {
        document = load.uri
        documentName = load.name
        base = load.base
        title = load.name
        Log.i(TAG, "Loaded ${load.name}, based on ${load.base.take(8)}")
        if (load.discardDraft) drafts.submit(load.uri.toString(), null)
    }

    // ---------- drafts (docs/BRIDGE.md, section 6) ----------

    /** A draft concerns the map loaded now: its document is fixed here, before any writing. */
    private fun keepDraft(message: JSONObject) {
        val uri = document ?: return
        val bytes = if (message.isNull("data")) null else Base64.decode(message.getString("data"), Base64.NO_WRAP)
        val draft = bytes?.let { Draft(uri.toString(), documentName, base, System.currentTimeMillis(), it) }
        Log.i(TAG, "Draft of $documentName: ${bytes?.let { "${it.size} bytes, based on ${base.take(8)}" } ?: "delete"}")
        drafts.submit(uri.toString(), draft)
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
        saveWriter.execute {
            val start = System.currentTimeMillis()
            try {
                contentResolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot write $uri", e)
                runOnUiThread { toast(getString(R.string.error_write)) }
                return@execute
            }
            val written = DraftStore.fingerprint(bytes)
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread // its map is gone with it
                sendToCore(JSONObject().put("type", "saved").put("saveId", saveId))
                if (document == uri) {
                    // The document now holds these bytes. A draft left by later changes must
                    // be based on them, even if no change follows: ask for it again.
                    base = written
                    Log.i(TAG, "Saved: now based on ${written.take(8)}")
                    sendToCore(JSONObject().put("type", "flushDraft"))
                }
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
                reopen?.let(::open)
                reopen = null
            }
            "loaded" -> pendingLoads.remove(message.getString("requestId"))?.let(::loaded)
            "draftData" -> keepDraft(message)
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
        const val STATE_DOCUMENT = "document"

        // One of each for the whole process, not per activity: when Android recreates
        // the activity, two writers must never work on the same files.

        /** Writes one save at a time, in request order. */
        val saveWriter = Executors.newSingleThreadExecutor()

        private var drafts: DraftStore? = null

        @Synchronized
        fun draftStore(context: Context): DraftStore =
            drafts ?: DraftStore(File(context.filesDir, "drafts"), WriterThread()).also { drafts = it }
    }
}
