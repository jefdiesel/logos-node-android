package io.github.jefdiesel.logosnode

import java.net.URI

/**
 * What happens when the wallet page asks for fingerprint unlock (window.LogosAndroid.unlockWithFingerprint()),
 * as plain logic so it can be unit-tested. WalletActivity supplies the Android parts: the page's
 * current address, the wallet's setting, the fingerprint prompt, the in-process unlock, and running
 * JavaScript in the page.
 *
 * Rules: act only for the wallet's own page (http://127.0.0.1:18190); never prompt when fingerprint
 * unlock is off; open the wallet only after a successful strong-biometric check, through server.py's
 * native_unlock() in this process; hand the token to the page only, never log it.
 */
class FingerprintUnlock(
    /** Whether fingerprint unlock is on in the wallet (GET /api/wallet); null if the wallet doesn't answer. */
    private val featureOn: () -> Boolean?,
    /** Shows the phone's fingerprint prompt and reports the outcome (on any thread). */
    private val authenticate: (onDone: (Outcome) -> Unit) -> Unit,
    /** server.native_unlock(): a session token, or null. */
    private val nativeUnlock: () -> String?,
    /** Turns fingerprint unlock off in the wallet, after the phone's fingerprints changed. */
    private val turnOff: () -> Unit,
    /** Runs JavaScript in the page, if the page at `url` is still the wallet's own. */
    private val toPage: (js: String) -> Unit,
) {
    sealed class Outcome {
        object Confirmed : Outcome()
        object NoneEnrolled : Outcome()
        object FingerprintsChanged : Outcome()
        class NotConfirmed(val message: String) : Outcome()
    }

    @Volatile private var busy = false

    /** The page asked; `pageUrl` is the address the WebView shows now. */
    fun request(pageUrl: String?) {
        if (!isOwnPage(pageUrl)) return                    // not the wallet's page: ignore it entirely
        if (busy) return
        busy = true
        when (featureOn()) {
            null -> return done(fail("The wallet isn't answering. Use your PIN."))
            false -> return done(fail(OFF))
            true -> {}
        }
        authenticate { outcome ->
            val js = when (outcome) {
                Outcome.Confirmed -> {
                    val token = nativeUnlock()
                    if (token != null && TOKEN.matches(token)) "window.logosNativeUnlocked('$token')" else fail(OFF)
                }
                Outcome.NoneEnrolled -> fail("No fingerprint is set up on this phone. Add one in the phone's settings, or use your PIN.")
                Outcome.FingerprintsChanged -> {
                    turnOff()
                    fail("The fingerprints on this phone changed, so fingerprint unlock was turned off. " +
                        "Unlock with your PIN, then turn it on again in Settings.")
                }
                is Outcome.NotConfirmed -> fail(outcome.message)
            }
            done(js)
        }
    }

    private fun done(js: String) {
        busy = false
        toPage(js)
    }

    companion object {
        const val OFF = "Fingerprint unlock is off. Unlock with your PIN; you can turn it on in Settings."
        private val TOKEN = Regex("^[0-9a-f]{64}$")

        /** Only the wallet's own page, exactly: http://127.0.0.1:18190. */
        fun isOwnPage(url: String?): Boolean = try {
            val u = URI(url ?: return false)
            u.scheme == "http" && u.host == "127.0.0.1" && u.port == WalletServer.PORT && u.userInfo == null
        } catch (_: Exception) {
            false
        }

        /** JavaScript that tells the page why it didn't open (the page's optional logosNativeUnlockFailed). */
        fun fail(message: String) =
            "window.logosNativeUnlockFailed && window.logosNativeUnlockFailed(${jsString(message)})"

        fun jsString(s: String) = "\"" + s.flatMap {
            when {
                it == '"' || it == '\\' -> listOf('\\', it)
                it < ' ' || it == ' ' || it == ' ' || it == '<' -> "\\u%04x".format(it.code).toList()
                else -> listOf(it)
            }
        }.joinToString("") + "\""
    }
}
