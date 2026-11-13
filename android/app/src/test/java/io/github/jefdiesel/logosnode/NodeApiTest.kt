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

    @Test fun tcpGuardIgnoresStrangersAndStopsOnlyOurNodeOnTcp() {
        val g = NodeApi.TcpGuard()
        assertEquals(NodeApi.TcpGuard.Verdict.FINE, g.observe(false, false, false))
        // another app on 18180 (any app can listen there): never a stop, whatever it answers
        repeat(10) { assertEquals(NodeApi.TcpGuard.Verdict.STRANGER_IGNORED, g.observe(true, false, true)) }
        repeat(10) { assertEquals(NodeApi.TcpGuard.Verdict.STRANGER_IGNORED, g.observe(true, false, false)) }
        // it even imitates the node, but our socket answers: still ignored
        repeat(10) { assertEquals(NodeApi.TcpGuard.Verdict.STRANGER_IGNORED, g.observe(true, true, true)) }
        // the node answers on TCP and its socket doesn't: a stop, but only after STRIKES checks in a row
        repeat(NodeApi.TcpGuard.STRIKES - 1) { assertEquals(NodeApi.TcpGuard.Verdict.SUSPECT, g.observe(true, true, false)) }
        assertEquals(NodeApi.TcpGuard.Verdict.FINE, g.observe(false, false, false))          // a break resets the count
        repeat(NodeApi.TcpGuard.STRIKES - 1) { assertEquals(NodeApi.TcpGuard.Verdict.SUSPECT, g.observe(true, true, false)) }
        assertEquals(NodeApi.TcpGuard.Verdict.STOP, g.observe(true, true, false))
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
