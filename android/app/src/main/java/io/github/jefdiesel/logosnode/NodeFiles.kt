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

    /**
     * files/node/logos-blockchain-node, a link to the bundled binary. Started through it, the node's
     * command line carries its usual name, which the web app looks for (pgrep -f logos-blockchain-node).
     */
    val link = File(home, LINK_NAME)

    /** What to run: the link when it works, else the binary itself. */
    val launcher: File get() = if (link.exists()) link else binary

    fun mkdirs() {
        listOf(home, tmp, state, nodeLogs).forEach { it.mkdirs() }
    }

    /**
     * (Re)creates the link when it doesn't point at this install's binary (its folder changes with
     * every install). The new link is made under a temporary name, checked by running it, and then
     * renamed into place, so the two processes of the app can both call this safely.
     */
    fun linkBinary() = synchronized(NodeFiles::class.java) {
        val current = try {
            android.system.Os.readlink(link.path)
        } catch (_: Exception) {
            null
        }
        if (current == binary.path) return@synchronized
        val tmp = File(home, "$LINK_NAME.tmp-${android.os.Process.myPid()}")
        try {
            tmp.delete()
            android.system.Os.symlink(binary.path, tmp.path)
            val p = ProcessBuilder(tmp.path, "--version").redirectErrorStream(true).start()
            p.inputStream.readBytes()
            if (p.waitFor(20, java.util.concurrent.TimeUnit.SECONDS) && p.exitValue() == 0) {
                android.system.Os.rename(tmp.path, link.path)
            } else {
                p.destroyForcibly()
            }
        } catch (_: Exception) {
        } finally {
            tmp.delete()
        }
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
        const val LINK_NAME = "logos-blockchain-node"
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

/**
 * Running nodes of this app, found in /proc (an app only sees its own processes there): the binary or
 * its link, started with the config file. Short calls such as --show-config are not counted.
 */
object NodeProcesses {
    fun pids(): List<Int> =
        File("/proc").listFiles { f -> f.name.all(Char::isDigit) }.orEmpty().mapNotNull { dir ->
            val argv = try {
                File(dir, "cmdline").readText().split('\u0000')
            } catch (_: Exception) {
                emptyList()
            }
            val name = argv.firstOrNull().orEmpty().substringAfterLast('/')
            val isNode = name == NodeFiles.BINARY_NAME || name == NodeFiles.LINK_NAME
            if (isNode && argv.getOrNull(1) == "user_config.yaml") dir.name.toInt() else null
        }

    /** Resident memory of a process in MB, from /proc/<pid>/status. */
    fun rssMb(pid: Int): Long? = try {
        File("/proc/$pid/status").readLines().firstOrNull { it.startsWith("VmRSS:") }
            ?.split(Regex("\\s+"))?.getOrNull(1)?.toLong()?.div(1024)
    } catch (_: Exception) {
        null
    }
}
