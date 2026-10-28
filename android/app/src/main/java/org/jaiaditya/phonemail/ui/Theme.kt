package org.jaiaditya.phonemail.ui

import android.app.Activity
import android.graphics.drawable.ColorDrawable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/** One set of the app's colours: [Palette] shows the light or the dark one. */
class Colors(
    val header: Color, // the brand colour: links, section titles, icons, selected chips
    val bar: Color, // app bars
    val onBar: Color, // titles and icons on the app bars
    val onHeader: Color, // text and icons on a brand-coloured button
    val accent: Color,
    val onAccent: Color,
    val bg: Color, // screens
    val surface: Color, // dialogs, sheets, text fields on the chat wallpaper
    val chatBg: Color,
    val bubbleMine: Color,
    val bubbleTheirs: Color,
    val text: Color,
    val muted: Color,
    val divider: Color,
    val chipBg: Color,
    val chipOnBg: Color,
    val danger: Color,
    val star: Color,
    val notice: Color,
    val shade: Color, // a quoted message or a file inside a bubble
    val failedBg: Color, // a file that failed to upload
    val groupAvatar: Color,
)

val LightColors = Colors(
    header = Color(0xFF4B3FB0), bar = Color(0xFF4B3FB0), onBar = Color.White, onHeader = Color.White,
    accent = Color(0xFFF2A33A), onAccent = Color(0xFF3B2500),
    bg = Color.White, surface = Color.White, chatBg = Color(0xFFEFECF7), bubbleMine = Color(0xFFE1DCFA), bubbleTheirs = Color.White,
    text = Color(0xFF1F1C33), muted = Color(0xFF6B6680), divider = Color(0xFFE4DFD4),
    chipBg = Color(0xFFF1EEE7), chipOnBg = Color(0xFFECEAFB), danger = Color(0xFFEA0038), star = Color(0xFFF5B400),
    notice = Color(0xFFFDF0DC), shade = Color.Black.copy(alpha = 0.05f), failedBg = Color(0xFFFDE7EA), groupAvatar = Color(0xFFDFE5E7),
)

/** The web app's dark colours (brand #8C82F2, text #ECEAF4, muted #A49FB8, background #121019, lines #332E42). */
val DarkColors = Colors(
    header = Color(0xFF8C82F2), bar = Color(0xFF1E1A2A), onBar = Color(0xFFECEAF4), onHeader = Color(0xFF121019),
    accent = Color(0xFFF2A33A), onAccent = Color(0xFF3B2500),
    bg = Color(0xFF121019), surface = Color(0xFF1E1A2A), chatBg = Color(0xFF0D0B13), bubbleMine = Color(0xFF332C69), bubbleTheirs = Color(0xFF221E30),
    text = Color(0xFFECEAF4), muted = Color(0xFFA49FB8), divider = Color(0xFF332E42),
    chipBg = Color(0xFF221E30), chipOnBg = Color(0xFF2E2858), danger = Color(0xFFFF5C7A), star = Color(0xFFF5B400),
    notice = Color(0xFF3A2E1A), shade = Color.White.copy(alpha = 0.07f), failedBg = Color(0xFF4A1E2A), groupAvatar = Color(0xFF4A4560),
)

/** WhatsApp's layout (brief: "every screen should follow WhatsApp's design language") in PhoneMail's colours: indigo, with
 *  Pip's orange as the accent, the same as the web app at mail.phonemail.net. Light or dark (Settings → Appearance);
 *  screens read these names and redraw when the choice changes. */
object Palette {
    private var colors by mutableStateOf(LightColors)
    /** A plain copy of the choice, so the theme can compare without reading (and so redrawing) itself. */
    private var shownDark = false

