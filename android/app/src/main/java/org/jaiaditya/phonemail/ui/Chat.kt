package org.jaiaditya.phonemail.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Api
import org.jaiaditya.phonemail.data.Conversation
import org.jaiaditya.phonemail.data.Message
import org.jaiaditya.phonemail.data.Session
import org.jaiaditya.phonemail.push.Push
import kotlin.math.roundToInt

/**
 * While a screen of this chat (the chat, or one of its messages) is on screen, its new mail isn't notified and a
 * notification already showing for it goes. Each screen sets and clears its own entry (see Viewing).
 */
@Composable
fun ViewingChat(conversationId: Long) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(conversationId, lifecycle) {
        val owner = Any()
        val watch = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && conversationId != 0L) {
                Push.viewing.enter(owner, conversationId)
                Push.cancel(context, conversationId)
            }
            if (event == Lifecycle.Event.ON_PAUSE) Push.viewing.leave(owner)
        }
        lifecycle.addObserver(watch)
        onDispose {
            lifecycle.removeObserver(watch)
            Push.viewing.leave(owner)
        }
    }
}

/** The newest email in a chat, by time (then id). */
fun newestMessage(messages: List<Message>): Message? =
    messages.maxWithOrNull(compareBy<Message>({ parseTime(it.sentAt)?.toInstant() }, { it.id }))

/**
 * Reply by default: the email the chat box answers when the user hasn't picked one, as if it had been swiped. The
 * newest email, unless it is the user's own, they can't write here, or they cancelled replying to it ([dismissed]: the
 * newest id when they did). Null: a new email.
 */
fun autoReplyTarget(messages: List<Message>, canWrite: Boolean = true, dismissed: Long? = null): Message? =
    newestMessage(messages)?.takeIf { canWrite && !it.isMine && it.id != dismissed }

