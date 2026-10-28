package org.jaiaditya.phonemail.ui

import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Conversation
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

// The chat lists and what can be done to chats (the same menus as the web app). Plain logic, unit-tested.

/** The chat lists in the Home menu, in its order (the api's conversation filters); the user's folders follow. */
val FILTERS = listOf("all", "unread", "attachments", "favorites", "snoozed", "everything", "archived")

/** A list's title in the menu and the top bar; null for one of the user's folders, which shows the folder's name. */
fun filterTitle(filter: String): Int? = when (filter) {
    "all" -> R.string.menu_inbox
    "unread" -> R.string.menu_unread
    "attachments" -> R.string.menu_attachments
    "favorites" -> R.string.menu_starred
    "snoozed" -> R.string.menu_snoozed
    "everything" -> R.string.menu_all_mail
    "archived" -> R.string.menu_archived
    else -> null
}

fun folderFilter(id: Long) = "folder:$id"

/** "folder:12" -> 12; null for the other lists. */
fun folderIdOf(filter: String): Long? = if (filter.startsWith("folder:")) filter.removePrefix("folder:").toLongOrNull() else null

/** The longest folder name the api takes. */
const val FOLDER_NAME_MAX = 40

/** A folder name as typed, tidied: no spaces around it, and runs of spaces made one. */
fun cleanFolderName(s: String): String = s.trim().replace(Regex("\\s+"), " ")

/** Worth sending: 1–40 characters once tidied (the api checks the rest: built-in names, names already used). */
fun folderNameOk(s: String): Boolean = cleanFolderName(s).let { it.isNotEmpty() && it.codePointCount(0, it.length) <= FOLDER_NAME_MAX }

/**
 * "Move to Inbox" instead of Archive: in the Archived list, or when every picked chat is archived already
 * (a folder's chats are archived too).
 */
fun offersUnarchive(filter: String, picked: List<Conversation>): Boolean =
    filter == "archived" || (picked.isNotEmpty() && picked.all { it.archived })

/**
 * What "Move to Inbox" sends. A filed chat is taken out of its folder (unfile): the api's unarchive keeps the folder,
 * so the chat would stay there too. That is the case in a folder's list, or when every picked chat is filed.
 */
fun moveToInboxAction(filter: String, picked: List<Conversation>): String =
    if (folderIdOf(filter) != null || (picked.isNotEmpty() && picked.all { it.folderId != null })) "unfile" else "unarchive"

/** One call that puts an action back: [action] on [ids] (with [folderId] for a move). */
data class ChatUndo(val action: String, val ids: List<Long>, val folderId: Long? = null)

/**
 * How to undo [action] done to [picked] in the list [filter]; empty when it can't be undone. Only the chats the action
 * really changed are put back: archiving leaves already archived chats alone, so Undo doesn't unarchive them (the same
 * for snooze). A move or an unfile puts each chat back in the folder it was in (a folder's list: that folder); chats
 * that were in no folder are taken out again (unfile).
 */
fun undoFor(action: String, filter: String, picked: List<Conversation>): List<ChatUndo> {
    fun one(action: String, chats: List<Conversation>, folderId: Long? = null) =
        if (chats.isEmpty()) emptyList() else listOf(ChatUndo(action, chats.map { it.id }, folderId))
    val shownFolder = folderIdOf(filter)
    fun homeFolder(c: Conversation) = c.folderId ?: shownFolder
    return when (action) {
        "archive" -> one("unarchive", picked.filter { !it.archived })
        "snooze" -> one("unsnooze",picked.filter { it.snoozedUntil == null })
        "move", "unfile" -> {
            val (filed, loose) = picked.partition { homeFolder(it) != null }
            val back = filed.groupBy { homeFolder(it)!! }.map { (folder, chats) -> ChatUndo("move", chats.map { it.id }, folder) }
            back + if (action == "move") one("unfile", loose) else emptyList()
        }
        else -> emptyList()
    }
}

/** "Unsnooze" instead of Snooze: in the Snoozed list, or when every picked chat is snoozed. */
fun offersUnsnooze(filter: String, picked: List<Conversation>): Boolean =
    filter == "snoozed" || (picked.isNotEmpty() && picked.all { it.snoozedUntil != null })

/** The snooze choices, as the web app offers them. */
enum class Snooze(val label: Int) {
    LaterToday(R.string.snooze_later_today),
    Tomorrow(R.string.snooze_tomorrow),
    Weekend(R.string.snooze_weekend),
    NextWeek(R.string.snooze_next_week),
}

/**
 * When each choice would bring the chat back, seen from [now]: later today at 18:00 (only while that is still ahead),
 * tomorrow at 08:00, this weekend (Saturday) at 08:00 and next week (Monday) at 08:00. A choice that falls at the same
 * time as an earlier one (Saturday seen from a Friday) is left out.
 */
fun snoozeChoices(now: LocalDateTime): List<Pair<Snooze, LocalDateTime>> {
    val today = now.toLocalDate()
    return listOf(
        Snooze.LaterToday to today.atTime(18, 0),
        Snooze.Tomorrow to today.plusDays(1).atTime(8, 0),
        Snooze.Weekend to today.with(TemporalAdjusters.nextOrSame(DayOfWeek.SATURDAY)).atTime(8, 0),
        Snooze.NextWeek to today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)).atTime(8, 0),
    ).filter { it.second.isAfter(now) }.distinctBy { it.second }
}

/** A local time as the api takes it: ISO, in UTC ("2026-10-17T12:30:00Z"). */
fun isoUtc(t: LocalDateTime, zone: ZoneId = ZoneId.systemDefault()): String = t.atZone(zone).toInstant().toString()

/** "Sat 8:00 AM", in the app's language (a snooze choice's time). */
fun dayTime(t: LocalDateTime): String = t.format(DateTimeFormatter.ofPattern("EEE h:mm a", Locale.getDefault()))

/** When a snoozed chat comes back or a scheduled email goes: the time today, otherwise the day and the time. */
fun laterTime(iso: String?): String {
    val t = parseTime(iso) ?: return ""
    return if (t.toLocalDate() == LocalDate.now()) bubbleTime(iso)
    else t.format(DateTimeFormatter.ofPattern("EEE d MMM, h:mm a", Locale.getDefault()))
}
