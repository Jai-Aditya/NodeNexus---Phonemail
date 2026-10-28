package org.jaiaditya.phonemail.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.SimCard
import androidx.compose.material.icons.filled.Watch
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.ui.res.stringResource
import org.jaiaditya.phonemail.BuildConfig
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.ApiException
import org.jaiaditya.phonemail.data.AuthMode
import org.jaiaditya.phonemail.data.AuthResponse
import org.jaiaditya.phonemail.data.JoinStart
import org.jaiaditya.phonemail.data.Session
import org.jaiaditya.phonemail.sms.SmsCode
import org.jaiaditya.phonemail.sms.rememberPhoneHint

data class Language(val code: String, val name: String, val native: String)

/** The languages the app is translated into (res/values, values-hi, values-ta). */
val LANGUAGES = listOf(
    Language("en", "English", "English"),
    Language("hi", "Hindi", "हिन्दी"),
    Language("ta", "Tamil", "தமிழ்"),
)

/** Screen 1: language. Saved on the device now and to the profile after sign-in. */
@Composable
fun LanguageScreen(initial: String?, onDone: (String) -> Unit) {
    var picked by rememberSaveable { mutableStateOf(initial ?: "en") }
    OnboardingPage(
        title = stringResource(R.string.welcome_title),
        subtitle = stringResource(R.string.choose_language),
        footer = { PrimaryButton(stringResource(R.string.next), onClick = { onDone(picked) }) },
    ) {
        Spacer(Modifier.height(8.dp))
        LANGUAGES.forEach { l ->
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable { picked = l.code }.padding(vertical = 6.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = picked == l.code, onClick = { picked = l.code }, colors = RadioButtonDefaults.colors(selectedColor = Palette.Header))
                Column {
                    Text(l.native, fontSize = 17.sp, color = Palette.Text)
                    if (l.native != l.name) Text(l.name, fontSize = 13.sp, color = Palette.Muted)
                }
            }
        }
    }
}

/** Screen 2: terms. */
@Composable
fun TermsScreen(onAccept: () -> Unit) {
    val uri = LocalUriHandler.current
    OnboardingPage(
        title = stringResource(R.string.terms_title),
        subtitle = stringResource(R.string.terms_subtitle),
        footer = {
            PrimaryButton(stringResource(R.string.terms_agree), onClick = onAccept)
            TextButton(onClick = { uri.openUri("https://mail.phonemail.net/terms") }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.terms_read_full), color = Palette.Header)
            }
        },
    ) {
        Column(
            Modifier.fillMaxWidth().background(Palette.ChipBg, RoundedCornerShape(12.dp)).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            listOf(R.string.terms_1, R.string.terms_2, R.string.terms_3, R.string.terms_4, R.string.terms_5)
                .forEach { Text("•  " + stringResource(it), color = Palette.Text, fontSize = 15.sp) }
        }
    }
}

