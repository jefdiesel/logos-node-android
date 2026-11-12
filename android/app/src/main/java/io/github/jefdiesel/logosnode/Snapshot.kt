package io.github.jefdiesel.logosnode

import java.io.File
import java.io.FileOutputStream
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

// Starting the node from a snapshot: a tar of a synced node's state folder (its RocksDB database,
// `db/...`), as docs/start-from-a-synced-database.md describes. Plain Java/Kotlin only, so the
// same code is unit-tested on a computer and runs in the app.

/**
 * The patched node's replay marker, next to its database (`state/db.replay-verified`): it records that
 * this build verified the stored blocks in full, so later starts replay them fast. It must never come
 * with a state from elsewhere, nor survive a swap (native/patches/README.md).
 */
const val REPLAY_MARKER = "db.replay-verified"

/**
 * Which node binary last ran against the state: its sha256, kept next to the state
 * (files/node/state-node.sha256). When the binary about to start is a different one (an app update
 * with a new node build, or a switch between patched and unpatched), the replay marker is dropped
 * first: the other binary may have written blocks the marker's build never verified.
 */
object NodeBinaryRecord {
    /** Call before every node start. Returns true if a marker was there and was dropped. */
    fun check(record: File, state: File, binarySha256: String): Boolean {
        val last = try { record.readText().trim() } catch (_: Exception) { "" }
        if (last == binarySha256) return false
        val marker = File(state, REPLAY_MARKER)
        val dropped = marker.exists()
        marker.delete()
        File(state, "db/$REPLAY_MARKER").delete()
        val tmp = File(record.path + ".tmp")
        tmp.writeText(binarySha256 + "\n")
        Files.move(tmp.toPath(), record.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        return dropped
    }

    fun sha256(file: File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}

/** Something about the snapshot or the swap that stops the import, in words for the screen. */
class SnapshotError(message: String) : Exception(message)

/**
 * Reads a tar as a stream and writes a node snapshot from it into `<dest>/db`, without holding it
 * in memory. Accepts the database files under `db/`, under `state/db/`, or at the top of the tar.
 * Refuses links, devices, absolute paths, `..`, sub-folders inside the database, damaged headers,
 * and more than [maxTotalBytes] of file data or [maxEntries] entries. macOS "._" files are skipped.
 */
class TarExtractor(
    private val maxTotalBytes: Long,
    private val maxEntries: Int = 100_000,
    private val onProgress: (bytesRead: Long) -> Unit = {},
) {
    data class Result(val files: Int, val bytes: Long, val skipped: List<String>)

    private enum class Root { DB, STATE_DB, TOP }

    fun extract(input: InputStream, dest: File): Result {
        val db = File(dest, "db")
        if (!db.mkdirs() && !db.isDirectory) throw SnapshotError("Couldn't create ${db.path}.")
        val dbCanonical = db.canonicalPath
        val counting = Counting(input)
        val header = ByteArray(512)
        var root: Root? = null
        var files = 0
        var entries = 0
        var total = 0L
        val skipped = mutableListOf<String>()
        var paxPath: String? = null
        var paxSize: Long? = null
        var longName: String? = null

        while (true) {
            if (!readBlock(counting, header)) throw SnapshotError("The file ends in the middle of the archive; it is incomplete.")
            if (header.all { it.toInt() == 0 }) break                       // end of archive
            if (++entries > maxEntries) throw SnapshotError("The archive has more than $maxEntries entries; that isn't a node snapshot.")
            checkChecksum(header)
            val type = header[156].toInt().toChar()
            val size = paxSize ?: parseSize(header)
            var name = paxPath ?: longName ?: headerName(header)
            paxPath = null; paxSize = null; longName = null

            when (type) {
                'x' -> {                                                     // pax header for the next entry
                    val pax = readSmall(counting, size, 1 shl 20)
                    for ((k, v) in parsePax(pax)) {
                        if (k == "path") paxPath = v
                        if (k == "size") paxSize = v.toLongOrNull() ?: throw SnapshotError("Damaged archive header.")
                    }
                    continue
                }
                'g' -> { skipData(counting, size); continue }               // global pax header: nothing we need
                'L' -> { longName = String(readSmall(counting, size, 65536)).trimEnd('\u0000'); continue }
                '1', '2', 'K' -> throw SnapshotError("The archive contains a link ($name); a node snapshot has none.")
                '3', '4', '6' -> throw SnapshotError("The archive contains a device or pipe ($name).")
            }

            name = name.removePrefix("./")
            checkPath(name)
            val isDir = type == '5' || name.endsWith("/")
            val parts = name.trimEnd('/').split('/')
            val base = parts.last()
            if (base.startsWith("._") || base == REPLAY_MARKER) {           // macOS metadata; another node's replay marker
                skipped += name
                skipData(counting, size)
                continue
            }
            if (isDir) {
                val allowed = listOf(listOf("db"), listOf("state"), listOf("state", "db"))
                if (parts !in allowed) throw SnapshotError("Unexpected folder in the archive: $name. A node snapshot holds only the db folder.")
                skipData(counting, size)
                continue
            }
            if (type != '0' && type != '\u0000' && type != '7') throw SnapshotError("Unsupported entry type '$type' for $name.")
            val (entryRoot, fileName) = when {
                parts.size == 2 && parts[0] == "db" -> Root.DB to parts[1]
                parts.size == 3 && parts[0] == "state" && parts[1] == "db" -> Root.STATE_DB to parts[2]
                parts.size == 1 -> Root.TOP to parts[0]
                else -> throw SnapshotError("Unexpected file in the archive: $name. A node snapshot holds only db/<files>.")
            }
            if (root == null) root = entryRoot
            if (root != entryRoot) throw SnapshotError("The archive mixes folders ($name); it isn't one node snapshot.")
            total += size
            if (total > maxTotalBytes) throw SnapshotError("The archive holds more than ${maxTotalBytes / 1_000_000} MB, more than there is room for.")
            val out = File(db, fileName)
            if (!out.canonicalPath.startsWith(dbCanonical + File.separator)) throw SnapshotError("Unsafe file name in the archive: $name.")
            if (out.exists()) throw SnapshotError("The archive has $fileName twice.")
            FileOutputStream(out).use { copyData(counting, it, size) }
            skipPadding(counting, size)
            files++
            onProgress(counting.count)
        }
        if (files == 0) throw SnapshotError("The archive has no database files.")
        return Result(files, total, skipped)
    }

    private fun checkPath(name: String) {
        if (name.isEmpty() || name.startsWith("/") || name.contains('\\') || name.contains('\u0000'))
            throw SnapshotError("Unsafe path in the archive: '$name'.")
        val parts = name.trimEnd('/').split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) throw SnapshotError("Unsafe path in the archive: '$name'.")
    }

    private fun headerName(h: ByteArray): String {
        val name = cString(h, 0, 100)
        val magic = String(h, 257, 5, Charsets.US_ASCII)
        val prefix = if (magic == "ustar") cString(h, 345, 155) else ""
        return if (prefix.isNotEmpty()) "$prefix/$name" else name
    }

    private fun cString(h: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && h[end].toInt() != 0) end++
        return String(h, off, end - off, Charsets.UTF_8)
    }

