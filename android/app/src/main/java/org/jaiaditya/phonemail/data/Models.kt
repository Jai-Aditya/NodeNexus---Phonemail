package org.jaiaditya.phonemail.data

import kotlinx.serialization.Serializable

// The api's JSON shapes (docs-site/static/api/openapi.yaml). Unknown fields are ignored.

@Serializable
data class User(
    val id: Long,
    val phone: String,
    val address: String,
    val displayName: String? = null,
    val language: String = "en",
    val avatarUrl: String? = null,
    /** null = the default number bloom; "glyph:<emoji>:<#rrggbb>"; "photo:<name>.jpg". */
    val avatar: String? = null,
    val hasPush: Boolean = false,
    val createdVia: String = "",
    val hasPassword: Boolean = false,
    val aliases: List<String> = emptyList(),
)

/** Someone the user blocked: their direct mail goes to Spam. */
data class BlockedPerson(val userId: Long, val address: String, val name: String?) {
    val label: String get() = name ?: address
}

@Serializable
data class AuthResponse(val token: String, val user: User)

@Serializable
data class AuthMode(val mode: String, val smsJoin: Boolean = false, val smsTo: String? = null)

@Serializable
data class JoinStart(
    val code: String,
    val smsTo: String,
    val text: String,
    val qr: String? = null,
    val link: String? = null,
    val expiresAt: String = "",
)

@Serializable
data class JoinStatus(val status: String, val token: String? = null, val user: User? = null)

@Serializable
data class Conversation(
    val id: Long,
    val kind: String,
    val name: String? = null,
    val peerAddress: String? = null,
    val peerName: String? = null,
    val peerAvatar: String? = null,
    val lastMessageAt: String? = null,
    val lastMessageId: Long? = null,
    val snippet: String = "",
    val unreadCount: Int = 0,
    val hasAttachments: Boolean = false,
    val favouriteCount: Int = 0,
    val memberCount: Int = 0,
    val archived: Boolean = false,
    val muted: Boolean = false,
    /** Hidden from Home until this time (ISO); null when not snoozed. */
    val snoozedUntil: String? = null,
    /** The user's folder it is filed in, if any. */
    val folderId: Long? = null,
) {
    val isGroup get() = kind == "group"
    /** The server's name for the chat; screens add a contact name or a translated fallback (see Home). */
    val title get() = if (isGroup) name.orEmpty() else peerName ?: peerAddress.orEmpty()
}

@Serializable
data class Attachment(val id: Long, val filename: String, val contentType: String = "application/octet-stream", val size: Long = 0) {
    val isImage get() = contentType.startsWith("image/")
}

@Serializable
data class StockAvatars(val glyphs: List<String> = emptyList(), val colors: List<String> = emptyList())

@Serializable
data class Recipient(
    val kind: String,
    val address: String? = null,
    val groupId: Long? = null,
    val groupName: String? = null,
)

@Serializable
data class Message(
    val id: Long,
    val conversationId: Long = 0,
    val senderId: Long = 0,
    val senderAddress: String = "",
    val senderName: String? = null,
    val senderAvatar: String? = null,
    val subject: String = "",
    val body: String = "",
    val parentId: Long? = null,
    val rootId: Long = 0,
    val depth: Int = 0,
    val sentAt: String = "",
    val hasAttachments: Boolean = false,
    val isRead: Boolean = false,
    val isFavourite: Boolean = false,
    val isReplied: Boolean = false,
    val isMine: Boolean = false,
    val folder: String = "inbox",
    val recipients: List<Recipient> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
) {
    val senderLabel get() = senderName ?: senderAddress
}

@Serializable
data class DraftRecipients(
    val to: List<String> = emptyList(),
    val cc: List<String> = emptyList(),
    val bcc: List<String> = emptyList(),
)

@Serializable
data class Draft(
    val id: Long,
    val conversationId: Long? = null,
    val parentId: Long? = null,
    val recipients: DraftRecipients = DraftRecipients(),
    val subject: String = "",
    val body: String = "",
    val updatedAt: String = "",
    /** Set when the draft is scheduled: it goes out by itself then. */
    val sendAt: String? = null,
)

/** One of the user's own folders: chats filed there leave Home (they are archived) and show under the folder. */
data class Folder(val id: Long, val name: String, val chatCount: Int = 0, val unreadCount: Int = 0)

@Serializable
data class Delivered(val messageId: Long, val conversationIds: List<Long> = emptyList())

@Serializable
data class GroupMember(val userId: Long, val address: String, val role: String)

@Serializable
data class Group(val id: Long, val name: String, val created: Boolean = false, val members: List<GroupMember> = emptyList())

@Serializable
data class Lookup(val address: String, val exists: Boolean, val conversationId: Long? = null)

@Serializable
data class AliasAdded(val alias: String)
