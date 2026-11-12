package io.github.jefdiesel.logosnode

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The phone's fingerprint check for the wallet, bound to an Android Keystore key that needs a strong
 * biometric for every use and is invalidated when a fingerprint is added or removed. So the check
 * only counts with a strong biometric (no screen-lock PIN fallback: the wallet's own PIN is the
 * fallback), and a newly added finger turns fingerprint unlock off until the wallet's PIN turns it
 * on again. The key holds no wallet secret; it only proves the check happened.
 */
object FingerprintKey {
    private const val ALIAS = "logos-wallet-fingerprint"
    private const val STORE = "AndroidKeyStore"

    private fun keyStore() = KeyStore.getInstance(STORE).apply { load(null) }

    fun exists(): Boolean = try {
        keyStore().containsAlias(ALIAS)
    } catch (_: Exception) {
        false
    }

    fun delete() {
        try {
            keyStore().deleteEntry(ALIAS)
        } catch (_: Exception) {
        }
    }

    /** Creates the key if it isn't there. Fails (throws) if no strong biometric is enrolled. */
    fun ensure() {
        if (exists()) return
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            }
            .build()
        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE).apply { init(spec) }.generateKey()
    }

    /** Whether a strong biometric is enrolled (null if the phone can't say, before Android 10). */
    fun enrolled(activity: Activity): Boolean? {
        if (Build.VERSION.SDK_INT < 29) return null
        val bm = activity.getSystemService(BiometricManager::class.java) ?: return false
        val code = if (Build.VERSION.SDK_INT >= 30) bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        else @Suppress("DEPRECATION") bm.canAuthenticate()
        return code == BiometricManager.BIOMETRIC_SUCCESS
    }

    /** Shows the prompt (call on the main thread) and reports one outcome. */
    fun authenticate(activity: Activity, onDone: (FingerprintUnlock.Outcome) -> Unit) {
        if (enrolled(activity) == false) return onDone(FingerprintUnlock.Outcome.NoneEnrolled)
        val cipher = try {
            ensure()
            val key = keyStore().getKey(ALIAS, null) as SecretKey
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        } catch (_: KeyPermanentlyInvalidatedException) {
            delete()
            return onDone(FingerprintUnlock.Outcome.FingerprintsChanged)
        } catch (e: Exception) {
            // creating a key that needs a biometric fails when none is enrolled (Android 9)
            return onDone(FingerprintUnlock.Outcome.NoneEnrolled)
        }
        val executor = activity.mainExecutor
        var reported = false
        fun report(o: FingerprintUnlock.Outcome) {
            if (!reported) { reported = true; onDone(o) }
        }
        val notConfirmed = "Fingerprint wasn't confirmed. Use your PIN, or try again."
        val prompt = BiometricPrompt.Builder(activity)
            .setTitle("Unlock the wallet")
            .setDescription("Confirm with your fingerprint. Your PIN works too.")
            .setNegativeButton("Use PIN", executor) { _, _ -> report(FingerprintUnlock.Outcome.NotConfirmed(notConfirmed)) }
            .apply { if (Build.VERSION.SDK_INT >= 30) setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG) }
            .build()
        prompt.authenticate(BiometricPrompt.CryptoObject(cipher), CancellationSignal(), executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    // the key only works after a real strong-biometric check: use it once to be sure
                    val ok = try {
                        result.cryptoObject?.cipher?.doFinal(byteArrayOf(1)) != null
                    } catch (_: Exception) {
                        false
                    }
                    report(if (ok) FingerprintUnlock.Outcome.Confirmed else FingerprintUnlock.Outcome.NotConfirmed(notConfirmed))
                }

                override fun onAuthenticationError(code: Int, message: CharSequence) {
                    report(
                        when (code) {
                            BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS -> FingerprintUnlock.Outcome.NoneEnrolled
                            BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT, BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT ->
                                FingerprintUnlock.Outcome.NotConfirmed("Too many tries with the fingerprint. Use your PIN.")
                            BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, BiometricPrompt.BIOMETRIC_ERROR_CANCELED ->
                                FingerprintUnlock.Outcome.NotConfirmed(notConfirmed)
                            else -> FingerprintUnlock.Outcome.NotConfirmed("Fingerprint check didn't work ($message). Use your PIN.")
                        }
                    )
                }
                // onAuthenticationFailed (a finger that didn't match) keeps the prompt open: nothing to do
            })
    }
}
