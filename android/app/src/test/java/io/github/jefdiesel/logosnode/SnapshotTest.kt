package io.github.jefdiesel.logosnode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

class SnapshotTest {
    @get:Rule val tmp = TemporaryFolder()

    // ---- a tiny ustar writer, for archives a real tar would refuse to make ----

    private class Tar {
        val out = ByteArrayOutputStream()
        fun entry(name: String, data: ByteArray = ByteArray(0), type: Char = '0', size: Long = data.size.toLong(), badChecksum: Boolean = false): Tar {
            val h = ByteArray(512)
            name.toByteArray().copyInto(h, 0, 0, minOf(100, name.length))
            "0000644\u0000".toByteArray().copyInto(h, 100)
            String.format("%011o\u0000", size).toByteArray().copyInto(h, 124)
            "00000000000\u0000".toByteArray().copyInto(h, 136)
            h[156] = type.code.toByte()
            "ustar\u000000".toByteArray().copyInto(h, 257)
            for (i in 148 until 156) h[i] = ' '.code.toByte()
            var sum = h.sumOf { it.toInt() and 0xff }
            if (badChecksum) sum += 1
            String.format("%06o\u0000 ", sum).toByteArray().copyInto(h, 148)
            out.write(h)
            out.write(data)
            out.write(ByteArray(((512 - data.size % 512) % 512)))
            return this
        }
        fun pax(vararg records: Pair<String, String>): Tar {
            val body = ByteArrayOutputStream()
            for ((k, v) in records) {
                val rest = " $k=$v\n"
                var len = rest.length + 1
                while ((len.toString() + rest).length != len) len++
                body.write((len.toString() + rest).toByteArray())
            }
            return entry("PaxHeader", body.toByteArray(), 'x')
        }
        fun end(): ByteArray { out.write(ByteArray(1024)); return out.toByteArray() }
    }

    private fun goodDb(): Tar = Tar()
        .entry("db/", type = '5')
        .entry("db/CURRENT", "MANIFEST-000003\n".toByteArray())
        .entry("db/MANIFEST-000003", ByteArray(700) { 1 })
        .entry("db/000004.sst", ByteArray(5000) { 2 })

    private fun extract(bytes: ByteArray, cap: Long = 1 shl 30): Pair<File, TarExtractor.Result> {
        val dest = tmp.newFolder()
        return dest to TarExtractor(cap).extract(ByteArrayInputStream(bytes), dest)
    }

    private fun refused(bytes: ByteArray, cap: Long = 1 shl 30, contains: String) {
        try {
            extract(bytes, cap)
            fail("expected a refusal containing '$contains'")
        } catch (e: SnapshotError) {
            assertTrue("message was: ${e.message}", e.message!!.contains(contains))
        }
    }

    // ---- extraction: the real formats ----

    private fun fixture(name: String) = javaClass.getResourceAsStream("/snapshots/$name")!!.readBytes()

    @Test fun macTarDefault() = checkFixture("bsdtar-default.tar")
    @Test fun macTarPaxWithXattr() = checkFixture("bsdtar-pax.tar")
    @Test fun gnuTarWithLongName() = checkFixture("gnutar-longname.tar")
    @Test fun stateDbLayout() = checkFixture("state-db-layout.tar")
    @Test fun filesAtTheTop() {
        val (dest, r) = extract(fixture("top-layout.tar"))
        assertEquals(6, r.files)
        assertNull(RocksDbCheck.problem(File(dest, "db")))
    }

    private fun checkFixture(name: String) {
        val (dest, r) = extract(fixture(name))
        val db = File(dest, "db")
        assertEquals(7, r.files)
        assertNull(RocksDbCheck.problem(db))
        assertEquals("MANIFEST-000005", File(db, "CURRENT").readText().trim())
        assertEquals(70000L, File(db, "000007.sst").length())
        assertTrue(File(db, "x".repeat(120) + ".sst").isFile)
        assertEquals(setOf("db"), dest.list()!!.toSet())
    }

    @Test fun writtenByTheTinyWriter() {
        val (dest, r) = extract(goodDb().end())
        assertEquals(3, r.files)
        assertNull(RocksDbCheck.problem(File(dest, "db")))
    }

