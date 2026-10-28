package org.jaiaditya.phonemail.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.EmojiEmotions
import androidx.compose.material.icons.filled.LocalFlorist
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jaiaditya.phonemail.BuildConfig
import org.jaiaditya.phonemail.push.Push
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.BlockedPerson
import org.jaiaditya.phonemail.data.Session
import org.jaiaditya.phonemail.data.StockAvatars
import org.jaiaditya.phonemail.data.User
import java.io.ByteArrayOutputStream

/** Used when the stock list can't be fetched (offline); the server checks the choice either way. */
private val STOCK_FALLBACK = StockAvatars(
    glyphs = listOf("🦚", "🐘", "🐯", "🪷", "🌺", "🥭", "🏏", "🪁", "🎵", "📚", "🚀", "⭐", "🌙", "☕", "🐬", "🦉"),
    colors = listOf("#4B3FB0", "#1f6feb", "#8250df", "#d1242f", "#bf5700", "#9a6700", "#0e7490", "#be185d"),
)

/** Profile and settings: picture, name, language, appearance, notifications, password, alias addresses, sign out. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(session: Session, back: () -> Unit, onLanguage: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val uri = LocalUriHandler.current
    val user by session.user.collectAsState()
    val theme by session.theme.collectAsState()
    var name by remember { mutableStateOf(user?.displayName.orEmpty()) }
    var alias by remember { mutableStateOf("") }
    var currentPw by remember { mutableStateOf("") }
    var newPw by remember { mutableStateOf("") }
    var newPw2 by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var pickLanguage by remember { mutableStateOf(false) }
    var glyphSheet by remember { mutableStateOf(false) }
    var pictureBusy by remember { mutableStateOf(false) }
    var stylePhoto by remember { mutableStateOf<Bitmap?>(null) }
    var blocked by remember { mutableStateOf<List<BlockedPerson>>(emptyList()) }
    var deleting by remember { mutableStateOf(false) }
    var notifyOn by remember { mutableStateOf(Push.enabled(context)) }
    // Checked again on coming back from the phone's settings.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { notifyOn = Push.enabled(context) }

    LaunchedEffect(Unit) {
        runCatching { session.refreshUser() }
        runCatching { session.api.blocks() }.onSuccess { blocked = it }
    }

    fun act(done: Int, block: suspend () -> Unit) = scope.launch {
        error = ""
        message = ""
        runCatching { block(); session.refreshUser() }
            .onSuccess { message = context.getString(done) }
            .onFailure { error = it.message ?: context.getString(R.string.could_not_save) }
    }

    fun picture(done: Int, block: suspend () -> org.jaiaditya.phonemail.data.User) = scope.launch {
        pictureBusy = true
        error = ""
        message = ""
        runCatching { block() }
            .onSuccess { session.setUser(it.copy(aliases = user?.aliases.orEmpty())); message = context.getString(done) }
            .onFailure { error = it.message ?: context.getString(R.string.could_not_save) }
        pictureBusy = false
    }

    val pickPhoto = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { picked ->
        if (picked != null) scope.launch {
            // Cropped and styled on the phone; only the chosen picture is uploaded.
            runCatching { squareBitmap(context, picked) }
                .onSuccess { stylePhoto = it }
                .onFailure { error = it.message ?: context.getString(R.string.could_not_open) }
        }
    }

    StatusBarIcons(darkIcons = false)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.menu_settings)) },
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, titleContentColor = Palette.OnBar, navigationIconContentColor = Palette.OnBar,
                ),
            )
        },
        containerColor = Palette.Bg,
    ) { inner ->
        val u = user ?: return@Scaffold
        Column(
            Modifier.padding(inner).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(contentAlignment = Alignment.Center) {
                    Avatar(u.displayName, u.address, u.avatar, size = 96.dp)
                    if (pictureBusy) CircularProgressIndicator(color = Color.White, strokeWidth = 3.dp, modifier = Modifier.size(40.dp))
                }
                Column(Modifier.padding(start = 16.dp)) {
                    Text(u.displayName ?: stringResource(R.string.add_your_name), fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text)
                    Text(u.address, color = Palette.Muted)
                }
            }

            Section(stringResource(R.string.profile_picture))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                PictureChoice(Icons.Filled.AddAPhoto, stringResource(R.string.upload_photo), Modifier.weight(1f)) {
                    pickPhoto.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }
                PictureChoice(Icons.Filled.EmojiEmotions, stringResource(R.string.pick_glyph), Modifier.weight(1f)) { glyphSheet = true }
                PictureChoice(Icons.Filled.LocalFlorist, stringResource(R.string.use_bloom), Modifier.weight(1f)) {
                    picture(R.string.bloom_restored) { session.api.resetAvatar() }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(44.dp).clip(CircleShape)) {
                    NumberBloom.digits(u.address)?.let { BloomAvatar(it, NumberBloom.centreLabel(u.displayName, it), 44.dp) }
                }
                Text(stringResource(R.string.bloom_line), color = Palette.Muted, fontSize = 13.sp, modifier = Modifier.padding(start = 12.dp))
            }

            Section(stringResource(R.string.your_name))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(name, { name = it }, singleLine = true, placeholder = { Text(stringResource(R.string.name_placeholder)) }, colors = fieldColors(), modifier = Modifier.weight(1f))
                TextButton(onClick = { act(R.string.name_saved) { session.api.updateMe("displayName" to name.trim()) } }) { Text(stringResource(R.string.save), color = Palette.Header) }
            }

            Section(stringResource(R.string.language))
            val lang = LANGUAGES.firstOrNull { it.code == (session.language ?: u.language) }
            Row(Modifier.fillMaxWidth().clickable { pickLanguage = true }.padding(vertical = 8.dp)) {
                Text(lang?.let { if (it.native == it.name) it.native else "${it.native} (${it.name})" } ?: u.language, color = Palette.Text, modifier = Modifier.weight(1f))
                Text(stringResource(R.string.change), color = Palette.Header)
            }

            // Kept on this phone; the whole app changes at once.
            Section(stringResource(R.string.appearance))
            Column {
                listOf(THEME_SYSTEM to R.string.theme_system, THEME_LIGHT to R.string.theme_light, THEME_DARK to R.string.theme_dark).forEach { (mode, label) ->
                    Row(
                        Modifier.fillMaxWidth().clickable { session.chooseTheme(mode) }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = theme == mode, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = Palette.Header))
                        Text("  " + stringResource(label), color = Palette.Text)
                    }
                }
            }

            // New-mail notifications: on, or off with a way to the phone's settings (Android decides; the app can't switch it on).
            Section(stringResource(R.string.notifications))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(if (notifyOn) R.string.notifications_on else R.string.notifications_off),
                    color = if (notifyOn) Palette.Text else Palette.Muted, fontSize = 14.sp, modifier = Modifier.weight(1f),
                )
                if (!notifyOn) {
                    TextButton(onClick = {
                        runCatching { context.startActivity(Push.settingsIntent(context)) }
                            .onFailure { error = context.getString(R.string.could_not_open) }
                    }) { Text(stringResource(R.string.open_settings), color = Palette.Header) }
                }
            }

            Section(stringResource(if (u.hasPassword) R.string.change_password else R.string.set_a_password))
            Text(stringResource(if (u.hasPassword) R.string.pw_forgot_hint else R.string.pw_sms_hint), color = Palette.Muted, fontSize = 14.sp)
            if (u.hasPassword) {
                OutlinedTextField(
                    currentPw, { currentPw = it }, singleLine = true, placeholder = { Text(stringResource(R.string.current_password)) },
                    visualTransformation = PasswordVisualTransformation(), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
                )
            }
            OutlinedTextField(
                newPw, { newPw = it }, singleLine = true, placeholder = { Text(stringResource(R.string.new_password)) },
                visualTransformation = PasswordVisualTransformation(), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                newPw2, { newPw2 = it }, singleLine = true, placeholder = { Text(stringResource(R.string.new_password_again)) },
                visualTransformation = PasswordVisualTransformation(), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
            )
            TextButton(
                enabled = newPw.length >= 8,
                onClick = {
                    if (newPw != newPw2) {
                        error = context.getString(R.string.pw_mismatch); message = ""
                    } else {
                        val cur = currentPw.ifEmpty { null }
                        val next = newPw
                        act(if (u.hasPassword) R.string.password_changed else R.string.password_set) {
                            session.api.changePassword(cur, next)
                            currentPw = ""; newPw = ""; newPw2 = ""
                        }
                    }
                },
            ) { Text(stringResource(if (u.hasPassword) R.string.change_password else R.string.set_password), color = Palette.Header) }

            Section(stringResource(R.string.aliases_title))
            Text(stringResource(R.string.aliases_hint), color = Palette.Muted, fontSize = 14.sp)
            u.aliases.forEach { a ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(a, color = Palette.Text, modifier = Modifier.weight(1f))
                    IconButton(onClick = { act(R.string.alias_removed) { session.api.removeAlias(a) } }) {
                        Icon(Icons.Filled.Delete, stringResource(R.string.remove_alias, a), tint = Palette.Muted)
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    alias, { alias = it.trim().lowercase() }, singleLine = true, colors = fieldColors(), modifier = Modifier.weight(1f),
                    placeholder = { Text("new.alias") }, suffix = { Text("@${BuildConfig.MAIL_DOMAIN}", color = Palette.Muted) },
                )
                TextButton(onClick = { act(R.string.alias_added) { session.api.addAlias(alias); alias = "" } }, enabled = alias.length >= 3) {
                    Text(stringResource(R.string.add), color = Palette.Header)
                }
            }

            Section(stringResource(R.string.blocked_people))
            Text(stringResource(R.string.blocked_hint), color = Palette.Muted, fontSize = 14.sp)
            if (blocked.isEmpty()) Text(stringResource(R.string.no_one_blocked), color = Palette.Muted)
            blocked.forEach { p ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(p.label, color = Palette.Text)
                        if (p.name != null) Text(p.address, color = Palette.Muted, fontSize = 13.sp)
                    }
                    TextButton(onClick = {
                        scope.launch {
                            error = ""
                            message = ""
                            runCatching { session.api.unblock(p.userId) }
                                .onSuccess { blocked = blocked - p; message = context.getString(R.string.unblocked_done, p.label) }
                                .onFailure { error = it.message ?: context.getString(R.string.could_not_save) }
                        }
                    }) { Text(stringResource(R.string.unblock), color = Palette.Header) }
                }
            }

            if (message.isNotEmpty()) Text(message, color = Palette.Header)
            ErrorText(error)

            HorizontalDivider(color = Palette.Divider)
            TextButton(onClick = { uri.openUri("https://mail.phonemail.net/terms") }) { Text(stringResource(R.string.terms_link), color = Palette.Header) }
            TextButton(onClick = { uri.openUri("https://phonemail.net/docs/manual/") }) { Text(stringResource(R.string.help), color = Palette.Header) }
            // Signing out returns to the phone-number screen (MainActivity watches the session).
            TextButton(onClick = { session.signOut() }) { Text(stringResource(R.string.sign_out), color = Palette.Danger) }
            TextButton(onClick = { deleting = true }) { Text(stringResource(R.string.delete_account), color = Palette.Danger) }
            Text(stringResource(R.string.version, BuildConfig.VERSION_NAME), color = Palette.Muted, fontSize = 12.sp)
        }
    }

    if (deleting) user?.let { DeleteAccountDialog(session, it, onDismiss = { deleting = false }) }

    if (pickLanguage) {
        AlertDialog(
            onDismissRequest = { pickLanguage = false },
            confirmButton = { TextButton(onClick = { pickLanguage = false }) { Text(stringResource(R.string.close), color = Palette.Header) } },
            title = { Text(stringResource(R.string.language)) },
            text = {
                Column {
                    LANGUAGES.forEach { l ->
                        Row(
                            Modifier.fillMaxWidth().clickable {
                                pickLanguage = false
                                // Saved to the profile, then the app redraws in the new language at once.
                                session.scope.launch { runCatching { session.setUser(session.api.updateMe("language" to l.code)) } }
                                onLanguage(l.code)
                            }.padding(vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = (session.language ?: user?.language) == l.code, onClick = null, colors = RadioButtonDefaults.colors(selectedColor = Palette.Header))
                            Text("  ${l.native}", color = Palette.Text)
                        }
                    }
                }
            },
        )
    }

    stylePhoto?.let { photo ->
        StylePicker(photo, onCancel = { stylePhoto = null }) { chosen ->
            stylePhoto = null
            picture(R.string.photo_saved) { session.api.uploadAvatarPhoto(jpeg(chosen)) }
        }
    }

    if (glyphSheet) {
        GlyphSheet(session, user?.avatar, onDismiss = { glyphSheet = false }) { glyph, color ->
            glyphSheet = false
            // The api stores pictures only, so the glyph on its colour is drawn into one here.
            picture(R.string.picture_saved) { session.api.uploadAvatar(glyphPng(glyph, color), "image/png") }
        }
    }
}

/**
 * Deleting the account (Google Play and App Store rules): confirmed with the password, or with an SMS code when the
 * account has none, so a borrowed unlocked phone isn't enough. Afterwards the app is signed out.
 */
