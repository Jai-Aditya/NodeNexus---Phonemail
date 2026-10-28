package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.data.Message
import org.jaiaditya.phonemail.ui.autoReplyTarget
import org.jaiaditya.phonemail.ui.newestMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutoReplyTest {
    private fun msg(id: Long, mine: Boolean, at: String) = Message(id, conversationId = 7, isMine = mine, sentAt = at, body = "Hi")

    @Test
    fun repliesToTheNewestIncomingEmail() {
        // Newest first, as the api sends them.
        val chat = listOf(msg(2, mine = false, at = "2026-10-18T10:00:00Z"), msg(1, mine = true, at = "2026-10-18T09:00:00Z"))
        assertEquals(2L, autoReplyTarget(chat)?.id)
    }

    @Test
    fun goesByTimeNotListOrder() {
        val chat = listOf(msg(2, mine = true, at = "2026-10-18T10:00:00Z"), msg(3, mine = false, at = "2026-10-18T10:00:00.250Z"))
        assertEquals(3L, autoReplyTarget(chat)?.id)
    }

    @Test
    fun newEmailWhenTheNewestIsMine() {
        val chat = listOf(msg(2, mine = true, at = "2026-10-18T10:00:00Z"), msg(1, mine = false, at = "2026-10-18T09:00:00Z"))
        assertNull(autoReplyTarget(chat))
    }

    @Test
    fun cancelledStaysCancelledUntilANewerEmail() {
        val chat = listOf(msg(2, mine = false, at = "2026-10-18T10:00:00Z"), msg(1, mine = true, at = "2026-10-18T09:00:00Z"))
        val dismissed = newestMessage(chat)?.id
        assertNull(autoReplyTarget(chat, dismissed = dismissed))
        val more = listOf(msg(3, mine = false, at = "2026-10-18T11:00:00Z")) + chat
        assertEquals(3L, autoReplyTarget(more, dismissed = dismissed)?.id)
    }

    @Test
    fun nothingInAnEmptyChatOrOneThatCantBeWritten() {
        assertNull(autoReplyTarget(emptyList()))
        assertNull(autoReplyTarget(listOf(msg(2, mine = false, at = "2026-10-18T10:00:00Z")), canWrite = false))
    }
}
