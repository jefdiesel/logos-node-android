package io.github.jefdiesel.logosnode

import io.github.jefdiesel.logosnode.FingerprintUnlock.Outcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FingerprintUnlockTest {
    private val token = "ab".repeat(32)

    private class Run(
        val featureOn: Boolean? = true,
        val outcome: Outcome = Outcome.Confirmed,
        val unlockReturns: String? = null,
    ) {
        var prompted = 0
        var unlocked = 0
        var turnedOff = 0
        val page = mutableListOf<String>()
        val unlock = FingerprintUnlock(
            featureOn = { featureOn },
            authenticate = { done -> prompted++; done(outcome) },
            nativeUnlock = { unlocked++; unlockReturns },
            turnOff = { turnedOff++ },
            toPage = { page += it },
        )
    }

    private val own = "http://127.0.0.1:18190/"

    @Test fun originCheck() {
        assertTrue(FingerprintUnlock.isOwnPage("http://127.0.0.1:18190/"))
        assertTrue(FingerprintUnlock.isOwnPage("http://127.0.0.1:18190/?x=1#y"))
        for (bad in listOf(null, "", "about:blank", "data:text/html,hi", "https://127.0.0.1:18190/", "http://localhost:18190/",
            "http://127.0.0.1:8090/", "http://127.0.0.1/", "http://127.0.0.1.evil.com:18190/", "http://evil.com/?http://127.0.0.1:18190/",
            "http://user@127.0.0.1:18190/", "file:///data/data/x", "javascript:alert(1)")) {
            assertFalse("should refuse $bad", FingerprintUnlock.isOwnPage(bad))
        }
    }

    @Test fun anotherPageGetsNothing() {
        val r = Run(unlockReturns = token)
        r.unlock.request("https://example.com/")
        r.unlock.request(null)
        assertEquals(0, r.prompted); assertEquals(0, r.unlocked); assertTrue(r.page.isEmpty())
    }

    @Test fun confirmedOpensTheWallet() {
        val r = Run(unlockReturns = token)
        r.unlock.request(own)
        assertEquals(1, r.prompted); assertEquals(1, r.unlocked)
        assertEquals(listOf("window.logosNativeUnlocked('$token')"), r.page)
    }

    @Test fun refusesWhenTheWalletSaysOffWithoutPrompting() {
        val r = Run(featureOn = false, unlockReturns = token)
        r.unlock.request(own)
        assertEquals(0, r.prompted); assertEquals(0, r.unlocked)
        assertTrue(r.page.single().startsWith("window.logosNativeUnlockFailed"))
    }

    @Test fun refusesWhenNativeUnlockReturnsNone() {
        val r = Run(featureOn = true, unlockReturns = null)          // e.g. turned off, or no PIN, meanwhile
        r.unlock.request(own)
        assertEquals(1, r.unlocked)
        assertEquals(listOf(FingerprintUnlock.fail(FingerprintUnlock.OFF)), r.page)
    }

    @Test fun neverPassesSomethingThatIsntAToken() {
        val r = Run(unlockReturns = "x'); alert(1); ('")
        r.unlock.request(own)
        assertTrue(r.page.single().startsWith("window.logosNativeUnlockFailed"))
        assertFalse(r.page.single().contains("alert"))
    }

    @Test fun cancelledOrNoFingerprint() {
        Run(outcome = Outcome.NotConfirmed("Fingerprint wasn't confirmed.")).also {
            it.unlock.request(own)
            assertEquals(0, it.unlocked)
            assertEquals(listOf("window.logosNativeUnlockFailed && window.logosNativeUnlockFailed(\"Fingerprint wasn't confirmed.\")"), it.page)
        }
        Run(outcome = Outcome.NoneEnrolled).also {
            it.unlock.request(own)
            assertEquals(0, it.unlocked)
            assertTrue(it.page.single().contains("No fingerprint is set up"))
        }
    }

    @Test fun changedFingerprintsTurnItOff() {
        val r = Run(outcome = Outcome.FingerprintsChanged, unlockReturns = token)
        r.unlock.request(own)
        assertEquals(0, r.unlocked); assertEquals(1, r.turnedOff)
        assertTrue(r.page.single().contains("changed"))
    }

    @Test fun walletNotAnswering() {
        val r = Run(featureOn = null)
        r.unlock.request(own)
        assertEquals(0, r.prompted)
        assertTrue(r.page.single().contains("isn't answering"))
    }

    @Test fun messagesAreQuotedSafely() {
        assertEquals("\"a\\\"b\\\\c\\u000a\\u003c/script>\"", FingerprintUnlock.jsString("a\"b\\c\n</script>"))
    }

    @Test fun oneRequestAtATime() {
        var held: ((Outcome) -> Unit)? = null
        var prompts = 0
        val page = mutableListOf<String>()
        val u = FingerprintUnlock({ true }, { done -> prompts++; held = done }, { token }, {}, { page += it })
        u.request(own); u.request(own)
        assertEquals(1, prompts)
        held!!(Outcome.Confirmed)
        u.request(own)
        assertEquals(2, prompts)
        assertEquals(1, page.size)
    }
}
