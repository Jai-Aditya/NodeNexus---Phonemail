package org.jaiaditya.phonemail.sms

import android.app.Activity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import com.google.android.gms.auth.api.identity.GetPhoneNumberHintIntentRequest
import com.google.android.gms.auth.api.identity.Identity
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Google's Phone Number Hint: a system sheet listing the SIM's number(s). Picking one fills the field;
 * the person can always edit it (brief: "auto-detected, editable"). Needs no permission.
 * Returns a function that opens the sheet; [onNumber] gets the last 10 digits.
 */
@Composable
fun rememberPhoneHint(onNumber: (String) -> Unit): () -> Unit {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { result ->
        if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
        runCatching { Identity.getSignInClient(context).getPhoneNumberFromIntent(result.data) }
            .getOrNull()
            ?.filter { it.isDigit() }
            ?.takeLast(10)
            ?.let(onNumber)
    }
    return {
        scope.launch {
            runCatching {
                val pending = Identity.getSignInClient(context)
                    .getPhoneNumberHintIntent(GetPhoneNumberHintIntentRequest.builder().build())
                    .await()
                launcher.launch(IntentSenderRequest.Builder(pending).build())
            } // no SIM or no Play services: the person types the number
        }
    }
}
