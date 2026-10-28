package org.jaiaditya.phonemail.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The JSON the PhoneMail api sends (mail.phonemail.net since 30 Sep 2026: snake_case names, lists wrapped in
// {"items": [...]}). Read with Api.wire (snake_case naming) and turned into the app's own models (Models.kt), so the
// screens don't depend on the server's shapes. Unknown fields are ignored.

@Serializable
data class WUser(
    val id: Long,
    val phone: String = "",
    val address: String = "",
    val displayName: String = "",
    val language: String = "en",
    val avatarUrl: String = "",
    val hasPush: Boolean = false,
    val hasPassword: Boolean = false,
    val createdVia: String = "",
    val aliases: List<String> = emptyList(),
)

@Serializable
data class WAuth(val token: String? = null, val user: WUser, val created: Boolean = false)

@Serializable
data class WAuthConfig(val mode: String = "otp", val passwordReset: Boolean = false, val domain: String = "", val signupNumber: String? = null)

@Serializable
data class WPerson(val userId: Long = 0, val address: String = "", val displayName: String = "", val avatarUrl: String = "")

@Serializable
data class WChat(
    val conversationId: Long,
    val kind: String = "direct",
    val name: String = "",
    val peer: WPerson? = null,
    val memberCount: Int = 0,
    val lastMessageAt: String? = null,
    val lastMessageId: Long? = null,
    val snippet: String = "",
    val unreadCount: Int = 0,
    val hasAttachments: Boolean = false,
    val favouriteCount: Int = 0,
    /** Left out when false. */
    val archived: Boolean = false,
    val muted: Boolean = false,
    val snoozedUntil: String? = null,
    /** The user's folder the chat is filed in; left out when none. */
    val folderId: Long? = null,
)

/** {"changed": n} from POST /mail/conversations/actions. */
@Serializable
data class WChanged(val changed: Int = 0)

/** One of the user's own folders (GET /mail/folders, A–Z). */
@Serializable
data class WFolder(val id: Long, val name: String = "", val chatCount: Int = 0, val unreadCount: Int = 0, val createdAt: String = "")

@Serializable
data class WRecipient(val kind: String = "to", val person: WPerson? = null, val groupId: Long? = null, val groupName: String? = null)

@Serializable
data class WAttachment(val id: Long, val filename: String = "", val contentType: String = "application/octet-stream", val sizeBytes: Long = 0)

@Serializable
data class WMessage(
    val id: Long,
    val conversationId: Long = 0,
    val sender: WPerson = WPerson(),
    val subject: String = "",
    val bodyText: String = "",
    val snippet: String = "",
    val parentId: Long? = null,
    val rootId: Long = 0,
    val depth: Int = 0,
    val hasAttachments: Boolean = false,
    val sentAt: String = "",
    val folder: String = "inbox",
    val isRead: Boolean = false,
    val isFavourite: Boolean = false,
    val isReplied: Boolean = false,
    val isMine: Boolean = false,
    val recipients: List<WRecipient> = emptyList(),
    val attachments: List<WAttachment> = emptyList(),
)

@Serializable
data class WPage<T>(val items: List<T> = emptyList())

@Serializable
data class WSearch(val messages: List<WMessage> = emptyList())

/** One recipient as the api takes it: a person (number or address) or a group. */
@Serializable
data class WTo(val address: String? = null, val groupId: Long? = null)

@Serializable
data class WDraftRecipients(
    /** One recipient object, or a list of them (the api writes a single To as an object). */
    val to: JsonElement? = null,
    val cc: List<WTo> = emptyList(),
    val bcc: List<WTo> = emptyList(),
)

@Serializable
data class WDraft(
    val id: Long,
    val conversationId: Long? = null,
    val parentId: Long? = null,
    val recipients: WDraftRecipients = WDraftRecipients(),
    val subject: String = "",
    val bodyText: String = "",
    val updatedAt: String = "",
    /** When a scheduled draft goes out (absent for plain drafts). */
    val sendAt: String? = null,
)

@Serializable
data class WSent(val messageId: Long, val conversationIds: List<Long> = emptyList())

@Serializable
data class WMember(val userId: Long = 0, val address: String = "", val role: String = "member")

@Serializable
data class WGroup(val conversationId: Long, val name: String = "", val created: Boolean = false, val members: List<WMember> = emptyList())

@Serializable
data class WSuggestions(val people: List<WSuggestion> = emptyList())

@Serializable
data class WSuggestion(val address: String = "", val conversationId: Long? = null, val known: Boolean = false)
