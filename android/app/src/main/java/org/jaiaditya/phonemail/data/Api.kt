package org.jaiaditya.phonemail.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNamingStrategy
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** An api error: [status] 0 means the server could not be reached. */
class ApiException(val status: Int, message: String) : Exception(message)

/**
 * The PhoneMail api at `/api` (the build live on mail.phonemail.net since 30 Sep 2026). Mail calls are under
 * `/api/mail/`; JSON uses snake_case and lists come as {"items": [...]}. Replies are turned into the app's own
 * models (Models.kt) here, so the screens don't change with the server's shapes.
 *
 * Every call sends `Authorization: Bearer <token>` once signed in (the sign-in calls send `client: "mobile"`, which
 * is what makes the api hand out a token instead of a browser cookie) and `X-Requested-With`, which the api asks of
 * every change made without a token.
 */
class Api(
    val base: String,
    private val token: () -> String?,
    private val onUnauthorized: () -> Unit,
    /** Translated texts for errors the app writes itself (the server's own messages come as they are). */
    private val unreachable: () -> String = { "Cannot reach PhoneMail. Check your connection and try again." },
    private val failed: (Int) -> String = { "Request failed ($it)" },
) {
    /** The app's own JSON (the profile kept on the phone). */
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    /** The server's JSON: snake_case names. */
    @OptIn(ExperimentalSerializationApi::class)
    val wire = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    private fun Request.Builder.common(): Request.Builder = apply {
        header("X-Client", "mobile")
        header("X-Requested-With", "PhoneMailAndroid")
        token()?.let { header("Authorization", "Bearer $it") }
    }

    /** Performs a call and returns the response text ("" for 204). */
    suspend fun call(method: String, path: String, body: JsonElement? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(base + path)
            .common()
            .method(method, body?.toString()?.toRequestBody(jsonType) ?: if (method == "GET" || method == "DELETE") null else "{}".toRequestBody(jsonType))
            .build()
        execute(req, path) { it.body?.string().orEmpty() }
    }

    private suspend inline fun <reified T> getW(path: String): T = wire.decodeFromString(call("GET", path))
    private suspend inline fun <reified T> sendW(method: String, path: String, body: JsonElement): T = wire.decodeFromString(call(method, path, body))

    // ---- sign-in ----

    suspend fun authMode(): AuthMode {
        val c = getW<WAuthConfig>("/auth/config")
        // Texting JOIN still creates an account, but the api can't link that text to this phone's sign-in, so the app
        // verifies with a code or a password; the number is kept for the "text or call to sign up" hint.
        return AuthMode(mode = c.mode, smsJoin = false, smsTo = c.signupNumber)
    }

    /** [appHash] was for Android's SMS Retriever; the api's texts don't carry it, so the code is typed (or autofilled). */
    suspend fun otpStart(phone: String, @Suppress("UNUSED_PARAMETER") appHash: String?) =
        call("POST", "/auth/otp/start", obj("phone" to phone))

    suspend fun otpVerify(phone: String, code: String) =
        auth(sendW("POST", "/auth/otp/verify", obj("phone" to phone, "code" to code, "client" to "mobile")))

    suspend fun joinStart(@Suppress("UNUSED_PARAMETER") phone: String): JoinStart =
        throw ApiException(501, "Signing in by text isn't available in the app. Use the code we text you, or a password.")

    suspend fun joinStatus(@Suppress("UNUSED_PARAMETER") code: String): JoinStatus = JoinStatus("expired")

    suspend fun passwordLogin(phone: String, password: String) =
        auth(sendW("POST", "/auth/login", obj("phone" to phone, "password" to password, "client" to "mobile")))

    /** Works only when the server is in password mode; otherwise the api asks for a code instead (its message is shown). */
    suspend fun passwordRegister(phone: String, password: String) =
        auth(sendW("POST", "/auth/register", obj("phone" to phone, "password" to password, "client" to "mobile")))

    private fun auth(a: WAuth): AuthResponse =
        AuthResponse(a.token ?: throw ApiException(500, failed(500)), a.user.toUser())

    // ---- profile ----

    suspend fun me(): User = getW<WUser>("/me").toUser()

    /** Fields by the app's names (displayName, language). */
    suspend fun updateMe(vararg fields: Pair<String, Any?>): User =
        sendW<WUser>("PATCH", "/me", obj(*fields.map { (k, v) -> snake(k) to v }.toTypedArray())).toUser()

    /** The api asks for the current password whenever one exists. */
    suspend fun changePassword(current: String?, new: String) =
        call("PUT", "/me/password", obj("current_password" to current, "new_password" to new))

    suspend fun addAlias(alias: String) = sendW<AliasAdded>("POST", "/me/aliases", obj("alias" to alias))
    suspend fun removeAlias(alias: String) = call("DELETE", "/me/aliases/${enc(alias)}")

    /** Erases the account for good. Confirmed with the password, or (accounts without one) a code from [otpStart]. */
    suspend fun deleteAccount(password: String?, code: String?) =
        call("DELETE", "/me", obj("password" to password, "code" to code))

    // ---- blocking: a blocked person's direct mail goes to Spam (groups are not affected) ----

    suspend fun blocks(): List<BlockedPerson> = getW<WPage<WPerson>>("/mail/blocks").items.map { it.toBlocked() }

    /** A number, address or alias; people outside PhoneMail can be blocked too. */
    suspend fun block(address: String): BlockedPerson = sendW<WPerson>("POST", "/mail/blocks", obj("address" to address)).toBlocked()

    suspend fun unblock(userId: Long) = call("DELETE", "/mail/blocks/$userId")

    // ---- reading ----

    /** [filter]: all, unread, attachments, favorites, snoozed, archived, everything, or folder:<id> (one of the user's folders). */
    suspend fun conversations(filter: String): List<Conversation> =
        getW<WPage<WChat>>("/mail/conversations?filter=${enc(filter)}&limit=100").items.map { it.toConversation() }

    /** One chat as it stands (archived, muted, snoozed, its folder), for the chat's menu. */
    suspend fun conversation(id: Long): Conversation = getW<WChat>("/mail/conversations/$id").toConversation()

    // ---- changing chats, and the user's own folders ----

    /**
     * Changes several chats at once and returns how many changed. [action]: archive, unarchive, trash, read, unread,
     * mute, unmute, snooze (until [until], an ISO time), unsnooze, move (files them in [folderId] and archives them) or
     * unfile (out of their folder, back to Home). The api takes at most 100 chats a call, so longer lists go in turns.
     */
    suspend fun chatAction(ids: List<Long>, action: String, until: String? = null, folderId: Long? = null): Int =
        ids.chunked(100).sumOf { part ->
            sendW<WChanged>(
                "POST", "/mail/conversations/actions",
                obj("conversation_ids" to part, "action" to action, "until" to until, "folder_id" to folderId),
            ).changed
        }

    /** A–Z, with how many chats (and unread ones) each holds. */
    suspend fun folders(): List<Folder> = getW<WPage<WFolder>>("/mail/folders").items.map { it.toFolder() }

    /** The api refuses an empty name, more than 40 characters, a built-in name (Inbox, Spam…) or one already used; its message is shown. */
    suspend fun createFolder(name: String): Folder = sendW<WFolder>("POST", "/mail/folders", obj("name" to name)).toFolder()

    suspend fun renameFolder(id: Long, name: String) = call("PATCH", "/mail/folders/$id", obj("name" to name))

    /** Its chats stay archived (in All mail). */
    suspend fun deleteFolder(id: Long) = call("DELETE", "/mail/folders/$id")

    /**
     * The newest messages of a chat first; the first page also marks the chat read (as the app expects). Older pages:
     * [before] and [beforeId] are the oldest message already shown (the api pages by time and id together).
     */
    suspend fun chatMessages(conversationId: Long, before: String? = null, beforeId: Long? = null): List<Message> {
        val cursor = before?.let { "&before=${enc(it)}" + (beforeId?.let { id -> "&before_id=$id" } ?: "") } ?: ""
        val page = getW<WPage<WMessage>>("/mail/conversations/$conversationId/messages?limit=50$cursor")
        if (before == null) runCatching { markRead(conversationId) }
        return page.items.map { it.toMessage() }
    }

    /** Marks every message of a chat read (also the notification's Mark as read). */
    suspend fun markRead(conversationId: Long) = call("POST", "/mail/conversations/$conversationId/read")

    suspend fun message(id: Long): Message = getW<WMessage>("/mail/messages/$id").toMessage()

    suspend fun lookup(q: String): Lookup {
        val p = getW<WSuggestions>("/mail/suggest?q=${enc(q)}").people.firstOrNull()
        return Lookup(address = p?.address ?: q, exists = p?.known == true, conversationId = p?.conversationId)
    }

    suspend fun setFlags(messageId: Long, vararg flags: Pair<String, Any?>) =
        call("PATCH", "/mail/mailbox/$messageId", obj(*flags.map { (k, v) -> snake(k) to v }.toTypedArray()))

    suspend fun folder(name: String): List<Message> = getW<WPage<WMessage>>("/mail/folders/$name?limit=100").items.map { it.toMessage() }
    suspend fun search(q: String): List<Message> = getW<WSearch>("/mail/search?q=${enc(q)}").messages.map { it.toMessage() }

    // ---- sending ----

    /**
     * [to] is a person (number or address) or a group id. With files, the message goes out through the draft that holds
     * them (the api keeps attachments on a draft); [draftId] is the editor's autosaved draft, removed once sent.
     */
    suspend fun send(
        to: Any, cc: List<String>, bcc: List<String>, subject: String, body: String, draftId: Long? = null,
        attachmentIds: List<Long> = emptyList(),
    ): Delivered {
        val toJson = if (to is Long) obj("group_id" to to) else obj("address" to to.toString())
        val recipients = listOf("to" to toJson, "cc" to people(cc), "bcc" to people(bcc))
        val carrier = fileDraft
        if (attachmentIds.isNotEmpty() && carrier != null) {
            sendW<WDraft>("PUT", "/mail/drafts/$carrier", obj("recipients" to obj(*recipients.toTypedArray()), "subject" to subject, "body_text" to body))
            val sent = sendW<WSent>("POST", "/mail/drafts/$carrier/send", obj())
            fileDraft = null
            draftId?.let { runCatching { deleteDraft(it) } }
            return sent.toDelivered()
        }
        return sendW<WSent>(
            "POST", "/mail/messages",
            obj(*recipients.toTypedArray(), "subject" to subject, "body_text" to body, "draft_id" to draftId),
        ).toDelivered()
    }

    suspend fun reply(messageId: Long, conversationId: Long, body: String, attachmentIds: List<Long> = emptyList()): Delivered {
        val carrier = fileDraft
        if (attachmentIds.isNotEmpty() && carrier != null) {
            sendW<WDraft>(
                "PUT", "/mail/drafts/$carrier",
                obj("conversation_id" to conversationId, "parent_id" to messageId, "recipients" to obj(), "subject" to "", "body_text" to body),
            )
            val sent = sendW<WSent>("POST", "/mail/drafts/$carrier/send", obj())
            fileDraft = null
            return sent.toDelivered()
        }
        return sendW<WSent>("POST", "/mail/messages/$messageId/reply", replyBody(conversationId, body)).toDelivered()
    }

    // ---- push notifications: this phone's Firebase token, so the api can tell it about new mail ----

    /** 201 {"ok": true}; sent again on every start (the api keeps one row per token). */
    suspend fun registerPush(fcmToken: String) = call("POST", "/push/devices", pushDevice(fcmToken))

    /** Before signing out or deleting the account. */
    suspend fun unregisterPush(fcmToken: String) = call("DELETE", "/push/devices", obj("token" to fcmToken))

    // ---- attachments: they live on a draft until it is sent ----

    /** The draft carrying the files being attached (one editor at a time). */
    @Volatile private var fileDraft: Long? = null

    private suspend fun carrierDraft(): Long =
        fileDraft ?: sendW<WDraft>("POST", "/mail/drafts", obj("recipients" to obj(), "subject" to "", "body_text" to "")).id.also { fileDraft = it }

    /** Uploads a file onto the carrier draft and reports progress 0..1 as bytes go out. */
    suspend fun uploadAttachment(name: String, type: String, size: Long, open: () -> InputStream, progress: (Float) -> Unit): Attachment {
        val draft = carrierDraft()
        return withContext(Dispatchers.IO) {
            val file = object : RequestBody() {
                override fun contentType() = type.toMediaTypeOrNull()
                override fun contentLength() = size
                override fun writeTo(sink: BufferedSink) {
                    open().use { input ->
                        val buf = ByteArray(64 * 1024)
                        var sent = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            sink.write(buf, 0, n)
                            sent += n
                            if (size > 0) progress((sent.toFloat() / size).coerceAtMost(1f))
                        }
                    }
                }
            }
            val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("file", name, file).build()
            val req = Request.Builder().url("$base/mail/drafts/$draft/attachments").common().post(form).build()
            execute(req, "/mail/drafts") { wire.decodeFromString<WAttachment>(it.body?.string().orEmpty()).toAttachment() }
        }
    }

    suspend fun discardAttachment(id: Long) {
        fileDraft?.let { call("DELETE", "/mail/drafts/$it/attachments/$id") }
    }

    /** Downloads an attachment into [dest] (with the sign-in token). */
    suspend fun downloadAttachment(id: Long, dest: File) = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$base/mail/attachments/$id").common().build()
        execute(req, "/mail/attachments") { res ->
            dest.parentFile?.mkdirs()
            val tmp = File(dest.path + ".part")
            res.body!!.byteStream().use { input -> tmp.outputStream().use { input.copyTo(it) } }
            dest.delete() // a rename doesn't replace an existing file everywhere
            tmp.renameTo(dest)
        }
    }

    /** An attachment's address, for thumbnails loaded with [authHeader]. */
    fun attachmentUrl(id: Long): String = "$base/mail/attachments/$id"

    /** The Authorization header for images that need the sign-in (attachment thumbnails). */
    fun authHeader(): String? = token()?.let { "Bearer $it" }

    private inline fun <T> execute(req: Request, path: String, read: (okhttp3.Response) -> T): T {
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw ApiException(0, unreachable())
        }
        return res.use {
            if (it.code == 401 && token() != null && !path.startsWith("/auth/")) onUnauthorized()
            if (!it.isSuccessful) throw ApiException(it.code, errorMessage(it.body?.string().orEmpty()) ?: failed(it.code))
            read(it)
        }
    }

    /** The api's error text: {"error": {"code", "message"}} (older servers sent {"error": "text"}). */
    private fun errorMessage(text: String): String? = runCatching {
        when (val e = json.parseToJsonElement(text).jsonObject["error"]) {
            is JsonObject -> e["message"]?.jsonPrimitive?.contentOrNull
            is JsonPrimitive -> e.contentOrNull
            else -> null
        }
    }.getOrNull()

    // ---- profile picture ----

    /** The api has no stock glyph list: the app's own set is used, and the glyph is drawn into a picture on the phone. */
    suspend fun stockAvatars() = StockAvatars()

    suspend fun resetAvatar(): User = wire.decodeFromString<WUser>(call("DELETE", "/me/avatar")).toUser()

    /** Uploads a picture (a photo, or a glyph drawn on the phone) as the profile picture. */
    suspend fun uploadAvatar(bytes: ByteArray, type: String): User = withContext(Dispatchers.IO) {
        val req = Request.Builder().url("$base/me/avatar").common().put(bytes.toRequestBody(type.toMediaType())).build()
        execute(req, "/me/avatar") { wire.decodeFromString<WUser>(it.body?.string().orEmpty()).toUser() }
    }

    suspend fun uploadAvatarPhoto(jpeg: ByteArray): User = uploadAvatar(jpeg, "image/jpeg")

    /** A public photo avatar's address ("photo:<name>" -> https://…/api/avatars/<name>). */
    fun photoUrl(avatar: String): String = "$base/avatars/" + avatar.removePrefix("photo:")

    // ---- drafts and groups ----

    suspend fun drafts(): List<Draft> = wire.decodeFromString<WPage<WDraft>>(call("GET", "/mail/drafts")).items.map { it.toDraft() }

    suspend fun saveDraft(id: Long?, to: List<String>, cc: List<String>, bcc: List<String>, subject: String, body: String): Draft {
        val payload = obj("recipients" to obj("to" to people(to), "cc" to people(cc), "bcc" to people(bcc)), "subject" to subject, "body_text" to body)
        return (if (id == null) sendW<WDraft>("POST", "/mail/drafts", payload) else sendW("PUT", "/mail/drafts/$id", payload)).toDraft()
    }

    suspend fun deleteDraft(id: Long) = call("DELETE", "/mail/drafts/$id")

    /** Cancels a scheduled send: the draft stays, back among the drafts. */
    suspend fun unschedule(id: Long): Draft = sendW<WDraft>("POST", "/mail/drafts/$id/unschedule", obj()).toDraft()

    suspend fun createGroup(name: String, members: List<String>): Group {
        val g = sendW<WGroup>("POST", "/mail/groups", obj("name" to name, "members" to people(members)))
        return Group(g.conversationId, g.name, g.created, g.members.map { GroupMember(it.userId, it.address, it.role) })
    }

    // ---- from the server's shapes to the app's ----

    private fun avatarOf(url: String): String? = url.takeIf { it.startsWith("/api/avatars/") }?.let { "photo:" + it.removePrefix("/api/avatars/") }

    private fun WUser.toUser() = User(
        id = id, phone = phone, address = address, displayName = displayName.ifBlank { null }, language = language,
        avatar = avatarOf(avatarUrl), hasPush = hasPush, createdVia = createdVia, hasPassword = hasPassword, aliases = aliases,
    )

    private fun WChat.toConversation() = Conversation(
        id = conversationId, kind = kind, name = name.ifBlank { null }, peerAddress = peer?.address, peerName = peer?.displayName?.ifBlank { null },
        peerAvatar = peer?.let { avatarOf(it.avatarUrl) }, lastMessageAt = lastMessageAt, lastMessageId = lastMessageId, snippet = snippet,
        unreadCount = unreadCount, hasAttachments = hasAttachments, favouriteCount = favouriteCount, memberCount = memberCount,
        archived = archived, muted = muted, snoozedUntil = snoozedUntil, folderId = folderId,
    )

    private fun WFolder.toFolder() = Folder(id, name, chatCount, unreadCount)

    private fun WPerson.toBlocked() = BlockedPerson(userId, address, displayName.ifBlank { null })

    private fun WAttachment.toAttachment() = Attachment(id, filename, contentType, sizeBytes)

    private fun WMessage.toMessage() = Message(
        id = id, conversationId = conversationId, senderId = sender.userId, senderAddress = sender.address,
        senderName = sender.displayName.ifBlank { null }, senderAvatar = avatarOf(sender.avatarUrl), subject = subject,
        body = bodyText.ifEmpty { snippet }, parentId = parentId, rootId = rootId, depth = depth, sentAt = sentAt, hasAttachments = hasAttachments,
        isRead = isRead, isFavourite = isFavourite, isReplied = isReplied, isMine = isMine, folder = folder,
        recipients = recipients.map { Recipient(it.kind, it.person?.address, it.groupId, it.groupName) },
        attachments = attachments.map { it.toAttachment() },
    )

    private fun WDraft.toDraft(): Draft {
        val to = when (val t = recipients.to) {
            is JsonArray -> t.mapNotNull { (it as? JsonObject)?.get("address")?.jsonPrimitive?.contentOrNull }
            is JsonObject -> listOfNotNull(t["address"]?.jsonPrimitive?.contentOrNull)
            else -> emptyList()
        }
        return Draft(
            id = id, conversationId = conversationId, parentId = parentId,
            recipients = DraftRecipients(to, recipients.cc.mapNotNull { it.address }, recipients.bcc.mapNotNull { it.address }),
            subject = subject, body = bodyText, updatedAt = updatedAt, sendAt = sendAt,
        )
    }

    private fun WSent.toDelivered() = Delivered(messageId, conversationIds)

    companion object {
        fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        /** "9876543210" and "9876543210@phonemail.net" (any case) are the same person. */
        fun sameAddress(a: String, b: String): Boolean {
            fun key(s: String) = s.trim().lowercase().removeSuffix("@phonemail.net")
            return key(a) == key(b)
        }

        /** "displayName" -> "display_name" (the app's names to the api's). */
        fun snake(k: String): String = k.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").lowercase()

        /** A reply's body (the chat's own reply bar and the notification's Reply send the same). */
        fun replyBody(conversationId: Long, text: String): JsonObject = obj("conversation_id" to conversationId, "body_text" to text)

        /** This phone as a push device: {"platform": "android", "token": "<fcm token>"}. */
        fun pushDevice(fcmToken: String): JsonObject = obj("platform" to "android", "token" to fcmToken)

        /** People as the api takes them: [{"address": "9876543210"}, ...]. */
        fun people(list: List<String>): JsonArray = JsonArray(list.map { obj("address" to it) })

        /** Builds a JSON object from Kotlin values (null values are left out). */
        fun obj(vararg pairs: Pair<String, Any?>): JsonObject =
            JsonObject(pairs.filter { it.second != null }.associate { (k, v) -> k to toJson(v) })

        private fun toJson(v: Any?): JsonElement = when (v) {
            null -> JsonNull
            is JsonElement -> v
            is String -> JsonPrimitive(v)
            is Number -> JsonPrimitive(v)
            is Boolean -> JsonPrimitive(v)
            is List<*> -> JsonArray(v.map { toJson(it) })
            else -> JsonPrimitive(v.toString())
        }
    }
}