/** Screen 3: phone number, suggested from the SIM and always editable. */
@Composable
fun PhoneScreen(onNext: (String) -> Unit) {
    var digits by rememberSaveable { mutableStateOf("") }
    val askSim = rememberPhoneHint { digits = it }
    var asked by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!asked) {
            asked = true
            askSim()
        }
    }
    // A 10-digit Indian mobile number, or one of the server's test numbers (55555…, used by app reviewers).
    val valid = Regex("^([6-9]\\d{9}|55555\\d{5})$").matches(digits)
    OnboardingPage(
        title = stringResource(R.string.phone_title),
        subtitle = stringResource(R.string.phone_subtitle),
        footer = { PrimaryButton(stringResource(R.string.next), onClick = { onNext(digits) }, enabled = valid) },
    ) {
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.border(1.dp, Palette.Divider, RoundedCornerShape(4.dp)).height(56.dp).width(64.dp),
                contentAlignment = Alignment.Center,
            ) { Text("+91", fontSize = 18.sp, color = Palette.Text) }
            OutlinedTextField(
                value = digits,
                onValueChange = { v -> digits = v.filter { it.isDigit() }.takeLast(10) },
                placeholder = { Text(stringResource(R.string.phone_placeholder)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                colors = fieldColors(),
                modifier = Modifier.weight(1f),
            )
        }
        TextButton(onClick = askSim) {
            Icon(Icons.Filled.SimCard, contentDescription = null, tint = Palette.Header, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.phone_use_sim), color = Palette.Header)
        }
        if (digits.length == 10) {
            Text(
                stringResource(R.string.phone_your_address, "$digits@${BuildConfig.MAIL_DOMAIN}"),
                color = Palette.Muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

private enum class VerifyView { Choose, Otp, Join, Password }

/**
 * Screen 4: verification, with no phone calls anywhere.
 *  1. A code by SMS (Twilio Verify), read automatically by the SMS Retriever.
 *  2. Otherwise the person texts "JOIN <code>" from this phone; the incoming text proves the number.
 *  3. A password, the brief's own fallback.
 */
@Composable
fun VerifyScreen(session: Session, phone: String, onSignedIn: () -> Unit, onChangeNumber: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf<AuthMode?>(null) }
    var view by rememberSaveable { mutableStateOf(VerifyView.Choose) }
    var code by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var join by remember { mutableStateOf<JoinStart?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var smsJob by remember { mutableStateOf<Job?>(null) }
    // Seconds until another code can be asked for (a text can get lost; the api allows one every 30 s).
    var resendIn by rememberSaveable { mutableStateOf(0) }
    LaunchedEffect(resendIn) {
        if (resendIn > 0) {
            delay(1000)
            resendIn -= 1
        }
    }

    LaunchedEffect(Unit) {
        runCatching { session.api.authMode() }.onSuccess { mode = it }.onFailure { error = it.message ?: context.getString(R.string.error_unreachable) }
    }

    fun done(auth: AuthResponse) {
        smsJob?.cancel()
        session.signIn(auth)
        onSignedIn()
    }

    fun run(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            error = ""
            try {
                block()
            } catch (e: Exception) {
                error = e.message ?: context.getString(R.string.error_generic)
            } finally {
                busy = false
            }
        }
    }

    fun openMessages(j: JoinStart) {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${j.smsTo}")).putExtra("sms_body", j.text)
        try {
            context.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            error = context.getString(R.string.no_messages_app, j.text, j.smsTo)
        }
    }

    suspend fun startJoin() {
        val j = session.api.joinStart(phone)
        join = j
        view = VerifyView.Join
        openMessages(j)
    }

    fun verifyCode(c: String) = run { done(session.api.otpVerify(phone, c)) }

    fun startOtp() = run {
        try {
            // Listen before asking, so a fast SMS is not missed.
            smsJob?.cancel()
            smsJob = scope.launch {
                SmsCode.await(context)?.let {
                    code = it
                    verifyCode(it)
                }
            }
            session.api.otpStart(phone, SmsCode.appHash(context))
            view = VerifyView.Otp
            resendIn = 90
        } catch (e: ApiException) {
            smsJob?.cancel()
            // The trial account cannot text this number (or OTP is off): use the JOIN text instead.
            if ((e.status == 422 || e.status == 501) && mode?.smsJoin == true) startJoin() else throw e
        }
    }

    // While waiting for the JOIN text, ask the api every 2 seconds whether it arrived.
    LaunchedEffect(join?.code) {
        val j = join ?: return@LaunchedEffect
        while (true) {
            delay(2000)
            val st = runCatching { session.api.joinStatus(j.code) }.getOrNull() ?: continue
            when (st.status) {
                "done" -> if (st.token != null && st.user != null) {
                    done(AuthResponse(st.token, st.user)); return@LaunchedEffect
                }
                "expired", "used" -> {
                    error = context.getString(R.string.code_expired); join = null; view = VerifyView.Choose; return@LaunchedEffect
                }
            }
        }
    }

    val m = mode
    OnboardingPage(
        title = stringResource(R.string.verify_title, phone),
        subtitle = stringResource(
            when (view) {
                VerifyView.Otp -> R.string.verify_sub_otp
                VerifyView.Join -> R.string.verify_sub_join
                VerifyView.Password -> R.string.verify_sub_password
                VerifyView.Choose -> R.string.verify_sub_choose
            },
        ),
        footer = { TextButton(onClick = onChangeNumber, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.change_number), color = Palette.Muted) } },
    ) {
        Spacer(Modifier.height(12.dp))
        if (m == null && error.isEmpty()) {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = Palette.Header) }
        }
        when (view) {
            VerifyView.Choose -> if (m != null) {
                if (m.mode == "otp") PrimaryButton(stringResource(R.string.send_code_sms), onClick = { startOtp() }, busy = busy)
                if (m.smsJoin) {
                    PrimaryButton(
                        stringResource(if (m.mode == "otp") R.string.or_verify_text else R.string.verify_text),
                        onClick = { run { startJoin() } }, busy = busy,
                    )
                }
                TextButton(onClick = { view = VerifyView.Password }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.use_password), color = Palette.Header)
                }
            }

            VerifyView.Otp -> {
                OutlinedTextField(
                    value = code,
                    onValueChange = { v -> code = v.filter { it.isDigit() }.take(6) },
                    placeholder = { Text(stringResource(R.string.code_placeholder)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                    textStyle = androidx.compose.ui.text.TextStyle(fontSize = 22.sp, letterSpacing = 8.sp, textAlign = TextAlign.Center),
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                PrimaryButton(stringResource(R.string.verify), onClick = { verifyCode(code) }, enabled = code.length >= 4, busy = busy)
                if (resendIn > 0) {
                    Text(
                        stringResource(R.string.new_code_in, "%d:%02d".format(resendIn / 60, resendIn % 60)),
                        color = Palette.Muted, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    TextButton(onClick = { code = ""; startOtp() }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.new_code), color = Palette.Header)
                    }
                }
                if (m?.smsJoin == true) {
                    TextButton(onClick = { run { startJoin() } }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.didnt_get_code), color = Palette.Header)
                    }
                }
                TextButton(onClick = { error = ""; view = VerifyView.Password }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.use_password), color = Palette.Header)
                }
            }

            VerifyView.Join -> join?.let { j ->
                Column(
                    Modifier.fillMaxWidth().background(Palette.ChipBg, RoundedCornerShape(12.dp)).padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(stringResource(R.string.send_this_text), color = Palette.Muted)
                    Text(j.text, fontSize = 26.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp, color = Palette.Text)
                    Text(stringResource(R.string.to_number, j.smsTo), color = Palette.Muted)
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(color = Palette.Header, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(stringResource(R.string.waiting_text), color = Palette.Muted)
                }
                PrimaryButton(stringResource(R.string.open_messages_again), onClick = { openMessages(j) })
                TextButton(onClick = { view = VerifyView.Password }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.use_password), color = Palette.Header)
                }
            }

            VerifyView.Password -> {
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    placeholder = { Text(stringResource(R.string.password_placeholder)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    colors = fieldColors(),
                    modifier = Modifier.fillMaxWidth(),
                )
                PrimaryButton(stringResource(R.string.continue_), enabled = password.length >= 8, busy = busy, onClick = {
                    run {
                        val auth = try {
                            session.api.passwordLogin(phone, password)
                        } catch (e: ApiException) {
                            if (e.status != 401) throw e
                            // With SMS codes on, the api never creates an account from a password (it answers "Sign up
                            // with a one-time code instead."), so a 401 is a wrong password or a number without one.
                            if (m?.mode == "otp") throw ApiException(401, context.getString(R.string.wrong_password_or_none))
                            // A new number: create the account. A known number with a wrong password: say so.
                            try {
                                session.api.passwordRegister(phone, password)
                            } catch (e2: ApiException) {
                                throw if (e2.status == 409) ApiException(401, context.getString(R.string.wrong_password)) else e2
                            }
                        }
                        done(auth)
                    }
                })
                Text(
                    stringResource(R.string.password_hint),
                    color = Palette.Muted, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth(),
                )
                if (m?.mode == "otp") {
                    TextButton(onClick = { startOtp() }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.send_code_sms_instead), color = Palette.Header)
                    }
                }
                if (m?.smsJoin == true) {
                    TextButton(onClick = { run { startJoin() } }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.verify_text_instead), color = Palette.Header)
                    }
                }
            }
        }
        ErrorText(error)
    }
}

