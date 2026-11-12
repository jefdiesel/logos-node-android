package io.github.jefdiesel.logosnode

import io.github.jefdiesel.logosnode.QrScan.Result
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QrScanTest {
    private val own = "http://127.0.0.1:18190/"

    /** A fake phone: camera permission, the camera question's answer, the scanner's result, the page's address. */
    private class Run(
        var allowed: Boolean = true,
        val answer: Boolean? = true,
        val result: Result? = Result.Scanned("logos:abc"),     // null: the scanner stays open
        var url: String? = "http://127.0.0.1:18190/",
        val scannerThrows: Boolean = false,
    ) {
        var asked = 0
        var opened = 0
        val page = mutableListOf<String>()
        var pendingScanner: ((Result) -> Unit)? = null
        val qr = QrScan(
            cameraAllowed = { allowed },
            askCamera = { onAnswer -> asked++; onAnswer(answer) },
            openScanner = { onResult ->
                opened++
                if (scannerThrows) throw IllegalStateException("no activity")
                if (result != null) onResult(result) else pendingScanner = onResult
            },
            pageUrl = { url },
            toPage = { page += it },
        )
    }

    /** The text the page receives, read back from the JavaScript call's string literal. */
    private fun scannedText(js: String): String {
        val prefix = "window.logosScanned && window.logosScanned("
        assertTrue(js, js.startsWith(prefix) && js.endsWith(")"))
        return JSONArray("[" + js.removePrefix(prefix).removeSuffix(")") + "]").getString(0)
    }

    @Test fun anotherPageGetsNothing() {
        for (bad in listOf(null, "about:blank", "https://example.com/", "http://localhost:18190/")) {
            val r = Run(url = bad)
            r.qr.request()
            assertEquals(0, r.asked + r.opened)
            assertTrue(r.page.isEmpty())
            assertFalse(r.qr.busy)
        }
    }

    @Test fun scannedTextGoesToThePageAsIs() {
        val r = Run()
        r.qr.request()
        assertEquals(0, r.asked)                                  // camera already allowed: no question
        assertEquals(1, r.opened)
        assertEquals(listOf("window.logosScanned && window.logosScanned(\"logos:abc\")"), r.page)
        assertFalse(r.qr.busy)
    }

    @Test fun awkwardTextCannotBreakOutOfTheCall() {
        val texts = listOf(
            "", "a\"b", "back\\slash", "line\nbreak\r\n", "</script><script>alert(1)</script>",
            "  ", "tab\there", "\u0000nul", "')); alert(1); ((' ", "emoji 😀 ünïcødé",
            "x".repeat(7089),                                     // longer than any QR code holds
        )
        for (t in texts) {
            val r = Run(result = Result.Scanned(t))
            r.qr.request()
            assertEquals(1, r.page.size)
            val js = r.page[0]
            assertEquals("exactly as read: ${t.take(40)}", t, scannedText(js))
            assertFalse("no raw line terminator in the script", js.any { it == '\n' || it == '\r' || it == ' ' || it == ' ' })
            assertFalse("no raw < in the script", js.removePrefix("window.logosScanned && window.logosScanned(").contains('<'))
        }
    }

    @Test fun cancelSaysNothing() {
        val r = Run(result = Result.Cancelled)
        r.qr.request()
        assertEquals(listOf("window.logosScanFailed && window.logosScanFailed()"), r.page)
        assertFalse(r.qr.busy)
    }

    @Test fun failureGivesItsMessage() {
        val r = Run(result = Result.Failed(QrScan.CAMERA_ERROR))
        r.qr.request()
        assertEquals(listOf("window.logosScanFailed && window.logosScanFailed(\"${QrScan.CAMERA_ERROR}\")"), r.page)
    }

    @Test fun cameraAskedOnlyWhenNeededAndThenScans() {
        val r = Run(allowed = false, answer = true)
        r.qr.request()
        assertEquals(1, r.asked)
        assertEquals(1, r.opened)
        assertEquals(1, r.page.size)
        assertTrue(r.page[0].startsWith("window.logosScanned"))
    }

    @Test fun cameraRefused() {
        val r = Run(allowed = false, answer = false)
        r.qr.request()
        assertEquals(1, r.asked)
        assertEquals(0, r.opened)                                 // no scanner without the camera
        assertEquals(listOf("window.logosScanFailed && window.logosScanFailed(" +
            "\"Camera access is off. Turn it on in Android settings to scan.\")"), r.page)
        assertFalse(r.qr.busy)
        r.qr.request()                                            // the next tap asks once more, no loop on its own
        assertEquals(2, r.asked)
        assertEquals(2, r.page.size)
    }

    @Test fun cameraQuestionBackedOut() {
        val r = Run(allowed = false, answer = null)
        r.qr.request()
        assertEquals(0, r.opened)
        assertEquals(listOf("window.logosScanFailed && window.logosScanFailed()"), r.page)
    }

    @Test fun oneScanAtATime() {
        val r = Run(result = null)                                // the scanner stays open
        r.qr.request()
        r.qr.request()
        r.qr.request()
        assertEquals(1, r.opened)
        assertTrue(r.qr.busy)
        assertTrue(r.page.isEmpty())
        r.pendingScanner!!(Result.Scanned("one"))
        assertEquals(listOf("window.logosScanned && window.logosScanned(\"one\")"), r.page)
        assertFalse(r.qr.busy)
        r.pendingScanner!!(Result.Scanned("again"))               // a second answer for the same scan: ignored
        assertEquals(1, r.page.size)
        r.qr.request()                                            // and the next tap scans again
        assertEquals(2, r.opened)
    }

    @Test fun pageChangedWhileScanning() {
        val r = Run(result = null)
        r.qr.request()
        r.url = "about:blank"                                     // e.g. the page is being reloaded
        r.pendingScanner!!(Result.Scanned("secret-ish"))
        assertTrue(r.page.isEmpty())                              // dropped: nobody to tell
        assertFalse(r.qr.busy)                                    // and the next scan can start
        r.url = own
        r.qr.request()
        assertEquals(2, r.opened)
    }

    @Test fun scannerThatCannotOpen() {
        val r = Run(scannerThrows = true)
        r.qr.request()
        assertEquals(listOf("window.logosScanFailed && window.logosScanFailed(\"${QrScan.NO_SCANNER}\")"), r.page)
        assertFalse(r.qr.busy)
    }
}
