package org.jaiaditya.phonemail.data

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.Request
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.jaiaditya.phonemail.BuildConfig
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.push.Push
import org.jaiaditya.phonemail.push.PushRules

/**
 * Who is signed in, the onboarding choices, and live new-mail events. One instance for the app
 * (see PhoneMailApp). The token and a copy of the profile live in the app's private storage, so the
 * app opens straight to Home, even offline.
 */
class Session(context: Context) {
    private val app = context.applicationContext
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Work that must outlive a screen (saving a draft when the editor closes, signing out). */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    val api = Api(
        BuildConfig.API_BASE, token = { token }, onUnauthorized = { scope.launch { signOut() } },
        unreachable = { text(R.string.error_unreachable) },
        failed = { text(R.string.error_request_failed, it) },
    )

    /** Avatar photos and attachment thumbnails. */
    val images = Images(app, api.http)

    private val _contacts = MutableStateFlow<List<Contact>>(emptyList())
    /** The phone's contacts (empty until the person allows access). */
    val contacts: StateFlow<List<Contact>> = _contacts

    var contactsAsked: Boolean = prefs.getBoolean(KEY_CONTACTS_ASKED, false)
        private set

    fun markContactsAsked() {
        contactsAsked = true
        prefs.edit().putBoolean(KEY_CONTACTS_ASKED, true).apply()
    }

    var notificationsAsked: Boolean = prefs.getBoolean(KEY_NOTIFICATIONS_ASKED, false)
        private set

    fun markNotificationsAsked() {
        notificationsAsked = true
        prefs.edit().putBoolean(KEY_NOTIFICATIONS_ASKED, true).apply()
    }

    private var contactsLoad: Job? = null

    fun loadContacts() {
        contactsLoad = scope.launch { _contacts.value = Contacts.load(app) }
    }

    /** Waits (at most [timeoutMs]) for the contacts being read, e.g. to name a notification's sender on a cold start. */
    suspend fun awaitContacts(timeoutMs: Long) {
        withTimeoutOrNull(timeoutMs) { contactsLoad?.join() }
    }

    /** A contact's name for a PhoneMail address or number, if the phone knows it. */
    fun contactName(address: String?): String? {
        val local = address?.substringBefore('@') ?: return null
        val digits = local.filter { it.isDigit() }
        if (digits.length < 10 || digits.length != local.filter { it != '+' }.length) return null
        return _contacts.value.firstOrNull { it.digits == digits.takeLast(10) }?.name
    }

    /** A string in the app's chosen language (for texts made outside a screen). */
    fun text(id: Int, vararg args: Any): String = AppLocale.wrap(app, language).getString(id, *args)

    private var token: String? = prefs.getString(KEY_TOKEN, null)

    private val _user = MutableStateFlow(
        prefs.getString(KEY_USER, null)?.let { runCatching { api.json.decodeFromString(User.serializer(), it) }.getOrNull() },
    )
    val user: StateFlow<User?> = _user

    var language: String? = prefs.getString(KEY_LANGUAGE, null)
        private set
    var termsAccepted: Boolean = prefs.getBoolean(KEY_TERMS, false)
        private set

    private val _theme = MutableStateFlow(prefs.getString(KEY_THEME, null) ?: "system")
    /** Appearance (Settings): "system" (follow the phone), "light" or "dark". Kept on this phone only. */
    val theme: StateFlow<String> = _theme

    private val _mail = MutableSharedFlow<Unit>(extraBufferCapacity = 16)
    /** Emits whenever the api says something changed for this person (new mail, a group change: its live event stream). */
    val mail: SharedFlow<Unit> = _mail

    private var live: Job? = null

    /** Sign-out's push cleanup (the api forgets the token, Firebase drops it): the next registration waits for it. */
    private var pushCleanup: Job? = null

    init {
        loadContacts()
        if (token != null) {
            connectLive()
            scope.launch { runCatching { refreshUser() } } // a 401 signs out via onUnauthorized
            registerPush()
            publishToWatch() // also signs in a watch app installed after the phone signed in
        }
    }

    /** The Wear OS app's sign-in and language follow the phone's (WatchLink). */
    private fun publishToWatch() = WatchLink.publish(app, token, _user.value?.displayName, language)

    fun chooseLanguage(code: String) {
        language = code
        prefs.edit().putString(KEY_LANGUAGE, code).apply()
        publishToWatch()
    }

    fun chooseTheme(mode: String) {
        _theme.value = mode
        prefs.edit().putString(KEY_THEME, mode).apply()
    }

    fun acceptTerms() {
        termsAccepted = true
        prefs.edit().putBoolean(KEY_TERMS, true).apply()
    }

    fun signIn(auth: AuthResponse) {
        token = auth.token
        prefs.edit().putString(KEY_TOKEN, auth.token).apply()
        setUser(auth.user)
        connectLive()
        registerPush()
        // The language chosen on the first screen goes to the profile.
        val lang = language
        if (lang != null && lang != auth.user.language) {
            scope.launch { runCatching { setUser(api.updateMe("language" to lang)) } }
        }
    }

