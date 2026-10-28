package org.jaiaditya.phonemail.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Message
import org.jaiaditya.phonemail.data.Session

/** The traditional view of one email: full headers, the whole body, and Reply / Report spam / Delete; the menu blocks the sender. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageScreen(session: Session, id: Long, back: () -> Unit, reply: (Message) -> Unit, conversationId: Long = 0L) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var m by remember { mutableStateOf<Message?>(null) }
    // Reading a message of a chat counts as being in it (the chat's id comes along from the chat; else once loaded).
    ViewingChat(m?.conversationId ?: conversationId)
    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }

    fun blockSender(msg: Message) = scope.launch {
        error = ""
        runCatching { session.api.block(msg.senderAddress) }
            .onSuccess { notice = context.getString(R.string.blocked_done, msg.senderLabel) }
            .onFailure { error = it.message ?: context.getString(R.string.could_not_update) }
    }

    suspend fun load() {
        runCatching { session.api.message(id) }.onSuccess { m = it }.onFailure { error = it.message ?: context.getString(R.string.could_not_open) }
    }
    LaunchedEffect(id) { load() }

    fun change(vararg flags: Pair<String, Any?>, leave: Boolean = false) = scope.launch {
        runCatching { session.api.setFlags(id, *flags) }
            .onSuccess { if (leave) back() else load() }
            .onFailure { error = it.message ?: context.getString(R.string.could_not_update) }
    }

    StatusBarIcons(darkIcons = false)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {},
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                actions = {
                    m?.let {
                        IconButton(onClick = { change("favourite" to !it.isFavourite) }) {
                            Icon(if (it.isFavourite) Icons.Filled.Star else Icons.Filled.StarBorder, stringResource(if (it.isFavourite) R.string.unstar else R.string.star))
                        }
                        if (!it.isMine && it.senderAddress.isNotEmpty()) {
                            Box {
                                IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.more)) }
                                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.block_name, it.senderLabel), color = Palette.Danger) },
                                        onClick = { menuOpen = false; confirmBlock = true },
                                    )
                                }
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, navigationIconContentColor = Palette.OnBar, actionIconContentColor = Palette.OnBar,
                ),
            )
        },
        bottomBar = {
            m?.let { msg ->
                Column(Modifier.navigationBarsPadding()) {
                    HorizontalDivider(color = Palette.Divider)
                    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                        if (msg.folder != "inbox") {
                            TextButton(onClick = { change("folder" to "inbox", leave = true) }) { Text(stringResource(R.string.move_home), color = Palette.Header) }
                        } else {
                            TextButton(onClick = { reply(msg) }) { Text(stringResource(R.string.reply), color = Palette.Header) }
                            if (!msg.isMine) {
                                TextButton(onClick = { change("folder" to "spam", leave = true) }) { Text(stringResource(R.string.report_spam), color = Palette.Header) }
                            }
                            TextButton(onClick = { change("folder" to "trash", leave = true) }) { Text(stringResource(R.string.delete), color = Palette.Danger) }
                        }
                    }
                }
            }
        },
        containerColor = Palette.Bg,
    ) { inner ->
        val msg = m
        if (msg == null) {
            Box(Modifier.padding(inner).fillMaxSize(), contentAlignment = Alignment.Center) {
                if (error.isNotEmpty()) ErrorText(error) else CircularProgressIndicator(color = Palette.Header)
            }
            return@Scaffold
        }
        fun list(kind: String) = msg.recipients.filter { it.kind == kind }.joinToString(", ") { it.groupName ?: it.address ?: "" }
        Column(
            Modifier.padding(inner).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(msg.subject.ifBlank { stringResource(R.string.no_subject) }, fontSize = 22.sp, color = Palette.Text)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(msg.senderName, msg.senderAddress, msg.senderAvatar, size = 40.dp)
                Column(Modifier.padding(start = 12.dp)) {
                    Text(if (msg.isMine) stringResource(R.string.you) else msg.senderLabel, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, color = Palette.Text)
                    Text(fullTime(msg.sentAt), color = Palette.Muted, fontSize = 13.sp)
                }
            }
            Column {
                Text(stringResource(R.string.from_line, msg.senderAddress), color = Palette.Muted, fontSize = 13.sp)
                list("to").takeIf { it.isNotEmpty() }?.let { Text(stringResource(R.string.to_line, it), color = Palette.Muted, fontSize = 13.sp) }
                list("cc").takeIf { it.isNotEmpty() }?.let { Text(stringResource(R.string.cc_line, it), color = Palette.Muted, fontSize = 13.sp) }
                list("bcc").takeIf { it.isNotEmpty() }?.let { Text(stringResource(R.string.bcc_line, it), color = Palette.Muted, fontSize = 13.sp) }
            }
            SelectionContainer { Text(msg.body, fontSize = 16.sp, lineHeight = 24.sp, color = Palette.Text) }
            if (msg.attachments.isNotEmpty()) {
                Text(stringResource(R.string.attachments), color = Palette.Header, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                AttachmentList(msg.attachments)
            }
            if (notice.isNotEmpty()) Text(notice, color = Palette.Header)
            ErrorText(error)
        }
    }

    val msg = m
    if (confirmBlock && msg != null) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false },
            title = { Text(stringResource(R.string.block_question, msg.senderLabel)) },
            text = { Text(stringResource(R.string.block_explain)) },
            confirmButton = {
                TextButton(onClick = { confirmBlock = false; blockSender(msg) }) { Text(stringResource(R.string.block), color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmBlock = false }) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
            containerColor = Palette.Surface,
        )
    }
}
