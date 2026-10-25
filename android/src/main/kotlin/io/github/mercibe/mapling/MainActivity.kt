// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package io.github.mercibe.mapling

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.icu.text.ListFormatter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.method.LinkMovementMethod
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.util.Linkify
import android.util.Log
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.Toolbar
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.core.view.GravityCompat
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.navigation.NavigationView
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
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var home: View
    private lateinit var recent: RecentMaps
    private lateinit var nodeBar: View
    private lateinit var drafts: DraftStore
    private var coreReady = false
    private var requestCount = 0

    /** The open document: changes only when the core has accepted a new one. */
    private var document: Uri? = null
    private var documentName = ""
    private var documentTitle = "" // the root's text (core's `title`)

    /**
     * Fingerprint of the content the open map is based on: the bytes read, then the bytes
     * of each successful save. A restored draft keeps its own, so that a change made
     * elsewhere is still reported next time.
     */
    private var base = ""
    private var dirty = false

    /** Reads of the open map's file in progress (checkFile): those started before a change are ignored. */
    private val fileReads = FileReads()

    /** The current watch for a newer version of the open map (see watchForNewerVersion). */
    @Volatile private var newerVersionWatch: Any? = null

    /** Fingerprint of the version made elsewhere the user was told about: not asked again. */
    private var keptOver: String? = null

    /** Whether the user was told that the open map's file can no longer be read: told once. */
    private var unreadableTold = false

    /** What the core reports, to enable the commands (docs/BRIDGE.md, section 5). */
    private var mapReadOnly = false
    private var canUndo = false
    private var canRedo = false
    private var selection: JSONObject? = null

    /**
     * Leaving the map once a given save has been written (Save in leaveMap): tied to that
     * save request and its document, so that nothing else can set it off later.
     */
    private class LeaveAfterSave(val requestId: String, val uri: Uri, val then: () -> Unit)

    private var leaveAfterSave: LeaveAfterSave? = null

    private lateinit var drawer: DrawerLayout

    /** "Back" with unsaved changes asks first (AndroidX, predictive back included). */
    private val backWhileModified = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = leaveMap(::finish)
    }

    /** "Back" closes the drawer first, when it is open. */
    private val backClosesDrawer = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = drawer.closeDrawer(GravityCompat.START)
    }

    /** Messages shown in banners while they apply. */
    private var readOnlyReasons = listOf<String>() // warning codes of `loaded`
    private var hiddenNotice: String? = null // shown once per document, until dismissed
    private var draftsProtected = true

    /**
     * Document to reopen once the core is ready (the last map left open, or the one shown
     * before Android recreated the activity). Kept until it is loaded or cannot be: the
     * home screen stays hidden meanwhile, so that it does not flash before the map.
     */
    private var reopen: Uri? = null

    /**
     * Documents lent by another app ("Open with", by their URI): for this session only, so
     * neither listed in the recent maps nor reopened at start. The value: whether writing
     * was lent too; if not, the map is read-only and can be saved as a copy.
     */
    private val lent = mutableMapOf<String, Boolean>()

    /** What each pending `load` will open, by requestId: a refused load changes nothing. */
    private class PendingLoad(
        val uri: Uri,
        val name: String,
        val base: String,
        val discardDraft: Boolean,
        val restoredDraft: Boolean,
        val modified: Long?, // the provider's date when the file was read
        val ifRefused: (() -> Unit)?, // set: a version made elsewhere, loaded only if nothing is lost
    )

    private val pendingLoads = mutableMapOf<String, PendingLoad>()

    /**
     * Document each pending `save` request belongs to, by requestId (docs/BRIDGE.md, section 7),
     * with the fingerprint of the content its map was based on when the save was requested.
     */
    private class SaveTarget(val uri: Uri, val base: String, val asCopy: Boolean)

    private val saveTargets = mutableMapOf<String, SaveTarget>()

    /** A save refused because of a change made elsewhere, while the user picks where to copy it. */
    private class PendingCopy(val document: Uri, val name: String, val saveId: Long, val bytes: ByteArray)

    private var pendingCopy: PendingCopy? = null

    /** A banner tells the user while unsaved changes are not protected by drafts. */
    private val protectionListener: (Boolean) -> Unit = { protected ->
        runOnUiThread {
            draftsProtected = protected
            render()
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // the core is JavaScript; the page only runs our own code
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
        webView = findViewById(R.id.map)
        home = findViewById(R.id.home)
        findViewById<View>(R.id.open_map).setOnClickListener { pickDocument() }
        findViewById<View>(R.id.new_map).setOnClickListener { pickNewMap() }
        recent = RecentMaps.decode(preferences().getString(RECENT_MAPS, null))
        nodeBar = findViewById(R.id.node_bar)
        setUpToolbar()
        setUpNodeBar()
        keepClearOfSystemBars()
        WebView.setWebContentsDebuggingEnabled(isDebuggable())

        drafts = draftStore(applicationContext)
        drafts.watchProtection(protectionListener)
        // After Android recreated the screen, its document; on a fresh start, the last map
        // left open, unless it was closed (Close in the ☰ menu).
        reopen = (savedInstanceState?.getString(STATE_DOCUMENT) ?: preferences().getString(LAST_OPEN, null))
            ?.toUri()
        val viewed = lentDocument(intent) // also when Android recreates the activity: still lent
        if (savedInstanceState == null && viewed != null) reopen = viewed
        render() // the home screen stays hidden from the start while a map is to be reopened

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
        if (checkWebView()) webView.loadUrl(AssetServer.PAGE_URL)
    }

    /**
     * An old WebView (a device without the Play Store, for instance) would show a blank
     * page: say instead what to update, and close.
     */
    private fun checkWebView(): Boolean {
        val webViewPackage = WebView.getCurrentWebViewPackage()
        if (runsCore(webViewPackage?.versionName)) return true
        val name = webViewPackage?.applicationInfo?.loadLabel(packageManager) ?: ""
        MaterialAlertDialogBuilder(this)
            .setMessage(getString(R.string.webview_too_old, name, webViewPackage?.versionName, MIN_CHROMIUM))
            .setCancelable(false)
            .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
            .show()
        return false
    }

    /** "Open with Mapling" while Mapling runs (a single instance: singleTask). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val viewed = lentDocument(intent) ?: return
        if (coreReady) leaveMap { open(viewed) } else reopen = viewed
    }

    /** The document another app asks Mapling to open, if any, recorded as lent. */
    private fun lentDocument(intent: Intent?): Uri? {
        if (intent?.action != Intent.ACTION_VIEW) return null
        val uri = intent.data ?: return null
        lent[uri.toString()] = intent.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0
        return uri
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

    /** Back from another app, the open map or the recent maps may have been saved elsewhere meanwhile. */
    override fun onResume() {
        super.onResume()
        val open = document
        if (open != null) checkFile(open) else renderHome()
    }

    /** Only the document: the map itself is protected by its draft on disk. */
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        (document ?: reopen)?.let { outState.putString(STATE_DOCUMENT, it.toString()) }
    }

    override fun onDestroy() {
        newerVersionWatch = null
        fileReads.invalidate()
        // Unless a newer activity has already taken over.
        if (drafts.onProtectionChanged === protectionListener) drafts.watchProtection(null)
        webView.destroy()
        super.onDestroy()
    }

    // ---------- toolbar and menus ----------

    private fun setUpToolbar() {
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)
        supportActionBar?.setDisplayShowTitleEnabled(false)
        toolbar.setNavigationIcon(R.drawable.ic_menu)
        toolbar.setNavigationContentDescription(R.string.menu)
        toolbar.setNavigationOnClickListener { openDrawer() }
        drawer = findViewById(R.id.drawer)
        // The drawer opens from ☰ only, which fills it: a swipe from the edge would show it
        // empty or out of date (with button navigation; with gestures, that swipe is "back").
        // Once open, it can be swiped closed.
        drawer.setDrawerLockMode(DrawerLayout.LOCK_MODE_LOCKED_CLOSED)
        drawer.addDrawerListener(object : DrawerLayout.SimpleDrawerListener() {
            override fun onDrawerOpened(drawerView: View) {
                backClosesDrawer.isEnabled = true
                drawer.setDrawerLockMode(DrawerLayout.LOCK_MODE_UNLOCKED)
            }

            override fun onDrawerClosed(drawerView: View) {
                backClosesDrawer.isEnabled = false
                drawer.setDrawerLockMode(DrawerLayout.LOCK_MODE_LOCKED_CLOSED)
            }
        })
        // The last added runs first: an open drawer closes before anything else.
        onBackPressedDispatcher.addCallback(this, backWhileModified)
        onBackPressedDispatcher.addCallback(this, backClosesDrawer)
    }

    /** Undo, redo and save, always at hand. */
    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        val tint = getColorStateList(R.color.toolbar_icon)
        for ((id, title, icon) in TOOLBAR_ACTIONS) {
            menu.add(Menu.NONE, id, Menu.NONE, title).apply {
                setIcon(icon)
                iconTintList = tint
                setShowAsAction(MenuItem.SHOW_AS_ACTION_IF_ROOM)
            }
        }
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        val open = document != null
        for ((id, _, _) in TOOLBAR_ACTIONS) menu.findItem(id).isVisible = open
        menu.findItem(MENU_UNDO).isEnabled = canUndo
        menu.findItem(MENU_REDO).isEnabled = canRedo
        menu.findItem(MENU_SAVE).isEnabled = dirty
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            MENU_UNDO -> sendToCore(JSONObject().put("type", "undo"))
            MENU_REDO -> sendToCore(JSONObject().put("type", "redo"))
            MENU_SAVE -> save()
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    /**
     * A recent map in the drawer, on two lines: its root's text, then its file, smaller and
     * grey. Each is shortened to fit its line, so that no line is cut.
     */
    private fun recentLabel(entry: RecentMaps.Entry): CharSequence {
        val file = shortenMiddle(entry.name, DRAWER_FILE_CHARS)
        val title = oneLine(entry.title)
        if (title.isEmpty()) return file
        val label = SpannableStringBuilder(shortenEnd(title, DRAWER_TITLE_CHARS)).append('\n')
        val start = label.length
        label.append(file)
        label.setSpan(RelativeSizeSpan(0.8f), start, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        label.setSpan(ForegroundColorSpan(getColor(R.color.menu_detail)), start, label.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return label
    }

    /** The ☰ drawer, filled each time it opens: the open map, the commands, the recent maps, About. */
    private fun openDrawer() {
        val navigation = findViewById<NavigationView>(R.id.navigation)
        val open = document != null
        val header = navigation.getHeaderView(0) ?: navigation.inflateHeaderView(R.layout.drawer_header)
        header.visibility = if (open) View.VISIBLE else View.GONE
        val title = oneLine(documentTitle)
        header.findViewById<TextView>(R.id.drawer_title).text = title.ifEmpty { documentName }
        header.findViewById<TextView>(R.id.drawer_file).text = if (title.isEmpty()) "" else documentName

        // Each icon has its own tint (grey, red for deleting): the drawer's single tint would override it.
        navigation.itemIconTintList = null
        val menu = navigation.menu
        menu.clear()
        val actions = mutableMapOf<Int, () -> Unit>()
        // Entries of different groups are separated by a line in the drawer.
        fun add(
            menu: Menu, label: CharSequence, icon: Int, enabled: Boolean, group: Int = COMMANDS,
            tint: Int = R.color.menu_icon, action: () -> Unit,
        ): MenuItem {
            val id = actions.size + 1
            actions[id] = action
            val item = menu.add(group, id, Menu.NONE, label).setIcon(icon).setEnabled(enabled)
            item.icon?.mutate()?.setTint(getColor(tint))
            return item
        }
        add(menu, getString(R.string.open), R.drawable.ic_folder_open, coreReady) { leaveMap(::pickDocument) }
        add(menu, getString(R.string.new_map), R.drawable.ic_note_add, coreReady) { leaveMap(::pickNewMap) }
        add(menu, getString(R.string.reload), R.drawable.ic_refresh, open) { document?.let { uri -> leaveMap { open(uri) } } }
        if (open) { // only shown when it applies: red stays red, even disabled
            add(menu, dangerous(getString(R.string.delete_map)), R.drawable.ic_delete, true, tint = R.color.danger) {
                confirmDeleteMap()
            }
        }
        add(menu, getString(R.string.center), R.drawable.ic_filter_center_focus, open) {
            sendToCore(JSONObject().put("type", "center"))
        }
        add(menu, getString(R.string.close), R.drawable.ic_close, open) {
            leaveMap {
                // Not reopened at the next start; a lent map never was, the one before it still is.
                if (document?.toString() !in lent) preferences().edit { remove(LAST_OPEN) }
                close()
            }
        }
        val others = recent.entries.filter { it.document != document?.toString() }
        if (others.isNotEmpty()) {
            val section = menu.addSubMenu(R.string.recent_maps) // a titled section in the drawer
            for (entry in others) {
                val item = add(section, recentLabel(entry), R.drawable.ic_history, coreReady) {
                    leaveMap { open(entry.document.toUri()) }
                }
                item.actionView = removeButton(entry, ::openDrawer) // then the list, updated
            }
        }
        add(menu, getString(R.string.about), R.drawable.ic_info, true, group = ABOUT) { showAbout() }

        navigation.setNavigationItemSelectedListener { item ->
            drawer.closeDrawer(GravityCompat.START)
            actions[item.itemId]?.invoke()
            true
        }
        drawer.openDrawer(GravityCompat.START)
    }

    // ---------- about ----------

    /** Version, copyright, license and no warranty (GPL section 5), with the licenses' texts. */
    private fun showAbout() {
        val version = packageManager.getPackageInfo(packageName, 0).versionName
        // Two buttons fit on one line; the source code is a link in the text.
        val text = getString(R.string.about_text, version) + "\n\n" + getString(R.string.source_code_link, SOURCE_URL)
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.app_name)
            .setMessage(text)
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(R.string.licenses) { _, _ -> showLicenses() }
            .show()
        dialog.findViewById<TextView>(android.R.id.message)?.let { message ->
            Linkify.addLinks(message, Linkify.WEB_URLS) // opened in the browser: the app itself never uses the network
            message.movementMethod = LinkMovementMethod.getInstance()
        }
    }

    private fun showLicenses() {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.licenses)
            .setItems(LICENSES.map { getString(it.first) }.toTypedArray()) { _, which ->
                val (title, files) = LICENSES[which]
                val text = files.joinToString("\n\n") { file -> assets.open(file).bufferedReader().use { it.readText() } }
                MaterialAlertDialogBuilder(this).setTitle(title).setMessage(text).setPositiveButton(android.R.string.ok, null).show()
            }
            .show()
    }


    // ---------- leaving a modified map ----------

    /**
     * Before the map is left (another one opened, reloaded, closed, or the app quit):
     * with unsaved changes, save them, discard them (and their draft), or stay.
     */
    private fun leaveMap(then: () -> Unit) {
        val uri = document
        if (!dirty || uri == null) return then()
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.unsaved_changes)
            .setPositiveButton(R.string.save) { _, _ ->
                save()?.let { requestId -> leaveAfterSave = LeaveAfterSave(requestId, uri, then) }
            }
            .setNegativeButton(R.string.discard) { _, _ ->
                // The core still holds the changes: closing the map first makes the shell
                // ignore any draft it may still send for them (onPause asks for one).
                drafts.submit(uri.toString(), null)
                close()
                then()
            }
            .setNeutralButton(android.R.string.cancel, null)
            .show()
    }

    // ---------- commands on the selected node ----------

    private fun setUpNodeBar() {
        findViewById<ImageButton>(R.id.edit_text).setOnClickListener { nodeCommand("editText") }
        findViewById<ImageButton>(R.id.add_child).setOnClickListener { nodeCommand("addChild") }
        findViewById<ImageButton>(R.id.add_sibling).setOnClickListener { nodeCommand("addSibling") }
        findViewById<ImageButton>(R.id.delete_node).setOnClickListener { deleteSelected() }
    }

    /** Commands name their target, taken from the latest selectionChanged (docs/BRIDGE.md). */
    private fun nodeCommand(type: String) {
        val node = selection ?: return
        sendToCore(JSONObject().put("type", type).put("id", node.getString("id")))
    }

    /** Asks first when the branch holds content that is not shown, with a summary of it. */
    private fun deleteSelected() {
        val node = selection ?: return
        val branch = node.getJSONObject("branch")
        val hidden = branch.getJSONObject("hidden")
        if (hidden.length() == 0) return sendDelete(node)
        val items = mutableListOf<String>()
        val descendants = branch.getInt("descendants")
        if (descendants > 0) items += resources.getQuantityString(R.plurals.count_descendants, descendants, descendants)
        for ((kind, plural) in HIDDEN_KINDS) {
            val count = hidden.optInt(kind)
            if (count > 0) items += resources.getQuantityString(plural, count, count)
        }
        MaterialAlertDialogBuilder(this)
            .setMessage(getString(R.string.confirm_delete, ListFormatter.getInstance().format(items)))
            .setPositiveButton(R.string.delete_node) { _, _ -> sendDelete(node) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /**
     * Sends back the revision the decision was based on: if the map changed since, the core
     * refuses it (OUTDATED_COMMAND) and the user, told so, starts again from what is shown now.
     */
    private fun sendDelete(node: JSONObject) {
        sendToCore(
            JSONObject().put("type", "deleteNode").put("requestId", "r${++requestCount}")
                .put("id", node.getString("id")).put("revision", node.getInt("revision")),
        )
    }

    /** Shows what can be done now: the map or the home screen, and the enabled commands. */
    private fun render() {
        val open = document != null
        webView.visibility = if (open) View.VISIBLE else View.INVISIBLE
        home.visibility = if (open || reopen != null) View.GONE else View.VISIBLE
        if (!open) renderHome()
        // Shown whenever the map can be edited, so that the map does not jump at each selection.
        nodeBar.visibility = if (open && !mapReadOnly) View.VISIBLE else View.GONE
        val node = selection
        val root = node?.getBoolean("root") ?: true
        findViewById<View>(R.id.edit_text).isEnabled = node?.getBoolean("textEditable") ?: false
        findViewById<View>(R.id.add_child).isEnabled = node != null
        findViewById<View>(R.id.add_sibling).isEnabled = !root
        findViewById<View>(R.id.delete_node).isEnabled = !root
        renderMessages()
        renderHints()
        backWhileModified.isEnabled = dirty && document != null
        invalidateOptionsMenu()
    }

    /** Open, new, and the recent maps: one gesture to go back to a map. */
    private fun renderHome() {
        findViewById<View>(R.id.open_map).isEnabled = coreReady
        findViewById<View>(R.id.new_map).isEnabled = coreReady
        val list = findViewById<LinearLayout>(R.id.recent_list)
        list.removeAllViews()
        findViewById<View>(R.id.recent_title).visibility = if (recent.entries.isEmpty()) View.GONE else View.VISIBLE
        val details = mutableListOf<Pair<RecentMaps.Entry, TextView>>()
        for (entry in recent.entries) {
            val row = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                isEnabled = coreReady
                isClickable = true
                setBackgroundResource(selectableBackground())
                setOnClickListener { open(entry.document.toUri()) }
            }
            // The root's text, then the file's name and, once known, when it was last saved.
            val texts = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(10), 0, dp(10))
            }
            val title = oneLine(entry.title)
            texts.addView(TextView(this).apply {
                text = title.ifEmpty { entry.name }
                textSize = 16f
                maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setTextColor(getColor(R.color.message_text))
            })
            val detail = TextView(this).apply {
                text = if (title.isEmpty()) "" else entry.name
                textSize = 13f
            }
            texts.addView(detail)
            row.addView(texts, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            row.addView(removeButton(entry) {})
            details.add(entry to detail)
            list.addView(row)
        }
        showModifiedDates(details)
    }

    /**
     * The date each recent map was last saved, here or elsewhere, as its provider reports it
     * (for Drive, once the file reached the server). Asked off the main thread, since a
     * provider may be slow; a map whose provider gives no date shows none.
     */
    private fun showModifiedDates(details: List<Pair<RecentMaps.Entry, TextView>>) {
        if (details.isEmpty()) return
        val format = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        thread {
            val start = System.currentTimeMillis()
            for ((entry, detail) in details) {
                val date = lastModified(entry.document.toUri())?.let { format.format(Date(it)) } ?: continue
                runOnUiThread { detail.text = if (detail.text.isEmpty()) date else "${detail.text} · $date" }
            }
            Log.i(TAG, "Modification dates of ${details.size} recent maps in ${System.currentTimeMillis() - start} ms")
        }
    }

    private fun lastModified(uri: Uri): Long? = try {
        contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use {
            if (it.moveToFirst() && !it.isNull(0)) it.getLong(0).takeIf { time -> time > 0 } else null
        }
    } catch (e: Exception) {
        Log.w(TAG, "No modification date for $uri", e)
        null
    }

    private fun selectableBackground(): Int {
        val value = android.util.TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackground, value, true)
        return value.resourceId
    }

    private fun renderMessages() {
        val messages = findViewById<LinearLayout>(R.id.messages)
        messages.removeAllViews()
        for (code in readOnlyReasons) {
            READ_ONLY_TEXTS[code]?.let { messages.addView(banner(getString(it), R.color.message_warning)) }
        }
        if (lent[document?.toString()] == false) {
            val copy = R.string.save_copy to ::pickLentCopy
            messages.addView(banner(getString(R.string.lent_read_only), R.color.message_warning, action = copy))
        }
        hiddenNotice?.let {
            messages.addView(banner(it, R.color.message_info) { hiddenNotice = null; render() })
        }
        if (!draftsProtected) messages.addView(banner(getString(R.string.drafts_not_protected), R.color.message_warning))
    }

    /** While a node with a lock or a dot is selected, what the mark means; nothing otherwise. */
    private fun renderHints() {
        val hints = findViewById<LinearLayout>(R.id.hints)
        hints.removeAllViews()
        val node = selection ?: return
        if (!node.getBoolean("textEditable") && !mapReadOnly) {
            hints.addView(hint(getString(R.string.hint_locked), R.drawable.mark_lock))
        }
        val hidden = node.getJSONObject("hidden")
        val items = HIDDEN_KINDS.mapNotNull { (kind, plural) ->
            hidden.optInt(kind).takeIf { it > 0 }?.let { resources.getQuantityString(plural, it, it) }
        }
        if (items.isNotEmpty()) {
            hints.addView(hint(getString(R.string.hint_hidden, ListFormatter.getInstance().format(items)), R.drawable.mark_dot))
        }
    }

    /** A message across the screen; with `action`, a text button does it; with `dismiss`, a button closes it. */
    private fun banner(
        text: String, color: Int, action: Pair<Int, () -> Unit>? = null, dismiss: (() -> Unit)? = null,
    ): View {
        val row = LinearLayout(this)
        row.setBackgroundColor(getColor(color))
        row.gravity = Gravity.CENTER_VERTICAL
        row.addView(messageText(text), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (action != null) {
            val button = Button(this, null, android.R.attr.borderlessButtonStyle)
            button.setText(action.first)
            button.setTextColor(getColor(R.color.forest))
            button.setOnClickListener { action.second() }
            row.addView(button)
        }
        if (dismiss != null) {
            val close = ImageButton(this, null, android.R.attr.borderlessButtonStyle)
            close.setImageResource(R.drawable.ic_close)
            close.imageTintList = getColorStateList(R.color.message_text)
            close.contentDescription = getString(R.string.dismiss)
            close.tooltipText = getString(R.string.dismiss)
            close.setOnClickListener { dismiss() }
            row.addView(close, LinearLayout.LayoutParams(dp(48), dp(48)))
        }
        return row
    }

    /** An explanation preceded by the very mark it explains. */
    private fun hint(text: String, mark: Int): View = messageText(text).apply {
        setBackgroundColor(getColor(R.color.message_hint))
        setCompoundDrawablesRelativeWithIntrinsicBounds(mark, 0, 0, 0)
        compoundDrawablePadding = dp(8)
    }

    private fun messageText(text: String) = TextView(this).apply {
        this.text = text
        textSize = 14f
        setTextColor(getColor(R.color.message_text))
        setPadding(dp(12), dp(8), dp(12), dp(8))
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    // ---------- opening a document ----------

    private fun pickDocument() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*") // providers disagree on the type of .mm files
        startActivityForResult(intent, REQUEST_OPEN)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data.takeIf { resultCode == RESULT_OK }
        when (requestCode) {
            REQUEST_OPEN -> if (uri != null) {
                keepAccess(uri, data!!.flags)
                open(uri)
            }
            REQUEST_NEW_MAP -> if (uri != null) {
                keepAccess(uri, data!!.flags)
                createMap(uri)
            }
            REQUEST_SAVE_LENT_COPY -> {
                val lentUri = document?.takeIf { lent[it.toString()] == false } ?: return
                if (uri == null) return
                keepAccess(uri, data!!.flags)
                writeLentCopy(lentUri, uri)
            }
            REQUEST_SAVE_COPY -> {
                val copy = pendingCopy ?: return
                pendingCopy = null
                if (uri == null) return // the map stays modified, protected by its draft
                keepAccess(uri, data!!.flags)
                saveWriter.execute { writeTo(uri, copy.saveId, copy.bytes, copy = copy) }
            }
        }
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

    /** The number of documents an app may keep access to is limited: give back what is no longer listed. */
    private fun releaseAccess(uri: Uri) {
        try {
            contentResolver.releasePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: SecurityException) {
            Log.w(TAG, "No access to release for $uri", e)
        }
    }

    /**
     * A recent map that cannot be read may be gone (moved, deleted, access withdrawn) or only
     * out of reach for now (a provider offline): providers do not tell which (Drive reports
     * both as a missing file), so the user decides.
     */
    private fun offerToForget(uri: Uri) {
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.map_unreadable)
            .setPositiveButton(R.string.remove_from_list) { _, _ -> forget(uri) }
            .setNegativeButton(R.string.keep, null)
            .show()
    }

    /** The document now open goes first in the recent maps; those that no longer fit give back their access. */
    private fun putFirstInRecent(uri: Uri, name: String, title: String) {
        recent.opened(uri.toString(), name, title, System.currentTimeMillis()).forEach { releaseAccess(it.toUri()) }
    }

    /**
     * The recent maps show the title of what the file holds: the current title only once
     * the map is unmodified (opened, saved, or changes undone). A title changed and then
     * discarded never reaches them.
     */
    private fun recentTitleIsSaved() {
        val uri = document ?: return
        recent.retitle(uri.toString(), documentTitle)
        storeRecent()
    }

    private fun recentTitle(uri: Uri) = recent.entries.find { it.document == uri.toString() }?.title.orEmpty()

    /** Keeps the recent maps, and the document open now as the one to reopen at start. */
    private fun storeRecent() {
        preferences().edit {
            putString(RECENT_MAPS, recent.encode())
            // A lent map is not reopened at start: its access ends with the session.
            if (document?.toString() !in lent) putString(LAST_OPEN, document?.toString())
        }
    }

    /**
     * At the end of a recent map's entry: removes it from the list, once confirmed (the file
     * itself is left as it is), then `removed`.
     */
    private fun removeButton(entry: RecentMaps.Entry, removed: () -> Unit): ImageButton {
        val button = ImageButton(this, null, android.R.attr.borderlessButtonStyle)
        button.setImageResource(R.drawable.ic_delete)
        // Smaller and grey: a secondary action, beside the entry's own icon and text.
        button.scaleType = ImageView.ScaleType.FIT_CENTER
        button.setPadding(dp(15), dp(15), dp(15), dp(15))
        button.imageTintList = getColorStateList(R.color.menu_detail)
        // 48 dp square: the style's minimum width (88 dp) would take room from the text.
        button.minimumWidth = dp(48)
        button.layoutParams = ViewGroup.LayoutParams(dp(48), dp(48))
        button.contentDescription = getString(R.string.remove_recent)
        button.tooltipText = getString(R.string.remove_recent)
        button.setOnClickListener {
            val name = oneLine(entry.title).ifEmpty { entry.name }
            MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.remove_recent_question, name))
                .setPositiveButton(R.string.remove) { _, _ ->
                    forget(entry.document.toUri())
                    removed()
                }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
        return button
    }

    /** In red: an action that cannot be undone. */
    private fun dangerous(label: String): CharSequence = SpannableStringBuilder(label).apply {
        setSpan(ForegroundColorSpan(getColor(R.color.danger)), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    /** Deletes the open map's file, once confirmed; unsaved changes go with it. */
    private fun confirmDeleteMap() {
        val uri = document ?: return
        // As in the recent maps: the root's text, then the file's name.
        val title = oneLine(documentTitle)
        var message = if (title.isEmpty()) getString(R.string.delete_map_question, documentName)
        else getString(R.string.delete_titled_map_question, title, documentName)
        if (dirty) message += "\n\n" + getString(R.string.delete_map_unsaved)
        MaterialAlertDialogBuilder(this)
            .setMessage(message)
            .setPositiveButton(R.string.delete) { _, _ -> deleteMap(uri) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Off the main thread (Drive may ask its server); then the map is closed and forgotten. */
    private fun deleteMap(uri: Uri) {
        thread {
            val deleted = try {
                DocumentsContract.deleteDocument(contentResolver, uri)
            } catch (e: Exception) {
                Log.w(TAG, "Cannot delete $uri", e)
                false
            }
            Log.i(TAG, "Deleted: $deleted, $uri")
            runOnUiThread {
                if (!deleted) return@runOnUiThread alert(R.string.error_delete)
                if (document == uri) close()
                drafts.submit(uri.toString(), null)
                forget(uri)
                toast(getString(R.string.map_deleted))
            }
        }
    }

    /** A map removed from the recent maps is not reopened at start either. */
    private fun forget(uri: Uri) {
        recent.remove(uri.toString())
        val preferences = preferences()
        preferences.edit {
            putString(RECENT_MAPS, recent.encode())
            if (preferences.getString(LAST_OPEN, null) == uri.toString()) remove(LAST_OPEN)
        }
        releaseAccess(uri)
        render()
    }

    private fun preferences() = getSharedPreferences(PREFERENCES, MODE_PRIVATE)

    // ---------- creating a map ----------

    /** Where and under which name: the system's picker, as for any document. */
    private fun pickNewMap() {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(MAP_TYPE)
            .putExtra(Intent.EXTRA_TITLE, getString(R.string.new_map) + ".mm")
        startActivityForResult(intent, REQUEST_NEW_MAP)
    }

    /** Writes a new map as Freeplane does (the core's template), then opens it like any other. */
    private fun createMap(uri: Uri) {
        thread {
            try {
                val template = assets.open(NEW_MAP_TEMPLATE).use { it.readBytes() }
                contentResolver.openOutputStream(uri, "wt")!!.use { it.write(template) }
                // The file holds what was just written: loaded as is, not read back. Dropbox
                // serves no content for a moment after a write (checked on a Pixel, 2026-10-25).
                // No date: a map just created cannot have been changed elsewhere, nothing to watch.
                val name = displayName(uri)
                runOnUiThread { load(uri, name, template, DraftStore.fingerprint(template), modified = null) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot create $uri", e)
                runOnUiThread { alert(R.string.error_write) }
            }
        }
    }

    /**
     * Reads the document off the main thread (a provider such as Drive may download it
     * first), with its draft if it has one, and offers to restore it.
     */
    private fun open(uri: Uri) {
        thread {
            try {
                val (bytes, modified) = readFile(uri)
                val name = displayName(uri)
                val base = DraftStore.fingerprint(bytes)
                val found = drafts.read(uri.toString())
                Log.i(TAG, "Opened $name: ${bytes.size} bytes, ${describe(uri)}, draft: ${found.javaClass.simpleName}, $uri")
                runOnUiThread {
                    when (found) {
                        is Found.Present -> offerDraft(uri, name, bytes, base, modified, found.draft)
                        is Found.Unreadable -> {
                            toast(getString(R.string.draft_unreadable))
                            load(uri, name, bytes, base, modified)
                        }
                        Found.None -> load(uri, name, bytes, base, modified)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read $uri", e)
                runOnUiThread {
                    if (reopen == uri) stopReopening()
                    if (recent.entries.any { it.document == uri.toString() }) offerToForget(uri)
                    else alert(R.string.error_read)
                }
            }
        }
    }

    /** Restore or discard: either way, the draft is deleted only once a map is loaded. */
    private fun offerDraft(uri: Uri, name: String, bytes: ByteArray, base: String, modified: Long?, draft: Draft) {
        val time = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(draft.time))
        var message = getString(R.string.draft_message, time)
        if (base != draft.base) message += "\n\n" + getString(R.string.draft_document_changed)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.draft_title)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton(R.string.restore) { _, _ -> load(uri, name, draft.bytes, draft.base, modified, restoredDraft = true) }
            .setNegativeButton(R.string.discard) { _, _ -> load(uri, name, bytes, base, modified, discardDraft = true) }
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
        modified: Long?,
        restoredDraft: Boolean = false,
        discardDraft: Boolean = false,
        ifRefused: (() -> Unit)? = null,
    ) {
        val requestId = "r${++requestCount}"
        pendingLoads[requestId] = PendingLoad(uri, name, base, discardDraft, restoredDraft, modified, ifRefused)
        sendToCore(
            JSONObject()
                .put("type", "load")
                .put("requestId", requestId)
                .put("name", name)
                .put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                .put("readOnly", lent[uri.toString()] == false) // lent without writing
                .put("restoredDraft", restoredDraft)
                .put("onlyIfUnmodified", ifRefused != null)
                .put("locale", resources.configuration.locales[0].toLanguageTag()),
        )
    }

    private fun loaded(load: PendingLoad, message: JSONObject) {
        reopen = null
        document = load.uri
        documentName = load.name
        documentTitle = message.optString("title")
        base = load.base
        mapReadOnly = message.getBoolean("readOnly")
        val warnings = message.getJSONArray("warnings")
        readOnlyReasons = List(warnings.length()) { warnings.getJSONObject(it).getString("code") }
        if (load.uri.toString() !in lent) {
            // A restored draft is not saved yet: the recent maps keep the title of the file.
            val fileTitle = if (load.restoredDraft) recentTitle(load.uri) else documentTitle
            putFirstInRecent(load.uri, load.name, fileTitle)
        }
        hiddenNotice = hiddenNotice(load.uri, message.getJSONArray("hiddenContent"))
        storeRecent()
        Log.i(TAG, "Loaded ${load.name}, based on ${load.base.take(8)}")
        if (load.discardDraft) drafts.submit(load.uri.toString(), null)
        if (load.ifRefused != null) toast(getString(R.string.map_updated))
        fileReads.invalidate()
        keptOver = null
        unreadableTold = false
        watchForNewerVersion(load.uri, load.modified)
        render()
    }

    /**
     * Drive serves the copy it has cached, and fetches a newer one only once the file is
     * read; it then reports the newer date within seconds, but tells no one (checked on a
     * Pixel, 2026-10-25). So, for a while after the file is read, its date is asked again:
     * when it changes, the file is read again.
     */
    private fun watchForNewerVersion(uri: Uri, modified: Long?) {
        val watch = Any()
        newerVersionWatch = watch
        if (modified == null) return
        thread {
            repeat(NEWER_VERSION_CHECKS) {
                Thread.sleep(NEWER_VERSION_INTERVAL_MS)
                if (newerVersionWatch !== watch) return@thread
                val now = lastModified(uri)
                if (now != null && now != modified) {
                    runOnUiThread { if (newerVersionWatch === watch) checkFile(uri) }
                    return@thread
                }
            }
        }
    }

    /**
     * Reads the open map's file again, off the main thread: if it no longer holds what the
     * map is based on, it was changed elsewhere; otherwise, watch for a newer version.
     */
    private fun checkFile(uri: Uri) {
        val ticket = fileReads.ticket(uri.toString())
        thread {
            val start = System.currentTimeMillis()
            val (bytes, modified) = try {
                readFile(uri)
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read $uri again", e)
                runOnUiThread { if (fileReads.applies(ticket, document?.toString()) && !isFinishing) fileUnreadable() }
                return@thread
            }
            val version = DraftStore.fingerprint(bytes)
            Log.i(TAG, "Read again in ${System.currentTimeMillis() - start} ms: ${version.take(8)}, based on ${base.take(8)}")
            runOnUiThread {
                when {
                    !fileReads.applies(ticket, document?.toString()) || isFinishing -> {} // another map, or saved, loaded or closed since
                    version == base || version == keptOver -> watchForNewerVersion(uri, modified)
                    else -> changedElsewhere(uri, bytes, version, modified)
                }
            }
        }
    }

    /** Off the main thread: the content, and the date its provider gave for it (see FileSnapshot). */
    private fun readFile(uri: Uri): Pair<ByteArray, Long?> {
        val file = FileSnapshot.take({ lastModified(uri) }, { contentResolver.openInputStream(uri)!!.use { it.readBytes() } })
        return file.bytes to file.modified
    }

    /**
     * Deleted, moved, or out of reach for now: Drive tells none of these apart (it serves a
     * file put in its trash as any other). Told once per map opened, since being offline
     * would otherwise tell it at each return to the app.
     */
    private fun fileUnreadable() {
        if (unreadableTold) return
        unreadableTold = true
        val dialog = MaterialAlertDialogBuilder(this).setTitle(R.string.file_unreadable_title)
        if (dirty) {
            dialog.setMessage(getString(R.string.file_unreadable) + "\n\n" + getString(R.string.file_unreadable_changes))
                .setPositiveButton(R.string.save_copy) { _, _ -> save(asCopy = true) }
                .setNegativeButton(R.string.keep_editing, null)
        } else {
            dialog.setMessage(R.string.file_unreadable).setPositiveButton(android.R.string.ok, null)
        }
        dialog.show()
    }

    /**
     * Unmodified, the map shows the version made elsewhere. Modified, the user chooses now,
     * rather than when saving. Only the core can tell for sure: a text being typed, or just
     * validated, is not in `dirty` yet (docs/BRIDGE.md, `onlyIfUnmodified`).
     */
    private fun changedElsewhere(uri: Uri, bytes: ByteArray, version: String, modified: Long?) {
        val choose = { if (document == uri && !isFinishing) offerChangedElsewhere(uri, bytes, version, modified) }
        if (dirty) choose() else load(uri, documentName, bytes, version, modified, ifRefused = choose)
    }

    /** A copy keeps both versions, reloading drops the changes. */
    private fun offerChangedElsewhere(uri: Uri, bytes: ByteArray, version: String, modified: Long?) {
        keptOver = version // coming back from picking a copy must not ask again
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.conflict_title)
            .setMessage(R.string.changed_elsewhere)
            .setCancelable(false)
            .setPositiveButton(R.string.save_copy) { _, _ -> save(asCopy = true) }
            .setNeutralButton(R.string.reload) { _, _ -> load(uri, documentName, bytes, version, modified, discardDraft = true) }
            .setNegativeButton(R.string.keep_editing, null) // saving will ask again
            .show()
    }

    /** The map to reopen cannot be read or loaded: the home screen is shown instead. */
    private fun stopReopening() {
        reopen = null
        render()
    }

    /** Back to the screen with no map. The core keeps the map until the next load. */
    private fun close() {
        newerVersionWatch = null
        fileReads.invalidate()
        document = null
        documentName = ""
        documentTitle = ""
        selection = null
        readOnlyReasons = listOf()
        hiddenNotice = null
        render()
    }

    /**
     * "This map contains notes and icons that are not shown here. They are kept.":
     * told once per document, the first time it is opened with such content. Remembered
     * in the recent maps, so forgotten with the document when it leaves them.
     */
    private fun hiddenNotice(uri: Uri, kinds: org.json.JSONArray): String? {
        if (kinds.length() == 0 || recent.hiddenContentTold(uri.toString())) return null
        recent.tellHiddenContent(uri.toString())
        val names = List(kinds.length()) { getString(KIND_NAMES.getValue(kinds.getString(it))) }
        return getString(R.string.hidden_notice, ListFormatter.getInstance().format(names))
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

    /** Returns the request's id, or null with no document open. As a copy, the user picks where. */
    private fun save(asCopy: Boolean = false): String? {
        val uri = document ?: return null
        val requestId = "r${++requestCount}"
        saveTargets[requestId] = SaveTarget(uri, base, asCopy)
        sendToCore(JSONObject().put("type", "save").put("requestId", requestId))
        return requestId
    }

    /**
     * Writes the bytes of a `saveData` to its own document, then confirms with `saved`;
     * unless the document was changed elsewhere since its map was read or saved: then
     * nothing is written, and the user chooses.
     */
    private fun write(message: JSONObject) {
        val requestId = message.getString("requestId")
        val target = saveTargets.remove(requestId) ?: return
        val saveId = message.getLong("saveId")
        val bytes = Base64.decode(message.getString("data"), Base64.NO_WRAP)
        if (target.asCopy) return pickCopy(target.uri, saveId, bytes)
        saveWriter.execute {
            val current = try {
                contentResolver.openInputStream(target.uri)!!.use { DraftStore.fingerprint(it.readBytes()) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot read ${target.uri} before writing", e) // never write blindly
                runOnUiThread {
                    giveUpLeaving(requestId)
                    alert(R.string.error_write)
                }
                return@execute
            }
            if (!writeCheck.unchanged(target.uri.toString(), current, target.base)) {
                Log.i(TAG, "Not written: changed elsewhere (${current.take(8)}, based on ${target.base.take(8)})")
                runOnUiThread {
                    giveUpLeaving(requestId) // the user decides again, once the conflict is settled
                    if (!isDestroyed) offerConflict(target.uri, saveId, bytes)
                }
                return@execute
            }
            writeTo(target.uri, saveId, bytes, requestId = requestId)
        }
    }

    /** Save a copy (recommended: nothing is lost), overwrite, or cancel. */
    private fun offerConflict(uri: Uri, saveId: Long, bytes: ByteArray) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.conflict_title)
            .setMessage(R.string.conflict_message)
            .setCancelable(false)
            .setPositiveButton(R.string.save_copy) { _, _ -> pickCopy(uri, saveId, bytes) }
            .setNeutralButton(R.string.overwrite) { _, _ -> saveWriter.execute { writeTo(uri, saveId, bytes) } }
            .setNegativeButton(android.R.string.cancel, null) // the map stays modified
            .show()
    }

    /** A map lent without writing, kept as a copy where the user picks: then an ordinary map. */
    private fun pickLentCopy() {
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(MAP_TYPE)
            .putExtra(Intent.EXTRA_TITLE, documentName)
        startActivityForResult(intent, REQUEST_SAVE_LENT_COPY)
    }

    /**
     * Read-only, the map is unmodified: the copy is the lent file's content, loaded as
     * written rather than read back (see createMap).
     */
    private fun writeLentCopy(lentUri: Uri, copy: Uri) {
        thread {
            try {
                val bytes = contentResolver.openInputStream(lentUri)!!.use { it.readBytes() }
                contentResolver.openOutputStream(copy, "wt")!!.use { it.write(bytes) }
                val name = displayName(copy)
                runOnUiThread { load(copy, name, bytes, DraftStore.fingerprint(bytes), modified = null) }
            } catch (e: Exception) {
                Log.w(TAG, "Cannot copy $lentUri to $copy", e)
                runOnUiThread { alert(R.string.error_write) }
            }
        }
    }

    private fun pickCopy(uri: Uri, saveId: Long, bytes: ByteArray) {
        val name = getString(R.string.copy_name, mapTitle(documentName)) + ".mm"
        pendingCopy = PendingCopy(uri, name, saveId, bytes)
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(MAP_TYPE)
            .putExtra(Intent.EXTRA_TITLE, name)
        startActivityForResult(intent, REQUEST_SAVE_COPY)
    }

    /**
     * Writes on the save writer's thread, then confirms with `saved`. A `copy` becomes the
     * open document, like "save as": the map is now based on the copy, and the original's
     * draft is deleted, since the copy holds the changes.
     */
    private fun writeTo(uri: Uri, saveId: Long, bytes: ByteArray, requestId: String? = null, copy: PendingCopy? = null) {
        val start = System.currentTimeMillis()
        try {
            contentResolver.openOutputStream(uri, "wt")!!.use { it.write(bytes) }
        } catch (e: Exception) {
            Log.w(TAG, "Cannot write $uri", e)
            runOnUiThread {
                requestId?.let(::giveUpLeaving) // the map stays open, still modified
                alert(R.string.error_write)
            }
            return
        }
        val written = DraftStore.fingerprint(bytes)
        writeCheck.wrote(uri.toString(), written)
        // The copy is written: a provider failing to tell its name must not stop the save.
        val name = copy?.let {
            try {
                displayName(uri)
            } catch (e: Exception) {
                Log.w(TAG, "No name for $uri", e)
                it.name
            }
        }
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread // its map is gone with it
            if (copy != null && name != null && document == copy.document) {
                document = uri
                documentName = name
                newerVersionWatch = null // the original's
                drafts.submit(copy.document.toString(), null)
                // The copy is now the map worked on: listed first, and reopened at start.
                putFirstInRecent(uri, name, documentTitle)
                if (recent.hiddenContentTold(copy.document.toString())) recent.tellHiddenContent(uri.toString())
                storeRecent()
                render()
            }
            sendToCore(JSONObject().put("type", "saved").put("saveId", saveId)) {
                // The core has handled `saved`, and its dirtyChanged, if any, is already
                // handled too: leave only if the map is now unmodified.
                val leave = leaveAfterSave?.takeIf { it.requestId == requestId } ?: return@sendToCore
                leaveAfterSave = null
                if (!dirty && document == leave.uri) leave.then()
            }
            if (document == uri) {
                // The document now holds these bytes. A draft left by later changes must
                // be based on them, even if no change follows: ask for it again.
                base = written
                fileReads.invalidate()
                Log.i(TAG, "Saved: now based on ${written.take(8)}")
                sendToCore(JSONObject().put("type", "flushDraft"))
            }
            toast(getString(R.string.saved))
        }
        Log.i(TAG, "Wrote ${bytes.size} bytes in ${System.currentTimeMillis() - start} ms: ${describe(uri)}")
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

    /**
     * `handled`, if given, runs on the main thread once the core has handled the message:
     * the messages it sent in return (through MindShell.send) have been posted before.
     */
    private fun sendToCore(message: JSONObject, handled: (() -> Unit)? = null) {
        message.put("v", 1)
        val script = "MindCore.receive(${JSONObject.quote(message.toString())})"
        webView.evaluateJavascript(script, handled?.let { { _: String? -> it() } })
    }

    private fun giveUpLeaving(requestId: String) {
        if (leaveAfterSave?.requestId == requestId) leaveAfterSave = null
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
                render()
                reopen?.let(::open)
            }
            "loaded" -> pendingLoads.remove(message.getString("requestId"))?.let { loaded(it, message) }
            "draftData" -> keepDraft(message)
            "saveData" -> write(message)
            "titleChanged" -> {
                documentTitle = message.getString("title")
                if (!dirty) recentTitleIsSaved()
            }
            "dirtyChanged" -> {
                dirty = message.getBoolean("dirty")
                if (!dirty) recentTitleIsSaved()
                render()
            }
            "historyChanged" -> {
                canUndo = message.getBoolean("canUndo")
                canRedo = message.getBoolean("canRedo")
                render()
            }
            "selectionChanged" -> {
                selection = message.optJSONObject("node")
                render()
            }
            "error" -> {
                // A refused load leaves the previous map, and so the previous document, open.
                val requestId = message.optString("requestId")
                val load = pendingLoads.remove(requestId)
                if (message.getString("code") == "MAP_MODIFIED" && load?.ifRefused != null) {
                    load.ifRefused.invoke() // nothing replaced: the user chooses
                    return
                }
                saveTargets.remove(requestId)
                giveUpLeaving(requestId)
                if (load != null && load.uri == reopen) stopReopening()
                showError(message.getString("code"))
            }
            else -> Log.d(TAG, "Core: ${message.toString().take(200)}")
        }
    }

    // ---------- helpers ----------

    /**
     * Since Android 15, the app draws under the system bars: the toolbar extends under the
     * status bar, and the rest of the screen stays clear of the other bars, of the camera
     * cutout and of the keyboard. The insets are then consumed: passed on, the keyboard
     * would be subtracted a second time by the WebView, leaving it a visible area of zero
     * height (the map jumped at each key typed).
     */
    private fun keepClearOfSystemBars() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
        val toolbar = findViewById<View>(R.id.toolbar)
        val navigation = findViewById<View>(R.id.navigation)
        val types = WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { root, insets ->
            val bars = insets.getInsets(types)
            toolbar.setPadding(0, bars.top, 0, 0)
            root.setPadding(bars.left, 0, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
        // The ☰ drawer stays between the system bars: the time and the camera remain visible.
        navigation.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(types)
            (view.layoutParams as ViewGroup.MarginLayoutParams).setMargins(0, bars.top, 0, bars.bottom)
            view.requestLayout()
            WindowInsets.CONSUMED
        }
    }

    /** The core's errors are shown from their code, translated; their `message` is only for logs. */
    private fun showError(code: String) = alert(ERROR_TEXTS[code] ?: R.string.error_INTERNAL)

    /** Errors are rare and matter: shown until dismissed on purpose, not by a stray touch. */
    private fun alert(text: Int) {
        if (isFinishing) return
        MaterialAlertDialogBuilder(this).setMessage(text).setPositiveButton(android.R.string.ok, null).create().apply {
            setCanceledOnTouchOutside(false)
            show()
        }
    }

    private fun isDebuggable() = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    private companion object {
        const val TAG = "mapling"

        // How long a newer version of a map just read is watched for: 30 s.
        const val NEWER_VERSION_CHECKS = 15
        const val NEWER_VERSION_INTERVAL_MS = 2000L
        const val MENU_SAVE = 2

        // What fits on one line of the ☰ drawer (at most 360 dp wide), beside the button that
        // removes the entry: a root's text, a file's name (smaller).
        const val DRAWER_TITLE_CHARS = 22
        const val DRAWER_FILE_CHARS = 28

        // Groups of entries in the ☰ drawer.
        const val COMMANDS = 1
        const val ABOUT = 2
        const val MENU_UNDO = 4
        const val MENU_REDO = 5

        val TOOLBAR_ACTIONS = listOf(
            Triple(MENU_UNDO, R.string.undo, R.drawable.ic_undo),
            Triple(MENU_REDO, R.string.redo, R.drawable.ic_redo),
            Triple(MENU_SAVE, R.string.save, R.drawable.ic_save),
        )

        const val PREFERENCES = "mapling"
        const val RECENT_MAPS = "recentMaps"
        const val LAST_OPEN = "lastOpen" // the map to reopen at start; removed by Close
        const val NEW_MAP_TEMPLATE = "core/assets/new-map.mm"

        /**
         * The type of a map created here. Android knows it goes with ".mm" (from Debian's
         * table): a provider making a name unique then numbers it "Map (1).mm", where an
         * unknown type got "Map.mm (1)", a file Freeplane would not recognise.
         */
        const val MAP_TYPE = "application/x-freemind"
        const val SOURCE_URL = "https://github.com/mercibe/mapling"

        /** Shown in About: each license, from the app's assets (see build.gradle.kts). */
        val LICENSES = listOf(
            R.string.license_mapling to listOf("licenses/LICENSE", "licenses/LICENSE-EXCEPTION.md"),
            R.string.license_jsmind to listOf("core/vendor/jsmind-0.9.1/LICENSE"),
            R.string.license_material_symbols to listOf("licenses/LICENSE-material-symbols.txt"),
        )

        /** Why a map opened read-only: warning codes of `loaded` (docs/BRIDGE.md, section 5). */
        val READ_ONLY_TEXTS = mapOf(
            "FORMAT_TOO_OLD" to R.string.read_only_FORMAT_TOO_OLD,
            "FORMAT_TOO_NEW" to R.string.read_only_FORMAT_TOO_NEW,
            "DUPLICATE_IDS" to R.string.read_only_DUPLICATE_IDS,
        )

        /** Names of the kinds of hidden content, for the notice shown when a map opens. */
        val KIND_NAMES = mapOf(
            "note" to R.string.kind_note,
            "details" to R.string.kind_details,
            "attribute" to R.string.kind_attribute,
            "link" to R.string.kind_link,
            "icon" to R.string.kind_icon,
            "connector" to R.string.kind_connector,
            "image" to R.string.kind_image,
        )

        /** The core's error codes (docs/BRIDGE.md, section 5) and their texts. */
        val ERROR_TEXTS = mapOf(
            "PARSE_ERROR" to R.string.error_PARSE_ERROR,
            "NOT_A_MAP" to R.string.error_NOT_A_MAP,
            "UNSUPPORTED_ENCODING" to R.string.error_UNSUPPORTED_ENCODING,
            "NO_MAP_LOADED" to R.string.error_NO_MAP_LOADED,
            "PROTOCOL_VERSION" to R.string.error_PROTOCOL_VERSION,
            "OUTDATED_COMMAND" to R.string.error_OUTDATED_COMMAND,
            "INTERNAL" to R.string.error_INTERNAL,
        )

        /** Kinds of hidden content, in the order of docs/BRIDGE.md, with their counted text. */
        val HIDDEN_KINDS = listOf(
            "note" to R.plurals.count_note,
            "details" to R.plurals.count_details,
            "attribute" to R.plurals.count_attribute,
            "link" to R.plurals.count_link,
            "icon" to R.plurals.count_icon,
            "connector" to R.plurals.count_connector,
            "image" to R.plurals.count_image,
        )
        const val REQUEST_OPEN = 1
        const val REQUEST_SAVE_COPY = 2
        const val REQUEST_NEW_MAP = 3
        const val REQUEST_SAVE_LENT_COPY = 4
        const val STATE_DOCUMENT = "document"

        // One of each for the whole process, not per activity: when Android recreates
        // the activity, two writers must never work on the same files.

        /** Writes one save at a time, in request order. */
        val saveWriter = Executors.newSingleThreadExecutor()

        /** Used on the save writer's thread only. */
        val writeCheck = WriteCheck()

        private var drafts: DraftStore? = null

        @Synchronized
        fun draftStore(context: Context): DraftStore =
            drafts ?: DraftStore(File(context.filesDir, "drafts"), WriterThread()).also { drafts = it }
    }
}
