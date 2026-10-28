package org.jaiaditya.phonemail.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.content.ContextCompat
import com.google.android.gms.auth.api.phone.SmsRetriever
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import java.security.MessageDigest
import kotlin.coroutines.resume

/**
 * Reads the one-time code from the incoming SMS automatically (Google's SMS Retriever API).
 * No SMS permission is needed: Play services hands over only a message that ends with this app's
 * 11-character hash, which Twilio Verify adds when the api passes `AppHash`.
 */
object SmsCode {
    private val CODE = Regex("""\b(\d{4,8})\b""")

    /** Starts listening, then suspends until a code arrives (null on timeout, about 5 minutes). */
    suspend fun await(context: Context): String? {
        try {
            SmsRetriever.getClient(context).startSmsRetriever().await()
        } catch (e: Exception) {
            return null // no Play services (some emulators): the person types the code
        }
        return suspendCancellableCoroutine { cont ->
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(ctx: Context, intent: Intent) {
                    if (intent.action != SmsRetriever.SMS_RETRIEVED_ACTION) return
                    val extras = intent.extras ?: return
                    @Suppress("DEPRECATION")
                    val status = extras.get(SmsRetriever.EXTRA_STATUS) as? Status
                    val code = if (status?.statusCode == CommonStatusCodes.SUCCESS) {
                        extras.getString(SmsRetriever.EXTRA_SMS_MESSAGE)?.let { CODE.find(it)?.groupValues?.get(1) }
                    } else null
                    runCatching { context.unregisterReceiver(this) }
                    if (cont.isActive) cont.resume(code)
                }
            }
            ContextCompat.registerReceiver(
                context, receiver, IntentFilter(SmsRetriever.SMS_RETRIEVED_ACTION),
                SmsRetriever.SEND_PERMISSION, null, ContextCompat.RECEIVER_EXPORTED,
            )
            cont.invokeOnCancellation { runCatching { context.unregisterReceiver(receiver) } }
        }
    }

    /** The 11-character hash of this app's package and signing key that the SMS must end with. */
    fun appHash(context: Context): String? = runCatching {
        val pm = context.packageManager
        val pkg = context.packageName
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures
        }
        val sig = signatures?.firstOrNull() ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update("$pkg ${sig.toCharsString()}".toByteArray(Charsets.UTF_8))
        Base64.encodeToString(digest.digest().copyOfRange(0, 9), Base64.NO_PADDING or Base64.NO_WRAP).substring(0, 11)
    }.getOrNull()
}
