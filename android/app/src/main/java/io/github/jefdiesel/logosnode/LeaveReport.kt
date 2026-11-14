package io.github.jefdiesel.logosnode

/**
 * Lock on leave, told by the app itself. The wallet locks a minute after the person leaves its screen. The page
 * reports leaving from its own `visibilitychange`, but a WebView that is being hidden may never send that (its
 * timers and network are paused, or the page is reloading). So the activity also tells the wallet server directly,
 * in its own process (server.native_visibility, no HTTP): "hidden" when it stops (Home, the screen off, another
 * app) and "visible" when it starts again. The server counts the minute from the first report and locks when it
 * runs out, whatever the page says.
 *
 * One report per change: stop and start come in pairs, and a repeated stop (or a start without a stop) sends
 * nothing. [send] runs off the main thread; a failure is ignored (the page's own report is still there).
 */
class LeaveReport(private val send: (String) -> Unit) {
    private var away = false

    /** onStop: the wallet's screen went away. */
    fun stopped() {
        if (away) return
        away = true
        try { send("hidden") } catch (_: Exception) {}
    }

    /** onStart: the wallet's screen is back. */
    fun started() {
        if (!away) return
        away = false
        try { send("visible") } catch (_: Exception) {}
    }
}
