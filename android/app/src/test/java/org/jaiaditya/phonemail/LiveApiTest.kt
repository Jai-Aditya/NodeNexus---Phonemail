package org.jaiaditya.phonemail

import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.jaiaditya.phonemail.data.Api
import org.jaiaditya.phonemail.data.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * The app's api layer (Api.kt) against a running PhoneMail api in password mode: every call the screens make.
 * Runs only with `-PliveApi=http://<host>/api` (e.g. the staging copy of the live build); it creates throwaway
 * accounts, so never point it at production.
 */
class LiveApiTest {
    private val base = System.getProperty("liveApi").orEmpty()

    private class Person(base: String) {
        var token: String? = null
        val api = Api(base, token = { token }, onUnauthorized = {})
        val phone = "9" + (1..9).joinToString("") { Random.nextInt(10).toString() }
    }

    private fun person() = Person(base).also { p -> runBlocking { p.token = p.api.passwordRegister(p.phone, "test-pass-123").token } }

    @Test
    fun everyCallTheScreensMake() = runBlocking {
        assumeTrue("set -PliveApi to run", base.isNotEmpty())
        val a = person()
        val b = person()
        val c = person()
        assertEquals("password", a.api.authMode().mode)

        // profile
        val me = a.api.updateMe("displayName" to "Asha Test", "language" to "ta")
        assertEquals("Asha Test", me.displayName)
        assertEquals("ta", me.language)
        assertTrue(me.address.startsWith(a.phone))
        assertTrue(a.api.me().hasPassword)

        // live events for B, opened before A writes
        val gotEvent = CountDownLatch(1)
        val stream = Thread {
            runCatching {
                val req = Request.Builder().url("$base/events").header("Authorization", "Bearer ${b.token}").build()
                b.api.http.newBuilder().readTimeout(30, TimeUnit.SECONDS).build().newCall(req).execute().use { res ->
                    val src = res.body!!.source()
                    while (!src.exhausted()) {
                        val line = src.readUtf8Line() ?: break
                        if (line.startsWith("event:") && line.substringAfter(":").trim() != "ready") { gotEvent.countDown(); break }
                    }
                }
            }
        }.apply { isDaemon = true; start() }
        Thread.sleep(1500)

        // A writes to B
        val sent = a.api.send(b.phone, emptyList(), emptyList(), "Hello from the test", "First email")
        assertTrue(sent.messageId > 0)
        assertTrue("live event reached B", gotEvent.await(10, TimeUnit.SECONDS))
        stream.interrupt()

        // B's home, chat, message
        val chat = b.api.conversations("all").first { it.peerAddress?.startsWith(a.phone) == true }
        assertEquals(1, chat.unreadCount)
        assertEquals("Asha Test", chat.peerName)
        val msgs = b.api.chatMessages(chat.id)
        assertEquals("First email", msgs.first().body)
        assertEquals("Hello from the test", msgs.first().subject)
        assertEquals("Asha Test", msgs.first().senderLabel)
        assertEquals(0, b.api.conversations("unread").count { it.id == chat.id }) // opening the chat read it
        assertEquals("First email", b.api.message(sent.messageId).body)

        // replying again to the same email is fine
        val first = b.api.reply(sent.messageId, chat.id, "Thanks!")
        val again = b.api.reply(sent.messageId, chat.id, "Again")
        assertTrue("a second reply goes too", again.messageId > 0 && again.messageId != first.messageId)
        assertTrue(b.api.message(sent.messageId).isReplied)

        // a file, through the draft that carries it
        val bytes = "hello attachment".toByteArray()
        val att = a.api.uploadAttachment("note.txt", "text/plain", bytes.size.toLong(), { bytes.inputStream() }) {}
        assertEquals("note.txt", att.filename)
        val withFile = a.api.send(b.phone, emptyList(), emptyList(), "With a file", "See attached", attachmentIds = listOf(att.id))
        val m = b.api.message(withFile.messageId)
        assertEquals(listOf("note.txt"), m.attachments.map { it.filename })
        val dest = File.createTempFile("att", ".txt")
        b.api.downloadAttachment(m.attachments.first().id, dest)
        assertEquals("hello attachment", dest.readText())
        dest.delete()

        // a reply with a file
        val rbytes = "reply file".toByteArray()
        val ratt = b.api.uploadAttachment("reply.txt", "text/plain", rbytes.size.toLong(), { rbytes.inputStream() }) {}
        val r = b.api.reply(withFile.messageId, chat.id, "Here is mine", listOf(ratt.id))
        assertEquals(listOf("reply.txt"), a.api.message(r.messageId).attachments.map { it.filename })

        // drafts
        val d = a.api.saveDraft(null, listOf(b.phone), emptyList(), emptyList(), "Draft subject", "Draft body")
        val listed = a.api.drafts().first { it.id == d.id }
        assertEquals("Draft body", listed.body)
        assertTrue(listed.recipients.to.single().startsWith(b.phone))
        a.api.saveDraft(d.id, listOf(b.phone, c.phone), emptyList(), emptyList(), "Draft subject", "Changed")
        assertEquals(2, a.api.drafts().first { it.id == d.id }.recipients.to.size)
        a.api.deleteDraft(d.id)
        assertNull(a.api.drafts().firstOrNull { it.id == d.id })

        // a group, and mail to it
        val g = a.api.createGroup("Test group", listOf(b.phone, c.phone))
        assertTrue(g.id > 0)
        a.api.send(g.id, emptyList(), emptyList(), "To the group", "Hi all")
        assertTrue(c.api.conversations("all").any { it.isGroup && it.title == "Test group" })

        // flags, folders, search
        b.api.setFlags(sent.messageId, "isFavourite" to true)
        assertTrue(b.api.conversations("favorites").any { it.id == chat.id })
        b.api.setFlags(sent.messageId, "folder" to "trash")
        assertTrue(b.api.folder("trash").any { it.id == sent.messageId })
        b.api.setFlags(sent.messageId, "folder" to "inbox")
        assertTrue(a.api.search("group").any { it.subject == "To the group" })
        assertTrue(a.api.lookup(b.phone).exists)

        // aliases
        val alias = "t" + (1..8).joinToString("") { Random.nextInt(10).toString() }
        val added = a.api.addAlias(alias).alias // the api answers with the full address
        assertTrue(added.startsWith(alias))
        assertTrue(a.api.me().aliases.any { it.startsWith(alias) })
        a.api.removeAlias(a.api.me().aliases.first { it.startsWith(alias) }) // as Settings does, with the listed value
        assertTrue(a.api.me().aliases.none { it.startsWith(alias) })

        // profile picture: upload, public address, back to the bloom
        val png = javaClass.classLoader!!.getResourceAsStream("pixel.png")?.readBytes() ?: TINY_PNG
        val withPic = a.api.uploadAvatar(png, "image/png")
        assertNotNull(withPic.avatar)
        assertTrue(withPic.avatar!!.startsWith("photo:"))
        val picRes = a.api.http.newCall(Request.Builder().url(a.api.photoUrl(withPic.avatar!!)).build()).execute()
        assertEquals(200, picRes.code); picRes.close()
        assertNull(a.api.resetAvatar().avatar)

        // password change, then sign in with the new one
        a.api.changePassword("test-pass-123", "test-pass-456")
        val again2 = a.api.passwordLogin(a.phone, "test-pass-456")
        assertTrue(again2.token.isNotEmpty())
        val wrong = runCatching { a.api.passwordLogin(a.phone, "test-pass-123") }.exceptionOrNull()
        assertTrue(wrong is ApiException && wrong.status == 401 && wrong.message!!.isNotBlank())
    }

    companion object {
        /** A 1x1 PNG. */
        val TINY_PNG: ByteArray = java.util.Base64.getDecoder()
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
    }
}
