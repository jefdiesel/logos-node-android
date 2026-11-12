package io.github.jefdiesel.logosnode

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/** One screen: Start and Stop, the node's status from its own API, and the end of its log. */
class MainActivity : Activity() {

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private lateinit var files: NodeFiles
    private lateinit var log: NodeLog
    private lateinit var processView: TextView
    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private var visible = false

    private val refresh = object : Runnable {
        override fun run() {
            if (!visible) return
            io.execute { update() }
            main.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        files = NodeFiles(this)
        log = NodeLog(files.output)
        setContentView(layout())
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onResume() {
        super.onResume()
        visible = true
        main.post(refresh)
    }

    override fun onPause() {
        visible = false
        main.removeCallbacks(refresh)
        super.onPause()
    }

    private fun layout(): ScrollView {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun text(size: Float, value: String = "") = TextView(this).apply {
            textSize = size
            text = value
            setPadding(0, pad / 2, 0, pad / 2)
            setTextIsSelectable(true)
        }
        column.addView(text(22f, "Logos node"))
        column.addView(
            text(
                14f,
                "This test build runs the official Logos node (${BuildConfig.NODE_VERSION}) inside this app and " +
                    "syncs the chain from its first block. That cannot finish on a phone: the node's memory grows " +
                    "with the chain during the first sync, until Android stops it. Starting from a snapshot is a later step."
            )
        )
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.addView(Button(this).apply {
            text = "Start"
            setOnClickListener {
                startForegroundService(Intent(this@MainActivity, NodeService::class.java).setAction(NodeService.ACTION_START))
                io.execute { update() }
            }
        })
        buttons.addView(Button(this).apply {
            text = "Stop"
            setOnClickListener {
                if (NodeService.active) {
                    startService(Intent(this@MainActivity, NodeService::class.java).setAction(NodeService.ACTION_STOP))
                }
                io.execute { update() }
            }
        })
        column.addView(buttons)
        processView = text(16f).also { column.addView(it) }
        statusView = text(16f).also { column.addView(it) }
        column.addView(text(14f, "Log (full log: files/node/output.log)"))
        logView = text(11f).apply { typeface = Typeface.MONOSPACE }.also { column.addView(it) }
        column.addView(
            text(
                11f,
                "Node binary: ${BuildConfig.NODE_VERSION}, sha256 ${BuildConfig.NODE_SHA256}\n" +
                    "App ${BuildConfig.VERSION_NAME}. API on 127.0.0.1:${NodeFiles.API_PORT}."
            )
        )
        return ScrollView(this).apply { addView(column, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
    }

    /** Runs on the io thread; posts the result to the screen. */
    private fun update() {
        val pids = NodeProcesses.pids()
        val processText = if (pids.isEmpty()) {
            "Node process: not running (service: ${NodeService.status})"
        } else {
            "Node process: running, " + pids.joinToString { "pid $it, ${NodeProcesses.rssMb(it) ?: "?"} MB" } +
                " (service: ${NodeService.status})"
        }
        val statusText = if (pids.isEmpty()) "" else nodeStatus()
        val logText = log.tail(40)
        main.post {
            processView.text = processText
            statusView.text = statusText
            logView.text = logText
        }
    }

    private fun nodeStatus(): String = try {
        val info = JSONObject(get("/cryptarchia/info"))
        val c = info.optJSONObject("cryptarchia_info") ?: info
        val net = try {
            JSONObject(get("/network/info"))
        } catch (_: Exception) {
            null
        }
        val peers = net?.optJSONArray("connected_peers")?.length()?.toString()
            ?: net?.opt("n_peers")?.toString() ?: "?"
        "Block height: ${c.opt("height")}\nState: ${c.opt("state")}\nPhase: ${info.opt("phase")}\nPeers: $peers"
    } catch (e: Exception) {
        "Node API not answering yet (${e.javaClass.simpleName}: ${e.message})"
    }

    private fun get(path: String): String {
        val c = URL("http://127.0.0.1:${NodeFiles.API_PORT}$path").openConnection() as HttpURLConnection
        c.connectTimeout = 2000
        c.readTimeout = 3000
        return try {
            c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }
}
