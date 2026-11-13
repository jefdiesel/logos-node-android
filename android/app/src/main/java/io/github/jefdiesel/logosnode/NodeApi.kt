package io.github.jefdiesel.logosnode

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The node's own HTTP API, for the app's status calls (android/LOCAL-APIS.md).
 *
 * With a node that has patch 0002 (the "api" variant) the API is a Unix socket in the app's files
 * (files/node/api/api.sock, a 0700 folder) and there is no TCP port: any app on the phone could connect
 * to 127.0.0.1. Calls then go over android.net.LocalSocket, file-system namespace (never the abstract
 * one). Other variants keep TCP on 127.0.0.1:[NodeFiles.API_PORT].
 */
object NodeApi {
    /** Whether this build's node serves its API on the Unix socket (patch 0002). */
    val onSocket: Boolean get() = BuildConfig.NODE_VARIANT == "api"

    private const val MAX_BYTES = 4 * 1024 * 1024

    /** GET [path]: (HTTP status, body), or null when the node doesn't answer. */
    fun get(files: NodeFiles, path: String, timeoutMs: Int = 5000): Pair<Int, String>? =
        if (onSocket) getUnix(files.apiSocket, path, timeoutMs) else getTcp(path, timeoutMs)

    /** GET [path] parsed as a JSON object when the node answers 200; null otherwise. */
    fun json(files: NodeFiles, path: String, timeoutMs: Int = 5000): org.json.JSONObject? = try {
        get(files, path, timeoutMs)?.takeIf { it.first == 200 }?.let { org.json.JSONObject(it.second) }
    } catch (_: Exception) {
        null
    }

    private fun getUnix(socket: File, path: String, timeoutMs: Int): Pair<Int, String>? = try {
        android.net.LocalSocket().use { s ->
            s.connect(android.net.LocalSocketAddress(socket.path, android.net.LocalSocketAddress.Namespace.FILESYSTEM))
            s.soTimeout = timeoutMs
            s.outputStream.write(request(path))
            s.outputStream.flush()
            parse(readAll(s.inputStream))
        }
    } catch (_: Exception) {
        null
    }

