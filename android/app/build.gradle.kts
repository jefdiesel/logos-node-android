plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Which node binary is packaged; set by the build (-PnodeVersion=... -PnodeSha256=...).
val nodeVersion = (findProperty("nodeVersion") as String?) ?: "unknown"
val nodeSha256 = (findProperty("nodeSha256") as String?) ?: "unknown"

android {
    namespace = "io.github.jefdiesel.logosnode"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.github.jefdiesel.logosnode"
        minSdk = 28 // the node binary is built for API 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += "arm64-v8a" }
        buildConfigField("String", "NODE_VERSION", "\"$nodeVersion\"")
        buildConfigField("String", "NODE_SHA256", "\"$nodeSha256\"")
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

kotlin { jvmToolchain(17) }