    val isDark get() = colors === DarkColors
    val Header get() = colors.header
    val Bar get() = colors.bar
    val OnBar get() = colors.onBar
    val OnHeader get() = colors.onHeader
    val Accent get() = colors.accent // FAB, unread badge (Pip's orange)
    val OnAccent get() = colors.onAccent // text and icons on the orange
    val Bg get() = colors.bg
    val Surface get() = colors.surface
    val ChatBg get() = colors.chatBg // chat wallpaper
    val BubbleMine get() = colors.bubbleMine
    val BubbleTheirs get() = colors.bubbleTheirs
    val Text get() = colors.text
    val Muted get() = colors.muted
    val Divider get() = colors.divider
    val ChipBg get() = colors.chipBg
    val ChipOnBg get() = colors.chipOnBg
    val Danger get() = colors.danger
    val Star get() = colors.star
    val Notice get() = colors.notice
    val Shade get() = colors.shade
    val FailedBg get() = colors.failedBg
    val GroupAvatar get() = colors.groupAvatar

    fun use(dark: Boolean) {
        if (dark == shownDark) return
        shownDark = dark
        colors = if (dark) DarkColors else LightColors
    }
}

/** Appearance choices (Settings): follow the phone, or always light or dark. */
const val THEME_SYSTEM = "system"
const val THEME_LIGHT = "light"
const val THEME_DARK = "dark"

/** Whether [mode] shows the dark colours, given the phone's own setting. */
fun isDarkTheme(mode: String, systemDark: Boolean): Boolean = when (mode) {
    THEME_DARK -> true
    THEME_LIGHT -> false
    else -> systemDark
}

private val lightScheme = lightColorScheme(
    primary = LightColors.header,
    onPrimary = LightColors.onHeader,
    secondary = LightColors.accent,
    onSecondary = LightColors.onAccent,
    background = LightColors.bg,
    surface = LightColors.bg,
    onSurface = LightColors.text,
    onBackground = LightColors.text,
    surfaceVariant = LightColors.chipBg,
    onSurfaceVariant = LightColors.muted,
    error = LightColors.danger,
    outlineVariant = LightColors.divider,
)

private val darkScheme = darkColorScheme(
    primary = DarkColors.header,
    onPrimary = DarkColors.onHeader,
    secondary = DarkColors.accent,
    onSecondary = DarkColors.onAccent,
    background = DarkColors.bg,
    surface = DarkColors.bg,
    onSurface = DarkColors.text,
    onBackground = DarkColors.text,
    surfaceVariant = DarkColors.chipBg,
    onSurfaceVariant = DarkColors.muted,
    error = DarkColors.danger,
    outline = DarkColors.muted,
    outlineVariant = DarkColors.divider,
    // Menus, dialogs, the drawer and snackbars.
    surfaceContainerLowest = DarkColors.bg,
    surfaceContainerLow = DarkColors.surface,
    surfaceContainer = DarkColors.surface,
    surfaceContainerHigh = DarkColors.surface,
    surfaceContainerHighest = DarkColors.chipBg,
    inverseSurface = DarkColors.text,
    inverseOnSurface = DarkColors.bg,
    inversePrimary = LightColors.header,
)

/** [mode] is the Appearance choice (THEME_SYSTEM, THEME_LIGHT or THEME_DARK); a change redraws the app at once. */
@Composable
fun PhoneMailTheme(mode: String = THEME_SYSTEM, content: @Composable () -> Unit) {
    val dark = isDarkTheme(mode, isSystemInDarkTheme())
    Palette.use(dark) // before any screen reads the colours
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            // The window behind the screens (seen while one slides in) follows too.
            (view.context as? Activity)?.window?.setBackgroundDrawable(ColorDrawable((if (dark) DarkColors else LightColors).bg.toArgb()))
        }
    }
    MaterialTheme(colorScheme = if (dark) darkScheme else lightScheme, content = content)
}

/** Dark status-bar icons on white screens (onboarding), light icons under the app bar; always light in dark mode. */
@Composable
fun StatusBarIcons(darkIcons: Boolean) {
    val view = LocalView.current
    if (view.isInEditMode) return
    val dark = Palette.isDark
    SideEffect {
        val window = (view.context as? Activity)?.window ?: return@SideEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = darkIcons && !dark
            isAppearanceLightNavigationBars = !dark
        }
    }
}
