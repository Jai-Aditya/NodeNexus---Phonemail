import SwiftUI
import UserNotifications
import WatchKit

/// PhoneMail on the Apple Watch: the Inbox, a chat, and a quick reply. It signs in through the iPhone app.
@main
struct PhoneMailWatchApp: App {
    @WKApplicationDelegateAdaptor(WatchDelegate.self) private var delegate
    @State private var store = WatchStore.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if store.token == nil {
                    SignedOutView()
                } else {
                    InboxView()
                }
            }
            .environment(store)
            .tint(Color(red: 0x8C / 255, green: 0x82 / 255, blue: 0xF2 / 255)) // the iPhone app's indigo (dark)
            .id(store.lang) // every string again in the iPhone app's language
        }
    }
}

/// The new-mail notifications the iPhone forwards: Reply and Mark as read can arrive here when they are used on
/// the watch (with the watch app installed), so they are handled the same way as on the iPhone.
final class WatchDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        let reply = UNTextInputNotificationAction(identifier: MailPush.replyAction, title: L("Reply"), options: [],
                                                  textInputButtonTitle: L("Send"), textInputPlaceholder: L("Message"))
        let read = UNNotificationAction(identifier: MailPush.markReadAction, title: L("Mark as read"), options: [])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: MailPush.category, actions: [reply, read], intentIdentifiers: [], options: []),
        ])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let push = MailPush(response.notification.request.content.userInfo),
              let action = MailPush.action(response.actionIdentifier, text: (response as? UNTextInputNotificationResponse)?.userText)
        else { completionHandler(); return }
        Task { @MainActor in
            let store = WatchStore.shared
            guard let call = push.call(for: action) else {
                store.pendingChat = push.conversationId // opened: show that chat
                completionHandler()
                return
            }
            // A reply that didn't go is told in a notification (as on the iPhone): nothing else is on screen.
            let replying: Bool
            if case .reply = action { replying = true } else { replying = false }
            if store.token == nil {
                if replying { Self.notify(L("Open PhoneMail on your iPhone to sign in."), push) }
            } else {
                do {
                    try await store.raw(call.method, call.path, body: call.body)
                    store.didChange()
                } catch {
                    if replying { Self.notify(L("Couldn't send your reply. Open PhoneMail to try again."), push) }
                }
            }
            completionHandler()
        }
    }

    private static func notify(_ text: String, _ push: MailPush) {
        let content = UNMutableNotificationContent()
        content.title = push.title
        content.body = text
        content.threadIdentifier = MailPush.threadId(push.conversationId)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
