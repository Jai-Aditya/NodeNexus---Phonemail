package org.jaiaditya.phonemail.ui

import kotlin.math.exp
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Profile photo styles, applied on the phone before upload so only the picture the person chooses leaves it.
 * The same recipes run on web, Android and iPhone. Pixels are ARGB ints (android.graphics.Bitmap order), and the
 * input is the 512×512 square crop.
 */
enum class PhotoStyle { Original, Oil, Pixel, Outline, Pencil }

object PhotoStyles {
    fun apply(style: PhotoStyle, px: IntArray, w: Int, h: Int): IntArray = when (style) {
        PhotoStyle.Original -> px.copyOf()
        PhotoStyle.Pixel -> pixelate(px, w, h, 20)
        PhotoStyle.Oil -> oil(px, w, h)
        PhotoStyle.Outline -> outline(px, w, h)
        PhotoStyle.Pencil -> pencil(px, w, h)
    }

    private fun r(c: Int) = (c shr 16) and 0xff
    private fun g(c: Int) = (c shr 8) and 0xff
    private fun b(c: Int) = c and 0xff
    private fun argb(r: Int, g: Int, b: Int) = (0xff shl 24) or (r.coerceIn(0, 255) shl 16) or (g.coerceIn(0, 255) shl 8) or b.coerceIn(0, 255)
    private fun gray(c: Int) = (0.299 * r(c) + 0.587 * g(c) + 0.114 * b(c)).roundToInt()

    /** Pixel: a [cells]×[cells] grid, each cell filled with its average colour. */
    fun pixelate(px: IntArray, w: Int, h: Int, cells: Int): IntArray {
        val out = IntArray(w * h)
        for (cy in 0 until cells) for (cx in 0 until cells) {
            val x0 = cx * w / cells; val x1 = (cx + 1) * w / cells
            val y0 = cy * h / cells; val y1 = (cy + 1) * h / cells
            var sr = 0L; var sg = 0L; var sb = 0L; var n = 0
            for (y in y0 until y1) for (x in x0 until x1) {
                val c = px[y * w + x]; sr += r(c); sg += g(c); sb += b(c); n++
            }
            if (n == 0) continue
            val c = argb((sr / n).toInt(), (sg / n).toInt(), (sb / n).toInt())
            for (y in y0 until y1) for (x in x0 until x1) out[y * w + x] = c
        }
        return out
    }

    /** Oil painting: the oil-paint filter (radius 4, 20 intensity levels) on a half-size copy, scaled back up smoothly. */
    fun oil(px: IntArray, w: Int, h: Int, radius: Int = 4, levels: Int = 20): IntArray {
        val sw = w / 2; val sh = h / 2
        val small = resize(px, w, h, sw, sh)
        val out = IntArray(sw * sh)
        val count = IntArray(levels); val sr = IntArray(levels); val sg = IntArray(levels); val sb = IntArray(levels)
        val level = IntArray(sw * sh) { gray(small[it]) * (levels - 1) / 255 }
        for (y in 0 until sh) for (x in 0 until sw) {
            count.fill(0); sr.fill(0); sg.fill(0); sb.fill(0)
            for (dy in -radius..radius) {
                val yy = (y + dy).coerceIn(0, sh - 1)
                for (dx in -radius..radius) {
                    val xx = (x + dx).coerceIn(0, sw - 1)
                    val i = yy * sw + xx
                    val l = level[i]; val c = small[i]
                    count[l]++; sr[l] += r(c); sg[l] += g(c); sb[l] += b(c)
                }
            }
            var best = 0
            for (l in 1 until levels) if (count[l] > count[best]) best = l
            val n = count[best]
            out[y * sw + x] = argb(sr[best] / n, sg[best] / n, sb[best] / n)
        }
        return resize(out, sw, sh, w, h)
    }

    /** Pencil sketch: colour-dodge of the grayscale over its blurred inverse, with a little more contrast. */
    fun pencil(px: IntArray, w: Int, h: Int, sigma: Double = 8.0): IntArray {
        val gray = IntArray(w * h) { gray(px[it]) }
        val inverse = IntArray(w * h) { 255 - gray[it] }
        val blurred = gaussian(inverse, w, h, sigma)
        return IntArray(w * h) {
            val dodge = if (blurred[it] >= 255) 255 else min(255, gray[it] * 255 / (255 - blurred[it]))
            val v = ((dodge - 128) * 1.15 + 128).roundToInt().coerceIn(0, 255)
            argb(v, v, v)
        }
    }

