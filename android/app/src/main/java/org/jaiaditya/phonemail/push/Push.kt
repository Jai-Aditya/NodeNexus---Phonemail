package org.jaiaditya.phonemail.push

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.tasks.await
import org.jaiaditya.phonemail.MainActivity
import org.jaiaditya.phonemail.R
import org.jaiaditya.phonemail.data.Session

/**
 * New-mail notifications: one per chat, with Reply (typed right in the notification) and Mark as read. Wear OS
 * watches show the same notification and actions by themselves; there is no watch app.
 */
object Push {
    const val CHANNEL = "new_mail"
    private const val TAG = "mail"
    const val EXTRA_CONVERSATION = "conversation_id"
    const val EXTRA_MESSAGE = "message_id"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val KEY_REPLY = "reply_text"

    /** The chat on screen right now (ChatScreen, or one of its messages, while resumed): its mail isn't notified. */
    val viewing = Viewing()

    // ---- the Firebase token ----

    /** This phone's push token, or null in a build without google-services.json (or without Play services). */
    suspend fun token(context: Context): String? {
        if (FirebaseApp.getApps(context).isEmpty()) return null
        return runCatching { FirebaseMessaging.getInstance().token.await() }.getOrNull()
    }

    /** After signing out: the next person to sign in on this phone gets a fresh token. */
    suspend fun forgetToken(context: Context) {
        if (FirebaseApp.getApps(context).isEmpty()) return
        runCatching { FirebaseMessaging.getInstance().deleteToken().await() }
    }

    // ---- permission and settings ----

