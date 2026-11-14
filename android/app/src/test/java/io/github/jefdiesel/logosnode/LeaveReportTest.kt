package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Test

class LeaveReportTest {
    @Test fun oneReportPerChange() {
        val sent = mutableListOf<String>()
        val r = LeaveReport { sent.add(it) }
        r.started()                                  // the first start: nothing was left, nothing to say
        r.stopped(); r.stopped()                     // Home, then the screen off: one "hidden"
        r.started(); r.started()
        r.stopped(); r.started()
        assertEquals(listOf("hidden", "visible", "hidden", "visible"), sent)
    }

    @Test fun aFailedReportChangesNothing() {
        val sent = mutableListOf<String>()
        var fail = true
        val r = LeaveReport { if (fail) throw IllegalStateException("no server"); sent.add(it) }
        r.stopped()                                  // lost (the page's own report is still there)
        fail = false
        r.started()
        r.stopped()
        assertEquals(listOf("visible", "hidden"), sent)
    }
}
