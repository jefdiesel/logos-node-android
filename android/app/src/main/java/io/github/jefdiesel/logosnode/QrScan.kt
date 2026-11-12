package io.github.jefdiesel.logosnode

/**
 * What happens when the wallet page asks for a QR scan (window.LogosAndroid.scanQr()), as plain logic so it
 * can be unit-tested. WalletActivity supplies the Android parts: the camera permission, the scanner screen
 * (ScanActivity, ZXing) and running JavaScript in the page.
 *
 * Rules: act only for the wallet's own page; one scan at a time (a second call while one is open is
 * ignored: the first one's answer is still coming); ask for the camera only here, when the user tapped
 * Scan, and never again in a loop (one answer per tap); hand the decoded text to the page exactly as read,
 * through window.logosScanned(text), and do nothing else with it natively; a cancel or failure goes back as
 * window.logosScanFailed(message) (no message for a plain cancel). The answer goes only to the wallet's own
 * page: if the WebView shows anything else by then, it is dropped.
 */
class QrScan(
    /** Whether the app may use the camera now. */
    private val cameraAllowed: () -> Boolean,
    /** Asks for the camera (the reason, then Android's own question): true granted, false refused, null backed out. */
    private val askCamera: (onAnswer: (Boolean?) -> Unit) -> Unit,
    /** Opens the scanner screen and reports one result. */
    private val openScanner: (onResult: (Result) -> Unit) -> Unit,
    /** The address the WebView shows now. */
    private val pageUrl: () -> String?,
    /** Runs JavaScript in the page. */
    private val toPage: (js: String) -> Unit,
) {
    sealed class Result {
        class Scanned(val text: String) : Result()
        object Cancelled : Result()
        class Failed(val message: String) : Result()
    }

    @Volatile var busy = false
        private set

    /** The page asked. */
    fun request() {
        if (!FingerprintUnlock.isOwnPage(pageUrl())) return     // not the wallet's page: ignore it entirely
        if (busy) return
        busy = true
        if (cameraAllowed()) return open()
        askCamera { granted ->
            when (granted) {
                true -> open()
                false -> done(Result.Failed(CAMERA_OFF))
                null -> done(Result.Cancelled)
            }
        }
    }

    private fun open() = try {
        openScanner { done(it) }
    } catch (e: Exception) {
        done(Result.Failed(NO_SCANNER))
    }

    private fun done(result: Result) {
        if (!busy) return                                       // one answer per scan
        busy = false
        if (!FingerprintUnlock.isOwnPage(pageUrl())) return     // the page changed meanwhile: nobody to tell
        toPage(js(result))
    }

    companion object {
        const val CAMERA_OFF = "Camera access is off. Turn it on in Android settings to scan."
        const val NO_SCANNER = "The scanner couldn't be opened. Try again."
        const val CAMERA_ERROR = "The camera couldn't be started. Try again."

        fun js(result: Result) = when (result) {
            is Result.Scanned -> "window.logosScanned && window.logosScanned(${FingerprintUnlock.jsString(result.text)})"
            Result.Cancelled -> "window.logosScanFailed && window.logosScanFailed()"
            is Result.Failed -> "window.logosScanFailed && window.logosScanFailed(${FingerprintUnlock.jsString(result.message)})"
        }
    }
}
