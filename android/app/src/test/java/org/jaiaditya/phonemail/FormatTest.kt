package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.data.Api
import org.jaiaditya.phonemail.ui.initials
import org.jaiaditya.phonemail.ui.splitAddresses
import org.jaiaditya.phonemail.ui.tenDigits
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FormatTest {
    @Test
    fun splitsRecipientLists() {
        assertEquals(listOf("9876543210", "a@phonemail.net", "9123456780"), splitAddresses(" 9876543210, a@phonemail.net;9123456780 "))
        assertEquals(emptyList<String>(), splitAddresses(" , ; "))
    }

    @Test
    fun takesTheLastTenDigits() {
        assertEquals("9876543210", tenDigits("+91 98765 43210"))
        assertEquals("9876543210", tenDigits("09876543210"))
        assertNull(tenDigits("12345"))
    }

    @Test
    fun makesInitials() {
        assertEquals("AM", initials("Asha Menon"))
        assertEquals("9", initials("9884690127@phonemail.net"))
        assertEquals("#", initials(""))
    }

    @Test
    fun buildsJsonBodies() {
        val body = Api.obj("to" to listOf("9876543210", Api.obj("groupId" to 7L)), "draftId" to null, "subject" to "Hi")
        assertEquals("""{"to":["9876543210",{"groupId":7}],"subject":"Hi"}""", body.toString())
    }
}
