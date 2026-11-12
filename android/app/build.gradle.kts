plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

// Which node binary is packaged; set by the build (-PnodeVersion=... -PnodeSha256=...).
val nodeVersion = (findProperty("nodeVersion") as String?) ?: "unknown"
val nodeSha256 = (findProperty("nodeSha256") as String?) ?: "unknown"

// The wallet is the repository's own web app (app/: server.py, index.html, names/), taken as it is at
// build time and shipped as assets. It is never copied by hand into this project.
val webAppSource = rootProject.file("../app")
val webAppOut = layout.buildDirectory.dir("generated/webapp")
val webAppVersion: String = Regex("""APP_VERSION = "([0-9.]+)"""")
    .find(webAppSource.resolve("server.py").readText())?.groupValues?.get(1) ?: "unknown"
val copyWebApp by tasks.registering(Sync::class) {
    from(webAppSource) {
        exclude("**/__pycache__/**", "**/*.pyc", "**/*.prev", "**/*.tmp", "wallet-*")
    }
    into(webAppOut.map { it.dir("webapp") })
}

android {
    namespace = "io.github.jefdiesel.logosnode"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.jefdiesel.logosnode"
        minSdk = 28 // the node binary is built for API 28
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0"
        ndk { abiFilters += "arm64-v8a" }
        buildConfigField("String", "NODE_VERSION", "\"$nodeVersion\"")
        buildConfigField("String", "NODE_SHA256", "\"$nodeSha256\"")
        buildConfigField("String", "WEB_APP_VERSION", "\"$webAppVersion\"")
    }

    sourceSets {
        getByName("main") { assets.srcDir(webAppOut) }
    }

    signingConfigs {
        // The standard throwaway Android debug key (passwords "android"), committed so that a newer
        // debug build installs over an older one and keeps its data. Not a release key.
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
    }

    buildFeatures { buildConfig = true }

    packaging {
        jniLibs {
            // extract lib/arm64-v8a/*.so at install: the node runs from nativeLibraryDir
            useLegacyPackaging = true
            // ship the binary byte for byte as built (it is already stripped)
            keepDebugSymbols += "**/liblogosnode.so"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

// Python for the wallet server (Chaquopy). Standard library only, like the web app; no pip packages.
// The app's own Python (src/main/python) is shipped as source, so no Python is needed on the build machine.
chaquopy {
    defaultConfig {
        version = "3.12"
        pyc { src = false }
    }
}

tasks.named("preBuild") { dependsOn(copyWebApp) }

kotlin { jvmToolchain(17) }
