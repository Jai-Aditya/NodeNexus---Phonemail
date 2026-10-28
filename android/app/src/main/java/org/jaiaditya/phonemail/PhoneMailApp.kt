package org.jaiaditya.phonemail

import android.app.Application
import org.jaiaditya.phonemail.data.Session
import org.jaiaditya.phonemail.push.Push

class PhoneMailApp : Application() {
    lateinit var session: Session
        private set

    override fun onCreate() {
        super.onCreate()
        session = Session(this)
        Push.createChannel(this, session.text(R.string.channel_new_mail))
    }
}