    fun signOut() {
        live?.cancel()
        live = null
        // This phone stops getting the person's mail: the api forgets its token (with the sign-in being ended), best
        // effort, and Firebase drops the token, so whoever signs in next gets a fresh one (registerPush waits for this).
        val bearer = token
        val device = prefs.getString(KEY_PUSH_TOKEN, null)
        if (bearer != null) {
            val before = pushCleanup
            pushCleanup = scope.launch {
                before?.join()
                if (device != null) runCatching { apiFor(bearer).unregisterPush(device) }
                Push.forgetToken(app)
            }
        }
        token = null
        prefs.edit().remove(KEY_TOKEN).remove(KEY_USER).remove(KEY_PUSH_TOKEN).apply()
        _user.value = null
        publishToWatch() // an empty token signs the watch out too
    }

    /**
     * Tells the api where to push new mail: after sign-in, on every start while signed in, and when Firebase hands out
     * a new [fcmToken]. Without google-services.json (or Play services) there is no token and nothing is sent.
     */
    fun registerPush(fcmToken: String? = null) {
        val bearer = token ?: return
        scope.launch {
            pushCleanup?.join() // a sign-out's cleanup first, so its late DELETE or token drop can't undo this
            if (token != bearer) return@launch
            val t = fcmToken ?: Push.token(app) ?: return@launch
            runCatching { apiFor(bearer).registerPush(t) }
                .onSuccess {
                    // Signed out (or someone else signed in) while this was on its way: the api forgets it again.
                    if (PushRules.keepRegistration(bearer, token)) prefs.edit().putString(KEY_PUSH_TOKEN, t).apply()
                    else runCatching { apiFor(bearer).unregisterPush(t) }
                }
                .onFailure { Log.d("PhoneMail", "push registration: ${it.message}") }
        }
    }

    /** The api as one particular sign-in, whatever happens to the session meanwhile (no sign-out on a 401). */
    private fun apiFor(bearer: String) = Api(
        BuildConfig.API_BASE, token = { bearer }, onUnauthorized = {},
        unreachable = { text(R.string.error_unreachable) }, failed = { text(R.string.error_request_failed, it) },
    )

    /** Before deleting the account (signed in still): the api stops pushing to this phone. Best effort. */
    suspend fun forgetPushDevice() {
        val device = prefs.getString(KEY_PUSH_TOKEN, null) ?: return
        runCatching { api.unregisterPush(device) }
        prefs.edit().remove(KEY_PUSH_TOKEN).apply()
        Push.forgetToken(app)
    }

    suspend fun refreshUser() = setUser(api.me())

    fun setUser(u: User) {
        _user.value = u
        prefs.edit().putString(KEY_USER, api.json.encodeToString(User.serializer(), u)).apply()
        publishToWatch() // after sign-in (token set first) and whenever the name changes
    }

    /**
     * Live updates: the api's event stream (GET /api/events, Server-Sent Events). Every event means something changed
     * ("ready", sent on each connect, covers anything missed while disconnected), so the open screen reloads. Reconnects 3 s after the stream drops.
     */
    private fun connectLive() {
        val t = token ?: return
        live?.cancel()
        val client = api.http.newBuilder().readTimeout(90, TimeUnit.SECONDS).build() // the api pings every 25 s
        live = scope.launch(Dispatchers.IO) {
            while (isActive && token == t) {
                runCatching {
                    val req = Request.Builder().url("${BuildConfig.API_BASE}/events")
                        .header("Authorization", "Bearer $t").header("Accept", "text/event-stream").build()
                    client.newCall(req).execute().use { res ->
                        if (res.code == 401) { scope.launch { signOut() }; return@launch }
                        val source = res.body?.source() ?: return@use
                        while (isActive && !source.exhausted()) {
                            val line = source.readUtf8Line() ?: break
                            // Any event, "ready" included: after a reconnect the screen reloads, so nothing sent meanwhile is missed.
                            if (line.startsWith("event:")) _mail.tryEmit(Unit)
                        }
                    }
                }.onFailure { Log.d("PhoneMail", "live updates: ${it.message}") }
                delay(3000)
            }
        }
    }

    companion object {
        const val PREFS = "phonemail"
        const val KEY_LANGUAGE = "language"
        private const val KEY_CONTACTS_ASKED = "contacts_asked"
        private const val KEY_TOKEN = "token"
        private const val KEY_USER = "user"
        private const val KEY_TERMS = "terms"
        private const val KEY_THEME = "theme"
        private const val KEY_NOTIFICATIONS_ASKED = "notifications_asked"
        /** The push token the api last accepted (removed from the api on sign-out). */
        private const val KEY_PUSH_TOKEN = "push_token"
    }
}
