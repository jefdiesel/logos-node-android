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

    private fun getTcp(path: String, timeoutMs: Int): Pair<Int, String>? = try {
        val c = java.net.URL("http://127.0.0.1:${NodeFiles.API_PORT}$path").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = minOf(timeoutMs, 3000); c.readTimeout = timeoutMs
        try {
            val code = c.responseCode
            code to ((if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: "")
        } finally {
            c.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Whether anything accepts a TCP connection on 127.0.0.1:[NodeFiles.API_PORT]. With the node on its socket
     * nothing of ours should. Any app can listen there, so this alone never stops anything ([TcpGuard]).
     */
    fun tcpAnswers(timeoutMs: Int = 1000): Boolean = try {
        Socket().use { it.connect(InetSocketAddress("127.0.0.1", NodeFiles.API_PORT), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }

    /** Whether what answers on TCP [NodeFiles.API_PORT] speaks the node's API (a 200 with the chain's info). */
    fun tcpLooksLikeNode(): Boolean = try {
        val r = getTcp("/cryptarchia/info", 3000)
        r != null && r.first == 200 && org.json.JSONObject(r.second).let { it.has("cryptarchia_info") || it.has("height") }
    } catch (_: Exception) {
        false
    }

    /** The one line to show when [TcpGuard] stops the node. */
    const val TCP_BLOCK_LINE = "Node stopped: its API answered on 127.0.0.1:18180 (TCP, which other apps can reach) instead of " +
        "its private socket. It stays off; start it again from the Node screen."

    /**
     * Whether to stop the node because its API is on TCP (review S1). Any app can listen on 127.0.0.1:18180, and
     * nothing of ours connects there in socket mode, so a stranger on that port is ignored (it would otherwise be
     * a way for any app to stop the node). The node is stopped only when, [STRIKES] checks in a row, TCP answers
     * as a node does while the node's own socket doesn't answer: the node is running without its socket.
     */
    class TcpGuard {
        enum class Verdict { FINE, STRANGER_IGNORED, SUSPECT, STOP }

        var strikes = 0
            private set

        fun observe(tcpAnswers: Boolean, tcpLooksLikeNode: Boolean, socketAnswers: Boolean): Verdict {
            if (!tcpAnswers) { strikes = 0; return Verdict.FINE }
            if (socketAnswers || !tcpLooksLikeNode) { strikes = 0; return Verdict.STRANGER_IGNORED }
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

    private fun readAll(input: java.io.InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > MAX_BYTES) throw IllegalStateException("answer too large")
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
