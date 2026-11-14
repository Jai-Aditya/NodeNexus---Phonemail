package org.jaiaditya.phonemail.data

import android.content.Context
import android.content.ContextWrapper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume

/**
 * Sign in with a fingerprint or face, when the person turns it on: the account's password is encrypted with an
 * Android Keystore key that only unlocks after a strong biometric match (this device only; Android destroys the key
 * when a fingerprint or face is added). The number and the encrypted password are in SharedPreferences, so the phone
 * screen can offer the button without asking first. One account per device: turning it on for another number
 * replaces the first.
 */
object Biometric {
    private const val KEY = "phonemail_biometric"
    private const val PREFS = "biometric"

    /**
     * The phone screen offers the fingerprint/face sheet by itself once, when the app opens signed out; not again
     * that run, and not after a sign-in (so signing out never pops it up straight away). Set by Session.signIn.
     */
    @Volatile var offered = false

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** A strong fingerprint or face is set up on this device. */
    fun available(context: Context) =
        BiometricManager.from(context).canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

    /** The number whose password is saved, if any. */
    fun phone(context: Context): String? = prefs(context).getString("phone", null)

    /** Asks for the fingerprint or face, then saves the password. False when cancelled or the device can't. */
    suspend fun save(context: Context, phone: String, password: String, title: String, cancel: String): Boolean {
        val activity = context.fragmentActivity() ?: return false
        val cipher = runCatching {
            forget(context)
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, newKey()) }
        }.getOrNull() ?: return false
        val unlocked = prompt(activity, cipher, title, phone, cancel) ?: return false
        val sealed = runCatching { unlocked.doFinal(password.toByteArray()) }.getOrNull() ?: return false
        prefs(context).edit()
            .putString("phone", phone)
            .putString("iv", Base64.encodeToString(unlocked.iv, Base64.NO_WRAP))
            .putString("password", Base64.encodeToString(sealed, Base64.NO_WRAP))
            .apply()
        return true
    }

    /**
     * The saved password, after the fingerprint or face matches. Null when cancelled; when Android has destroyed the
     * key (biometrics changed) it is forgotten here too.
     */
    suspend fun password(context: Context, title: String, cancel: String): String? {
        val activity = context.fragmentActivity() ?: return null
        val p = prefs(context)
        val phone = p.getString("phone", null) ?: return null
        val iv = p.getString("iv", null)?.let { Base64.decode(it, Base64.NO_WRAP) }
        val sealed = p.getString("password", null)?.let { Base64.decode(it, Base64.NO_WRAP) }
        val key = runCatching { keyStore().getKey(KEY, null) as SecretKey? }.getOrNull()
        if (iv == null || sealed == null || key == null) {
            forget(context)
            return null
        }
        val cipher = try {
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            forget(context)
            return null
        }
        val unlocked = prompt(activity, cipher, title, phone, cancel) ?: return null
        return runCatching { String(unlocked.doFinal(sealed)) }.getOrNull()
    }

    fun forget(context: Context) {
        prefs(context).edit().clear().apply()
        runCatching { keyStore().deleteEntry(KEY) }
    }

    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun newKey(): SecretKey {
        val spec = KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
    }

    /** The system's fingerprint/face sheet; the cipher it unlocks, or null when cancelled or failed. */
    private suspend fun prompt(activity: FragmentActivity, cipher: Cipher, title: String, phone: String, cancel: String): Cipher? =
        suspendCancellableCoroutine { cont ->
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    if (cont.isActive) cont.resume(result.cryptoObject?.cipher)
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    if (cont.isActive) cont.resume(null)
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle("+91 $phone")
                .setNegativeButtonText(cancel)
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .build()
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
            cont.invokeOnCancellation { prompt.cancelAuthentication() }
        }
}

/** The activity behind a (possibly language-wrapped) Compose context. */
tailrec fun Context.fragmentActivity(): FragmentActivity? = when (this) {
    is FragmentActivity -> this
    is ContextWrapper -> baseContext.fragmentActivity()
    else -> null
}
