package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.data.Api
import org.jaiaditya.phonemail.data.Conversation
import org.jaiaditya.phonemail.data.WChat
import org.jaiaditya.phonemail.data.WDraft
import org.jaiaditya.phonemail.data.WFolder
import org.jaiaditya.phonemail.data.WPage
import org.jaiaditya.phonemail.ui.ChatUndo
import org.jaiaditya.phonemail.ui.FILTERS
import org.jaiaditya.phonemail.ui.moveToInboxAction
import org.jaiaditya.phonemail.ui.undoFor
import org.jaiaditya.phonemail.ui.Snooze
import org.jaiaditya.phonemail.ui.THEME_DARK
import org.jaiaditya.phonemail.ui.THEME_LIGHT
import org.jaiaditya.phonemail.ui.THEME_SYSTEM
import org.jaiaditya.phonemail.ui.cleanFolderName
import org.jaiaditya.phonemail.ui.filterTitle
import org.jaiaditya.phonemail.ui.folderFilter
import org.jaiaditya.phonemail.ui.folderIdOf
import org.jaiaditya.phonemail.ui.folderNameOk
import org.jaiaditya.phonemail.ui.isDarkTheme
import org.jaiaditya.phonemail.ui.isoUtc
import org.jaiaditya.phonemail.ui.offersUnarchive
import org.jaiaditya.phonemail.ui.offersUnsnooze
import org.jaiaditya.phonemail.ui.snoozeChoices
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class MailboxTest {
    private fun at(s: String) = LocalDateTime.parse(s)

    @Test
    fun offersEverySnoozeOnAWeekdayMorning() {
        // Wednesday 14 Oct 2026, 10:00.
        assertEquals(
            listOf(
                Snooze.LaterToday to at("2026-10-14T18:00"),
                Snooze.Tomorrow to at("2026-10-15T08:00"),
                Snooze.Weekend to at("2026-10-17T08:00"),
                Snooze.NextWeek to at("2026-10-19T08:00"),
            ),
            snoozeChoices(at("2026-10-14T10:00")),
        )
    }

    @Test
    fun dropsLaterTodayOnceSixHasPassed() {
        val choices = snoozeChoices(at("2026-10-14T18:00")).map { it.first }
        assertEquals(listOf(Snooze.Tomorrow, Snooze.Weekend, Snooze.NextWeek), choices)
    }

    @Test
    fun dropsChoicesThatFallOnTheSameTime() {
        // Friday: the weekend is tomorrow at 08:00, the same as Tomorrow.
        assertEquals(
            listOf(Snooze.LaterToday to at("2026-10-16T18:00"), Snooze.Tomorrow to at("2026-10-17T08:00"), Snooze.NextWeek to at("2026-10-19T08:00")),
            snoozeChoices(at("2026-10-16T09:00")),
        )
        // Sunday evening: next week is tomorrow; this weekend is the coming Saturday.
        assertEquals(
            listOf(Snooze.Tomorrow to at("2026-10-19T08:00"), Snooze.Weekend to at("2026-10-24T08:00")),
            snoozeChoices(at("2026-10-18T20:00")),
        )
        // Saturday before 8: this weekend is still this morning.
        assertEquals(at("2026-10-17T08:00"), snoozeChoices(at("2026-10-17T07:00")).toMap()[Snooze.Weekend])
    }

    @Test
    fun sendsSnoozeTimesInUtc() {
        assertEquals("2026-10-17T12:30:00Z", isoUtc(at("2026-10-17T18:00"), ZoneId.of("Asia/Kolkata")))
    }

    @Test
    fun namesTheLists() {
        assertEquals(listOf("all", "unread", "attachments", "favorites", "snoozed", "everything", "archived"), FILTERS)
        assertEquals(R.string.menu_inbox, filterTitle("all"))
        assertEquals(R.string.menu_starred, filterTitle("favorites"))
        assertEquals(R.string.menu_all_mail, filterTitle("everything"))
        assertEquals(R.string.menu_archived, filterTitle("archived"))
        FILTERS.forEach { assertTrue(it, filterTitle(it) != null) }
        assertNull(filterTitle("folder:3")) // a folder shows its own name
    }

    @Test
    fun readsFolderFilters() {
        assertEquals("folder:12", folderFilter(12))
        assertEquals(12L, folderIdOf("folder:12"))
        assertNull(folderIdOf("all"))
        assertNull(folderIdOf("folder:abc"))
    }

    @Test
    fun tidiesFolderNames() {
        assertEquals("Tax 2026", cleanFolderName("  Tax \t  2026 "))
        assertFalse(folderNameOk(""))
        assertFalse(folderNameOk("    "))
        assertTrue(folderNameOk("a".repeat(40)))
        assertFalse(folderNameOk("a".repeat(41)))
        assertTrue(folderNameOk("  " + "a".repeat(40) + "  ")) // spaces around don't count
        assertTrue(folderNameOk("🪷".repeat(40))) // characters, not UTF-16 units
    }

    @Test
    fun choosesArchiveOrMoveToInbox() {
        val home = Conversation(1, "direct")
        val archived = Conversation(2, "direct", archived = true)
        assertFalse(offersUnarchive("all", listOf(home)))
        assertFalse(offersUnarchive("everything", listOf(home, archived)))
        assertTrue(offersUnarchive("everything", listOf(archived)))
        assertTrue(offersUnarchive("archived", emptyList()))
        assertFalse(offersUnarchive("all", emptyList()))
    }

    @Test
    fun choosesSnoozeOrUnsnooze() {
        val snoozed = Conversation(1, "direct", snoozedUntil = "2026-10-18T02:30:00Z")
        assertTrue(offersUnsnooze("snoozed", emptyList()))
        assertTrue(offersUnsnooze("everything", listOf(snoozed)))
        assertFalse(offersUnsnooze("all", listOf(snoozed, Conversation(2, "direct"))))
    }

    @Test
    fun movesFiledChatsToTheInboxByUnfiling() {
        val filed = Conversation(1, "direct", archived = true, folderId = 3)
        val archived = Conversation(2, "direct", archived = true)
        assertEquals("unfile", moveToInboxAction("folder:3", listOf(filed)))
        assertEquals("unfile", moveToInboxAction("folder:3", emptyList()))
        assertEquals("unfile", moveToInboxAction("", listOf(filed))) // the chat's menu
        assertEquals("unarchive", moveToInboxAction("archived", listOf(archived)))
        assertEquals("unarchive", moveToInboxAction("everything", listOf(filed, archived)))
    }

    @Test
    fun undoesOnlyWhatChanged() {
        val home = Conversation(1, "direct")
        val archived = Conversation(2, "direct", archived = true)
        val snoozed = Conversation(3, "direct", snoozedUntil = "2026-10-18T02:30:00Z")
        assertEquals(listOf(ChatUndo("unarchive", listOf(1L, 3L))), undoFor("archive", "everything", listOf(home, archived, snoozed)))
        assertEquals(emptyList<ChatUndo>(), undoFor("archive", "archived", listOf(archived)))
        assertEquals(listOf(ChatUndo("unsnooze", listOf(1L, 2L))), undoFor("snooze", "all", listOf(home, archived, snoozed)))
        assertEquals(emptyList<ChatUndo>(), undoFor("trash", "all", listOf(home)))
        assertEquals(emptyList<ChatUndo>(), undoFor("read", "all", listOf(home)))
    }

    @Test
    fun undoesMovesAndUnfiling() {
        val home = Conversation(1, "direct")
        val inA = Conversation(2, "direct", archived = true, folderId = 7)
        // From a plain list: out of the folder again; a chat that was filed elsewhere goes back there.
        assertEquals(
            listOf(ChatUndo("move", listOf(2L), 7), ChatUndo("unfile", listOf(1L))),
            undoFor("move", "everything", listOf(home, inA)),
        )
        // From folder A to B: back to A (even when a row didn't say which folder it was in).
        assertEquals(listOf(ChatUndo("move", listOf(2L, 1L), 7)), undoFor("move", "folder:7", listOf(inA, home)))
        // Out of folder A (Remove from folder, or Move to Inbox there): back into A.
        assertEquals(listOf(ChatUndo("move", listOf(2L), 7)), undoFor("unfile", "folder:7", listOf(inA)))
        assertEquals(listOf(ChatUndo("move", listOf(2L), 7)), undoFor("unfile", "", listOf(inA))) // the chat's menu
        assertEquals(emptyList<ChatUndo>(), undoFor("unfile", "all", listOf(home)))
    }

    @Test
    fun picksTheAppearance() {
        assertTrue(isDarkTheme(THEME_SYSTEM, systemDark = true))
        assertFalse(isDarkTheme(THEME_SYSTEM, systemDark = false))
        assertTrue(isDarkTheme(THEME_DARK, systemDark = false))
        assertFalse(isDarkTheme(THEME_LIGHT, systemDark = true))
    }

    @Test
    fun buildsChatActionBodies() {
        val body = Api.obj("conversation_ids" to listOf(4L, 9L), "action" to "move", "until" to null, "folder_id" to 5L)
        assertEquals("""{"conversation_ids":[4,9],"action":"move","folder_id":5}""", body.toString())
    }

    @Test
    fun readsChatRowsFoldersAndScheduledDrafts() {
        val api = Api("http://localhost/api", token = { null }, onUnauthorized = {})
        val chats = api.wire.decodeFromString(
            WPage.serializer(WChat.serializer()),
            """{"items":[{"conversation_id":7,"kind":"group","name":"Family","member_count":4,"archived":true,"muted":true,
               "snoozed_until":"2026-10-18T02:30:00Z","folder_id":3,"unread_count":2},{"conversation_id":8}]}""",
        ).items
        assertEquals(4, chats[0].memberCount)
        assertTrue(chats[0].archived && chats[0].muted)
        assertEquals("2026-10-18T02:30:00Z", chats[0].snoozedUntil)
        assertEquals(3L, chats[0].folderId)
        // Left out when false or none.
        assertFalse(chats[1].archived)
        assertNull(chats[1].folderId)
        assertNull(chats[1].snoozedUntil)

        val folders = api.wire.decodeFromString(
            WPage.serializer(WFolder.serializer()),
            """{"items":[{"id":3,"name":"Bills","chat_count":5,"unread_count":1,"created_at":"2026-10-01T10:00:00Z"}]}""",
        ).items
        assertEquals(WFolder(3, "Bills", 5, 1, "2026-10-01T10:00:00Z"), folders.single())

        val draft = api.wire.decodeFromString(WDraft.serializer(), """{"id":11,"subject":"Hi","send_at":"2026-10-19T02:30:00Z"}""")
        assertEquals("2026-10-19T02:30:00Z", draft.sendAt)
    }
}
