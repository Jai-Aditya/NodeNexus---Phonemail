package org.jaiaditya.phonemail

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import kotlinx.coroutines.flow.MutableStateFlow
import org.jaiaditya.phonemail.data.AppLocale
import org.jaiaditya.phonemail.data.Contacts
import org.jaiaditya.phonemail.data.Session
import org.jaiaditya.phonemail.push.NewMail
import org.jaiaditya.phonemail.push.Push
import org.jaiaditya.phonemail.ui.ChatScreen
import org.jaiaditya.phonemail.ui.ComposeArgs
import org.jaiaditya.phonemail.ui.ComposeScreen
import org.jaiaditya.phonemail.ui.ContactsScreen
import org.jaiaditya.phonemail.ui.FolderScreen
import org.jaiaditya.phonemail.ui.HomeScreen
import org.jaiaditya.phonemail.ui.LanguageScreen
import org.jaiaditya.phonemail.ui.LocalSession
import org.jaiaditya.phonemail.ui.MessageScreen
import org.jaiaditya.phonemail.ui.NotificationsScreen
import org.jaiaditya.phonemail.ui.PhoneMailTheme
import org.jaiaditya.phonemail.ui.PhoneScreen
import org.jaiaditya.phonemail.ui.SettingsScreen
import org.jaiaditya.phonemail.ui.TermsScreen
import org.jaiaditya.phonemail.ui.VerifyScreen

class MainActivity : ComponentActivity() {
    /** A chat to open, from a tapped new-mail notification (PhoneMailNav opens it once signed in). */
    private val opening = MutableStateFlow<NewMail?>(null)

    /** The app shows in its own language (English, Hindi or Tamil), whatever the phone's language is. */
    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(AppLocale.wrap(base, AppLocale.saved(base)))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT))
        val session = (application as PhoneMailApp).session
        // Not again after a rotation, nor when reopened from Recents (that intent is the old tap).
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) opening.value = Push.mailOf(intent)
        setContent {
            // Settings → Appearance: a change redraws every screen at once.
            val theme by session.theme.collectAsState()
            CompositionLocalProvider(LocalSession provides session) {
                PhoneMailTheme(theme) { PhoneMailNav(session, opening) }
            }
        }
    }

    /** A notification tapped while the app is open (singleTop: this same screen gets the intent). */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        Push.mailOf(intent)?.let { opening.value = it }
    }
}

private fun enc(s: String) = Uri.encode(s)

/** Saves the language and redraws the app in it straight away. */
fun Context.applyLanguage(session: Session, code: String) {
    val changed = session.language != code
    session.chooseLanguage(code)
    Push.createChannel(applicationContext, session.text(R.string.channel_new_mail)) // its name, as the phone's settings show it
    if (changed) (this as? Activity)?.recreate()
}

