package org.jaiaditya.phonemail.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** One phone contact: its name and the last 10 digits of its number (the PhoneMail address). */
data class Contact(val name: String, val digits: String)

/** Reads the phone's contacts once the person has allowed it (asked during onboarding, never required). */
object Contacts {
    fun granted(context: Context) =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    suspend fun load(context: Context): List<Contact> = withContext(Dispatchers.IO) {
        if (!granted(context)) return@withContext emptyList()
        val out = LinkedHashMap<String, Contact>()
        runCatching {
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
                null, null, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE NOCASE",
            )?.use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(0)?.trim().orEmpty()
                    val digits = c.getString(1).orEmpty().filter { it.isDigit() }.takeLast(10)
                    if (name.isNotEmpty() && digits.length == 10) out.putIfAbsent(digits, Contact(name, digits))
                }
            }
        }
        out.values.toList()
    }

    /** Contacts whose name or number matches what was typed (at most [limit]). */
    fun search(all: List<Contact>, query: String, limit: Int = 5): List<Contact> {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return emptyList()
        val digits = q.filter { it.isDigit() }
        return all.filter { c ->
            c.name.lowercase().contains(q) || (digits.length >= 3 && c.digits.contains(digits))
        }.take(limit)
    }
}
