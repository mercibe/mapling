// SPDX-FileCopyrightText: 2026 Benoit Mercier and mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// The Android shell: a single module, no library dependency (Kotlin is built into
// the Android Gradle plugin since 9.0).

plugins {
    id("com.android.application") version "9.4.1"
}

android {
    namespace = "io.github.mercibe.mapling"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.github.mercibe.mapling"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
    }
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

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyCore, CopyCore::outputDir)
    }
}