@Composable
private fun PhoneMailNav(session: Session, opening: MutableStateFlow<NewMail?>) {
    val nav = rememberNavController()
    val context = LocalContext.current
    val user by session.user.collectAsState()
    // Chosen once: changing a NavHost's start destination later would rebuild the graph.
    val start = remember {
        when {
            session.user.value != null -> if (Push.shouldAsk(context, session)) "notifications" else "home" // updating to 1.1: asked once
            session.language == null -> "language"
            !session.termsAccepted -> "terms"
            else -> "phone"
        }
    }

    // Signed out (from Settings, or the token expired): back to the phone-number screen.
    val signedIn = user != null
    LaunchedEffect(signedIn) {
        val route = nav.currentDestination?.route ?: return@LaunchedEffect
        val onboarding = route in setOf("language", "terms", "phone") || route.startsWith("verify")
        if (!signedIn && !onboarding) nav.navigate("phone") { popUpTo(0) }
    }

    // A tapped notification: straight into its chat (the chat's details come from the api; the push's own title if offline).
    val open by opening.collectAsState()
    LaunchedEffect(open, signedIn) {
        val mail = open ?: return@LaunchedEffect
        // Cleared only once handled: clearing restarts this effect, which would cancel the lookup below.
        if (signedIn && Push.viewing.conversationId != mail.conversationId) {
            Push.cancel(context, mail.conversationId)
            val c = runCatching { session.api.conversation(mail.conversationId) }.getOrNull()
            if (c == null) {
                nav.openChat(mail.conversationId, false, mail.title, "", null, null)
            } else {
                val title = if (c.isGroup) c.name ?: context.getString(R.string.group)
                else c.peerName ?: session.contactName(c.peerAddress) ?: c.peerAddress ?: mail.title
                nav.openChat(c.id, c.isGroup, title, c.peerAddress.orEmpty(), c.peerName, c.peerAvatar)
            }
        }
        opening.value = null // signed out (an old notification): just the app
    }
    // After sign-in: contacts, then notifications (each asked once, each skippable), then Home.
    fun afterContacts() = if (Push.shouldAsk(context, session)) "notifications" else "home"

    NavHost(navController = nav, startDestination = start) {
        composable("language") {
            LanguageScreen(session.language) { code ->
                nav.navigate(if (session.termsAccepted) "phone" else "terms")
                context.applyLanguage(session, code)
            }
        }
        composable("terms") {
            TermsScreen {
                session.acceptTerms()
                nav.navigate("phone")
            }
        }
        composable("phone") { PhoneScreen { digits -> nav.navigate("verify/$digits") } }
        composable("verify/{phone}") { e ->
            VerifyScreen(
                session, e.arguments?.getString("phone").orEmpty(),
                onSignedIn = {
                    // Contacts access is asked once, right after sign-in (brief: permissions at the right stage).
                    val ask = !session.contactsAsked && !Contacts.granted(context)
                    nav.navigate(if (ask) "contacts" else afterContacts()) { popUpTo(0) }
                },
                onChangeNumber = { nav.popBackStack() },
            )
        }
        composable("contacts") {
            ContactsScreen(session) { nav.navigate(afterContacts()) { popUpTo(0) } }
        }
        composable("notifications") {
            NotificationsScreen(session) { nav.navigate("home") { popUpTo(0) } }
        }
        composable("home") {
            HomeScreen(
                session,
                openChat = { c, title -> nav.openChat(c.id, c.isGroup, title, c.peerAddress.orEmpty(), c.peerName, c.peerAvatar) },
                newChat = { number, name -> nav.openChat(0, false, name ?: number, "$number@${BuildConfig.MAIL_DOMAIN}", name, null) },
                compose = { nav.navigate("compose") },
                openFolder = { nav.navigate("folder/$it") },
                openSettings = { nav.navigate("settings") },
            )
        }
        composable(
            "chat/{id}?group={group}&title={title}&peer={peer}&name={name}&avatar={avatar}",
            arguments = listOf(
                navArgument("id") { type = NavType.LongType },
                navArgument("group") { type = NavType.BoolType; defaultValue = false },
                navArgument("title") { defaultValue = "" },
                navArgument("peer") { defaultValue = "" },
                navArgument("name") { defaultValue = "" },
                navArgument("avatar") { defaultValue = "" },
            ),
        ) { e ->
            val a = e.arguments!!
            val group = a.getBoolean("group")
            val title = a.getString("title").orEmpty()
            val peer = a.getString("peer").orEmpty()
            ChatScreen(
                session, a.getLong("id"), group, title, peer,
                peerName = a.getString("name").orEmpty().ifEmpty { null },
                peerAvatar = a.getString("avatar").orEmpty().ifEmpty { null },
                back = { nav.popBackStack() },
                openMessage = { nav.navigate("message/$it?conv=${a.getLong("id")}") },
                openEditor = { conv, replyTo ->
                    nav.navigate(
                        "compose?to=${enc(if (group) "" else peer)}&group=${if (group) conv else 0}" +
                            "&conv=$conv&reply=${replyTo ?: 0}&title=${enc(title)}",
                    )
                },
            )
        }
        composable(
            "message/{id}?conv={conv}",
            arguments = listOf(navArgument("id") { type = NavType.LongType }, navArgument("conv") { type = NavType.LongType; defaultValue = 0L }),
        ) { e ->
            MessageScreen(
                session, e.arguments!!.getLong("id"), conversationId = e.arguments!!.getLong("conv"),
                back = { nav.popBackStack() },
                reply = { m -> nav.navigate("compose?conv=${m.conversationId}&reply=${m.id}&title=${enc(m.senderLabel)}") },
            )
        }
        composable(
            "compose?to={to}&group={group}&conv={conv}&reply={reply}&title={title}&draft={draft}",
            arguments = listOf(
                navArgument("to") { defaultValue = "" },
                navArgument("group") { type = NavType.LongType; defaultValue = 0L },
                navArgument("conv") { type = NavType.LongType; defaultValue = 0L },
                navArgument("reply") { type = NavType.LongType; defaultValue = 0L },
                navArgument("title") { defaultValue = "" },
                navArgument("draft") { type = NavType.LongType; defaultValue = 0L },
            ),
        ) { e ->
            val a = e.arguments!!
            fun id(k: String) = a.getLong(k).takeIf { it != 0L }
            ComposeScreen(
                session,
                ComposeArgs(
                    to = a.getString("to").orEmpty(), groupId = id("group"), conversationId = id("conv"),
                    replyTo = id("reply"), title = a.getString("title").orEmpty(), draftId = id("draft"),
                ),
                close = { nav.popBackStack() },
            )
        }
        // Drafts, Scheduled, Spam and Trash (the user's own folders are chat lists on Home).
        composable("folder/{name}") { e ->
            FolderScreen(
                session, e.arguments?.getString("name").orEmpty(),
                back = { nav.popBackStack() },
                openMessage = { nav.navigate("message/$it") },
                openDraft = { nav.navigate("compose?draft=$it") },
            )
        }
        composable("settings") {
            SettingsScreen(session, back = { nav.popBackStack() }, onLanguage = { context.applyLanguage(session, it) })
        }
    }
}

private fun NavHostController.openChat(id: Long, group: Boolean, title: String, peer: String, name: String?, avatar: String?) =
    navigate("chat/$id?group=$group&title=${enc(title)}&peer=${enc(peer)}&name=${enc(name.orEmpty())}&avatar=${enc(avatar.orEmpty())}")
