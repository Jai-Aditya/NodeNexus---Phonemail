package org.jaiaditya.phonemail.wear

import android.app.RemoteInput
import android.content.ContextWrapper
import android.content.Intent
import android.content.res.Configuration
import android.content.res.Resources
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Smartphone
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Chip
import androidx.wear.compose.material.ChipDefaults
import androidx.wear.compose.material.CircularProgressIndicator
import androidx.wear.compose.material.Colors
import androidx.wear.compose.material.CompactChip
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.ListHeader
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.launch
import java.util.Locale

/** The phone app's indigo (dark theme) and Pip's orange, as on the Apple Watch. */
private val Indigo = Color(0xFF8C82F2)
private val Orange = Color(0xFFF2A33A)

/**
 * PhoneMail on Wear OS: the Inbox, a chat and a quick reply. It signs in through the phone app (PhoneLink), like
 * the Apple Watch app does through the iPhone.
 */
class MainActivity : ComponentActivity() {
    private lateinit var link: PhoneLink

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        link = PhoneLink(this)
        // Debug builds: `adb shell am start -n <pkg>/org.jaiaditya.phonemail.wear.MainActivity --es uiTestToken <token>`
        // (optionally `--es uiTestLang ta`, `--es uiTestApi http://localhost:3031/api`) signs in without a paired phone,
        // for emulator tests and screenshots.
        val testToken = if (BuildConfig.DEBUG) intent.getStringExtra("uiTestToken") else null
        setContent {
            LaunchedEffect(Unit) {
                if (testToken != null) {
                    link.useForTesting(testToken, intent.getStringExtra("uiTestLang") ?: "en", intent.getStringExtra("uiTestApi"))
                } else link.load()
            }
            WatchApp(link)
        }
    }

    override fun onStart() {
        super.onStart()
        link.start()
    }

    override fun onStop() {
        link.stop()
        super.onStop()
    }
}

@Composable
private fun WatchApp(link: PhoneLink) {
    val signIn by link.signIn.collectAsState()
    val loaded by link.loaded.collectAsState()
    InLanguage(signIn?.lang) {
        MaterialTheme(colors = Colors(primary = Indigo, secondary = Orange)) {
            when {
                !loaded -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                signIn == null -> SignedOut()
                else -> {
                    val s = signIn!!
                    val unreachable = stringResource(R.string.error_unreachable)
                    val failedText = stringResource(R.string.error_request_failed)
                    val api = remember(s.token, s.apiBase) {
                        WatchApi(s.apiBase, s.token, unreachable) { code -> String.format(failedText, code) }
                    }
                    SignedIn(api, onRejected = link::rejected)
                }
            }
        }
    }
}

/** Every string in the phone app's language ("en", "hi", "ta"), whatever the watch's own language is. */
@Composable
private fun InLanguage(lang: String?, content: @Composable () -> Unit) {
    if (lang == null || lang !in listOf("en", "hi", "ta")) return content()
    val base = LocalContext.current
    val config = remember(lang) {
        Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(lang)) }
    }
    // A wrapper of the activity (not a bare configuration context), so whatever looks for the activity through
    // LocalContext (the reply input's result, back handling) still finds it.
    val context = remember(lang) {
        val localized = base.createConfigurationContext(config).resources
        object : ContextWrapper(base) {
            override fun getResources(): Resources = localized
        }
    }
    CompositionLocalProvider(LocalContext provides context, LocalConfiguration provides config, content = content)
}

@Composable
private fun SignedOut() {
    Column(
        Modifier.fillMaxSize().padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Filled.Smartphone, contentDescription = null, tint = Indigo, modifier = Modifier.size(32.dp))
        Text(
            stringResource(R.string.sign_in_on_phone),
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = 10.dp),
        )
    }
}

@Composable
private fun SignedIn(api: WatchApi, onRejected: () -> Unit) {
    val nav = rememberSwipeDismissableNavController()
    SwipeDismissableNavHost(navController = nav, startDestination = "inbox") {
        composable("inbox") {
            Inbox(api, onRejected) { c -> nav.navigate("chat/${c.conversationId}") }
        }
        composable("chat/{id}") { entry ->
            val id = entry.arguments?.getString("id")?.toLongOrNull() ?: return@composable
            Chat(api, id, onRejected)
        }
    }
}

/** Reloads [load] whenever the screen comes back (raising the wrist, back from a chat). */
@Composable
private fun ReloadOnResume(load: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(lifecycle) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { load() } }
}

