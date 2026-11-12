package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WalletPageTest {
    @Test fun retriesGrowToTenSeconds() {
        var ms = WalletPage.FIRST_RETRY_MS
        val seen = (1..6).map { ms.also { ms = WalletPage.nextRetry(ms) } }
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 10000L, 10000L), seen)
    }

    @Test fun pageCheckIsRead() {
        // what evaluateJavascript hands back: the returned string, JSON-encoded
        val raw = "\"{\\\"v\\\":\\\"0.9.1\\\",\\\"n\\\":7,\\\"bg\\\":\\\"rgb(17, 17, 15)\\\"}\""
        assertEquals(WalletPage.Check("0.9.1", 7, "rgb(17, 17, 15)"), WalletPage.parseCheck(raw))
        assertEquals(0, WalletPage.parseCheck("\"{\\\"v\\\":\\\"\\\",\\\"n\\\":0,\\\"bg\\\":\\\"\\\"}\"")!!.children)
        assertNull(WalletPage.parseCheck("null"))                 // a page that didn't run the check
        assertNull(WalletPage.parseCheck(null))
    }

    @Test fun nodeRowFromVersion() {
        assertFalse(WalletPage.hasNodeRow("0.9.0"))
        assertFalse(WalletPage.hasNodeRow("0.8.1"))
        assertFalse(WalletPage.hasNodeRow(""))                    // unknown: keep the app's own button
        assertFalse(WalletPage.hasNodeRow("0.9.x"))
        assertTrue(WalletPage.hasNodeRow("0.9.1"))
        assertTrue(WalletPage.hasNodeRow("0.10.0"))
        assertTrue(WalletPage.hasNodeRow("1.0"))
    }

    @Test fun backgroundColor() {
        assertEquals(0xFF11110F.toInt(), WalletPage.parseCssColor("rgb(17, 17, 15)"))
        assertEquals(0xFFF3EAD7.toInt(), WalletPage.parseCssColor("rgba(243, 234, 215, 1)"))
        assertNull(WalletPage.parseCssColor("rgba(0, 0, 0, 0)"))  // transparent: keep the cream
        assertNull(WalletPage.parseCssColor(""))
        assertTrue(WalletPage.isLight(0xFFF3EAD7.toInt()))
        assertFalse(WalletPage.isLight(0xFF11110F.toInt()))
    }
}