/**
 * A chat: every email between you and one person (or one group), WhatsApp-style.
 * [conversationId] 0 = a new chat with [peer]; the first send creates it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    session: Session,
    conversationId: Long,
    isGroup: Boolean,
    title: String,
    peer: String,
    peerName: String? = null,
    peerAvatar: String? = null,
    back: () -> Unit,
    openMessage: (Long) -> Unit,
    openEditor: (conversationId: Long, replyTo: Long?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val snack = remember { SnackbarHostState() }
    val uploads = rememberUploads(session)
    val pickFiles = rememberFilePicker { uris -> uploads.add(uris) { msg -> scope.launch { snack.showSnackbar(msg) } } }
    val haptics = LocalHapticFeedback.current
    var convId by rememberSaveable { mutableStateOf(conversationId) }
    var messages by remember { mutableStateOf<List<Message>>(emptyList()) }
    var loading by remember { mutableStateOf(false) }
    var hasOlder by remember { mutableStateOf(true) }
    var subject by rememberSaveable { mutableStateOf("") }
    var body by rememberSaveable { mutableStateOf("") }
    var replyTo by remember { mutableStateOf<Message?>(null) }
    var pickedReply by remember { mutableStateOf(false) } // replyTo was swiped, not set by autoReplyTarget
    var dismissedReply by rememberSaveable { mutableStateOf<Long?>(null) } // the newest email when the user cancelled a reply
    var sending by remember { mutableStateOf(false) }
    var blockedId by remember { mutableStateOf<Long?>(null) } // the peer's user id while they are blocked
    var menuOpen by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }
    var chat by remember { mutableStateOf<Conversation?>(null) } // archived, muted, snoozed, its folder (for the menu)
    var snoozing by remember { mutableStateOf(false) }
    var moving by remember { mutableStateOf(false) }
    val list = rememberLazyListState()

    suspend fun loadChat() {
        if (convId != 0L) runCatching { session.api.conversation(convId) }.onSuccess { chat = it }
    }
    LaunchedEffect(convId) { loadChat() }

    /** The same chat actions as the web app's menu, confirmed in the snackbar (with Undo where it can be put back). */
    fun act(action: String, done: String, until: String? = null, folderId: Long? = null) {
        if (convId == 0L) return
        val undo = undoFor(action, "", listOf(chat ?: Conversation(convId, if (isGroup) "group" else "direct")))
        scope.launch { applyChatAction(session, snack, context, listOf(convId), action, done, undo, until, folderId) { loadChat() } }
    }

    LaunchedEffect(peer) {
        if (!isGroup && peer.isNotEmpty()) {
            runCatching { session.api.blocks() }.onSuccess { l -> blockedId = l.firstOrNull { Api.sameAddress(it.address, peer) }?.userId }
        }
    }

    /** Blocking sends their future direct mail to Spam; mail already here stays. */
    fun toggleBlock() = scope.launch {
        runCatching {
            val id = blockedId
            if (id != null) {
                session.api.unblock(id)
                blockedId = null
                context.getString(R.string.unblocked_done, title)
            } else {
                blockedId = session.api.block(peer).userId
                context.getString(R.string.blocked_done, title)
            }
        }.onSuccess { snack.showSnackbar(it) }
            .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_save)) }
    }

    /**
     * Reply by default: unless the user picked an email or has typed (or attached) something, the box replies to the
     * newest email from someone else (autoReplyTarget), following new mail as it comes.
     */
    fun followNewest() {
        if (pickedReply || body.isNotEmpty() || subject.isNotEmpty() || !uploads.isEmpty) return
        replyTo = autoReplyTarget(messages, canWrite = blockedId == null, dismissed = dismissedReply)
    }
    LaunchedEffect(blockedId) { followNewest() }

    suspend fun load() {
        if (convId == 0L) return
        loading = true
        runCatching { session.api.chatMessages(convId) } // the first page also marks the chat read
            .onSuccess { messages = it; hasOlder = true; followNewest() }
            .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_load)) }
        loading = false
    }

    LaunchedEffect(convId) { load() }
    // Files attached but never sent are thrown away when the chat closes.
    DisposableEffect(Unit) { onDispose { uploads.discardAll() } }
    // New mail (or a change made elsewhere) can unarchive, unsnooze or refile the chat: the menu follows.
    LaunchedEffect(Unit) { session.mail.collect { load(); loadChat() } }
    ViewingChat(convId)

    // Load older messages when the top of the chat comes into view (the list is reversed).
    val atTop by remember { derivedStateOf { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index == messages.lastIndex } }
    LaunchedEffect(atTop, messages.size) {
        if (!atTop || !hasOlder || messages.isEmpty() || loading || convId == 0L) return@LaunchedEffect
        val oldest = messages.last()
        val older = runCatching { session.api.chatMessages(convId, before = oldest.sentAt, beforeId = oldest.id) }.getOrNull() ?: return@LaunchedEffect
        val known = messages.mapTo(HashSet()) { it.id }
        val fresh = older.filter { it.id !in known } // never the same message twice (the list is keyed by id)
        if (fresh.isEmpty()) hasOlder = false else messages = messages + fresh
    }

    val byId = remember(messages) { messages.associateBy { it.id } }

    fun startReply(m: Message) {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        replyTo = m
        pickedReply = true
    }

    /** Cancel on the reply bar: a new email, until a newer email comes in. */
    fun cancelReply() {
        replyTo = null
        pickedReply = false
        dismissedReply = newestMessage(messages)?.id
    }

    fun send() {
        val text = body.trim()
        if ((text.isEmpty() && uploads.isEmpty) || sending) return
        if (uploads.busy) {
            scope.launch { snack.showSnackbar(context.getString(R.string.wait_uploads)) }
            return
        }
        val files = uploads.ids
        scope.launch {
            sending = true
            try {
                val r = replyTo
                if (r != null) {
                    session.api.reply(r.id, convId, text, files)
                } else {
                    val to: Any = if (isGroup) convId else peer
                    val res = session.api.send(to, emptyList(), emptyList(), subject.trim(), text, attachmentIds = files)
                    if (convId == 0L) convId = res.conversationIds.firstOrNull() ?: 0L
                }
                body = ""
                subject = ""
                replyTo = null
                pickedReply = false
                uploads.sent()
                load() // replies by default again if the newest email is someone else's
                loadChat() // sending can bring an archived or snoozed chat back
                list.scrollToItem(0)
            } catch (e: Exception) {
                snack.showSnackbar(e.message ?: context.getString(R.string.could_not_send))
            } finally {
                sending = false
            }
        }
    }

    if (confirmBlock) {
        AlertDialog(
            onDismissRequest = { confirmBlock = false },
            title = { Text(stringResource(R.string.block_question, title)) },
            text = { Text(stringResource(R.string.block_explain)) },
            confirmButton = {
                TextButton(onClick = { confirmBlock = false; toggleBlock() }) { Text(stringResource(R.string.block), color = Palette.Danger) }
            },
            dismissButton = { TextButton(onClick = { confirmBlock = false }) { Text(stringResource(R.string.cancel), color = Palette.Muted) } },
            containerColor = Palette.Surface,
        )
    }

    if (snoozing) {
        SnoozeDialog(onDismiss = { snoozing = false }) { t ->
            snoozing = false
            act("snooze", context.getString(R.string.done_snoozed, dayTime(t)), until = isoUtc(t))
        }
    }

    if (moving) {
        MoveToFolderDialog(session, onDismiss = { moving = false }) { f ->
            moving = false
            act("move", context.getString(R.string.done_moved, f.name), folderId = f.id)
        }
    }

    StatusBarIcons(darkIcons = false)
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back)) } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Avatar(peerName ?: title.takeIf { it != peer }, peer, peerAvatar, group = isGroup, size = 38.dp)
                        Column(Modifier.padding(start = 10.dp)) {
                            Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (!isGroup && peer.isNotEmpty() && peer != title) {
                                Text(peer, fontSize = 12.sp, color = Palette.OnBar.copy(alpha = 0.8f), maxLines = 1)
                            }
                        }
                    }
                },
                actions = {
                    // The traditional editor (brief: takes the place of WhatsApp's camera button).
                    IconButton(onClick = { openEditor(convId, null) }) { Icon(Icons.Outlined.Email, stringResource(R.string.write_full_editor)) }
                    val direct = !isGroup && peer.isNotEmpty()
                    if (direct || convId != 0L) {
                        Box {
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.more)) }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                // The chat's own actions (once it exists); a new chat has only Block.
                                if (convId != 0L) {
                                    val c = chat
                                    val item = @Composable { label: Int, run: () -> Unit ->
                                        DropdownMenuItem(text = { Text(stringResource(label), color = Palette.Text) }, onClick = { menuOpen = false; run() })
                                    }
                                    if (c?.archived == true) item(R.string.move_to_inbox) { act(moveToInboxAction("", listOf(c)), context.getString(R.string.done_unarchived)) }
                                    else item(R.string.archive) { act("archive", context.getString(R.string.done_archived)) }
                                    if (c?.snoozedUntil != null) item(R.string.unsnooze) { act("unsnooze", context.getString(R.string.done_unsnoozed)) }
                                    else item(R.string.snooze_ellipsis) { snoozing = true }
                                    if (c?.muted == true) item(R.string.unmute) { act("unmute", context.getString(R.string.done_unmuted)) }
                                    else item(R.string.mute) { act("mute", context.getString(R.string.done_muted)) }
                                    if (c?.folderId != null) item(R.string.remove_from_folder) { act("unfile", context.getString(R.string.done_unfiled)) }
                                    else item(R.string.move_to_folder_ellipsis) { moving = true }
                                    // Back to the list: staying here would read it again at once.
                                    item(R.string.mark_unread) {
                                        scope.launch {
                                            runCatching { session.api.chatAction(listOf(convId), "unread") }
                                                .onSuccess { back() }
                                                .onFailure { snack.showSnackbar(it.message ?: context.getString(R.string.could_not_update)) }
                                        }
                                    }
                                }
                                if (direct) {
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                stringResource(if (blockedId != null) R.string.unblock_name else R.string.block_name, title),
                                                color = if (blockedId != null) Palette.Text else Palette.Danger,
                                            )
                                        },
                                        onClick = {
                                            menuOpen = false
                                            if (blockedId != null) toggleBlock() else confirmBlock = true
                                        },
                                    )
                                }
                            }
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Palette.Bar, titleContentColor = Palette.OnBar,
                    navigationIconContentColor = Palette.OnBar, actionIconContentColor = Palette.OnBar,
                ),
            )
        },
        snackbarHost = { SnackbarHost(snack) },
        containerColor = Palette.ChatBg,
    ) { inner ->
        Column(Modifier.padding(inner).consumeWindowInsets(inner).imePadding().fillMaxSize()) {
            Box(Modifier.weight(1f)) {
                LazyColumn(state = list, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
                    items(messages, key = { it.id }) { m ->
                        SwipeToReply(onReply = { startReply(m) }) {
                            Bubble(m, parent = m.parentId?.let { byId[it] }, showSender = isGroup) { openMessage(m.id) }
                        }
                    }
                }
                if (messages.isEmpty() && !loading) {
                    Text(
                        if (convId == 0L) stringResource(R.string.start_first_email, title) else stringResource(R.string.no_messages_yet),
                        color = Palette.Muted, textAlign = TextAlign.Center,
                        modifier = Modifier.align(Alignment.Center).padding(32.dp)
                            .background(Palette.Notice, RoundedCornerShape(8.dp)).padding(12.dp),
                    )
                }
                if (loading && messages.isEmpty()) CircularProgressIndicator(color = Palette.Header, modifier = Modifier.align(Alignment.Center))
            }
            Composer(
                subject = subject, onSubject = { subject = it },
                body = body, onBody = { body = it },
                replyTo = replyTo, onCancelReply = ::cancelReply,
                onFullEditor = { replyTo?.let { openEditor(convId, it.id) } },
                sending = sending, onSend = ::send,
                uploads = uploads, onAttach = pickFiles,
            )
        }
    }
}

