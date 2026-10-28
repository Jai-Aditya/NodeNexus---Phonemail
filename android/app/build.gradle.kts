import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// Push notifications need the Firebase project's google-services.json (Firebase console → Project settings → Your apps).
// Without it the app still builds and runs; it just never gets a push token, so no new-mail notifications.
val googleServices = file("google-services.json")
if (googleServices.exists()) {
    apply(plugin = "com.google.gms.google-services")
    // Debug builds are org.jaiaditya.phonemail.debug: the file must list that app too, or the debug build fails.
    if (!googleServices.readText().contains("\"org.jaiaditya.phonemail.debug\"")) {
        logger.warn("w: google-services.json has no app for org.jaiaditya.phonemail.debug; add it in Firebase or debug builds will fail.")
    }
} else {
    logger.warn("w: app/google-services.json not found: building without Firebase (no push notifications).")
}

android {
    namespace = "org.jaiaditya.phonemail"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.jaiaditya.phonemail"
        minSdk = 26
        targetSdk = 36 // Google Play: new apps and updates must target Android 16 (API 36) since 31 Aug 2026
        versionCode = 12 // 9 is the Wear OS app (wear/); phone and watch codes must never clash
        versionName = "1.1.1"
        // Production api (nginx on the shankars Pi). Debug builds can point elsewhere, see below.
        buildConfigField("String", "API_BASE", "\"https://mail.phonemail.net/api\"")
        buildConfigField("String", "MAIL_DOMAIN", "\"phonemail.net\"")
    }

    // Release signing: an upload key kept OUTSIDE the repository (see docs: never commit keys).
    // Path: -PsigningProps=<file> or ~/Android/keys/phonemail-release.properties (storeFile, storePassword, keyAlias, keyPassword).
    val signingProps = file(
        (project.findProperty("signingProps") as String?)
            ?: "${System.getProperty("user.home")}/Android/keys/phonemail-release.properties"
    )
    val releaseKey = signingProps.takeIf { it.exists() }?.let { f ->
        Properties().apply { f.inputStream().use { load(it) } }
    }
    signingConfigs {
        if (releaseKey != null) {
            create("release") {
                storeFile = file(releaseKey.getProperty("storeFile"))
                storePassword = releaseKey.getProperty("storePassword")
                keyAlias = releaseKey.getProperty("keyAlias")
                keyPassword = releaseKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            // `-PapiBase=http://10.28.28.33:8090/api` builds against the staging Pi on the home LAN.
            val apiBase = (project.findProperty("apiBase") as String?) ?: "https://mail.phonemail.net/api"
            buildConfigField("String", "API_BASE", "\"$apiBase\"")
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Bundle the native libraries' symbols (from AndroidX) so Play can read native crash reports.
            ndk { debugSymbolLevel = "SYMBOL_TABLE" }
            // The release (upload) key when its properties file exists; otherwise the debug key, so the APK still installs for testing.
            signingConfig = if (releaseKey != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
    // `-PliveApi=http://<host>/api` also runs LiveApiTest against a running api (it creates throwaway accounts).
    testOptions { unitTests.all { it.systemProperty("liveApi", (project.findProperty("liveApi") as String?) ?: "") } }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.core:core-splashscreen:1.0.1")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // HTTP, and the api's live event stream (Server-Sent Events, read line by line).
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // SIM number suggestion (Phone Number Hint) and OTP auto-read (SMS Retriever): no permissions needed.
    implementation("com.google.android.gms:play-services-auth:21.3.0")
    implementation("com.google.android.gms:play-services-auth-api-phone:18.1.0")

    // Hands the sign-in to the PhoneMail Wear OS app (wear/) over the Data Layer (WatchLink).
    implementation("com.google.android.gms:play-services-wearable:19.0.0")

    // New-mail notifications: Firebase Cloud Messaging (data messages; the app builds the notification itself).
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