    @Test fun paxPathAndSizeOverrideTheHeader() {
        val data = ByteArray(10) { 7 }
        val tar = Tar().pax("path" to "db/000099.sst", "size" to "10").entry("ignored-short-name", data).end()
        val (dest, _) = extract(tar)
        assertEquals(10L, File(dest, "db/000099.sst").length())
    }

    @Test fun appleDoubleFilesAreSkipped() {
        val (dest, r) = extract(goodDb().entry("db/._000004.sst", ByteArray(40)).end())
        assertEquals(listOf("db/._000004.sst"), r.skipped)
        assertFalse(File(dest, "db/._000004.sst").exists())
    }

    // ---- extraction: refusals ----

    @Test fun refusesDotDot() = refused(goodDb().entry("db/../keystore.yaml", "x".toByteArray()).end(), contains = "Unsafe path")
    @Test fun refusesAbsolute() = refused(Tar().entry("/etc/passwd", "x".toByteArray()).end(), contains = "Unsafe path")
    @Test fun refusesSymlink() = refused(goodDb().entry("db/evil", type = '2').end(), contains = "link")
    @Test fun refusesHardLink() = refused(goodDb().entry("db/evil", type = '1').end(), contains = "link")
    @Test fun refusesDevice() = refused(goodDb().entry("db/dev", type = '3').end(), contains = "device")
    @Test fun refusesBadChecksum() = refused(Tar().entry("db/CURRENT", "x".toByteArray(), badChecksum = true).end(), contains = "checksum")
    @Test fun refusesOverCap() = refused(goodDb().end(), cap = 1000, contains = "more than")
    @Test fun refusesSubfolders() = refused(goodDb().entry("db/sub/000001.sst", ByteArray(3)).end(), contains = "Unexpected file")
    @Test fun refusesOtherFolders() = refused(Tar().entry("home/", type = '5').end(), contains = "Unexpected folder")
    @Test fun refusesMixedRoots() = refused(goodDb().entry("CURRENT2", ByteArray(3)).end(), contains = "mixes")
    @Test fun refusesDuplicates() = refused(goodDb().entry("db/CURRENT", "y".toByteArray()).end(), contains = "twice")
    @Test fun refusesTruncated() {
        val full = goodDb().end()
        refused(full.copyOf(full.size - 1024 - 300), contains = "incomplete")
    }
    @Test fun refusesEmpty() = refused(Tar().entry("db/", type = '5').end(), contains = "no database files")

    // ---- the RocksDB check ----

    @Test fun rocksDbCheck() {
        val db = tmp.newFolder("db")
        assertTrue(RocksDbCheck.problem(db)!!.contains("CURRENT"))
        File(db, "CURRENT").writeText("MANIFEST-000003\n")
        assertTrue(RocksDbCheck.problem(db)!!.contains("MANIFEST"))
        File(db, "MANIFEST-000003").writeBytes(ByteArray(10))
        assertTrue(RocksDbCheck.problem(db)!!.contains(".sst"))
        File(db, "000001.sst").writeBytes(ByteArray(10))
        assertNull(RocksDbCheck.problem(db))
        File(db, "CURRENT").writeText("../../keystore.yaml")
        assertTrue(RocksDbCheck.problem(db)!!.contains("doesn't name"))
    }

    // ---- the swap ----

    private class Home(root: File) {
        val dir = root
        val keys = File(root, "keystore.yaml").apply { writeText("keys") }
        val config = File(root, "user_config.yaml").apply { writeText("config") }
        fun state(name: String, mark: String) = File(dir, name).apply { mkdirs(); File(this, "mark").writeText(mark) }
        fun mark(name: String) = File(dir, "$name/mark").takeIf { it.exists() }?.readText()
        fun untouched() {
            assertEquals("keys", keys.readText())
            assertEquals("config", config.readText())
        }
    }

    private fun home() = Home(tmp.newFolder())

    @Test fun installKeepsExactlyOnePrevious() {
        val h = home()
        h.state("state", "current"); h.state("state.previous", "older"); h.state("state.importing", "new")
        StateSwap(h.dir).install()
        assertEquals("new", h.mark("state"))
        assertEquals("current", h.mark("state.previous"))
        assertEquals(setOf("state", "state.previous", "keystore.yaml", "user_config.yaml"), h.dir.list()!!.toSet())
        h.untouched()
    }

