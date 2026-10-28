plugins {
    id("com.android.application") version "8.10.1" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.1.0" apply false
    // Push notifications (Firebase Cloud Messaging): applied by app/ only when app/google-services.json exists.
    id("com.google.gms.google-services") version "4.4.2" apply false
}
