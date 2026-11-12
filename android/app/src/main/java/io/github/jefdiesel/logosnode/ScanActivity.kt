package io.github.jefdiesel.logosnode

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.CameraPreview
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/**
 * The QR scanner for the page's Scan button: the camera picture, one line of text, and Cancel. QR codes
 * only, portrait. The camera stops the moment a code is read, and whenever this screen is left. The
 * decoded text goes back to WalletActivity unchanged; nothing here acts on it. ZXing (Apache-2.0), all
 * on the phone: no network, no Google Play services.
 */
class ScanActivity : Activity() {
    private lateinit var camera: BarcodeView
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dp = resources.displayMetrics.density
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        camera = BarcodeView(this).apply {
            decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
            addStateListener(object : CameraPreview.StateListener {
                override fun previewSized() {}
                override fun previewStarted() {}
                override fun previewStopped() {}
                override fun cameraClosed() {}
                override fun cameraError(error: Exception) = finishWith(RESULT_CANCELED, error = QrScan.CAMERA_ERROR)
            })
        }
        root.addView(camera, FrameLayout.LayoutParams(MATCH, MATCH))
        val hint = TextView(this).apply {
            text = "Point the camera at a QR code"
            setTextColor(Color.WHITE); textSize = 16f; gravity = Gravity.CENTER
            setShadowLayer(4f, 0f, 0f, Color.BLACK)
        }
        root.addView(hint, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP).apply { topMargin = (24 * dp).toInt() })
        val cancel = Button(this).apply {
            text = "Cancel"
            setOnClickListener { finishWith(RESULT_CANCELED) }
        }
        root.addView(cancel, FrameLayout.LayoutParams(WRAP, WRAP, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
            .apply { bottomMargin = (32 * dp).toInt() })
        // edge to edge (targetSdk 35+): keep the text and Cancel clear of the status and navigation bars
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(root)
        camera.decodeSingle { result -> finishWith(RESULT_OK, text = result.text ?: "") }
    }

    override fun onResume() {
        super.onResume()
        if (!finished) camera.resume()
    }

    override fun onPause() {
        camera.pause()                                    // leaving the screen stops the camera
        super.onPause()
    }

    /** Back is a cancel, like the button. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = finishWith(RESULT_CANCELED)

    private fun finishWith(code: Int, text: String? = null, error: String? = null) {
        if (finished) return
        finished = true
        camera.pause()                                    // a code was read (or the user left): camera off now
        setResult(code, Intent().apply {
            if (text != null) putExtra(EXTRA_TEXT, text)
            if (error != null) putExtra(EXTRA_ERROR, error)
        })
        finish()
    }

    companion object {
        const val EXTRA_TEXT = "text"
        const val EXTRA_ERROR = "error"
        private const val MATCH = FrameLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = FrameLayout.LayoutParams.WRAP_CONTENT

        /** The scanner screen's answer, as QrScan's result. */
        fun result(resultCode: Int, data: Intent?): QrScan.Result {
            val text = data?.getStringExtra(EXTRA_TEXT)
            if (resultCode == RESULT_OK && text != null) return QrScan.Result.Scanned(text)
            val error = data?.getStringExtra(EXTRA_ERROR)
            return if (error != null) QrScan.Result.Failed(error) else QrScan.Result.Cancelled
        }
    }
}