    @Test fun revertSwapsBackAndForth() {
        val h = home()
        h.state("state", "snapshot"); h.state("state.previous", "before")
        StateSwap(h.dir).revert()
        assertEquals("before", h.mark("state")); assertEquals("snapshot", h.mark("state.previous"))
        StateSwap(h.dir).revert()
        assertEquals("snapshot", h.mark("state")); assertEquals("before", h.mark("state.previous"))
        h.untouched()
    }

    private class Killed : RuntimeException()

    @Test fun installKilledAtEveryStepIsUndoneAtNextStart() {
        for (killAt in 0..2) {
            val h = home()
            h.state("state", "current"); h.state("state.previous", "older"); h.state("state.importing", "new")
            val swap = StateSwap(h.dir)
            swap.beforeStep = { if (it == killAt) throw Killed() }
            try { swap.install(); fail() } catch (_: Killed) {}
            val msg = StateSwap(h.dir).recover()
            assertTrue(msg!!.contains("interrupted"))
            assertEquals("killed at $killAt", "current", h.mark("state"))
            assertEquals("killed at $killAt", "older", h.mark("state.previous"))
            assertFalse(File(h.dir, "state.importing").exists())
            assertEquals(setOf("state", "state.previous", "keystore.yaml", "user_config.yaml"), h.dir.list()!!.toSet())
            h.untouched()
        }
    }

    @Test fun revertKilledAtEveryStepIsUndoneAtNextStart() {
        for (killAt in 0..2) {
            val h = home()
            h.state("state", "snapshot"); h.state("state.previous", "before")
            val swap = StateSwap(h.dir)
            swap.beforeStep = { if (it == killAt) throw Killed() }
            try { swap.revert(); fail() } catch (_: Killed) {}
            StateSwap(h.dir).recover()
            assertEquals("snapshot", h.mark("state")); assertEquals("before", h.mark("state.previous"))
            h.untouched()
        }
    }

    @Test fun halfExtractedImportIsCleanedUp() {
        val h = home()
        h.state("state", "current"); h.state("state.importing", "half")
        assertTrue(StateSwap(h.dir).recover()!!.contains("cleaned up"))
        assertEquals("current", h.mark("state"))
        assertFalse(File(h.dir, "state.importing").exists())
        assertNull(StateSwap(h.dir).recover())
    }

    // ---- the patched node's replay marker (state/db.replay-verified) never survives a swap ----

    private fun marker(dir: File) = File(dir, REPLAY_MARKER)

    @Test fun markerIsGoneAfterInstall() {
        val h = home()
        h.state("state", "current"); marker(File(h.dir, "state")).writeText("build\nidentity")
        h.state("state.importing", "new"); marker(File(h.dir, "state.importing")).writeText("someone else's")
        StateSwap(h.dir).install()
        assertEquals("new", h.mark("state"))
        assertFalse(marker(File(h.dir, "state")).exists())
        h.untouched()
    }

    @Test fun markerIsGoneAfterGoBack() {
        val h = home()
        h.state("state", "snapshot"); h.state("state.previous", "before")
        marker(File(h.dir, "state.previous")).writeText("verified long ago")
        StateSwap(h.dir).revert()
        assertEquals("before", h.mark("state"))
        assertFalse(marker(File(h.dir, "state")).exists())
    }

    @Test fun markerIsGoneAfterRecoveryFromAKilledSwap() {
        for (killAt in 0..2) {
            val h = home()
            h.state("state", "current"); marker(File(h.dir, "state")).writeText("m")
            h.state("state.previous", "older"); h.state("state.importing", "new")
            val swap = StateSwap(h.dir)
            swap.beforeStep = { if (it == killAt) throw Killed() }
            try { swap.install(); fail() } catch (_: Killed) {}
            StateSwap(h.dir).recover()
            assertEquals("current", h.mark("state"))
            assertFalse("killed at $killAt", marker(File(h.dir, "state")).exists())
        }
    }

