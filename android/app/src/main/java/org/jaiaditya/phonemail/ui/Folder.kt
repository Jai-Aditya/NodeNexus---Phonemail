package org.jaiaditya.phonemail.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Draft
import org.jaiaditya.phonemail.data.Message
import org.jaiaditya.phonemail.data.Session

/** Drafts, Scheduled, Spam or Trash (from the Home menu). Scheduled holds the drafts that have a send time. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FolderScreen(session: Session, name: String, back: () -> Unit, openMessage: (Long) -> Unit, openDraft: (Long) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snack = remember { SnackbarHostState() }
    val ofDrafts = name == "drafts" || name == "scheduled"
    var messages by remember { mutableStateOf<List<Message>>(emptyList()) }
    var drafts by remember { mutableStateOf<List<Draft>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }

    suspend fun load() {
        runCatching {
            if (ofDrafts) drafts = session.api.drafts().filter { (it.sendAt != null) == (name == "scheduled") }
            else messages = session.api.folder(name)
        }.onFailure { error = it.message ?: context.getString(R.string.could_not_load) }
        loaded = true
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { scope.launch { load() } }

    /** Cancel send: the draft stays, back in Drafts. */
    fun unschedule(d: Draft) = scope.launch {
        runCatching { session.api.unschedule(d.id) }
            .onSuccess { load(); snack.showSnackbar(context.getString(R.string.send_cancelled)) }
            .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_update)) }
    }

    StatusBarIcons(darkIcons = false)
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        when (name) {
                            "drafts" -> stringResource(R.string.menu_drafts)
                            "scheduled" -> stringResource(R.string.menu_scheduled)
                            "spam" -> stringResource(R.string.menu_spam)
                            "trash" -> stringResource(R.string.menu_trash)
                            else -> name
                        },
                    )
                },
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, titleContentColor = Palette.OnBar, navigationIconContentColor = Palette.OnBar,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snack) },
        containerColor = Palette.Bg,
    ) { inner ->
        LazyColumn(Modifier.padding(inner).fillMaxSize()) {
            val empty = if (ofDrafts) drafts.isEmpty() else messages.isEmpty()
            if (loaded && empty) {
                item {
                    Text(
                        error.ifEmpty {
                            stringResource(
                                when (name) {
                                    "trash" -> R.string.trash_empty
                                    "scheduled" -> R.string.nothing_scheduled
                                    else -> R.string.nothing_here
                                },
                            )
                        },
                        color = Palette.Muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(48.dp),
                    )
                }
            }
            if (ofDrafts) {
                items(drafts, key = { it.id }) { d ->
                    Row(Modifier.fillMaxWidth().clickable { openDraft(d.id) }.padding(start = 16.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.draft_to, d.recipients.to.joinToString(", ").ifEmpty { stringResource(R.string.no_one_yet) }), color = Palette.Danger, fontSize = 14.sp, maxLines = 1)
                            Text(d.subject.ifBlank { stringResource(R.string.no_subject) }, fontWeight = FontWeight.SemiBold, color = Palette.Text, maxLines = 1)
                            Text(d.body, color = Palette.Muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            d.sendAt?.let { Text(stringResource(R.string.scheduled_for, laterTime(it)), color = Palette.Header, fontSize = 13.sp, fontWeight = FontWeight.SemiBold) }
                        }
                        if (d.sendAt != null) {
                            TextButton(onClick = { unschedule(d) }) { Text(stringResource(R.string.cancel_send), color = Palette.Danger) }
                        } else {
                            IconButton(onClick = { scope.launch { runCatching { session.api.deleteDraft(d.id) }; load() } }) {
                                Icon(Icons.Filled.Delete, stringResource(R.string.discard_draft), tint = Palette.Muted)
                            }
                        }
                    }
                    HorizontalDivider(color = Palette.Divider)
                }
            } else {
                items(messages, key = { it.id }) { m ->
                    Row(Modifier.fillMaxWidth().clickable { openMessage(m.id) }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Avatar(m.senderName, m.senderAddress, m.senderAvatar, size = 40.dp)
                        Column(Modifier.padding(start = 12.dp).weight(1f)) {
                            Row {
                                Text(if (m.isMine) stringResource(R.string.you) else m.senderLabel, fontWeight = FontWeight.SemiBold, color = Palette.Text, maxLines = 1, modifier = Modifier.weight(1f))
                                Text(chatTime(m.sentAt, stringResource(R.string.yesterday)), fontSize = 12.sp, color = Palette.Muted)
                            }
                            Text(m.subject.ifBlank { m.body }, color = Palette.Muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}
