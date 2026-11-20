package io.github.jefdiesel.logosnode

/**
 * The Node screen opens only while the wallet is unlocked, as plain logic so it can be unit-tested. [unlocked] asks the
 * wallet server itself (server.native_unlocked, in the wallet's process: WalletLock); true means an open session there,
 * false locked, null no answer. Anything but true counts as locked: the screen fails closed.
 *
 * - Entering (onCreate, onResume): unlocked shows everything; otherwise the screen closes.
 * - While it shows (every refresh): if the wallet locks (auto-lock, leaving, fingerprints changed), the screen drops to
 *   a read-only status view: no Start or Stop, snapshot, go back, messaging switches or log. It stays read-only until
 *   the screen is entered again, so a lock can't be undone from here.
 * - Every action asks again right before it runs ([allowed]), so a dialog or a file picker opened while unlocked does
 *   nothing once the wallet has locked.
 *
 * [unlocked] blocks (a call to another process): call these off the main thread.
 */
class NodeGate(private val unlocked: () -> Boolean?) {
    enum class Screen { FULL, READ_ONLY, CLOSE }

    @Volatile var screen: Screen = Screen.CLOSE
        private set

    private fun ask(): Boolean = try { unlocked() == true } catch (_: Exception) { false }

    /** onCreate and onResume: FULL or CLOSE. */
    fun enter(): Screen {
        screen = if (ask()) Screen.FULL else Screen.CLOSE
        return screen
    }

    /** Each refresh while the screen shows: FULL until the wallet locks, then READ_ONLY for good. */
    fun refresh(): Screen {
        if (screen == Screen.FULL && !ask()) screen = Screen.READ_ONLY
        return screen
    }

    /** Right before an action (Start, Stop, an import, going back, a messaging switch): only on a FULL screen, unlocked now. */
    fun allowed(): Boolean {
        if (screen != Screen.FULL) return false
        if (ask()) return true
        screen = Screen.READ_ONLY
        return false
    }
}