    /** Android 13+ asks before an app may notify; older versions allow it until it is turned off in Settings. */
    fun permissionGranted(context: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** On for this app: the permission, not switched off in the phone's settings, and the "New mail" channel not off. */
    fun enabled(context: Context): Boolean {
        val nm = NotificationManagerCompat.from(context)
        return PushRules.notificationsOn(nm.areNotificationsEnabled(), nm.getNotificationChannelCompat(CHANNEL)?.importance)
    }

    /** Asked once, after sign-in (after the contacts step), and only where Android asks at all. */
    fun shouldAsk(context: Context, session: Session) =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !session.notificationsAsked && !permissionGranted(context)

    /** The phone's notification settings for PhoneMail, or just the "New mail" channel's when only that is off. */
    fun settingsIntent(context: Context): Intent {
        val nm = NotificationManagerCompat.from(context)
        val channelOff = PushRules.onlyChannelOff(nm.areNotificationsEnabled(), nm.getNotificationChannelCompat(CHANNEL)?.importance)
        val intent = if (channelOff) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_CHANNEL_ID, CHANNEL)
        } else {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        }
        return intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
    }

    /** Made at every start, so its name follows the app's language. */
    fun createChannel(context: Context, name: String) {
        val channel = NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_HIGH).setName(name).build()
        NotificationManagerCompat.from(context).createNotificationChannel(channel)
    }

    // ---- notifications ----

    /** New mail: added to the chat's notification (the last few messages show, newest last). */
    fun show(context: Context, session: Session, mail: NewMail) {
        val sender = senderName(session, mail)
        val subject = mail.body.ifEmpty { session.text(R.string.no_subject) }
        val style = previous(context, mail.conversationId) ?: NotificationCompat.MessagingStyle(me(session))
        style.addMessage(subject, System.currentTimeMillis(), Person.Builder().setName(sender).setKey(mail.title.ifEmpty { sender }).build())
        val n = builder(context, mail)
            .setContentTitle(sender)
            .setContentText(subject)
            .setStyle(style)
            .addAction(replyAction(context, session, mail))
            .addAction(readAction(context, session, mail))
            .build()
        post(context, mail.conversationId, n)
    }

    /** After Reply: the sent text shows under the mail (and the spinner Android shows while sending stops). */
    fun showReplied(context: Context, session: Session, mail: NewMail, text: String) {
        val style = previous(context, mail.conversationId) ?: NotificationCompat.MessagingStyle(me(session))
        style.addMessage(text, System.currentTimeMillis(), null as Person?)
        val n = builder(context, mail)
            .setContentTitle(senderName(session, mail))
            .setContentText(text)
            .setStyle(style)
            .setOnlyAlertOnce(true)
            .build()
        post(context, mail.conversationId, n)
    }

    /** A line in place of the mail when a call failed; Reply and Mark as read stay, to try again. */
    fun showNote(context: Context, session: Session, mail: NewMail, note: String) {
        val n = builder(context, mail)
            .setContentTitle(senderName(session, mail))
            .setContentText(note)
            .setStyle(NotificationCompat.BigTextStyle().bigText(note))
            .setOnlyAlertOnce(true)
            .addAction(replyAction(context, session, mail))
            .addAction(readAction(context, session, mail))
            .build()
        post(context, mail.conversationId, n)
    }

    /**
     * The chat's notification posted again exactly as it was (silently): after an empty Reply, this stops the
     * spinner Android shows while it waits for the app.
     */
    fun repost(context: Context, conversationId: Long) {
        val shown = active(context, conversationId) ?: return
        val again = android.app.Notification.Builder.recoverBuilder(context, shown.notification).setOnlyAlertOnce(true).build()
        post(context, conversationId, again)
    }

    fun cancel(context: Context, conversationId: Long) =
        NotificationManagerCompat.from(context).cancel(TAG, NewMail.notificationId(conversationId))

    private fun builder(context: Context, mail: NewMail) = NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(R.drawable.ic_notification)
        .setColor(ContextCompat.getColor(context, R.color.brand))
        .setCategory(NotificationCompat.CATEGORY_EMAIL)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openChat(context, mail))

    private fun post(context: Context, conversationId: Long, n: android.app.Notification) {
        if (!permissionGranted(context)) return
        NotificationManagerCompat.from(context).notify(TAG, NewMail.notificationId(conversationId), n)
    }

    /** The chat's notification still showing, so new mail adds to it rather than replacing it. */
    private fun previous(context: Context, conversationId: Long): NotificationCompat.MessagingStyle? {
        val shown = active(context, conversationId) ?: return null
        return NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(shown.notification)
    }

    private fun active(context: Context, conversationId: Long): StatusBarNotification? {
        val id = NewMail.notificationId(conversationId)
        return runCatching {
            context.getSystemService(NotificationManager::class.java).activeNotifications.firstOrNull { it.tag == TAG && it.id == id }
        }.getOrNull()
    }

    private fun me(session: Session) = Person.Builder().setName(session.text(R.string.you)).build()

    /** The contact's name when the phone knows the sender. */
    private fun senderName(session: Session, mail: NewMail) =
        session.contactName(mail.title) ?: mail.title.ifEmpty { session.text(R.string.app_name) }

    // ---- what tapping and the buttons do ----

    fun Intent.putMail(mail: NewMail): Intent = putExtra(EXTRA_CONVERSATION, mail.conversationId)
        .putExtra(EXTRA_MESSAGE, mail.messageId).putExtra(EXTRA_TITLE, mail.title).putExtra(EXTRA_BODY, mail.body)

    fun mailOf(intent: Intent): NewMail? {
        val conversation = intent.getLongExtra(EXTRA_CONVERSATION, 0L)
        val message = intent.getLongExtra(EXTRA_MESSAGE, 0L)
        if (conversation <= 0L || message <= 0L) return null
        return NewMail(intent.getStringExtra(EXTRA_TITLE).orEmpty(), intent.getStringExtra(EXTRA_BODY).orEmpty(), conversation, message)
    }

    /** Tapping opens the app straight into the chat (MainActivity reads the extras). */
    private fun openChat(context: Context, mail: NewMail): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putMail(mail)
        return PendingIntent.getActivity(
            context, NewMail.notificationId(mail.conversationId), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(context: Context, action: String, mail: NewMail, mutable: Boolean): PendingIntent {
        val intent = Intent(context, NotificationActions::class.java).setAction(action).putMail(mail)
        // Reply must be mutable: Android adds the typed text to it. The intent names its receiver, so that is safe.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, NewMail.notificationId(mail.conversationId), intent, flags)
    }

    private fun replyAction(context: Context, session: Session, mail: NewMail): NotificationCompat.Action {
        val input = RemoteInput.Builder(KEY_REPLY).setLabel(session.text(R.string.write_reply)).build()
        return NotificationCompat.Action.Builder(
            R.drawable.ic_notification, session.text(R.string.reply), actionIntent(context, NotificationActions.REPLY, mail, mutable = true),
        )
            .addRemoteInput(input)
            .setAllowGeneratedReplies(true) // smart replies on watches
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
    }

    private fun readAction(context: Context, session: Session, mail: NewMail) = NotificationCompat.Action.Builder(
        R.drawable.ic_notification, session.text(R.string.mark_read), actionIntent(context, NotificationActions.READ, mail, mutable = false),
    )
        .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
        .setShowsUserInterface(false)
        .build()
}
