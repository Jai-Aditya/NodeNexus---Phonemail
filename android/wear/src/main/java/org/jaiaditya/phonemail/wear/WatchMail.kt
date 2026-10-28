package org.jaiaditya.phonemail.wear

import kotlinx.serialization.Serializable

// The few api shapes the watch reads (snake_case JSON, read with WatchApi.wire), and its small rules: the same as the
// Apple Watch app's (ios/Shared/WatchMail.swift). Kept free of Android classes so the unit tests cover them.

@Serializable
data class WatchPerson(val address: String = "", val displayName: String = "")

/** A row of the Inbox. */
@Serializable
data class WatchChat(
    val conversationId: Long,
    val kind: String = "direct",
    val name: String = "",
    val peer: WatchPerson? = null,
    val snippet: String = "",
    val unreadCount: Int = 0,
)

@Serializable
data class WatchMessage(
    val id: Long,
    val sender: WatchPerson = WatchPerson(),
    val subject: String = "",
    val bodyText: String = "",
    val snippet: String = "",
    val parentId: Long? = null,
    val isMine: Boolean = false,
)

@Serializable
data class WatchPage<T>(val items: List<T> = emptyList())

object WatchMail {
    /** A chat's name: the group's name, or the other person's name or address. */
    fun title(c: WatchChat, group: String, conversation: String): String =
        if (c.kind == "group") nonEmpty(c.name) ?: group
        else nonEmpty(c.peer?.displayName) ?: nonEmpty(c.peer?.address) ?: conversation

    fun senderLabel(m: WatchMessage, you: String): String =
        if (m.isMine) you else nonEmpty(m.sender.displayName) ?: m.sender.address

    fun text(m: WatchMessage): String = nonEmpty(m.bodyText) ?: m.snippet

    /** A new email shows its subject; replies never do (as in the phone's chats). */
    fun shownSubject(m: WatchMessage): String? = if (m.parentId == null) nonEmpty(m.subject) else null

    /** The email a reply from the watch answers: the newest one from someone else (messages oldest first). */
    fun replyTarget(messages: List<WatchMessage>): WatchMessage? = messages.lastOrNull { !it.isMine }

    /** Newest first, as the api sends them -> oldest first, as shown. Long bodies are cut for the small screen. */
    fun shown(newestFirst: List<WatchMessage>, limit: Int = 600): List<WatchMessage> =
        newestFirst.reversed().map { m ->
            if (m.bodyText.length > limit) m.copy(bodyText = m.bodyText.take(limit) + "…") else m
        }

    fun nonEmpty(s: String?): String? = s?.trim()?.takeIf { it.isNotEmpty() }
}