    /** Outline: the strongest Sobel edges as ~2 px dark lines on white. */
    fun outline(px: IntArray, w: Int, h: Int): IntArray {
        val gray = IntArray(w * h) { gray(px[it]) }
        val mag = IntArray(w * h)
        for (y in 1 until h - 1) for (x in 1 until w - 1) {
            fun p(dx: Int, dy: Int) = gray[(y + dy) * w + x + dx]
            val gx = -p(-1, -1) - 2 * p(-1, 0) - p(-1, 1) + p(1, -1) + 2 * p(1, 0) + p(1, 1)
            val gy = -p(-1, -1) - 2 * p(0, -1) - p(1, -1) + p(-1, 1) + 2 * p(0, 1) + p(1, 1)
            mag[y * w + x] = sqrt((gx * gx + gy * gy).toDouble()).roundToInt()
        }
        // "Strong" edges: the top 12% of edge strengths, and never below a floor that ignores noise.
        val sorted = mag.copyOf().also { it.sort() }
        val threshold = maxOf(48, sorted[(sorted.size * 0.88).toInt()])
        val edge = BooleanArray(w * h) { mag[it] > threshold }
        val out = IntArray(w * h) { 0xFFFAFAFA.toInt() }
        for (y in 0 until h) for (x in 0 until w) {
            var on = false
            for (dy in -1..1) for (dx in -1..1) {
                val yy = y + dy; val xx = x + dx
                if (yy in 0 until h && xx in 0 until w && edge[yy * w + xx]) on = true
            }
            if (on) out[y * w + x] = 0xFF1B1B1B.toInt()
        }
        return out
    }

    /** Separable Gaussian blur of one channel (values 0..255). */
    fun gaussian(v: IntArray, w: Int, h: Int, sigma: Double): IntArray {
        val rad = (sigma * 3).roundToInt()
        val k = DoubleArray(2 * rad + 1) { exp(-((it - rad) * (it - rad)) / (2 * sigma * sigma)) }
        val sum = k.sum()
        for (i in k.indices) k[i] /= sum
        val tmp = DoubleArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var s = 0.0
            for (i in -rad..rad) s += v[y * w + (x + i).coerceIn(0, w - 1)] * k[i + rad]
            tmp[y * w + x] = s
        }
        val out = IntArray(w * h)
        for (y in 0 until h) for (x in 0 until w) {
            var s = 0.0
            for (i in -rad..rad) s += tmp[(y + i).coerceIn(0, h - 1) * w + x] * k[i + rad]
            out[y * w + x] = s.roundToInt().coerceIn(0, 255)
        }
        return out
    }

    /** Bilinear resize (smooth both ways). */
    fun resize(px: IntArray, w: Int, h: Int, nw: Int, nh: Int): IntArray {
        val out = IntArray(nw * nh)
        for (y in 0 until nh) {
            val fy = ((y + 0.5) * h / nh - 0.5).coerceIn(0.0, (h - 1).toDouble())
            val y0 = fy.toInt(); val y1 = min(y0 + 1, h - 1); val ty = fy - y0
            for (x in 0 until nw) {
                val fx = ((x + 0.5) * w / nw - 0.5).coerceIn(0.0, (w - 1).toDouble())
                val x0 = fx.toInt(); val x1 = min(x0 + 1, w - 1); val tx = fx - x0
                val a = px[y0 * w + x0]; val b = px[y0 * w + x1]; val c = px[y1 * w + x0]; val d = px[y1 * w + x1]
                fun mix(ch: (Int) -> Int) =
                    ((ch(a) * (1 - tx) + ch(b) * tx) * (1 - ty) + (ch(c) * (1 - tx) + ch(d) * tx) * ty).roundToInt()
                out[y * nw + x] = argb(mix { r(it) }, mix { g(it) }, mix { b(it) })
            }
        }
        return out
    }
}
