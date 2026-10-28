package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.data.Contact
import org.jaiaditya.phonemail.data.Contacts
import org.jaiaditya.phonemail.ui.NumberBloom
import org.jaiaditya.phonemail.ui.sizeParts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The number bloom must come out the same on every client, so its maths is pinned here. */
class BloomTest {
    @Test
    fun readsTheTenDigits() {
        assertEquals("9884690127", NumberBloom.digits("9884690127@phonemail.net"))
        assertEquals("9884690127", NumberBloom.digits("+919884690127"))
        assertNull(NumberBloom.digits("ravi@gmail.com"))
        assertNull(NumberBloom.digits("12345@phonemail.net"))
        assertNull(NumberBloom.digits(null))
    }

    @Test
    fun hueFromTheDigits() {
        // (9+8+8+4+6+9+0+1+2+7 = 54) × 37 = 1998; + 0127 = 2125; mod 360 = 325
        assertEquals(325, NumberBloom.hue("9884690127"))
        // (0 × 10) × 37 + 0 = 0
        assertEquals(0, NumberBloom.hue("0000000000"))
        // 90 × 37 = 3330; + 9999 = 13329; mod 360 = 9
        assertEquals(9, NumberBloom.hue("9999999999"))
    }

    @Test
    fun petalsGrowWithTheDigit() {
        assertEquals(0.22f, NumberBloom.PETAL_INNER, 1e-6f)
        assertEquals(0.46f, NumberBloom.petalOuter(0), 1e-6f)
        assertEquals(0.91f, NumberBloom.petalOuter(9), 1e-6f)
        assertEquals(0.35f, NumberBloom.petalAlpha(0), 1e-6f)
        assertEquals(0.935f, NumberBloom.petalAlpha(9), 1e-6f)
        assertEquals(0.26f, NumberBloom.CENTRE, 1e-6f)
        // A 0-petal still reaches past the centre disc.
        assert(NumberBloom.petalOuter(0) > NumberBloom.CENTRE)
    }

    @Test
    fun petalsStartAtTheTopClockwise() {
        assertEquals(-90f, NumberBloom.petalAngle(0), 0f)
        assertEquals(-54f, NumberBloom.petalAngle(1), 0f)
        assertEquals(90f, NumberBloom.petalAngle(5), 0f)
        assertEquals(234f, NumberBloom.petalAngle(9), 0f)
    }

    @Test
    fun centreShowsInitialsOrLastTwoDigits() {
        assertEquals("AM", NumberBloom.centreLabel("Asha Menon", "9884690127"))
        assertEquals("R", NumberBloom.centreLabel("ravi", "9884690127"))
        assertEquals("27", NumberBloom.centreLabel(null, "9884690127"))
        assertEquals("27", NumberBloom.centreLabel("9884690127@phonemail.net", "9884690127"))
    }

    @Test
    fun formatsFileSizes() {
        assertEquals("B" to "812", sizeParts(812))
        assertEquals("KB" to "1.0", sizeParts(1024))
        assertEquals("KB" to "15", sizeParts(14 * 1024 + 700))
        assertEquals("MB" to "2.4", sizeParts((2.4 * 1024 * 1024).toLong()))
        assertEquals("MB" to "25", sizeParts(25L * 1024 * 1024))
    }

    @Test
    fun suggestsContacts() {
        val all = listOf(Contact("Asha Menon", "9838450101"), Contact("Ravi Kumar", "9838450202"), Contact("Meena", "9884690127"))
        assertEquals(listOf("Ravi Kumar"), Contacts.search(all, "ravi").map { it.name })
        assertEquals(listOf("Meena"), Contacts.search(all, "98846").map { it.name })
        assertEquals(2, Contacts.search(all, "983845").size)
        assertEquals(emptyList<Contact>(), Contacts.search(all, " "))
    }
}
