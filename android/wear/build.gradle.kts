import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

// PhoneMail on Wear OS: the Inbox, a chat and a quick reply (like the Apple Watch app). Same application ID and
// signing key as the phone app, which Play needs for a watch app in the same listing and the Data Layer needs to hand
// it the sign-in (WatchLink in app/). Its version codes must not clash with the phone's: see CLAUDE.md.
android {
    namespace = "org.jaiaditya.phonemail.wear"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.jaiaditya.phonemail"
        minSdk = 30 // Wear OS 3
        targetSdk = 36
        versionCode = 9
        versionName = "1.1.0"
    }

    // The phone app's release (upload) key, kept outside the repository (app/build.gradle.kts explains).
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
            // Same ID as the phone app's debug build, so the two find each other over the Data Layer.
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
        buildConfig = true // BuildConfig.DEBUG gates the test sign-in (MainActivity)
    }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2025.04.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.wear.compose:compose-material:1.5.2")
    implementation("androidx.wear.compose:compose-foundation:1.5.2")
    implementation("androidx.wear.compose:compose-navigation:1.5.2")
    implementation("androidx.compose.material:material-icons-extended") // only the icons used survive R8
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.core:core-ktx:1.15.0")
    // Typed, dictated or handwritten replies (the watch's own input screen).
    implementation("androidx.wear:wear-input:1.1.0")

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // The sign-in the phone app sends (WatchLink).
    implementation("com.google.android.gms:play-services-wearable:19.0.0")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
