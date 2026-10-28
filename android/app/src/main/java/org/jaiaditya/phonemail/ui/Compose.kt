package org.jaiaditya.phonemail.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Session

/** What the editor was opened for. */
data class ComposeArgs(
    val to: String = "",
    val groupId: Long? = null,
    val conversationId: Long? = null,
    val replyTo: Long? = null,
    val title: String = "",
    val draftId: Long? = null,
) {
    /** Opened from a chat: recipients are locked (brief: no new To/Cc inside a chat). */
    val locked get() = conversationId != null || groupId != null
    val isReply get() = replyTo != null
}

/**
 * The traditional email editor.
 *  - From Home: To / Cc / Bcc are editable; 2+ people in To starts a group chat (brief), which is then mailed.
 *  - From a chat: recipients are locked. Reply: no subject; the reply links to the original.
 *  - Leaving without sending keeps the email as a draft (Home only).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposeScreen(session: Session, args: ComposeArgs, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var to by rememberSaveable { mutableStateOf(args.to) }
    var cc by rememberSaveable { mutableStateOf("") }
    var bcc by rememberSaveable { mutableStateOf("") }
    var groupName by rememberSaveable { mutableStateOf("") }
    var subject by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var draftId by rememberSaveable { mutableStateOf(args.draftId) }
    var sent by remember { mutableStateOf(false) }
    val uploads = rememberUploads(session)
    val pickFiles = rememberFilePicker { uris -> uploads.add(uris) { error = it } }

    // Open a saved draft.
    LaunchedEffect(args.draftId) {
        val id = args.draftId ?: return@LaunchedEffect
        runCatching { session.api.drafts() }.getOrNull()?.firstOrNull { it.id == id }?.let { d ->
            to = d.recipients.to.joinToString(", ")
            cc = d.recipients.cc.joinToString(", ")
            bcc = d.recipients.bcc.joinToString(", ")
            subject = d.subject
            body = d.body
        }
    }

    // Save as a draft when the editor closes without sending.
    val latest by rememberUpdatedState(listOf(to, cc, bcc, subject, body))
    val sentNow by rememberUpdatedState(sent)
    DisposableEffect(Unit) {
        onDispose {
            val (t, c, b, s, text) = latest
            if (!sentNow) uploads.discardAll() // files are not kept with drafts
            if (sentNow || args.locked || args.isReply || (text.isBlank() && s.isBlank())) return@onDispose
            val id = draftId
            session.scope.launch {
                runCatching { session.api.saveDraft(id, splitAddresses(t), splitAddresses(c), splitAddresses(b), s, text) }
            }
        }
    }

    val pickContact = rememberLauncherForActivityResult(PickPhone()) { number ->
        if (number != null) to = (splitAddresses(to) + number).distinct().joinToString(", ")
    }

    val toList = splitAddresses(to)
    val makesGroup = !args.locked && !args.isReply && toList.size > 1

    fun send() = scope.launch {
        if (uploads.busy) {
            error = context.getString(R.string.wait_uploads)
            return@launch
        }
        busy = true
        error = ""
        val files = uploads.ids
        try {
            when {
                args.isReply -> session.api.reply(args.replyTo!!, args.conversationId ?: 0, body, files)
                args.locked -> session.api.send(args.groupId ?: args.to, emptyList(), emptyList(), subject, body, attachmentIds = files)
                else -> {
                    if (toList.isEmpty()) throw IllegalStateException(context.getString(R.string.add_recipient))
                    var target: Any = toList.first()
                    if (makesGroup) {
                        val name = groupName.trim().ifEmpty { toList.joinToString(", ") { it.substringBefore('@') }.take(60) }
                        target = session.api.createGroup(name, toList).id
                    }
                    session.api.send(target, splitAddresses(cc), splitAddresses(bcc), subject, body, draftId, files)
                }
            }
            uploads.sent()
            sent = true
            close()
        } catch (e: Exception) {
            error = e.message ?: context.getString(R.string.could_not_send)
        } finally {
            busy = false
        }
    }

    val plain = TextFieldDefaults.colors(
        focusedContainerColor = Palette.Bg, unfocusedContainerColor = Palette.Bg, focusedTextColor = Palette.Text, unfocusedTextColor = Palette.Text,
        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Palette.Header,
    )

    StatusBarIcons(darkIcons = false)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (args.isReply) R.string.reply else R.string.compose_title)) },
                navigationIcon = { IconButton(onClick = close) { Icon(Icons.Filled.Close, stringResource(R.string.close)) } },
                actions = {
                    IconButton(onClick = pickFiles) { Icon(Icons.Filled.AttachFile, stringResource(R.string.attach)) }
                    IconButton(onClick = { send() }, enabled = (body.isNotBlank() || !uploads.isEmpty) && !busy) {
                        if (busy) CircularProgressIndicator(color = Palette.OnBar, strokeWidth = 2.dp, modifier = Modifier.width(20.dp))
                        else Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, titleContentColor = Palette.OnBar,
                    navigationIconContentColor = Palette.OnBar, actionIconContentColor = Palette.OnBar,
                ),
            )
        },
        containerColor = Palette.Bg,
    ) { inner ->
        Column(Modifier.padding(inner).consumeWindowInsets(inner).imePadding().fillMaxSize().verticalScroll(rememberScrollState())) {
            Field(stringResource(R.string.to)) {
                if (args.locked || args.isReply) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 14.dp)) {
                        Icon(Icons.Filled.Lock, null, tint = Palette.Muted, modifier = Modifier.width(16.dp))
                        Text("  " + args.title.ifEmpty { args.to.ifEmpty { stringResource(R.string.this_chat) } }, color = Palette.Text, fontSize = 16.sp)
                    }
                } else {
                    TextField(
                        value = to, onValueChange = { to = it }, placeholder = { Text(stringResource(R.string.to_placeholder)) },
                        colors = plain, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                        modifier = Modifier.fillMaxWidth(),
                        trailingIcon = { IconButton(onClick = { pickContact.launch(Unit) }) { Icon(Icons.Filled.Contacts, stringResource(R.string.pick_contact), tint = Palette.Header) } },
                    )
                }
            }
            if (!args.locked && !args.isReply) {
                Field(stringResource(R.string.cc)) { TextField(cc, { cc = it }, colors = plain, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth()) }
                Field(stringResource(R.string.bcc)) { TextField(bcc, { bcc = it }, colors = plain, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth()) }
            }
            if (makesGroup) {
                Column(
                    Modifier.padding(12.dp).fillMaxWidth().background(Palette.ChipOnBg, RoundedCornerShape(10.dp)).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(stringResource(R.string.group_note, toList.size), color = Palette.Text, fontSize = 14.sp)
                    TextField(groupName, { groupName = it }, placeholder = { Text(stringResource(R.string.group_name)) }, singleLine = true, colors = plain, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth())
                }
            }
            if (!args.isReply) Field(stringResource(R.string.subject)) { TextField(subject, { subject = it }, colors = plain, singleLine = true, modifier = Modifier.fillMaxWidth()) }
            TextField(
                value = body, onValueChange = { body = it },
                placeholder = { Text(stringResource(if (args.isReply) R.string.write_reply else R.string.compose_email)) },
                colors = plain, modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp),
            )
            PendingFiles(uploads, Modifier.padding(horizontal = 12.dp, vertical = 8.dp))
            ErrorText(error)
        }
    }
}

@Composable
private fun Field(label: String, content: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = Palette.Muted, fontSize = 15.sp, modifier = Modifier.width(64.dp))
        Column(Modifier.weight(1f)) { content() }
    }
    HorizontalDivider(color = Palette.Divider)
}

/**
 * Picks one phone number from Contacts. The system picker grants access to just that row, so no
 * contacts permission is needed (brief: ask for permissions only when needed).
 */
private class PickPhone : ActivityResultContract<Unit, String?>() {
    private var context: Context? = null
    override fun createIntent(context: Context, input: Unit): Intent {
        this.context = context.applicationContext
        return Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI)
    }

    override fun parseResult(resultCode: Int, intent: Intent?): String? {
        val uri: Uri = intent?.data ?: return null
        val ctx = context ?: return null
        return ctx.contentResolver.query(uri, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER), null, null, null)?.use { c ->
            if (c.moveToFirst()) tenDigits(c.getString(0) ?: "") else null
        }
    }
}
