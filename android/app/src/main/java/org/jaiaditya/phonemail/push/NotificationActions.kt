package org.jaiaditya.phonemail.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.RemoteInput
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.jaiaditya.phonemail.PhoneMailApp
import org.jaiaditya.phonemail.R

/**
 * The notification's buttons (on the phone or a watch): Reply sends the typed text as a reply to that mail; Mark as
 * read marks the chat read. goAsync() keeps the app alive until the call is done (each call gets [CALL_MS]).
 */
class NotificationActions : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val mail = Push.mailOf(intent) ?: return
        val app = context.applicationContext as PhoneMailApp
        val pending = goAsync()
        scope.launch {
            try {
                if (app.session.user.value == null) {
                    Push.cancel(app, mail.conversationId) // signed out since: the earlier person's mail goes
                    return@launch
                }
                when (intent.action) {
                    REPLY -> reply(app, mail, RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Push.KEY_REPLY))
                    READ -> read(app, mail)
                }
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun reply(app: PhoneMailApp, mail: NewMail, typed: CharSequence?) {
        val session = app.session
        val text = NewMail.replyText(typed)
        if (text == null) {
            Push.repost(app, mail.conversationId) // nothing typed: the notification stays as it was
            return
        }
        val error = attempt { session.api.reply(mail.messageId, mail.conversationId, text) }
        if (error == null) {
            Push.showReplied(app, session, mail, text)
            delay(SHOW_MS)
            Push.cancel(app, mail.conversationId)
        } else {
            Log.d("PhoneMail", "notification reply: ${error.message}")
            val note = PushRules.failureText(error) ?: session.text(R.string.could_not_send)
            Push.showNote(app, session, mail, note)
        }
    }

    private suspend fun read(app: PhoneMailApp, mail: NewMail) {
        val error = attempt { app.session.api.markRead(mail.conversationId) }
        if (error == null) {
            Push.cancel(app, mail.conversationId)
        } else {
            Log.d("PhoneMail", "notification mark read: ${error.message}")
            Push.showNote(app, app.session, mail, app.session.text(R.string.could_not_mark_read))
        }
    }

    /** The call's error, or null when it worked. A timeout is a failure like any other; other cancellations go on up. */
    private suspend fun attempt(call: suspend () -> Unit): Throwable? = try {
        withTimeout(CALL_MS) { call() }
        null
    } catch (e: TimeoutCancellationException) {
        e
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        e
    }

    companion object {
        const val REPLY = "org.jaiaditya.phonemail.action.REPLY"
        const val READ = "org.jaiaditya.phonemail.action.READ"
        private const val CALL_MS = 40_000L // background broadcasts may run for a minute, notes and pauses included
        private const val SHOW_MS = 2_000L
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