@Composable
private fun DeleteAccountDialog(session: Session, u: User, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var codeSent by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val ready = if (u.hasPassword) password.isNotEmpty() else code.length >= 4

    fun run(work: suspend () -> Unit) = scope.launch {
        busy = true
        error = ""
        runCatching { work() }.onFailure { error = it.message ?: context.getString(R.string.could_not_save) }
        busy = false
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.delete_account)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.delete_warning), color = Palette.Text, fontSize = 14.sp)
                if (u.hasPassword) {
                    OutlinedTextField(
                        password, { password = it }, singleLine = true, placeholder = { Text(stringResource(R.string.your_password)) },
                        visualTransformation = PasswordVisualTransformation(), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    TextButton(enabled = !busy, onClick = { run { session.api.otpStart(u.phone, null); codeSent = true } }) {
                        Text(stringResource(R.string.send_code_sms), color = Palette.Header)
                    }
                    if (codeSent) {
                        OutlinedTextField(
                            code, { code = it.filter(Char::isDigit) }, singleLine = true, placeholder = { Text(stringResource(R.string.code_placeholder)) },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword), colors = fieldColors(), modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
                Text(stringResource(if (u.hasPassword) R.string.confirm_with_password else R.string.confirm_with_code), color = Palette.Muted, fontSize = 13.sp)
                ErrorText(error)
            }
        },
        confirmButton = {
            TextButton(enabled = ready && !busy, onClick = {
                run {
                    // The api stops pushing to this phone first (while the sign-in still works); back on if deleting fails.
                    session.forgetPushDevice()
                    runCatching { session.api.deleteAccount(password.takeIf { u.hasPassword }, code.takeIf { !u.hasPassword }) }
                        .onFailure { session.registerPush(); throw it }
                    onDismiss()
                    session.signOut() // MainActivity returns to the phone-number screen
                }
            }) { Text(stringResource(R.string.delete_my_account), color = Palette.Danger, fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
        containerColor = Palette.Surface,
    )
}

@Composable
private fun PictureChoice(icon: ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
    Column(
        modifier.clip(RoundedCornerShape(12.dp)).background(Palette.ChipBg).clickable(onClick = onClick).padding(vertical = 12.dp, horizontal = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, null, tint = Palette.Header)
        Spacer(Modifier.height(6.dp))
        Text(label, color = Palette.Text, fontSize = 12.sp, lineHeight = 15.sp, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/** The stock glyphs and colours, with a live preview; Save sets it as the profile picture. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun GlyphSheet(session: Session, current: String?, onDismiss: () -> Unit, onSave: (String, String) -> Unit) {
    var stock by remember { mutableStateOf(STOCK_FALLBACK) }
    LaunchedEffect(Unit) { runCatching { session.api.stockAvatars() }.onSuccess { if (it.glyphs.isNotEmpty()) stock = it } }
    val start = current?.takeIf { it.startsWith("glyph:") }?.removePrefix("glyph:")
    var glyph by remember { mutableStateOf(start?.substringBeforeLast(':') ?: STOCK_FALLBACK.glyphs.first()) }
    var color by remember { mutableStateOf(start?.substringAfterLast(':') ?: STOCK_FALLBACK.colors.first()) }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = Palette.Surface) {
        Column(Modifier.padding(horizontal = 20.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(stringResource(R.string.pick_glyph), fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text)
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Box(Modifier.size(96.dp).clip(CircleShape)) {
                    parseGlyph("glyph:$glyph:$color")?.let { GlyphAvatar(it.first, it.second, 96.dp) }
                }
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                stock.glyphs.forEach { g ->
                    Box(
                        Modifier.size(48.dp).clip(CircleShape)
                            .background(if (g == glyph) Palette.ChipOnBg else Palette.ChipBg)
                            .border(2.dp, if (g == glyph) Palette.Header else Color.Transparent, CircleShape)
                            .clickable { glyph = g },
                        contentAlignment = Alignment.Center,
                    ) { Text(g, fontSize = 24.sp) }
                }
            }
            Text(stringResource(R.string.glyph_colour), color = Palette.Muted, fontSize = 14.sp)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                stock.colors.forEach { c ->
                    val col = parseGlyph("glyph:x:$c")?.second ?: Palette.Header
                    Box(
                        Modifier.size(36.dp).clip(CircleShape).background(col)
                            .border(3.dp, if (c.equals(color, true)) Palette.Text else Color.Transparent, CircleShape)
                            .clickable { color = c },
                    )
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel), color = Palette.Muted) }
                TextButton(onClick = { onSave(glyph, color) }) { Text(stringResource(R.string.save), color = Palette.Header, fontWeight = FontWeight.SemiBold) }
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}

/** The picked photo, centre-cropped to a square and scaled to 512×512 (styles work on this). */
private suspend fun squareBitmap(context: Context, uri: Uri): Bitmap = withContext(Dispatchers.Default) {
    val src: Bitmap = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(context.contentResolver, uri)) { decoder, info, _ ->
            val short = minOf(info.size.width, info.size.height)
            if (short > 1024) decoder.setTargetSampleSize(short / 1024)
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
    } else {
        context.contentResolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) }
    }
    val side = minOf(src.width, src.height)
    val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
    Bitmap.createScaledBitmap(square, 512, 512, true).copy(Bitmap.Config.ARGB_8888, false)
}

/** 512×512 JPEG at quality 85 (the server keeps up to 2 MB). */
private suspend fun jpeg(b: Bitmap): ByteArray = withContext(Dispatchers.Default) {
    ByteArrayOutputStream().use { out ->
        b.compress(Bitmap.CompressFormat.JPEG, 85, out)
        out.toByteArray()
    }
}

@Composable
private fun Section(title: String) = Text(title, color = Palette.Header, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)

/** A glyph centred on its colour, as a 512 px PNG profile picture (shown in a circle everywhere). */
private fun glyphPng(glyph: String, color: String): ByteArray {
    val size = 512
    val bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = android.graphics.Canvas(bmp)
    canvas.drawColor(runCatching { android.graphics.Color.parseColor(color) }.getOrDefault(0xFF4B3FB0.toInt()))
    val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
        textSize = size * 0.55f
        textAlign = android.graphics.Paint.Align.CENTER
    }
    canvas.drawText(glyph, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2f, paint)
    return java.io.ByteArrayOutputStream().also { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
}