/** The Inbox, newest first, with unread counts. */
@Composable
private fun Inbox(api: WatchApi, onRejected: () -> Unit, open: (WatchChat) -> Unit) {
    var chats by remember { mutableStateOf<List<WatchChat>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val group = stringResource(R.string.group)
    val conversation = stringResource(R.string.conversation)

    suspend fun load() {
        try {
            chats = api.chats()
            error = ""
        } catch (e: WatchApiException) {
            if (e.status == 401) onRejected()
            error = e.message.orEmpty()
        }
        loaded = true
    }
    ReloadOnResume { load() }

    val list = rememberScalingLazyListState()
    Scaffold(timeText = { TimeText() }, positionIndicator = { PositionIndicator(list) }) {
        ScalingLazyColumn(Modifier.fillMaxSize(), state = list) {
            item { ListHeader { Text(stringResource(R.string.inbox)) } }
            if (!loaded) item { CircularProgressIndicator() }
            if (error.isNotEmpty()) {
                item { Text(error, color = Color(0xFFFF5C7A), textAlign = TextAlign.Center) }
                item {
                    CompactChip(onClick = { scope.launch { load() } }, label = { Text(stringResource(R.string.try_again)) })
                }
            } else if (loaded && chats.isEmpty()) {
                item { Text(stringResource(R.string.nothing_here), color = Color.Gray) }
            }
            items(chats, key = { it.conversationId }) { c ->
                Chip(
                    onClick = { open(c) },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ChipDefaults.secondaryChipColors(),
                    label = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                WatchMail.title(c, group, conversation),
                                fontWeight = if (c.unreadCount > 0) FontWeight.Bold else FontWeight.Normal,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            if (c.unreadCount > 0) UnreadBadge(c.unreadCount)
                        }
                    },
                    secondaryLabel = WatchMail.nonEmpty(c.snippet)?.let { s ->
                        { Text(s, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    },
                )
            }
        }
    }
}

@Composable
private fun UnreadBadge(n: Int) {
    Box(
        Modifier.padding(start = 6.dp).background(Orange, RoundedCornerShape(50)).padding(horizontal = 6.dp)
            .widthIn(min = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text("$n", color = Color(0xFF3B2500), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.caption2)
    }
}

/**
 * One chat, oldest message first; opening it marks it read. At the bottom, a reply to the newest email from someone
 * else: typed, dictated or handwritten (the watch's input screen), or one of the quick replies.
 */
@Composable
private fun Chat(api: WatchApi, conversationId: Long, onRejected: () -> Unit) {
    var messages by remember { mutableStateOf<List<WatchMessage>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val you = stringResource(R.string.you)
    val sent = stringResource(R.string.sent)
    val target = WatchMail.replyTarget(messages)

    suspend fun load() {
        try {
            messages = api.messages(conversationId)
            error = ""
        } catch (e: WatchApiException) {
            if (e.status == 401) onRejected()
            error = e.message.orEmpty()
        }
        loaded = true
    }
    ReloadOnResume { if (!sending) load() }

    fun send(text: String) {
        val body = text.trim()
        val t = target ?: return
        if (body.isEmpty() || sending) return
        scope.launch {
            sending = true
            note = ""
            try {
                api.reply(t.id, conversationId, body)
                note = sent
                load()
            } catch (e: WatchApiException) {
                if (e.status == 401) onRejected()
                note = e.message.orEmpty()
            }
            sending = false
        }
    }

    val replyLabel = stringResource(R.string.reply)
    val input = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data ?: return@rememberLauncherForActivityResult
        RemoteInput.getResultsFromIntent(data)?.getCharSequence(REPLY_KEY)?.let { send(it.toString()) }
    }
    fun openInput() {
        val intent: Intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
        RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(RemoteInput.Builder(REPLY_KEY).setLabel(replyLabel).build()))
        input.launch(intent)
    }

    val list = rememberScalingLazyListState()
    // Opens at the newest message (centred, the reply below it). Items before the messages: the top spacer, and the
    // error line when there is one.
    LaunchedEffect(messages.size, loaded) {
        if (loaded && messages.isNotEmpty()) list.scrollToItem(messages.size + if (error.isNotEmpty()) 1 else 0)
    }
    val quick = listOf(R.string.quick_ok, R.string.quick_thanks, R.string.quick_on_my_way, R.string.quick_call_later)
        .map { stringResource(it) }

    Scaffold(timeText = { TimeText() }, positionIndicator = { PositionIndicator(list) }) {
        ScalingLazyColumn(Modifier.fillMaxSize(), state = list) {
            item { Spacer8() }
            if (!loaded) item { CircularProgressIndicator() }
            if (error.isNotEmpty()) item { Text(error, color = Color(0xFFFF5C7A), textAlign = TextAlign.Center) }
            items(messages, key = { it.id }) { m ->
                Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
                    Text(
                        WatchMail.senderLabel(m, you),
                        color = if (m.isMine) Color.Gray else Indigo,
                        style = MaterialTheme.typography.caption2,
                    )
                    WatchMail.shownSubject(m)?.let { Text(it, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.caption1) }
                    Text(WatchMail.text(m), style = MaterialTheme.typography.caption1)
                }
            }
            if (target != null) {
                item {
                    ListHeader {
                        Text(
                            stringResource(R.string.reply_to, WatchMail.senderLabel(target, you)),
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                item {
                    Chip(
                        onClick = { openInput() },
                        enabled = !sending,
                        modifier = Modifier.fillMaxWidth(),
                        icon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                        label = { Text(replyLabel) },
                    )
                }
                items(quick) { q ->
                    Chip(
                        onClick = { send(q) },
                        enabled = !sending,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ChipDefaults.secondaryChipColors(),
                        label = { Text(q) },
                    )
                }
                if (sending) item { CircularProgressIndicator() }
                if (note.isNotEmpty()) item { Text(note, color = Color.Gray, textAlign = TextAlign.Center) }
            }
        }
    }
}

@Composable
private fun Spacer8() = Box(Modifier.size(8.dp))

private const val REPLY_KEY = "reply"
