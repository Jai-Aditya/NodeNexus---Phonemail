package org.jaiaditya.phonemail.wear

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchMailTest {
    private fun msg(id: Long, mine: Boolean, body: String = "b$id", parent: Long? = null, subject: String = "") =
        WatchMessage(id = id, isMine = mine, bodyText = body, parentId = parent, subject = subject,
            sender = WatchPerson(address = "98765${id}@phonemail.net", displayName = if (mine) "" else "Asha"))

    @Test
    fun replyTargetIsNewestFromSomeoneElse() {
        val shown = listOf(msg(1, false), msg(2, false), msg(3, true))
        assertEquals(2L, WatchMail.replyTarget(shown)?.id)
        assertNull(WatchMail.replyTarget(listOf(msg(1, true))))
        assertNull(WatchMail.replyTarget(emptyList()))
    }

    @Test
    fun shownIsOldestFirstAndCutsLongBodies() {
        val shown = WatchMail.shown(listOf(msg(3, false, "x".repeat(700)), msg(2, true), msg(1, false)))
        assertEquals(listOf(1L, 2L, 3L), shown.map { it.id })
        assertEquals(601, shown.last().bodyText.length)
        assertEquals('…', shown.last().bodyText.last())
    }

    @Test
    fun titles() {
        assertEquals("Family", WatchMail.title(WatchChat(1, kind = "group", name = "Family"), "Group", "Conversation"))
        assertEquals("Group", WatchMail.title(WatchChat(1, kind = "group", name = " "), "Group", "Conversation"))
        assertEquals("Asha", WatchMail.title(WatchChat(1, peer = WatchPerson("a@x", "Asha")), "Group", "Conversation"))
        assertEquals("a@x", WatchMail.title(WatchChat(1, peer = WatchPerson("a@x", "")), "Group", "Conversation"))
        assertEquals("Conversation", WatchMail.title(WatchChat(1), "Group", "Conversation"))
    }

    @Test
    fun subjectsOnlyOnNewEmails() {
        assertEquals("Hello", WatchMail.shownSubject(msg(1, false, subject = "Hello")))
        assertNull(WatchMail.shownSubject(msg(2, false, parent = 1, subject = "Re: Hello")))
        assertEquals("You", WatchMail.senderLabel(msg(3, true), "You"))
        assertEquals("Asha", WatchMail.senderLabel(msg(4, false), "You"))
    }

    @OptIn(ExperimentalSerializationApi::class)
    @Test
    fun readsTheApisSnakeCase() {
        val wire = Json { ignoreUnknownKeys = true; explicitNulls = false; namingStrategy = JsonNamingStrategy.SnakeCase }
        val page = wire.decodeFromString(
            WatchPage.serializer(WatchChat.serializer()),
            """{"items":[{"conversation_id":7,"kind":"direct","peer":{"user_id":3,"address":"a@x","display_name":"Asha"},
               "snippet":"hi","unread_count":2,"muted":false}]}""",
        )
        assertEquals(7L, page.items[0].conversationId)
        assertEquals("Asha", page.items[0].peer?.displayName)
        assertEquals(2, page.items[0].unreadCount)
    }
}