/**
 * After sign-in, once: why PhoneMail would like the contacts, then the system permission request. Continue always
 * leads to the system request (no "Not now", as on iOS after App Review 5.1.1(iv)); the person can deny it there.
 * With it, New chat and search suggest people and chats show contact names (brief: "request all required device
 * permissions at the appropriate stage of onboarding, including … contacts access").
 */
@Composable
fun ContactsScreen(session: Session, onDone: () -> Unit) {
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        session.markContactsAsked()
        if (granted) session.loadContacts()
        onDone()
    }
    OnboardingPage(
        title = stringResource(R.string.contacts_title),
        subtitle = stringResource(R.string.contacts_body),
        footer = {
            PrimaryButton(stringResource(R.string.continue_), onClick = { ask.launch(Manifest.permission.READ_CONTACTS) })
        },
    ) {
        Spacer(Modifier.height(24.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.size(120.dp).background(Palette.ChipOnBg, RoundedCornerShape(60.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Contacts, null, tint = Palette.Header, modifier = Modifier.size(56.dp))
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.background(Palette.ChipBg, RoundedCornerShape(12.dp)).padding(14.dp)) {
            Icon(Icons.Filled.Lock, null, tint = Palette.Muted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.contacts_private), color = Palette.Muted, fontSize = 14.sp)
        }
    }
}

/**
 * After the contacts step (Android 13+ only, once): why PhoneMail would like to notify, then the system request.
 * Skippable; Settings shows whether notifications are on and leads to the phone's settings when they're off.
 */
@Composable
fun NotificationsScreen(session: Session, onDone: () -> Unit) {
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        session.markNotificationsAsked()
        onDone()
    }
    OnboardingPage(
        title = stringResource(R.string.notifications_title),
        subtitle = stringResource(R.string.notifications_body),
        footer = {
            PrimaryButton(stringResource(R.string.notifications_allow), onClick = {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                else { session.markNotificationsAsked(); onDone() }
            })
            TextButton(onClick = { session.markNotificationsAsked(); onDone() }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.not_now), color = Palette.Muted)
            }
        },
    ) {
        Spacer(Modifier.height(24.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            Box(Modifier.size(120.dp).background(Palette.ChipOnBg, RoundedCornerShape(60.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Notifications, null, tint = Palette.Header, modifier = Modifier.size(56.dp))
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.background(Palette.ChipBg, RoundedCornerShape(12.dp)).padding(14.dp)) {
            Icon(Icons.Filled.Watch, null, tint = Palette.Muted, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(10.dp))
            Text(stringResource(R.string.notifications_watch), color = Palette.Muted, fontSize = 14.sp)
        }
    }
}

@Composable
fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = Palette.Header,
    cursorColor = Palette.Header,
    focusedTextColor = Palette.Text,
    unfocusedTextColor = Palette.Text,
)

@Composable
fun CenterLoading() {
    Box(Modifier.fillMaxSize().background(Palette.Bg), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = Palette.Header)
    }
}