    private fun parseOctal(h: ByteArray, off: Int, len: Int): Long {
        val s = String(h, off, len, Charsets.US_ASCII).trim { it == ' ' || it == '\u0000' }
        if (s.isEmpty()) return 0
        if (!s.all { it in '0'..'7' }) throw SnapshotError("Damaged archive header.")
        return s.toLong(8)
    }

    private fun parseSize(h: ByteArray): Long {
        if (h[124].toInt() and 0x80 != 0) {                                  // base-256 (GNU, very large files)
            var v = 0L
            for (i in 125 until 136) {
                if (v > (Long.MAX_VALUE shr 8)) throw SnapshotError("A file in the archive is too big.")
                v = (v shl 8) or (h[i].toLong() and 0xff)
            }
            return v
        }
        return parseOctal(h, 124, 12)
    }

    private fun checkChecksum(h: ByteArray) {
        val stored = parseOctal(h, 148, 8)
        var unsigned = 0L
        var signed = 0L
        for (i in 0 until 512) {
            val b = if (i in 148 until 156) 0x20 else h[i].toInt()
            unsigned += b and 0xff
            signed += if (i in 148 until 156) 0x20 else h[i].toInt()
        }
        if (stored != unsigned && stored != signed) throw SnapshotError("The archive is damaged (a header checksum is wrong).")
    }

