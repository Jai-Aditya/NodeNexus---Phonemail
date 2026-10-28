package org.jaiaditya.phonemail.wear

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** An api error on the watch: [status] 0 means the server could not be reached; 401 means signed out. */
class WatchApiException(val status: Int, message: String) : Exception(message)

/**
 * The watch's few api calls: the same api as the phone's (`Authorization: Bearer <token>`), called over the watch's
 * own connection (through the phone, or Wi-Fi).
 */
class WatchApi(
    private val base: String,
    private val token: String,
    private val unreachable: String,
    private val failed: (Int) -> String,
) {
    @OptIn(ExperimentalSerializationApi::class)
    private val wire = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    private suspend fun call(method: String, path: String, body: String? = null): String = withContext(Dispatchers.IO) {
        val req = Request.Builder()
            .url(base + path)
            .header("X-Client", "mobile")
            .header("X-Requested-With", "PhoneMailWear")
            .header("Authorization", "Bearer $token")
            .method(method, if (method == "GET") null else (body ?: "{}").toRequestBody(JSON))
            .build()
        val res = try {
            http.newCall(req).execute()
        } catch (e: IOException) {
            throw WatchApiException(0, unreachable)
        }
        res.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val message = runCatching {
                    wire.parseToJsonElement(text).jsonObject["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content
                }.getOrNull()
                throw WatchApiException(it.code, message ?: failed(it.code))
            }
            text
        }
    }

    /** The Inbox, newest first. */
    suspend fun chats(): List<WatchChat> =
        wire.decodeFromString(WatchPage.serializer(WatchChat.serializer()), call("GET", "/mail/conversations?filter=all&limit=50")).items

    /** The newest 30 messages, oldest first. Opening a chat marks it read. */
    suspend fun messages(conversationId: Long): List<WatchMessage> {
        val page = wire.decodeFromString(
            WatchPage.serializer(WatchMessage.serializer()),
            call("GET", "/mail/conversations/$conversationId/messages?limit=30"),
        )
        runCatching { call("POST", "/mail/conversations/$conversationId/read") }
        return WatchMail.shown(page.items)
    }

    suspend fun reply(messageId: Long, conversationId: Long, text: String) {
        val body = buildJsonObject {
            put("conversation_id", conversationId)
            put("body_text", text)
        }
        call("POST", "/mail/messages/$messageId/reply", body.toString())
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        private val http = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}
