package org.jaiaditya.phonemail

import org.jaiaditya.phonemail.data.Api
import org.jaiaditya.phonemail.data.ApiException
import org.jaiaditya.phonemail.push.NewMail
import org.jaiaditya.phonemail.push.PushRules
import org.jaiaditya.phonemail.push.Viewing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PushTest {
    private val data = mapOf(
        "type" to "new_mail", "title" to "Asha Menon", "body" to "Lunch on Friday?",
        "conversation_id" to "42", "message_id" to "9001",
    )

    @Test
    fun parsesANewMailPush() {
        assertEquals(NewMail("Asha Menon", "Lunch on Friday?", 42L, 9001L), NewMail.parse(data))
        // Spaces around values, and an empty subject.
        val loose = data + mapOf("title" to " 9876543210@phonemail.net ", "body" to "", "conversation_id" to " 42 ")
        assertEquals(NewMail("9876543210@phonemail.net", "", 42L, 9001L), NewMail.parse(loose))
    }

    @Test
    fun ignoresOtherOrBrokenPushes() {
        assertNull(NewMail.parse(data + ("type" to "something_else")))
        assertNull(NewMail.parse(data - "type"))
        assertNull(NewMail.parse(data - "conversation_id"))
        assertNull(NewMail.parse(data + ("message_id" to "abc")))
        assertNull(NewMail.parse(data + ("conversation_id" to "0")))
        assertNull(NewMail.parse(emptyMap()))
        // Title and body may be missing: the notification falls back to the app's name and "(no subject)".
        assertEquals(NewMail("", "", 42L, 9001L), NewMail.parse(data - "title" - "body"))
    }

    @Test
    fun notifiesUnlessThatChatIsOpen() {
        val mail = NewMail.parse(data)!!
        assertTrue(NewMail.shouldNotify(signedIn = true, viewing = null, mail = mail))
        assertTrue(NewMail.shouldNotify(signedIn = true, viewing = 7L, mail = mail)) // another chat is open
        assertFalse(NewMail.shouldNotify(signedIn = true, viewing = 42L, mail = mail))
        assertFalse(NewMail.shouldNotify(signedIn = false, viewing = null, mail = mail))
    }

    @Test
    fun oneNotificationPerChat() {
        assertEquals(42, NewMail.notificationId(42L))
        assertEquals(NewMail.notificationId(5_000_000_000L), NewMail.notificationId(5_000_000_000L))
        assertNotEquals(NewMail.notificationId(1L), NewMail.notificationId(2L))
    }

    @Test
    fun takesTheTypedReply() {
        assertEquals("On my way", NewMail.replyText("  On my way \n"))
        assertNull(NewMail.replyText("   "))
        assertNull(NewMail.replyText(null))
    }

    @Test
    fun keepsARegistrationOnlyForTheSameSignIn() {
        assertTrue(PushRules.keepRegistration("tok-a", "tok-a"))
        assertFalse(PushRules.keepRegistration("tok-a", null)) // signed out meanwhile
        assertFalse(PushRules.keepRegistration("tok-a", "tok-b")) // someone else signed in meanwhile
        assertFalse(PushRules.keepRegistration(null, null))
    }

    @Test
    fun wordsAFailedReply() {
        assertEquals("Cannot reach PhoneMail.", PushRules.failureText(ApiException(0, "Cannot reach PhoneMail.")))
        // A timeout (or anything not from the api) shows the app's own translated "Could not send".
        assertNull(PushRules.failureText(IllegalStateException("Timed out waiting for 40000 ms")))
        assertNull(PushRules.failureText(ApiException(500, " ")))
    }

    @Test
    fun countsTheNewMailChannel() {
        assertTrue(PushRules.notificationsOn(appEnabled = true, channelImportance = 4))
        assertTrue(PushRules.notificationsOn(appEnabled = true, channelImportance = null)) // not made yet
        assertFalse(PushRules.notificationsOn(appEnabled = true, channelImportance = PushRules.IMPORTANCE_NONE))
        assertFalse(PushRules.notificationsOn(appEnabled = false, channelImportance = 4))
        assertTrue(PushRules.onlyChannelOff(appEnabled = true, channelImportance = PushRules.IMPORTANCE_NONE))
        assertFalse(PushRules.onlyChannelOff(appEnabled = false, channelImportance = PushRules.IMPORTANCE_NONE))
        assertFalse(PushRules.onlyChannelOff(appEnabled = true, channelImportance = 4))
    }

    @Test
    fun viewingIsClearedOnlyByTheScreenThatSetIt() {
        val viewing = Viewing()
        val chat = Any()
        val message = Any()
        viewing.enter(chat, 42L)
        viewing.enter(message, 42L) // a message of the chat opens before the chat screen is gone
        viewing.leave(chat)
        assertEquals(42L, viewing.conversationId)
        viewing.leave(message)
        assertNull(viewing.conversationId)
        assertTrue(NewMail.shouldNotify(signedIn = true, viewing = viewing.conversationId, mail = NewMail.parse(data)!!))
    }

    @Test
    fun buildsTheReplyAndDeviceBodies() {
        assertEquals("""{"conversation_id":42,"body_text":"On my way"}""", Api.replyBody(42L, "On my way").toString())
        assertEquals("""{"platform":"android","token":"fcm-token-1"}""", Api.pushDevice("fcm-token-1").toString())
    }
}
