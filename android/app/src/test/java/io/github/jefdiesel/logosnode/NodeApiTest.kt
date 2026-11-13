package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NodeApiTest {
    private fun b(s: String) = s.toByteArray(Charsets.ISO_8859_1)

    @Test fun contentLength() {
        val r = NodeApi.parse(b("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 13\r\n\r\n{\"height\":42}"))
        assertEquals(200 to "{\"height\":42}", r)
    }

    @Test fun contentLengthCutsTrailingBytes() {
        assertEquals(200 to "abc", NodeApi.parse(b("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef")))
        assertNull(NodeApi.parse(b("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc")))       // cut short
    }

    @Test fun chunked() {
        val raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{\"a\"\r\n5;x=y\r\n:1}  \r\n0\r\n\r\n"
        assertEquals(200 to "{\"a\":1}  ", NodeApi.parse(b(raw)))
        assertNull(NodeApi.parse(b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nab\r\n0\r\n\r\n")))
        assertNull(NodeApi.parse(b("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nab")))
    }

    @Test fun toTheEnd() {
        assertEquals(404 to "not here", NodeApi.parse(b("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nnot here")))
    }

    @Test fun utf8Body() {
        val body = "{\"n\":\"é\"}".toByteArray(Charsets.UTF_8)
        val raw = b("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\n\r\n") + body
        assertEquals(200 to "{\"n\":\"é\"}", NodeApi.parse(raw))
    }

    @Test fun notAResponse() {
        assertNull(NodeApi.parse(b("")))
        assertNull(NodeApi.parse(b("HTTP/1.1 200 OK\r\n")))                               // headers never end
        assertNull(NodeApi.parse(b("SSH-2.0-x\r\n\r\n")))
        assertNull(NodeApi.parse(b("HTTP/1.1 abc OK\r\n\r\n")))
    }

    @Test fun tcpGuardDecidesOnOurSocketOnly() {
        val g = NodeApi.TcpGuard()
        assertEquals(NodeApi.TcpGuard.Verdict.FINE, g.observe(false, false))
        // something on 18180 while our socket accepts: a stranger, never a stop
        repeat(20) { assertEquals(NodeApi.TcpGuard.Verdict.STRANGER_IGNORED, g.observe(true, true)) }
        // something on 18180 and our socket accepts nothing: a stop, only after STRIKES checks in a row
        repeat(NodeApi.TcpGuard.STRIKES - 1) { assertEquals(NodeApi.TcpGuard.Verdict.SUSPECT, g.observe(true, false)) }
        assertEquals(NodeApi.TcpGuard.Verdict.STRANGER_IGNORED, g.observe(true, true))      // the socket came up: reset
        repeat(NodeApi.TcpGuard.STRIKES - 1) { assertEquals(NodeApi.TcpGuard.Verdict.SUSPECT, g.observe(true, false)) }
        assertEquals(NodeApi.TcpGuard.Verdict.FINE, g.observe(false, false))                // the port went quiet: reset
        repeat(NodeApi.TcpGuard.STRIKES - 1) { assertEquals(NodeApi.TcpGuard.Verdict.SUSPECT, g.observe(true, false)) }
        assertEquals(NodeApi.TcpGuard.Verdict.STOP, g.observe(true, false))
    }

    /** A listener on a free port that answers every connection with [answer] (run on its own thread). */
    private fun hostile(answer: (java.io.OutputStream) -> Unit): java.net.ServerSocket {
        val server = java.net.ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val c = try { server.accept() } catch (_: Exception) { break }
                Thread { try { c.getInputStream().read(ByteArray(4096)); answer(c.getOutputStream()) } catch (_: Exception) {} finally { try { c.close() } catch (_: Exception) {} } }
                    .apply { isDaemon = true }.start()
            }
        }.apply { isDaemon = true }.start()
        return server
    }

    @Test fun anAppStreamingEndlessBytesOnTheTcpPortChangesNothing() {
        // review M1: an app listening on 18180 that answers with endless bytes made the guard read until the heap ran out
        val endless = hostile { out -> out.write("HTTP/1.1 200 OK\r\n\r\n".toByteArray()); val zeros = ByteArray(65536); while (true) out.write(zeros) }
        try {
            val t0 = System.currentTimeMillis()
            assertTrue(NodeApi.tcpAnswers(1000, endless.localPort))                // the guard only connects, never reads
            assertTrue(System.currentTimeMillis() - t0 < 2000)
            // the TCP status path (only for builds whose node is on TCP) reads at most MAX_BYTES, then gives up
            val before = Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() }
            assertNull(NodeApi.getTcp("/cryptarchia/info", 3000, endless.localPort))
            val after = Runtime.getRuntime().let { it.totalMemory() - it.freeMemory() }
            assertTrue("held ${(after - before) / 1048576} MB", after - before < 64L * 1048576)
        } finally {
            endless.close()
        }
    }

    @Test fun theTcpPathFollowsNoRedirectAndGivesUpOnADrip() {
        val redirect = hostile { out -> out.write("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/elsewhere\r\nContent-Length: 0\r\n\r\n".toByteArray()) }
        val drip = hostile { out -> out.write("HTTP/1.1 200 OK\r\n\r\n".toByteArray()); while (true) { out.write('x'.code); out.flush(); Thread.sleep(200) } }
        try {
            assertEquals(302, NodeApi.getTcp("/cryptarchia/info", 3000, redirect.localPort)?.first)
            val t0 = System.currentTimeMillis()
            assertNull(NodeApi.getTcp("/cryptarchia/info", 1000, drip.localPort))   // a byte every 200 ms never times a read out
            assertTrue("took ${System.currentTimeMillis() - t0} ms", System.currentTimeMillis() - t0 < 6000)
        } finally {
            redirect.close(); drip.close()
        }
    }

    @Test fun requestIsPlainGet() {
        val r = String(NodeApi.request("/cryptarchia/info"))
        assertTrue(r.startsWith("GET /cryptarchia/info HTTP/1.1\r\nHost: localhost\r\n"))
        assertTrue(r.endsWith("Connection: close\r\n\r\n"))
        for (bad in listOf("cryptarchia/info", "/a b", "/a\r\nX: y")) {
            try { NodeApi.request(bad); throw AssertionError("accepted $bad") } catch (_: IllegalArgumentException) {}
        }
    }
}
