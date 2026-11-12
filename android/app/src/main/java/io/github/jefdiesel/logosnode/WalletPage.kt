package io.github.jefdiesel.logosnode

import org.json.JSONObject
import org.json.JSONTokener

/** The wallet screen's decisions about the page, as plain logic so it can be unit-tested. */
object WalletPage {
    const val FIRST_RETRY_MS = 1_000L
    private const val MAX_RETRY_MS = 10_000L

    /** The pause before the next reload: doubling from 1 s, at most 10 s. */
    fun nextRetry(ms: Long) = minOf(ms * 2, MAX_RETRY_MS)

    /** What the page check (PAGE_CHECK) reports: the web app's version, how much is on the page, its background. */
    data class Check(val version: String, val children: Int, val background: String)

    /** The result of evaluateJavascript(PAGE_CHECK): a JSON string holding a JSON object. Null if unreadable. */
    fun parseCheck(raw: String?): Check? = try {
        val inner = JSONTokener(raw ?: return null).nextValue() as? String ?: return null
        val o = JSONObject(inner)
        Check(o.optString("v"), o.optInt("n", 0), o.optString("bg"))
    } catch (_: Exception) {
        null
    }

    /** Whether the web app shows a Node row in its Settings (0.9.1 and later), so the app's own button can go. */
    fun hasNodeRow(version: String): Boolean {
        val v = version.split('.').map { it.toIntOrNull() ?: return false }
        val want = listOf(0, 9, 1)
        for (i in 0 until maxOf(v.size, want.size)) {
            val a = v.getOrElse(i) { 0 }; val b = want.getOrElse(i) { 0 }
            if (a != b) return a > b
        }
        return true
    }

    /** A CSS color as the page reports it ("rgb(17, 17, 15)" or "rgba(…, a)"), as an opaque ARGB int; null if see-through or unknown. */
    fun parseCssColor(css: String): Int? {
        val inside = css.trim().substringAfter('(', "").substringBefore(')', "")
        val parts = inside.split(',').map { it.trim() }
        if (parts.size < 3) return null
        val (r, g, b) = parts.take(3).map { it.toIntOrNull()?.takeIf { n -> n in 0..255 } ?: return null }
        if (parts.size >= 4 && (parts[3].toDoubleOrNull() ?: 0.0) < 0.99) return null
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or b
    }

    /** Whether dark status bar icons read on this color. */
    fun isLight(color: Int): Boolean {
        val r = (color shr 16) and 0xFF; val g = (color shr 8) and 0xFF; val b = color and 0xFF
        return (0.299 * r + 0.587 * g + 0.114 * b) > 150
    }
}
