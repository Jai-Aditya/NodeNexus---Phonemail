package org.jaiaditya.phonemail.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import org.jaiaditya.phonemail.PhoneMailApp

/** Firebase Cloud Messaging: a new token goes to the api; a new-mail message becomes a notification (built here). */
class PushService : FirebaseMessagingService() {
    private val session get() = (application as PhoneMailApp).session

    override fun onNewToken(token: String) {
        session.registerPush(token)
    }

    /** Runs on a background thread, so it may wait briefly. */
    override fun onMessageReceived(message: RemoteMessage) {
        val mail = NewMail.parse(message.data) ?: return
        if (!NewMail.shouldNotify(session.user.value != null, Push.viewing.conversationId, mail)) return
        // Started cold by this message, the contacts are still loading: wait a moment so the sender shows by name.
        runBlocking { session.awaitContacts(CONTACTS_MS) }
        Push.show(this, session, mail)
    }

    private companion object {
        const val CONTACTS_MS = 1_500L
    }
}
