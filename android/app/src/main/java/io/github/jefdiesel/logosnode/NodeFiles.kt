package io.github.jefdiesel.logosnode

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Where everything lives, all inside the app's own storage (files/node). */
class NodeFiles(context: Context) {
    val binary = File(context.applicationInfo.nativeLibraryDir, BINARY_NAME)
    val home = File(context.filesDir, "node")          // HOME and working directory
    val tmp = File(home, "tmp")                        // TMPDIR
    val state = File(home, "state")                    // the node's database
    val nodeLogs = File(home, "logs")                  // the node's own (rolling) log files
    val config = File(home, "user_config.yaml")
    val keystore = File(home, "keystore.yaml")
    val output = File(home, "output.log")              // the node's stdout and stderr, plus app events

    fun mkdirs() {
        listOf(home, tmp, state, nodeLogs).forEach { it.mkdirs() }
    }

    /** The user config, in the same shape as install.sh writes it. */
    fun writeConfig() {
        val lines = listOf("network:", "  backend:", "    initial_peers:") +
            INITIAL_PEERS.map { "    - $it" } +
            listOf(
                "api:",
                "  backend:",
                "    listen_address: 127.0.0.1:$API_PORT",
                "tracing:",
                "  logger:",
                "    file:",
                "      directory: ${nodeLogs.absolutePath}",
                "      prefix: node",
                "state:",
                "  base_folder: ${state.absolutePath}",
            )
        config.writeText(lines.joinToString("\n", postfix = "\n"))
    }

    companion object {
        const val BINARY_NAME = "liblogosnode.so"
        const val API_PORT = 18180
        val INITIAL_PEERS = listOf(
            "/ip4/65.109.51.37/udp/3000/quic-v1/p2p/12D3KooWFrouXfmrR4nsLMtE7wu15DoMJ6VtoUtHinREZCvbWHar",
            "/ip4/65.109.51.37/udp/3001/quic-v1/p2p/12D3KooWJRGau8M1rjT7R5e4YYsgdFhsMX35nRDtMwCDjxQkXAHz",
            "/ip4/65.109.51.37/udp/3002/quic-v1/p2p/12D3KooWQXJavMDTRscjauFSgVAB1VLB6Rzpy2uY5SU9Tk7927tb",
            "/ip4/65.109.51.37/udp/50001/quic-v1/p2p/12D3KooWSQc7CcGtvWDPF1yCbBthFnQjprfCVHmfmNDUrSmqQsU1",
        )
    }
}

/** The capped log file: output.log up to 4 MB, then it moves to output.log.1 (one old file kept). */
class NodeLog(private val file: File) {
    private val ansi = Regex("\u001B\\[[0-9;?]*[A-Za-z]")
    private val time = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

    /** A line from the app itself, marked [app]. */
    fun app(message: String) = write("${time.format(Date())} [app] $message")

    /** A line the node printed. */
    fun node(line: String) = write(ansi.replace(line, ""))

    @Synchronized
    private fun write(line: String) {
        try {
            file.parentFile?.mkdirs()
            if (file.length() > MAX_BYTES) {
                val old = File(file.path + ".1")
                old.delete()
                file.renameTo(old)
            }
            file.appendText(line + "\n")
        } catch (_: Exception) {
        }
    }

    /** The last [lines] lines, read from the end of the file. */
    fun tail(lines: Int): String {
        if (!file.exists()) return ""
        return try {
            RandomAccessFile(file, "r").use { f ->
                val start = maxOf(0L, f.length() - 64 * 1024)
                f.seek(start)
                val bytes = ByteArray((f.length() - start).toInt())
                f.readFully(bytes)
                String(bytes).trimEnd('\n').split('\n').takeLast(lines).joinToString("\n")
            }
        } catch (e: Exception) {
            "(cannot read the log: ${e.message})"
        }
    }

    companion object {
        const val MAX_BYTES = 4L * 1024 * 1024
    }
}

/** Node processes of this app, found in /proc (an app only sees its own processes there). */
object NodeProcesses {
    fun pids(): List<Int> =
        File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().mapNotNull { dir ->
            val cmdline = try {
                File(dir, "cmdline").readText()
            } catch (_: Exception) {
                ""
            }
            if (cmdline.contains(NodeFiles.BINARY_NAME) && !cmdline.contains("init-config")) dir.name.toInt() else null
        }

    /** Resident memory of a process in MB, from /proc/<pid>/status. */
    fun rssMb(pid: Int): Long? = try {
        File("/proc/$pid/status").readLines().firstOrNull { it.startsWith("VmRSS:") }
            ?.split(Regex("\\s+"))?.getOrNull(1)?.toLong()?.div(1024)
    } catch (_: Exception) {
        null
    }
}
