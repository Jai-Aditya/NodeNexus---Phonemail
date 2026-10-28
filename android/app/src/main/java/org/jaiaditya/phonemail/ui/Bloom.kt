package org.jaiaditya.phonemail.ui

/**
 * The default profile picture, a "number bloom": ten petals, one per digit of the phone number, drawn the same
 * way on every PhoneMail client (web, Android, iPhone) so a person looks the same everywhere.
 *  - hue H = (sum of the digits × 37 + the last four digits as a number) mod 360
 *  - background circle hsl(H, 55%, 42%); petals; then on top a centre disc radius 0.26r, hsl(H, 55%, 30%), with the
 *    initials (or the last two digits)
 *  - petal i (i = 0..9) points at −90° + 36°·i (clockwise from the top): an ellipse along that ray from 0.22r to
 *    r·(0.46 + 0.05·dᵢ) out from the centre (so a 0 still shows), width 0.22r, white at alpha 0.35 + 0.065·dᵢ
 */
object NumberBloom {
    /** The 10 digits of a phone number or PhoneMail address, or null if it is not one. */
    fun digits(address: String?): String? {
        val local = address?.substringBefore('@')?.removePrefix("+") ?: return null
        if (local.isEmpty() || !local.all { it.isDigit() } || local.length < 10) return null
        return local.takeLast(10)
    }

    fun hue(digits: String): Int = (digits.sumOf { it - '0' } * 37 + digits.takeLast(4).toInt()) % 360

    /** Where a petal starts and ends, as shares of the radius from the centre. */
    const val PETAL_INNER = 0.22f
    fun petalOuter(digit: Int): Float = 0.46f + 0.05f * digit

    fun petalAlpha(digit: Int): Float = 0.35f + 0.065f * digit

    /** Direction of petal [i] in degrees, 0° pointing right, clockwise (screen coordinates). */
    fun petalAngle(i: Int): Float = -90f + 36f * i

    const val PETAL_WIDTH = 0.22f
    const val CENTRE = 0.26f

    /** The centre text: the name's initials (1–2), or the number's last two digits when there is no name. */
    fun centreLabel(name: String?, digits: String): String {
        val n = name?.trim().orEmpty()
        if (n.isEmpty() || NumberBloom.digits(n) != null || n.contains('@')) return digits.takeLast(2)
        return n.split(Regex("\\s+")).filter { it.isNotBlank() }.take(2).joinToString("") { it.first().uppercase() }
    }
}

/** A file size the way people read it: 812 B, 14 KB, 2.4 MB. */
fun sizeParts(bytes: Long): Pair<String, String> = when {
    bytes < 1024 -> "B" to bytes.toString()
    bytes < 1024 * 1024 -> "KB" to (bytes / 1024.0).let { if (it < 10) "%.1f".format(java.util.Locale.ROOT, it) else Math.round(it).toString() }
    else -> "MB" to (bytes / (1024.0 * 1024)).let { if (it < 10) "%.1f".format(java.util.Locale.ROOT, it) else Math.round(it).toString() }
}
