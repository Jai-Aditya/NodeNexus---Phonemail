package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.ui.PhotoStyle
import org.jaiaditya.phonemail.ui.PhotoStyles
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PhotoStylesTest {
    private val n = 512

    /** A test "photo": a colour gradient with a dark disc and a light square on it. */
    private fun photo() = IntArray(n * n) { i ->
        val x = i % n; val y = i / n
        val inDisc = (x - 180) * (x - 180) + (y - 200) * (y - 200) < 90 * 90
        val inSquare = x in 300..430 && y in 280..420
        val r = if (inDisc) 30 else if (inSquare) 240 else x * 255 / n
        val g = if (inDisc) 40 else if (inSquare) 230 else y * 255 / n
        val b = if (inDisc) 60 else if (inSquare) 200 else 128
        (0xff shl 24) or (r shl 16) or (g shl 8) or b
    }

    @Test
    fun everyStyleKeepsTheSizeAndChangesThePicture() {
        val src = photo()
        for (style in PhotoStyle.entries) {
            val out = PhotoStyles.apply(style, src, n, n)
            assertEquals("$style keeps 512×512", n * n, out.size)
            val changed = out.indices.count { out[it] != src[it] }
            if (style == PhotoStyle.Original) assertEquals(0, changed)
            else assertTrue("$style changes the pixels ($changed changed)", changed > n * n / 10)
            assertTrue("$style is opaque", out.all { (it ushr 24) == 0xff })
        }
    }

    @Test
    fun pixelMakesTwentyByTwentyFlatCells() {
        val out = PhotoStyles.apply(PhotoStyle.Pixel, photo(), n, n)
        // Every pixel inside one 25-26 px cell has the same colour; neighbouring cells differ on the gradient.
        val cell = out[0]
        for (y in 0 until 25) for (x in 0 until 25) assertEquals(cell, out[y * n + x])
        assertTrue(out[0] != out[26 * n + 26 + n * 0 + 400])
        val distinct = (0 until 20).map { out[(it * n / 20 + 2) * n + 2] }.toSet()
        assertTrue(distinct.size > 10)
    }

    @Test
    fun outlineIsDarkLinesOnWhite() {
        val out = PhotoStyles.apply(PhotoStyle.Outline, photo(), n, n)
        val colours = out.toSet()
        assertEquals(setOf(0xFF1B1B1B.toInt(), 0xFFFAFAFA.toInt()), colours)
        val dark = out.count { it == 0xFF1B1B1B.toInt() }
        assertTrue("some edges ($dark)", dark in 500 until n * n / 3)
        // The disc's edge (x = 90 at y = 200) is drawn.
        assertEquals(0xFF1B1B1B.toInt(), (88..92).map { out[200 * n + it] }.firstOrNull { it == 0xFF1B1B1B.toInt() })
    }

    @Test
    fun pencilIsGrey() {
        val out = PhotoStyles.apply(PhotoStyle.Pencil, photo(), n, n)
        assertTrue(out.all { val r = (it shr 16) and 0xff; r == (it shr 8) and 0xff && r == it and 0xff })
    }
}
