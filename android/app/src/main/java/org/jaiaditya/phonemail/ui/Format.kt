package org.jaiaditya.phonemail.ui

import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.util.Locale

/** Longer bodies are cut in the chat; tapping opens the full (traditional) view. */
const val LONG_MESSAGE = 320

fun parseTime(iso: String?): ZonedDateTime? =
    iso?.let { runCatching { OffsetDateTime.parse(it).atZoneSameInstant(ZoneId.systemDefault()) }.getOrNull() }

/** Built on use, so it follows the app's language (AppLocale sets the default locale). */
private val clock get() = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

/** WhatsApp-style list time: time today, "Yesterday", weekday within a week, otherwise dd/MM/yy. */
fun chatTime(iso: String?, yesterday: String = "Yesterday"): String {
    val t = parseTime(iso) ?: return ""
    val today = LocalDate.now()
    val day = t.toLocalDate()
    return when {
        day == today -> t.format(clock)
        day == today.minusDays(1) -> yesterday
        day.isAfter(today.minusDays(7)) -> day.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())
        else -> t.format(DateTimeFormatter.ofPattern("dd/MM/yy"))
    }
}

fun bubbleTime(iso: String?): String = parseTime(iso)?.format(clock) ?: ""

fun fullTime(iso: String?): String =
    parseTime(iso)?.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)) ?: ""

fun initials(s: String): String =
    s.substringBefore('@').split(Regex("\\s+")).filter { it.isNotBlank() }.take(2)
        .joinToString("") { it.first().uppercase() }.ifEmpty { "#" }

/** Splits "a, b; c d" into addresses or numbers. */
fun splitAddresses(s: String): List<String> = s.split(Regex("[,;\\s]+")).map { it.trim() }.filter { it.isNotEmpty() }

/** Last 10 digits of anything that looks like an Indian mobile number, else null. */
fun tenDigits(s: String): String? = s.filter { it.isDigit() }.takeLast(10).takeIf { it.length == 10 }