    @Test fun anotherNodeBinaryDropsTheMarker() {
        val h = home()
        val state = h.state("state", "current")
        val record = File(h.dir, "state-node.sha256")
        val a = "aa".repeat(32); val b = "bb".repeat(32)
        marker(state).writeText("m")
        // no record yet (first start of an app that keeps one): the marker can't be trusted
        assertTrue(NodeBinaryRecord.check(record, state, a))
        assertFalse(marker(state).exists())
        assertEquals(a, record.readText().trim())
        // the same binary again: a marker it wrote is kept
        marker(state).writeText("m")
        assertFalse(NodeBinaryRecord.check(record, state, a))
        assertTrue(marker(state).exists())
        // another binary (new build, or patched <-> unpatched): dropped, and the new one recorded
        assertTrue(NodeBinaryRecord.check(record, state, b))
        assertFalse(marker(state).exists())
        assertEquals(b, record.readText().trim())
        assertFalse(NodeBinaryRecord.check(record, state, b))      // nothing left to drop
        h.untouched()
    }

    @Test fun binaryHashIsTheFileSha256() {
        val f = File(tmp.root, "bin").apply { writeText("abc") }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", NodeBinaryRecord.sha256(f))
    }

    @Test fun aMarkerInsideASnapshotIsStripped() {
        val tar = goodDb().entry("db/$REPLAY_MARKER", "x".toByteArray()).entry(REPLAY_MARKER, "y".toByteArray())
            .entry("state/$REPLAY_MARKER", "z".toByteArray()).end()
        val (dest, r) = extract(tar)
        assertEquals(3, r.files)
        assertEquals(3, r.skipped.size)
        assertFalse(File(dest, "db/$REPLAY_MARKER").exists())
        assertFalse(File(dest, REPLAY_MARKER).exists())
    }

    // ---- the whole import ----

    @Test fun importEndToEnd() {
        val h = home()
        h.state("state", "current")
        val tar = goodDb().end()
        val events = mutableListOf<String>()
        val msg = SnapshotImporter(h.dir, status = { events += it }).run(
            open = { ByteArrayInputStream(tar) }, size = tar.size.toLong(), available = 1L shl 32,
            stopNode = { events += "STOP" }, startNode = { events += "START" })
        assertTrue(msg.startsWith("Imported 3 files"))
        assertNull(RocksDbCheck.problem(File(h.dir, "state/db")))
        assertEquals("current", h.mark("state.previous"))
        assertTrue(events.indexOf("STOP") < events.indexOf("START"))
        h.untouched()
    }

    @Test fun importOfABadTarLeavesTheNodeAlone() {
        val h = home()
        h.state("state", "current")
        val tar = Tar().entry("db/CURRENT", "MANIFEST-1\n".toByteArray()).end()     // no manifest, no tables
        val events = mutableListOf<String>()
        try {
            SnapshotImporter(h.dir, status = { events += it }).run({ ByteArrayInputStream(tar) }, tar.size.toLong(), 1L shl 32,
                { events += "STOP" }, { events += "START" })
            fail()
        } catch (e: SnapshotError) {
            assertTrue(e.message!!.contains("MANIFEST"))
        }
        assertFalse("STOP" in events)
        assertEquals("current", h.mark("state"))
        assertEquals(setOf("state", "keystore.yaml", "user_config.yaml"), h.dir.list()!!.toSet())
    }

    @Test fun importRefusedWithoutSpace() {
        val h = home()
        try {
            SnapshotImporter(h.dir, status = {}).run({ ByteArrayInputStream(ByteArray(0)) }, 1000, 1999, {}, {})
            fail()
        } catch (e: SnapshotError) {
            assertTrue(e.message!!.contains("free space"))
        }
    }

    @Test fun cancelStopsExtraction() {
        val h = home()
        h.state("state", "current")
        val tar = goodDb().end()
        try {
            SnapshotImporter(h.dir, status = {}, cancelled = { true }).run({ ByteArrayInputStream(tar) }, null, 1L shl 32, {}, {})
            fail()
        } catch (e: SnapshotError) {
            assertTrue(e.message!!.contains("cancelled"))
        }
        assertFalse(File(h.dir, "state.importing").exists())
        assertEquals("current", h.mark("state"))
    }
}