@Composable
private fun Bubble(m: Message, parent: Message?, showSender: Boolean, onClick: () -> Unit) {
    val mine = m.isMine
    Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 3.dp), contentAlignment = if (mine) Alignment.CenterEnd else Alignment.CenterStart) {
        Surface(
            color = if (mine) Palette.BubbleMine else Palette.BubbleTheirs,
            shape = if (mine) RoundedCornerShape(10.dp, 2.dp, 10.dp, 10.dp) else RoundedCornerShape(2.dp, 10.dp, 10.dp, 10.dp),
            shadowElevation = 1.dp,
            modifier = Modifier.widthIn(max = 320.dp).clickable(onClick = onClick),
        ) {
            Column(Modifier.padding(start = 10.dp, end = 10.dp, top = 6.dp, bottom = 4.dp)) {
                if (showSender && !mine) Text(m.senderLabel, color = Palette.Header, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                if (m.parentId != null) {
                    Column(
                        Modifier.padding(bottom = 4.dp).background(Palette.Shade, RoundedCornerShape(6.dp))
                            .padding(start = 0.dp).fillMaxWidth(fraction = 1f),
                    ) {
                        Row {
                            Box(Modifier.width(4.dp).heightIn(min = 36.dp).background(Palette.Header))
                            Column(Modifier.padding(6.dp)) {
                                Text(
                                    parent?.let { if (it.isMine) stringResource(R.string.you) else it.senderLabel } ?: stringResource(R.string.earlier_message),
                                    color = Palette.Header, fontWeight = FontWeight.SemiBold, fontSize = 13.sp,
                                )
                                if (parent != null) Text(parent.body, color = Palette.Muted, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                } else if (m.subject.isNotBlank()) {
                    Text(m.subject, fontWeight = FontWeight.Bold, color = Palette.Text)
                }
                val long = m.body.length > LONG_MESSAGE
                if (m.body.isNotBlank()) Text(if (long) m.body.take(LONG_MESSAGE) + "…" else m.body, fontSize = 15.5.sp, color = Palette.Text, lineHeight = 21.sp)
                if (long) Text(stringResource(R.string.read_more), color = Palette.Header, fontWeight = FontWeight.SemiBold)
                AttachmentList(m.attachments, Modifier.padding(top = 4.dp).widthIn(min = 220.dp))
                Row(Modifier.align(Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                    if (m.isFavourite) Icon(Icons.Filled.Star, null, tint = Palette.Star, modifier = Modifier.size(12.dp))
                    Text(" " + bubbleTime(m.sentAt), fontSize = 11.sp, color = Palette.Muted)                }
            }
        }
    }
}

/** Swipe a message to the right to reply (brief: "swipe right to reply, like WhatsApp"). */
@Composable
private fun SwipeToReply(onReply: () -> Unit, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val offset = remember { Animatable(0f) }
    val trigger = with(LocalDensity.current) { 64.dp.toPx() }
    Box {
        Icon(
            Icons.AutoMirrored.Filled.Reply, null, tint = Palette.Header,
            modifier = Modifier.align(Alignment.CenterStart).padding(start = 16.dp).size(22.dp)
                .graphicsLayer { alpha = (offset.value / trigger).coerceIn(0f, 1f) },
        )
        Box(
            Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        if (offset.value >= trigger) onReply()
                        scope.launch { offset.animateTo(0f) }
                    },
                    onDragCancel = { scope.launch { offset.animateTo(0f) } },
                ) { change, dx ->
                    change.consume()
                    scope.launch { offset.snapTo((offset.value + dx).coerceIn(0f, trigger * 1.4f)) }
                }
            },
        ) { content() }
    }
}

@Composable
private fun Composer(
    subject: String, onSubject: (String) -> Unit,
    body: String, onBody: (String) -> Unit,
    replyTo: Message?, onCancelReply: () -> Unit, onFullEditor: () -> Unit,
    sending: Boolean, onSend: () -> Unit,
    uploads: Uploads, onAttach: () -> Unit,
) {
    val field = TextFieldDefaults.colors(
        focusedContainerColor = Palette.Surface, unfocusedContainerColor = Palette.Surface,
        focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent, cursorColor = Palette.Header,
        focusedTextColor = Palette.Text, unfocusedTextColor = Palette.Text,
    )
    Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (replyTo != null) {
            Row(
                Modifier.fillMaxWidth().background(Palette.Surface, RoundedCornerShape(12.dp)).padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.width(4.dp).heightIn(min = 36.dp).background(Palette.Header))
                Column(Modifier.padding(start = 8.dp).weight(1f)) {
                    Text(stringResource(R.string.replying_to, if (replyTo.isMine) stringResource(R.string.yourself) else replyTo.senderLabel), color = Palette.Header, fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    Text(replyTo.body, color = Palette.Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                Text(stringResource(R.string.full_editor), color = Palette.Header, fontWeight = FontWeight.SemiBold, modifier = Modifier.clickable(onClick = onFullEditor).padding(8.dp))
                IconButton(onClick = onCancelReply) { Icon(Icons.Filled.Close, stringResource(R.string.cancel_reply), tint = Palette.Muted) }
            }
        } else {
            // A new email in this chat gets a subject; replies never show one (brief).
            TextField(
                value = subject, onValueChange = onSubject, placeholder = { Text(stringResource(R.string.subject)) }, singleLine = true,
                shape = RoundedCornerShape(20.dp), colors = field, modifier = Modifier.fillMaxWidth(),
            )
        }
        PendingFiles(uploads)
        Row(verticalAlignment = Alignment.Bottom) {
            TextField(
                value = body, onValueChange = onBody, placeholder = { Text(stringResource(R.string.message)) },
                shape = RoundedCornerShape(24.dp), colors = field, maxLines = 6,
                modifier = Modifier.weight(1f),
                trailingIcon = { IconButton(onClick = onAttach) { Icon(Icons.Filled.AttachFile, stringResource(R.string.attach), tint = Palette.Muted) } },
            )
            Spacer(Modifier.width(6.dp))
            val canSend = (body.isNotBlank() || !uploads.isEmpty) && !sending
            Box(
                Modifier.size(52.dp).background(if (canSend) Palette.Header else Palette.Header.copy(alpha = 0.5f), CircleShape)
                    .clickable(enabled = canSend, onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                if (sending) CircularProgressIndicator(color = Palette.OnHeader, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
                else Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.send), tint = Palette.OnHeader)
            }
        }
    }
}
