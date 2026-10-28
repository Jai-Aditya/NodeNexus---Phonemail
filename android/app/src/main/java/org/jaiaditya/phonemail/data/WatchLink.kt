package org.jaiaditya.phonemail.data

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import org.jaiaditya.phonemail.BuildConfig

/**
 * Hands the sign-in to the PhoneMail Wear OS app (wear/), like the iPhone app does for the Apple Watch: one Data Layer
 * item at [PATH] with the token, api base, name and language; an empty token signs the watch out. Wear OS only
 * shares it with the same app (same package name and signing key) on the person's paired watch.
 * Phones without Wear OS or Play services just fail quietly.
 */
object WatchLink {
    const val PATH = "/signin"

    fun publish(context: Context, token: String?, name: String?, language: String?) {
        runCatching {
            val req = PutDataMapRequest.create(PATH).apply {
                dataMap.putString("token", token.orEmpty())
                dataMap.putString("apiBase", BuildConfig.API_BASE)
                dataMap.putString("name", name.orEmpty())
                dataMap.putString("lang", language ?: "en")
            }.asPutDataRequest().setUrgent()
            Wearable.getDataClient(context.applicationContext).putDataItem(req)
                .addOnFailureListener { Log.d("PhoneMail", "watch link: ${it.message}") }
        }.onFailure { Log.d("PhoneMail", "watch link: ${it.message}") }
    }
}
