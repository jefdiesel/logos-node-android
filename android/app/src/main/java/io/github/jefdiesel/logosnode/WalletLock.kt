package io.github.jefdiesel.logosnode

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Process
import android.util.Log

/**
 * Whether the wallet is unlocked, for the app's screens outside the page. The answer is the wallet server's own:
 * server.native_unlocked() (through logos_embed), which is true only while server.py holds an open session, made by
 * a PIN or fingerprint unlock and ended by its lock rules (Lock now, idle, leaving, fingerprints changed). Nothing
 * the page sends sets it, and there is no HTTP route to it.
 *
 * server.py runs in the wallet's process (":wallet"), the Node screen in the main one, so the Node screen asks
 * through [Provider], a content provider that runs in the wallet's process and is not exported (only this app's own
 * processes can call it). Any failure (the wallet's process starting, Python not up, an exception) answers "locked".
 */
object WalletLock {
    private const val TAG = "LogosWalletLock"
    private const val METHOD = "unlocked"
    private const val VISIBILITY = "visibility"
    private const val KEY = "unlocked"

    fun authority(context: Context) = "${context.packageName}.walletlock"

    /** In the wallet's process: the server's answer. False on any failure. */
    fun inProcess(): Boolean = try {
        com.chaquo.python.Python.isStarted() &&
            com.chaquo.python.Python.getInstance().getModule("logos_embed").callAttr("native_unlocked")?.toBoolean() == true
    } catch (e: Exception) {
        Log.w(TAG, "native_unlocked failed: ${e.javaClass.simpleName}")
        false
    }

    /** From any of this app's processes: asks [Provider]. Blocks; call it off the main thread. False on any failure. */
    fun ask(context: Context): Boolean = try {
        context.contentResolver.call(Uri.parse("content://${authority(context)}"), METHOD, null, null)
            ?.getBoolean(KEY, false) == true
    } catch (e: Exception) {
        Log.w(TAG, "couldn't ask the wallet: ${e.javaClass.simpleName}")
        false
    }

    /**
     * From the Node screen: the app's screen is still in front ("visible", while it shows) or went away ("hidden",
     * Home or the screen off), as WalletActivity reports it for itself (server.native_visibility, LeaveReport). So the
     * Node screen counts as being in the app: only the idle auto-lock applies while it shows, and leaving the app from
     * it starts the minute. "visible" never reopens a locked wallet. Blocks; off the main thread. Failures are ignored.
     */
    fun report(context: Context, state: String) {
        if (state != "visible" && state != "hidden") return
        try {
            context.contentResolver.call(Uri.parse("content://${authority(context)}"), VISIBILITY, state, null)
        } catch (e: Exception) {
            Log.w(TAG, "couldn't tell the wallet $state: ${e.javaClass.simpleName}")
        }
    }

    /** In the wallet's process: server.native_visibility(state). */
    private fun visibilityInProcess(state: String) = try {
        if (com.chaquo.python.Python.isStarted()) {
            com.chaquo.python.Python.getInstance().getModule("logos_embed").callAttr("native_visibility", state)
        }
        Unit
    } catch (e: Exception) {
        Log.w(TAG, "native_visibility failed: ${e.javaClass.simpleName}")
    }

    /** Runs in the wallet's process (android:process=":wallet", exported=false in the manifest): [METHOD] and [VISIBILITY]. */
    class Provider : ContentProvider() {
        override fun onCreate() = true

        override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
            // not exported, so only this app's uid gets here; checked again anyway
            val ours = Binder.getCallingUid() == Process.myUid()
            if (ours && method == VISIBILITY && (arg == "visible" || arg == "hidden")) {
                visibilityInProcess(arg)
                return Bundle()
            }
            return Bundle().apply { putBoolean(KEY, ours && method == METHOD && inProcess()) }
        }

        override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
        override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
    }
}
