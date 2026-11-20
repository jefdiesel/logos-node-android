package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeGateTest {
    private var answer: Boolean? = true
    private var throws = false
    private val gate = NodeGate {
        if (throws) throw IllegalStateException("the wallet's process isn't up")
        answer
    }

    @Test fun enteredLockedItCloses() {
        answer = false
        assertEquals(NodeGate.Screen.CLOSE, gate.enter())
        assertFalse(gate.allowed())                         // no action from a closed screen
    }

    @Test fun noAnswerOrAFailureCountsAsLocked() {
        answer = null
        assertEquals(NodeGate.Screen.CLOSE, gate.enter())
        answer = true; throws = true
        assertEquals(NodeGate.Screen.CLOSE, gate.enter())
        assertFalse(gate.allowed())
    }

    @Test fun enteredUnlockedEverythingShows() {
        assertEquals(NodeGate.Screen.FULL, gate.enter())
        assertEquals(NodeGate.Screen.FULL, gate.refresh())
        assertTrue(gate.allowed())
    }

    @Test fun lockedWhileOpenGoesReadOnlyForGood() {
        gate.enter()
        answer = false                                     // auto-lock, leaving, fingerprints changed
        assertEquals(NodeGate.Screen.READ_ONLY, gate.refresh())
        assertFalse(gate.allowed())
        answer = true                                      // no way back from this screen without entering again
        assertEquals(NodeGate.Screen.READ_ONLY, gate.refresh())
        assertFalse(gate.allowed())
        assertEquals(NodeGate.Screen.FULL, gate.enter())   // entered again, unlocked: everything again
    }

    @Test fun anActionAsksAgainRightBeforeItRuns() {
        gate.enter()
        answer = false                                     // locked after the dialog or picker opened, before the next refresh
        assertFalse(gate.allowed())
        assertEquals(NodeGate.Screen.READ_ONLY, gate.screen)
        throws = true; answer = true
        assertFalse(gate.allowed())
    }

    @Test fun reEnteringLockedCloses() {
        gate.enter()
        answer = false
        gate.refresh()
        assertEquals(NodeGate.Screen.CLOSE, gate.enter())  // onResume while locked: back to the wallet's lock
    }
}
