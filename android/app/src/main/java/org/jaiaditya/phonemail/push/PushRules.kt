package org.jaiaditya.phonemail.push

import org.jaiaditya.phonemail.data.ApiException

/** The push decisions that need no Android (unit-tested). */
object PushRules {
    /** NotificationManager.IMPORTANCE_NONE: the person switched the channel off. */
    const val IMPORTANCE_NONE = 0

    /** On only when the app may notify and the "New mail" channel isn't switched off (null: not made yet). */
    fun notificationsOn(appEnabled: Boolean, channelImportance: Int?): Boolean =
        appEnabled && channelImportance != IMPORTANCE_NONE

    /** The app is allowed, but the "New mail" channel alone is off: its own settings page is the one to open. */
    fun onlyChannelOff(appEnabled: Boolean, channelImportance: Int?): Boolean =
        appEnabled && channelImportance == IMPORTANCE_NONE

    /**
     * A registration finished: keep its token only if the same sign-in is still current. Otherwise (signed out, or
     * someone else signed in meanwhile) the api is told to forget it again.
     */
    fun keepRegistration(startedFor: String?, signedInNow: String?): Boolean = startedFor != null && startedFor == signedInNow

    /**
     * What a failed call shows: the api's message (already in the app's language), or null for "Could not send" /
     * "Could not mark as read" (a timeout or anything else the app didn't word itself).
     */
    fun failureText(e: Throwable): String? = (e as? ApiException)?.message?.takeIf { it.isNotBlank() }
}

/**
 * Which chat is on screen. Set by the screen showing it (a chat, or one of its messages) and cleared only by that same
 * screen: while switching, the next screen can appear before the last one is gone.
 */
class Viewing {
    private var owner: Any? = null

    @Volatile var conversationId: Long? = null
        private set

    @Synchronized fun enter(owner: Any, conversationId: Long) {
        this.owner = owner
        this.conversationId = conversationId
    }

    @Synchronized fun leave(owner: Any) {
        if (this.owner !== owner) return
        this.owner = null
        conversationId = null
    }
}