    private fun parsePax(data: ByteArray): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        var i = 0
        while (i < data.size) {
            var sp = i
            while (sp < data.size && data[sp] != ' '.code.toByte()) sp++
            val len = String(data, i, sp - i, Charsets.US_ASCII).toIntOrNull()
            if (len == null || len <= 0 || i + len > data.size) throw SnapshotError("Damaged archive header.")
            val record = String(data, sp + 1, i + len - sp - 2, Charsets.UTF_8)    // without the trailing newline
            val eq = record.indexOf('=')
            if (eq > 0) out += record.substring(0, eq) to record.substring(eq + 1)
            i += len
        }
        return out
    }

    private fun readBlock(input: InputStream, block: ByteArray): Boolean {
        var n = 0
        while (n < block.size) {
            val r = input.read(block, n, block.size - n)
            if (r < 0) return false
            n += r
        }
        return true
    }

    private fun readSmall(input: InputStream, size: Long, cap: Int): ByteArray {
        if (size < 0 || size > cap) throw SnapshotError("Damaged archive header.")
        val buf = ByteArray(size.toInt())
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) throw SnapshotError("The file ends in the middle of the archive; it is incomplete.")
            n += r
        }
        skipPadding(input, size)
        return buf
    }

    private val buffer = ByteArray(1 shl 20)

    private fun copyData(input: InputStream, out: FileOutputStream, size: Long) {
        var left = size
        while (left > 0) {
            val r = input.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
            if (r < 0) throw SnapshotError("The file ends in the middle of the archive; it is incomplete.")
            out.write(buffer, 0, r)
            left -= r
            onProgress((input as Counting).count)
        }
    }

    private fun skipData(input: InputStream, size: Long) {
        discard(input, size)
        skipPadding(input, size)
    }

    private fun skipPadding(input: InputStream, size: Long) = discard(input, (512 - size % 512) % 512)

    private fun discard(input: InputStream, count: Long) {
        var left = count
        while (left > 0) {
            val r = input.read(buffer, 0, minOf(left, buffer.size.toLong()).toInt())
            if (r < 0) throw SnapshotError("The file ends in the middle of the archive; it is incomplete.")
            left -= r
        }
    }

    private class Counting(input: InputStream) : FilterInputStream(input) {
        var count = 0L
        override fun read(): Int = super.read().also { if (it >= 0) count++ }
        override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { if (it > 0) count += it }
    }
}

/** Whether `db` looks like a RocksDB database: CURRENT naming a MANIFEST that exists, and table files. */
object RocksDbCheck {
    fun problem(db: File): String? {
        val current = File(db, "CURRENT")
        if (!current.isFile || current.length() > 256) return "The snapshot has no RocksDB CURRENT file."
        val manifest = current.readText().trim()
        if (!Regex("^MANIFEST-\\d+$").matches(manifest)) return "The snapshot's CURRENT file doesn't name a MANIFEST."
        val m = File(db, manifest)
        if (!m.isFile || m.length() == 0L) return "The snapshot's $manifest is missing or empty."
        if (db.listFiles { f -> f.name.endsWith(".sst") }.isNullOrEmpty()) return "The snapshot has no .sst table files."
        return null
    }
}

/**
 * Swaps whole state folders inside the node's home by renames only, with a journal
 * (state-swap.txt), so a swap cut short by the app being killed is undone, or finished, at the next
 * start ([recover]). Only the state folders are ever moved: never the keys or user_config.yaml.
 * Exactly one previous state is kept, as state.previous.
 */
class StateSwap(private val home: File) {
    val state = File(home, "state")
    val previous = File(home, "state.previous")
    val importing = File(home, "state.importing")
    private val discard = File(home, "state.discard")
    private val swap = File(home, "state.swap")
    private val journal = File(home, "state-swap.txt")

    /** Test hook: called before each rename; a test throws from it to act like the app being killed. */
    var beforeStep: (Int) -> Unit = {}

    /** Puts state.importing in place of state; the current state becomes state.previous. */
    fun install() {
        if (!importing.isDirectory) throw SnapshotError("There is no imported state to put in place.")
        val steps = mutableListOf<Pair<File, File>>()
        if (previous.exists()) steps += previous to discard
        if (state.exists()) steps += state to previous
        steps += importing to state
        run(steps, cleanup = listOf(discard))
    }

    /** Swaps state and state.previous, so going back can itself be undone the same way. */
    fun revert() {
        if (!previous.isDirectory) throw SnapshotError("There is no previous state to go back to.")
        if (!state.exists()) {
            run(listOf(previous to state), cleanup = emptyList())
        } else {
            run(listOf(state to swap, previous to state, swap to previous), cleanup = emptyList())
        }
    }

    /**
     * After the app was killed: undoes a swap that didn't finish, completes the clean-up of one that
     * did, and removes a half-extracted state.importing. Returns what it did, or null if nothing.
     */
    fun recover(): String? {
        if (journal.exists()) {
            val (steps, done, complete) = readJournal()
            if (complete) {
                dropReplayMarker()
                discard.deleteRecursively()
                journal.delete()
                return "A snapshot swap had finished; its clean-up was completed."
            }
            for (i in done - 1 downTo 0) {
                val (from, to) = steps[i]
                move(to, from)
            }
            // to be safe after an interrupted swap: one full replay on the next start
            dropReplayMarker()
            journal.delete()
            importing.deleteRecursively()
            return "A snapshot swap was interrupted; the state was put back as it was."
        }
        if (importing.exists()) {
            importing.deleteRecursively()
            return "An interrupted snapshot import was cleaned up; the node's state was not changed."
        }
        if (discard.exists()) discard.deleteRecursively()
        return null
    }

