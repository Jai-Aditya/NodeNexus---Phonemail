package org.jaiaditya.phonemail.data

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * The app's own language, independent of the phone's: chosen on the first screen or in Settings.
 * MainActivity wraps its context with it (attachBaseContext) and recreates itself when it changes.
 */
object AppLocale {
    /** Languages the app is translated into (strings.xml, values-hi, values-ta). */
    val SUPPORTED = listOf("en", "hi", "ta")

    fun saved(context: Context): String? =
        context.getSharedPreferences(Session.PREFS, Context.MODE_PRIVATE).getString(Session.KEY_LANGUAGE, null)

    fun wrap(base: Context, code: String?): Context {
        if (code == null || code !in SUPPORTED) return base
        val locale = Locale.forLanguageTag(code)
        Locale.setDefault(locale) // dates and weekday names follow too
        val config = Configuration(base.resources.configuration)
        config.setLocale(locale)
        config.setLayoutDirection(locale)
        return base.createConfigurationContext(config)
    }
}
