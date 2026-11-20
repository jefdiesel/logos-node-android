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

    /** Runs in the wallet's process (android:process=":wallet", exported=false in the manifest). Answers only [METHOD]. */
    class Provider : ContentProvider() {
        override fun onCreate() = true

        override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
            // not exported, so only this app's uid gets here; checked again anyway
            val ours = Binder.getCallingUid() == Process.myUid()
            return Bundle().apply { putBoolean(KEY, ours && method == METHOD && inProcess()) }
        }

        override fun query(uri: Uri, p: Array<out String>?, s: String?, a: Array<out String>?, o: String?): Cursor? = null
        override fun getType(uri: Uri): String? = null
        override fun insert(uri: Uri, values: ContentValues?): Uri? = null
        override fun delete(uri: Uri, s: String?, a: Array<out String>?) = 0
        override fun update(uri: Uri, v: ContentValues?, s: String?, a: Array<out String>?) = 0
    }
}