    private fun run(steps: List<Pair<File, File>>, cleanup: List<File>) {
        writeJournal(steps, 0, false)
        var done = 0
        try {
            for ((i, step) in steps.withIndex()) {
                beforeStep(i)
                move(step.first, step.second)
                done = i + 1
                writeJournal(steps, done, false)
            }
        } catch (e: IOException) {
            for (i in done - 1 downTo 0) {                                    // put everything back
                try { move(steps[i].second, steps[i].first) } catch (_: IOException) {}
            }
            journal.delete()
            throw SnapshotError("Couldn't move the state folders (${e.message}); the state was put back as it was.")
        }
        // the state now in place was not verified by this node's build on this database: its first start
        // replays every stored block in full (patched node, native/patches/README.md)
        dropReplayMarker()
        writeJournal(steps, done, true)
        cleanup.forEach { it.deleteRecursively() }
        journal.delete()
    }

    /** Deletes state/db.replay-verified (and one inside db/, should a copy have brought one). */
    fun dropReplayMarker() {
        File(state, REPLAY_MARKER).delete()
        File(state, "db/$REPLAY_MARKER").delete()
    }

    private fun move(from: File, to: File) {
        if (to.exists()) throw IOException("${to.name} already exists")
        Files.move(from.toPath(), to.toPath(), StandardCopyOption.ATOMIC_MOVE)
    }

    private fun writeJournal(steps: List<Pair<File, File>>, done: Int, complete: Boolean) {
        val text = buildString {
            append("complete=").append(complete).append('\n')
            append("done=").append(done).append('\n')
            for ((from, to) in steps) append("step=").append(from.name).append('|').append(to.name).append('\n')
        }
        val tmp = File(home, journal.name + ".tmp")
        tmp.writeText(text)
        Files.move(tmp.toPath(), journal.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }

    private fun readJournal(): Triple<List<Pair<File, File>>, Int, Boolean> {
        var done = 0
        var complete = false
        val steps = mutableListOf<Pair<File, File>>()
        for (line in journal.readLines()) {
            when {
                line.startsWith("complete=") -> complete = line.endsWith("true")
                line.startsWith("done=") -> done = line.removePrefix("done=").toInt()
                line.startsWith("step=") -> {
                    val (a, b) = line.removePrefix("step=").split('|')
                    steps += File(home, a) to File(home, b)
                }
            }
        }
        return Triple(steps, done, complete)
    }
}

/**
 * The whole import, the same for the real node and for a scratch test: extract while the node keeps
 * running, check the database, stop the node, swap, start the node. Any failure leaves (or puts
 * back) the old state and says why. [stopNode] and [startNode] are the service's; [startNode] is
 * always called once the node was stopped, whatever happens.
 */
class SnapshotImporter(
    private val home: File,
    private val status: (String) -> Unit,
    private val cancelled: () -> Boolean = { false },
) {
    fun run(open: () -> InputStream, size: Long?, available: Long, stopNode: () -> Unit, startNode: () -> Unit): String {
        val swap = StateSwap(home)
        swap.recover()
        if (size != null && available < 2 * size) {
            throw SnapshotError("Not enough free space: the snapshot is ${mb(size)} MB and needs about ${mb(2 * size)} MB free; " +
                "there is ${mb(available)} MB.")
        }
        val cap = maxOf(0L, available - 256L * 1024 * 1024)
        swap.importing.deleteRecursively()
        val result = try {
            var lastShown = -1L
            val extractor = TarExtractor(maxTotalBytes = cap, onProgress = { read ->
                if (cancelled()) throw SnapshotError("The import was cancelled.")
                val step = read / (25L * 1024 * 1024)
                if (step != lastShown) {
                    lastShown = step
                    status("Importing: ${mb(read)} MB" + (size?.let { " of ${mb(it)} MB" } ?: "") + " read")
                }
            })
            open().use { extractor.extract(it, swap.importing) }
        } catch (e: Exception) {
            swap.importing.deleteRecursively()
            throw if (e is SnapshotError) e else SnapshotError("Reading the snapshot failed: ${e.message}")
        }
        status("Checking the database")
        RocksDbCheck.problem(File(swap.importing, "db"))?.let {
            swap.importing.deleteRecursively()
            throw SnapshotError(it)
        }
        status("Stopping the node")
        stopNode()
        try {
            status("Moving the new database in")
            swap.install()
        } catch (e: Exception) {
            swap.importing.deleteRecursively()
            throw if (e is SnapshotError) e else SnapshotError("Putting the snapshot in place failed: ${e.message}")
        } finally {
            status("Starting the node")
            startNode()
        }
        return "Imported ${result.files} files (${mb(result.bytes)} MB). The node is starting from the snapshot; " +
            "the state before it is kept as state.previous." +
            (if (result.skipped.isNotEmpty()) " Skipped ${result.skipped.size} macOS metadata files." else "")
    }

    companion object {
        fun mb(bytes: Long) = bytes / 1_000_000
    }
}
