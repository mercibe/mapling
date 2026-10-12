# Mapling for Android

The Android shell: a single activity around a WebView that runs the core (`core/`), plus native menus, messages and file access. It follows the shell obligations of [docs/BRIDGE.md](../docs/BRIDGE.md).

- Opens and saves documents through the system's document picker (Storage Access Framework): Google Drive, local storage, or any other document provider. The app asks for **no permission**, not even network access.
- Serves the core to the WebView from the app's assets; the page cannot load anything else.
- Keeps unsaved changes as drafts in the app's private storage, so that they survive the app being killed.
- Before saving, checks that the document was not changed elsewhere (another device, Freeplane on a computer); if it was, offers to save a copy, overwrite, or cancel.
- Lists the last ten maps opened, reopens at start the map left open (unless it was closed), and creates new maps.
- Uses the platform's views only: no AndroidX, AppCompat or Compose. Its only other dependency is JUnit, for tests.

## Requirements

- Android 8.0 (API 26) or later, with a WebView based on Chromium 85 or later (any device updated through the Play Store). With an older WebView, the app says which component to update and closes.
- To build: JDK 17 or later, Node 24 or later (for the core), and the Android SDK with the platform and build tools of API 37. Gradle itself comes with the wrapper (`gradlew`).

Tell Gradle where the SDK is, either with the `ANDROID_HOME` environment variable or with a `local.properties` file in this directory (`sdk.dir=/path/to/Android/Sdk`, git-ignored).

## Build and install

The app embeds the compiled core: build it first, from the repository root.

```
npm install
npm run build
```

Then, from this directory:

```
./gradlew assembleDebug    # APK in build/outputs/apk/debug/
./gradlew installDebug     # build and install on the connected device (adb)
```

The build stops with a clear message if the core has not been built. Rebuild the core after each change in `core/src`.

## Tests

```
./gradlew testDebugUnitTest   # JUnit tests (drafts, write check, recent maps, WebView version), on the computer
./gradlew lint                # Android Lint, including calls to APIs newer than Android 8
```

The core has its own tests (`npm test`, at the repository root). The rest of the shell (gestures, file access, the app's life cycle) is checked by hand on a device.

## Debugging

Debug builds let Chrome inspect the WebView: with the device connected, open `chrome://inspect` in Chrome on the computer. Messages from the page's console also appear in `adb logcat` under the `mapling` tag.

## Files

| File | Role |
|---|---|
| `src/main/kotlin/.../MainActivity.kt` | The activity: toolbar and menus, document picker, bridge messages, saving, drafts, unsaved-changes guards |
| `src/main/kotlin/.../AssetServer.kt` | Serves the page and the core from the app's assets, and nothing else |
| `src/main/kotlin/.../DraftStore.kt` | Drafts of unsaved changes, one per document |
| `src/main/kotlin/.../WriteCheck.kt` | Whether a document may be overwritten: not if it was changed elsewhere |
| `src/main/kotlin/.../RecentMaps.kt` | The last maps opened, and whether their hidden content was told |
| `src/main/kotlin/.../WebViewVersion.kt` | The oldest WebView the core runs on |
| `src/main/assets/index.html` | The page: only the map |
| `src/main/res/` | Layout, icons, colors and translated texts (English, French) |
