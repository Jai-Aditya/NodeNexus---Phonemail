package org.jaiaditya.phonemail.wear

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.tasks.await

/** What the phone app sends (its WatchLink): an empty token means signed out. */
data class SignIn(val token: String, val apiBase: String, val name: String, val lang: String)

/**
 * The watch's end of the Data Layer: reads the sign-in item the phone app keeps at [PATH] (Wear OS keeps a copy on
 * the watch, so this works offline too) and follows its changes while the app is open.
 */
class PhoneLink(context: Context) : DataClient.OnDataChangedListener {
    private val data = Wearable.getDataClient(context.applicationContext)

    private val _signIn = MutableStateFlow<SignIn?>(null)
    /** Null until the phone has signed the watch in (or after it signed out, or the api refused the token). */
    val signIn: StateFlow<SignIn?> = _signIn

    private val _loaded = MutableStateFlow(false)
    /** False until the first read of the Data Layer has finished. */
    val loaded: StateFlow<Boolean> = _loaded

    suspend fun load() {
        runCatching {
            val items = data.dataItems.await()
            try {
                items.forEach { if (it.uri.path == PATH) apply(it) }
            } finally {
                items.release()
            }
        }.onFailure { Log.d("PhoneMail", "phone link: ${it.message}") }
        _loaded.value = true
    }

    fun start() = data.addListener(this)
    fun stop() = data.removeListener(this)

    override fun onDataChanged(events: DataEventBuffer) {
        events.forEach { e ->
            if (e.dataItem.uri.path == PATH) {
                if (e.type == DataEvent.TYPE_DELETED) _signIn.value = null else apply(e.dataItem)
            }
        }
    }

    private fun apply(item: DataItem) {
        val m = DataMapItem.fromDataItem(item).dataMap
        val token = m.getString("token").orEmpty()
        _signIn.value = if (token.isEmpty()) null else SignIn(
            token = token,
            apiBase = m.getString("apiBase").orEmpty().ifEmpty { DEFAULT_API },
            name = m.getString("name").orEmpty(),
            lang = m.getString("lang").orEmpty().ifEmpty { "en" },
        )
    }

    /** The api refused the token: show the signed-out screen until the phone sends a new one. */
    fun rejected() {
        _signIn.value = null
    }

    /** Debug builds only: screenshots and emulator tests without a paired phone. */
    fun useForTesting(token: String, lang: String, apiBase: String?) {
        _signIn.value = SignIn(token, apiBase ?: DEFAULT_API, "", lang)
        _loaded.value = true
    }

    companion object {
        const val PATH = "/signin"
        const val DEFAULT_API = "https://mail.phonemail.net/api"
    }
}
