// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// The Android shell: a single module (Kotlin is built into the Android Gradle plugin since
// 9.0). Its interface uses AndroidX and Material Components, Google's standard libraries
// (Apache-2.0); JUnit for the tests only.

plugins {
    id("com.android.application") version "9.4.1"
}

// Signing of the release build with the maintainer's upload key (Google Play signs the
// app itself). Read from ~/.gradle/gradle.properties, never from the repository:
// maplingUploadStoreFile, maplingUploadStorePassword, maplingUploadKeyAlias,
// maplingUploadKeyPassword. Without them, the release build is unsigned.
val uploadStoreFile: String? = providers.gradleProperty("maplingUploadStoreFile").orNull

// One version for the whole repository: package.json's. The version code goes up by one
// at each release sent to Google Play.
val projectVersion = (groovy.json.JsonSlurper().parse(file("../package.json")) as Map<*, *>)["version"] as String

android {
    namespace = "io.github.mercibe.mapling"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.mercibe.mapling"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = projectVersion
    }

    signingConfigs {
        if (uploadStoreFile != null) {
            create("upload") {
                storeFile = file(uploadStoreFile)
                storePassword = providers.gradleProperty("maplingUploadStorePassword").get()
                keyAlias = providers.gradleProperty("maplingUploadKeyAlias").get()
                keyPassword = providers.gradleProperty("maplingUploadKeyPassword").get()
            }
        }
    }

    buildTypes {
        release {
            if (uploadStoreFile != null) signingConfig = signingConfigs.getByName("upload")
            // Leaves out what the libraries bring but the app does not use. The default rules
            // keep the methods the page calls (@JavascriptInterface).
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("com.google.android.material:material:1.14.0")

    // Tests only: never part of the app.
    testImplementation("junit:junit:4.13.2")
}

/**
 * Copies the built core (`core/dist`, `core/assets`, `core/vendor`) into the app's
 * assets, under `core/`. The core is built by `npm run build`, at the repository root.
 */
abstract class CopyCore : DefaultTask() {
    @get:Internal
    abstract val coreDir: DirectoryProperty

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val coreFiles: FileTree
        get() = coreDir.asFileTree.matching { include(SERVED) }

    @TaskAction
    fun copy() {
        check(coreDir.file("dist/main.js").get().asFile.exists()) {
            "The core is not built: run `npm run build` at the repository root."
        }
        files.sync {
            from(coreDir) { include(SERVED) }
            into(outputDir.dir("core"))
        }
    }

    private companion object {
        val SERVED = listOf("dist/**", "assets/**", "vendor/**")
    }
}

val copyCore = tasks.register<CopyCore>("copyCore") {
    coreDir = layout.projectDirectory.dir("../core")
}

/**
 * Copies the licenses the app shows in About into its assets, under `licenses/`: its own,
 * and Apache-2.0, that of AndroidX, Material Components and the icons (jsMind's comes with
 * the core).
 */
abstract class CopyLicenses : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val licenses: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val files: FileSystemOperations

    @TaskAction
    fun copy() {
        files.sync {
            from(licenses)
            into(outputDir.dir("licenses"))
        }
    }
}

val copyLicenses = tasks.register<CopyLicenses>("copyLicenses") {
    licenses.from("../LICENSE", "../LICENSE-EXCEPTION.md", "LICENSE-material-symbols.txt")
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyCore, CopyCore::outputDir)
        variant.sources.assets?.addGeneratedSourceDirectory(copyLicenses, CopyLicenses::outputDir)
    }
}