    /**
     * GET over TCP, for builds whose node is on TCP (not the "api" variant). Whoever listens on the port answers,
     * so the whole answer, status line and headers included, is read with a size cap ([MAX_BYTES]) and one overall
     * deadline (twice [timeoutMs], connecting included: each read may wait only for the time left), over a plain
     * socket: no redirect is followed. Never used in socket mode.
     */
    internal fun getTcp(path: String, timeoutMs: Int, port: Int = NodeFiles.API_PORT): Pair<Int, String>? = try {
        val deadline = System.nanoTime() + 2L * timeoutMs * 1_000_000L
        Socket().use { s ->
            s.connect(InetSocketAddress("127.0.0.1", port), minOf(timeoutMs, 3000))
            s.soTimeout = timeoutMs
            s.getOutputStream().apply { write(request(path)); flush() }
            parse(readAll(s.getInputStream(), deadline) { leftMs -> s.soTimeout = leftMs })
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Whether anything accepts a TCP connection on 127.0.0.1:[port] (connect, then close: nothing is sent or read,
     * so whatever listens there can't feed us anything). With the node on its socket nothing of ours listens there;
     * any app can, so this alone never stops anything ([TcpGuard]).
     */
    fun tcpAnswers(timeoutMs: Int = 1000, port: Int = NodeFiles.API_PORT): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }

    /**
     * Whether the node's own Unix socket accepts a connection (connect, then close). A socket that accepts proves
     * patch 0002 is serving the API there, and the patch never binds TCP then. Blocks only if the node is wedged
     * with a full backlog; called on the guard thread only.
     */
    fun socketAccepts(files: NodeFiles): Boolean = try {
        android.net.LocalSocket().use { s ->
            s.connect(android.net.LocalSocketAddress(files.apiSocket.path, android.net.LocalSocketAddress.Namespace.FILESYSTEM))
        }
        true
    } catch (_: Exception) {
        false
    }

    /** The one line to show when [TcpGuard] stops the node. */
    const val TCP_BLOCK_LINE = "Node stopped: something accepts connections on 127.0.0.1:18180 and the node's private socket " +
        "doesn't, so its API may be on TCP, where other apps can reach it. It stays off; start it again from the Node screen."

    /**
     * Whether to stop the node because its API may be on TCP. Nothing is ever read from the TCP port: whoever
     * listens there decides nothing beyond "a connection is accepted" (review M1/D1). The proof that the node is
     * on its socket is that the socket accepts a connection. So: something accepts on 127.0.0.1:18180 while the
     * node's socket doesn't, [STRIKES] checks in a row (about a minute), means the node may be running without its
     * socket, and it is stopped. Anything accepting there while the socket accepts is a stranger, ignored.
     */
    /**
     * One round of the guard: connect to 127.0.0.1:[port] and close (nothing written, nothing read), and only if
     * that connects, ask [socketAccepts]. Kept apart from NodeService so a test can show it never reads from TCP.
     */
    fun guardRound(guard: TcpGuard, counting: Boolean, socketAccepts: () -> Boolean, port: Int = NodeFiles.API_PORT): TcpGuard.Verdict {
        val tcp = tcpAnswers(1000, port)
        return guard.observe(tcp, tcp && socketAccepts(), counting)
    }

    /**
     * Whether the TCP guard may count strikes yet (review E1, F2): once the node printed "Running chain" in this run
     * (its services, the API with them, have started), or once [limitMs] have passed since the start without it.
     * Times come from a monotonic clock (SystemClock.elapsedRealtime in the app), so setting the clock changes nothing.
     */
    class ServicesStart(private val limitMs: Long) {
        @Volatile private var seen = false
        @Volatile private var startedAt = 0L

        /** A new node process started at [nowMs]. */
        fun reset(nowMs: Long) { seen = false; startedAt = nowMs }

        /** One line of the node's output. */
        fun line(line: String) { if (!seen && line.contains("Running chain ")) seen = true }

        fun counting(nowMs: Long): Boolean = seen || nowMs - startedAt >= limitMs
    }

    class TcpGuard {
        enum class Verdict { FINE, STRANGER_IGNORED, WAITING, SUSPECT, STOP }

        var strikes = 0
            private set

        /**
         * [counting]: whether the node has started its services (it printed "Running chain", or ten minutes have
         * passed). Before that its API may not be bound yet, so a stranger on TCP proves nothing and no strike is
         * counted (review E1): the node's socket is bound as soon as its API service starts.
         */
        fun observe(tcpAnswers: Boolean, socketAccepts: Boolean, counting: Boolean = true): Verdict {
            if (!tcpAnswers) { strikes = 0; return Verdict.FINE }
            if (socketAccepts) { strikes = 0; return Verdict.STRANGER_IGNORED }
            if (!counting) { strikes = 0; return Verdict.WAITING }
            strikes++
            return if (strikes >= STRIKES) Verdict.STOP else Verdict.SUSPECT
        }

        companion object {
            const val STRIKES = 4
        }
    }

    fun request(path: String): ByteArray {
        require(path.startsWith("/") && path.none { it == '\r' || it == '\n' || it == ' ' }) { "bad path" }
        return "GET $path HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: close\r\n\r\n".toByteArray()
    }

    /**
     * Reads to the end, at most [MAX_BYTES], and (with [deadline], System.nanoTime) no later than that. With [waitAtMost],
     * each read may wait only for the time left before the deadline (a socket's soTimeout), so the deadline is total.
     */
    internal fun readAll(input: java.io.InputStream, deadline: Long = Long.MAX_VALUE, waitAtMost: ((Int) -> Unit)? = null): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            if (waitAtMost != null) {
                val leftMs = (deadline - System.nanoTime()) / 1_000_000L
                if (leftMs <= 0) throw IllegalStateException("answer too slow")
                waitAtMost(minOf(leftMs, Int.MAX_VALUE.toLong()).toInt())
            }
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > MAX_BYTES) throw IllegalStateException("answer too large")
            if (System.nanoTime() > deadline) throw IllegalStateException("answer too slow")
        }
        return out.toByteArray()
    }

    /**
     * An HTTP/1.1 response read to the end of the connection: (status, body). Handles Content-Length,
     * chunked transfer encoding, and a body that runs to the end. Null if it isn't a response.
     */
    fun parse(raw: ByteArray): Pair<Int, String>? {
        val text = String(raw, Charsets.ISO_8859_1)                  // byte-for-byte, so offsets match
        val end = text.indexOf("\r\n\r\n").takeIf { it >= 0 } ?: return null
        val lines = text.substring(0, end).split("\r\n")
        val status = lines.first().split(' ').let { p ->
            if (p.size < 2 || !p[0].startsWith("HTTP/1.")) return null
            p[1].toIntOrNull() ?: return null
        }
        val headers = lines.drop(1).mapNotNull { l ->
            val i = l.indexOf(':'); if (i <= 0) null else l.substring(0, i).trim().lowercase() to l.substring(i + 1).trim()
        }.toMap()
        var body = raw.copyOfRange(end + 4, raw.size)
        if (headers["transfer-encoding"]?.lowercase()?.contains("chunked") == true) {
            body = dechunk(body) ?: return null
        } else {
            headers["content-length"]?.toIntOrNull()?.let { n ->
                if (n < 0 || n > body.size) return null
                body = body.copyOfRange(0, n)
            }
        }
        return status to String(body, Charsets.UTF_8)
    }

    private fun dechunk(b: ByteArray): ByteArray? {
        val out = ByteArrayOutputStream()
        var i = 0
        while (true) {
            var j = i
            while (j + 1 < b.size && !(b[j] == '\r'.code.toByte() && b[j + 1] == '\n'.code.toByte())) j++
            if (j + 1 >= b.size) return null
            val size = String(b, i, j - i, Charsets.ISO_8859_1).substringBefore(';').trim().toIntOrNull(16) ?: return null
            i = j + 2
            if (size == 0) return out.toByteArray()
            if (size < 0 || i + size > b.size) return null
            out.write(b, i, size)
            i += size + 2                                           // the chunk's own CRLF
        }
    }
}
