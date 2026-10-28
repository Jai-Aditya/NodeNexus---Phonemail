package org.jaiaditya.phonemail.push

/**
 * One new-mail push: the api sends data-only messages (all values strings) and the app builds the notification itself:
 * {"type": "new_mail", "title": "<sender name or address>", "body": "<subject>", "conversation_id": "<id>", "message_id": "<id>"}.
 * Plain Kotlin (no Android), so the rules here are unit-tested.
 */
data class NewMail(val title: String, val body: String, val conversationId: Long, val messageId: Long) {
    companion object {
        const val TYPE = "new_mail"

        /** null for any other type, or when an id is missing or not a number (nothing to open or reply to). */
        fun parse(data: Map<String, String>): NewMail? {
            if (data["type"] != TYPE) return null
            val conversation = data["conversation_id"]?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: return null
            val message = data["message_id"]?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: return null
            return NewMail(data["title"].orEmpty().trim(), data["body"].orEmpty().trim(), conversation, message)
        }

        /** Shown only when someone is signed in and that chat isn't open on screen right now. */
        fun shouldNotify(signedIn: Boolean, viewing: Long?, mail: NewMail): Boolean =
            signedIn && viewing != mail.conversationId

        /** One notification per chat: later mail in it updates the same one. */
        fun notificationId(conversationId: Long): Int = (conversationId xor (conversationId ushr 32)).toInt()

        /** What was typed into the notification's Reply, or null when there is nothing to send. */
        fun replyText(typed: CharSequence?): String? = typed?.toString()?.trim()?.takeIf { it.isNotEmpty() }
    }
}
