plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.chaquo.python")
}

// Which node binary is packaged; set by the build (-PnodeVersion=... -PnodeSha256=...).
val nodeVersion = (findProperty("nodeVersion") as String?) ?: "unknown"
val nodeSha256 = (findProperty("nodeSha256") as String?) ?: "unknown"
// "api", "patched" or "unpatched" (android/node.properties chooses; CI passes it). Required: the variant decides
// whether the app runs the node's API on its private socket ("api") or on TCP, so a build that doesn't know it
// must not produce an APK that could ship a socket-patched node on TCP (android/LOCAL-APIS.md, review S2).
val nodeVariant = (findProperty("nodeVariant") as String?)?.trim().orEmpty()
if (nodeVariant !in setOf("api", "patched", "unpatched")) {
    throw GradleException("-PnodeVariant must be api, patched or unpatched (android/node.properties), not '$nodeVariant'")
}
// ...and it must say what the bundled binary is: each patched node names its patches in its own bytes
// (native/check-binary.sh does the same check in the native build). Skipped when no binary is in place yet.
run {
    val bin = file("src/main/jniLibs/arm64-v8a/liblogosnode.so")
    if (bin.isFile) {
        val bytes = bin.readBytes()
        fun has(name: String): Boolean {
            val pat = name.toByteArray()
            outer@ for (i in 0..bytes.size - pat.size) {
                for (j in pat.indices) if (bytes[i + j] != pat[j]) continue@outer
                return true
            }
            return false
        }
        val has0001 = has("0001-fast-replay-from-own-storage")
        val has0002 = has("0002-api-unix-socket")
        val ok = when (nodeVariant) {
            "api" -> has0002 && !has0001
            "patched" -> has0001
            else -> !has0001 && !has0002
        }
        if (!ok) throw GradleException("-PnodeVariant=$nodeVariant doesn't match the bundled node (patch 0001: $has0001, patch 0002: $has0002)")
    }
}

// The release key, read only from LOGOS_RELEASE_STORE_FILE, _STORE_PASSWORD, _KEY_ALIAS and _KEY_PASSWORD: the
// environment first, else a Gradle property from ~/.gradle/gradle.properties (not -P on the command line: other
// programs on the computer can read a command line). `problem` says why there is no usable key, or is null.
class ReleaseSigning(val storeFile: File?, val storePassword: String?, val keyAlias: String?, val keyPassword: String?, val problem: String?)
val releaseSigning: ReleaseSigning = run {
    fun value(name: String): String? =
        (System.getenv(name) ?: (findProperty(name) as String?))?.takeIf { it.isNotEmpty() }
    val names = listOf("LOGOS_RELEASE_STORE_FILE", "LOGOS_RELEASE_STORE_PASSWORD", "LOGOS_RELEASE_KEY_ALIAS", "LOGOS_RELEASE_KEY_PASSWORD")
    val got = names.associateWith { value(it) }
    val missing = names.filter { got[it] == null }
    val repo = rootProject.projectDir.parentFile.canonicalFile        // the repository's top folder (android/..)
    val store = got["LOGOS_RELEASE_STORE_FILE"]?.let { File(it).canonicalFile }
    val problem = when {
        missing.isNotEmpty() -> "not set: " + missing.joinToString(", ")
        store == null || !store.isFile -> "LOGOS_RELEASE_STORE_FILE is not a file: $store"
        store.name == "debug.keystore" || store == rootProject.file("debug.keystore").canonicalFile ->
            "LOGOS_RELEASE_STORE_FILE is the public debug key; a release is signed with your own key"
        store.path == repo.path || store.path.startsWith(repo.path + File.separator) ->
            "LOGOS_RELEASE_STORE_FILE is inside the repository ($store); keep the release key outside it"
        else -> null
    }
    ReleaseSigning(store, got["LOGOS_RELEASE_STORE_PASSWORD"], got["LOGOS_RELEASE_KEY_ALIAS"], got["LOGOS_RELEASE_KEY_PASSWORD"], problem)
}
// A release APK is never made without that key: not unsigned, and never with the debug key. Checked when the APK
// (or a bundle) is packaged, so the release code still compiles and is checked without a key (CI does).
tasks.configureEach {
    if (name == "packageRelease" || name == "signReleaseBundle" || name == "packageReleaseBundle") {
        doFirst {
            releaseSigning.problem?.let {
                throw GradleException("No release key, so no release APK: $it. Set LOGOS_RELEASE_STORE_FILE, " +
                    "LOGOS_RELEASE_STORE_PASSWORD, LOGOS_RELEASE_KEY_ALIAS and LOGOS_RELEASE_KEY_PASSWORD (see scripts/build-release.sh).")
            }
        }
    }
}

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
        versionCode = 41
        versionName = "0.5.30"
        ndk { abiFilters += "arm64-v8a" }
        buildConfigField("String", "NODE_VERSION", "\"$nodeVersion\"")
        buildConfigField("String", "NODE_SHA256", "\"$nodeSha256\"")
        buildConfigField("String", "NODE_VARIANT", "\"$nodeVariant\"")
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
        // The release key: never in this repository, never in CI (the repository is public). Only when all four
        // LOGOS_RELEASE_* values are set (environment, or ~/.gradle/gradle.properties) and the key file is outside
        // the repository; scripts/build-release.sh builds with it (android/NAMES04.md "The release build").
        if (releaseSigning.problem == null) {
            create("release") {
                storeFile = releaseSigning.storeFile
                storePassword = releaseSigning.storePassword
                keyAlias = releaseSigning.keyAlias
                keyPassword = releaseSigning.keyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
        // Not debuggable: no `run-as`, no WebView remote debugging, none of the debug builds' adb extras. Signed
        // only with the release key above, never the debug one; without that key the APK is not made (the check before `android {`).
        getByName("release") {
            isDebuggable = false
            isJniDebuggable = false
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = if (releaseSigning.problem == null) signingConfigs.getByName("release") else null
        }
    }

    buildFeatures { buildConfig = true }

    packaging {
        jniLibs {
            // extract lib/arm64-v8a/*.so at install: the node runs from nativeLibraryDir
            useLegacyPackaging = true
            // ship the binary byte for byte as built (it is already stripped)
            keepDebugSymbols += "**/liblogosnode.so"
            // the messaging node's runner and libraries too (checked by sha256 in CI)
            keepDebugSymbols += listOf("**/libwakurunner.so", "**/liblogosdelivery.so", "**/librln.so")
            // the LNS signer, `names` (android/NAMES.md), as built by names-build
            keepDebugSymbols += "**/libnames.so"
            // and the LEZ 0.4 one, `names` built bare by names04-build (android/NAMES04.md)
            keepDebugSymbols += "**/libnames04.so"
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

dependencies {
    // the QR scanner (Scan button): ZXing's camera view and decoder, Apache-2.0, all on the phone. Its only
    // dependency is ZXing core; no AndroidX, no Google Play services. (Its ScanContract names AndroidX's
    // ActivityResultContract but is never used, and no AndroidX class is in the APK: CI checks that.)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // JVM unit tests of the snapshot import (tar reader, RocksDB check, state swap); run with testDebugUnitTest
    testImplementation("junit:junit:4.13.2")
    // the real org.json for JVM tests (Android's own copy is only a stub there)
    testImplementation("org.json:json:20260814")
}

kotlin { jvmToolchain(17) }
