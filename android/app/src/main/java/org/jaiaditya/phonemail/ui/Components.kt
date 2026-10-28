package org.jaiaditya.phonemail.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Session

/** The signed-in session, for small pieces (avatars, attachments) that need the api or the image cache. */
val LocalSession = staticCompositionLocalOf<Session?> { null }

private val avatarColors = listOf(
    Color(0xFF0B8A7A), Color(0xFF7B61FF), Color(0xFFE66A2C), Color(0xFFD6336C),
    Color(0xFF1E88E5), Color(0xFF6D8B2F), Color(0xFF8E5A3C), Color(0xFF00838F),
)

/**
 * A person's round picture, the same on every PhoneMail client:
 *  - [avatar] "photo:<name>.jpg" -> their uploaded photo; "glyph:<emoji>:<#rrggbb>" -> the stock glyph they picked;
 *  - no avatar and a phone address -> the number bloom drawn from the digits (see NumberBloom);
 *  - anyone else (people outside PhoneMail) -> initials on a colour.
 * [name] is the display name (null if none), [address] the email address or number.
 */
@Composable
fun Avatar(name: String?, address: String?, avatar: String? = null, group: Boolean = false, size: Dp = 48.dp) {
    val label = name?.takeIf { it.isNotBlank() } ?: address.orEmpty()
    Box(Modifier.size(size).clip(CircleShape), contentAlignment = Alignment.Center) {
        when {
            group -> Box(Modifier.fillMaxSize().background(Palette.GroupAvatar), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Group, contentDescription = null, tint = Color.White, modifier = Modifier.size(size * 0.6f))
            }
            avatar?.startsWith("photo:") == true -> PhotoAvatar(avatar, size) { Fallback(name, address, label, size) }
            avatar?.startsWith("glyph:") == true -> {
                val glyph = parseGlyph(avatar)
                if (glyph != null) GlyphAvatar(glyph.first, glyph.second, size) else Fallback(name, address, label, size)
            }
            else -> Fallback(name, address, label, size)
        }
    }
}

@Composable
private fun Fallback(name: String?, address: String?, label: String, size: Dp) {
    val digits = NumberBloom.digits(address)
    if (digits != null) BloomAvatar(digits, NumberBloom.centreLabel(name, digits), size)
    else InitialsAvatar(label, size)
}

/** "glyph:🦚:#008069" -> ("🦚", colour). */
fun parseGlyph(avatar: String): Pair<String, Color>? {
    val rest = avatar.removePrefix("glyph:")
    val cut = rest.lastIndexOf(':')
    if (cut <= 0) return null
    val color = runCatching { Color(android.graphics.Color.parseColor(rest.substring(cut + 1))) }.getOrNull() ?: return null
    return rest.substring(0, cut) to color
}

@Composable
fun InitialsAvatar(label: String, size: Dp) {
    val color = avatarColors[(label.hashCode() and 0x7fffffff) % avatarColors.size]
    Box(Modifier.fillMaxSize().background(color), contentAlignment = Alignment.Center) {
        Text(initials(label), color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = (size.value * 0.36f).sp)
    }
}

@Composable
fun GlyphAvatar(glyph: String, color: Color, size: Dp) {
    val fontSize = with(LocalDensity.current) { (size * 0.55f).toSp() }
    Box(Modifier.fillMaxSize().background(color), contentAlignment = Alignment.Center) {
        Text(glyph, fontSize = fontSize, lineHeight = fontSize, textAlign = TextAlign.Center)
    }
}

/** The number bloom (see NumberBloom for the recipe): petals first, the centre disc on top. */
@Composable
fun BloomAvatar(digits: String, centre: String, size: Dp) {
    val hue = NumberBloom.hue(digits).toFloat()
    val background = Color.hsl(hue, 0.55f, 0.42f)
    val disc = Color.hsl(hue, 0.55f, 0.30f)
    Box(contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(size)) {
            val r = this.size.minDimension / 2
            val c = Offset(this.size.width / 2, this.size.height / 2)
            drawCircle(background, r, c)
            digits.forEachIndexed { i, ch ->
                val d = ch - '0'
                val inner = r * NumberBloom.PETAL_INNER
                val length = r * NumberBloom.petalOuter(d) - inner
                val width = r * NumberBloom.PETAL_WIDTH
                rotate(NumberBloom.petalAngle(i), pivot = c) {
                    drawOval(
                        Color.White.copy(alpha = NumberBloom.petalAlpha(d)),
                        topLeft = Offset(c.x + inner, c.y - width / 2), size = Size(length, width),
                    )
                }
            }
            drawCircle(disc, r * NumberBloom.CENTRE, c)
        }
        // Sized to sit inside the centre disc (diameter 0.26 of the picture).
        Text(centre, color = Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.16f).sp, maxLines = 1)
    }
}

@Composable
private fun PhotoAvatar(avatar: String, size: Dp, placeholder: @Composable () -> Unit) {
    val session = LocalSession.current
    val px = with(LocalDensity.current) { size.roundToPx() }
    val url = session?.api?.photoUrl(avatar)
    val bitmap by produceState<Bitmap?>(url?.let { session.images.cached(it, px) }, url, px) {
        if (url != null && value == null) value = session.images.load(url, px)
    }
    val b = bitmap
    if (b == null) placeholder()
    else Image(b.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
}

/** "2.4 MB", in the app's language. */
@Composable
fun sizeText(bytes: Long): String {
    val (unit, n) = sizeParts(bytes)
    return when (unit) {
        "B" -> stringResource(R.string.size_bytes, bytes.toInt())
        "KB" -> stringResource(R.string.size_kb, n)
        else -> stringResource(R.string.size_mb, n)
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, enabled: Boolean = true, busy: Boolean = false, modifier: Modifier = Modifier) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier.fillMaxWidth().height(48.dp),
        shape = RoundedCornerShape(24.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Palette.Header, contentColor = Palette.OnHeader),
        contentPadding = PaddingValues(horizontal = 24.dp),
    ) {
        if (busy) CircularProgressIndicator(color = Palette.OnHeader, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        else Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
fun ErrorText(text: String) {
    if (text.isNotEmpty()) Text(text, color = Palette.Danger, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
}

/** A white onboarding page: centred green title, grey subtitle, content, and a footer pinned at the bottom. */
@Composable
fun OnboardingPage(
    title: String,
    subtitle: String? = null,
    footer: @Composable ColumnScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    StatusBarIcons(darkIcons = true)
    Column(Modifier.fillMaxSize().background(Palette.Bg).safeDrawingPadding().imePadding()) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(title, color = Palette.Header, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            if (subtitle != null) Text(subtitle, color = Palette.Muted, fontSize = 15.sp, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            content()
        }
        Column(Modifier.padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = footer)
    }
}
