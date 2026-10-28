import Observation
import UIKit
import UserNotifications

/// Push notifications for new mail. Asked once the person is signed in (on Home's first appearance, after the
/// contacts step); on every launch while signed in the device token is sent again (POST /api/push/devices), and it
/// is removed on sign-out and before the account is deleted. Reply and Mark as read work from the notification,
/// on the iPhone and on a paired Apple Watch (AppDelegate handles them).
@MainActor
@Observable
final class Push {
    static let shared = Push()

    private(set) var status: UNAuthorizationStatus = .notDetermined
    /// The signed-in api (set by the app at launch).
    @ObservationIgnored var api: API?
    /// This device's token (hex), kept so signing out can remove it from the server.
    @ObservationIgnored private(set) var token: String? = UserDefaults.standard.string(forKey: "pushToken")

    var isOn: Bool { [.authorized, .provisional, .ephemeral].contains(status) }

    /// UI tests run without the permission alert (it would cover the screens they tap).
    private static var skipped: Bool { ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("-uiTest") } }

    /// Asks the first time (alert, sound, badge); afterwards just registers with APNs again.
    func start() async {
        guard !Self.skipped else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        await refresh()
        if isOn { UIApplication.shared.registerForRemoteNotifications() }
    }

    func refresh() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// APNs gave this device a token: sent to the server while someone is signed in.
    func registered(_ deviceToken: Data) {
        let hex = Self.hex(deviceToken)
        token = hex
        UserDefaults.standard.set(hex, forKey: "pushToken")
        guard let api, api.token != nil else { return }
        Task { try? await api.registerPush(token: hex, sandbox: Self.sandbox) }
    }

    /// Best effort: the server stops pushing to this device for the account `api` is signed in to.
    func unregister(using api: API) async {
        guard let token else { return }
        try? await api.unregisterPush(token: token)
    }

    /// After signing out: removes this device from the account `bearer` (the old sign-in) belonged to. If the server
    /// can't be reached (offline, or it fails), it is kept in the keychain and tried again on the next launch or
    /// return to the app while signed out; any other answer (done, or 401: that sign-in is already gone) ends it.
    func unregister(bearer: String) async {
        guard token != nil else { return }
        Keychain.set(Self.pendingKey, bearer)
        await retryPendingUnregister()
    }

    func retryPendingUnregister() async {
        guard let bearer = Keychain.get(Self.pendingKey), let token else { return }
        let api = API(base: Config.apiBase)
        api.token = bearer
        do {
            try await api.unregisterPush(token: token)
        } catch let e as APIError where Self.keepsPending(status: e.status) {
            return
        } catch {}
        Keychain.set(Self.pendingKey, nil)
    }

    /// Signing in again registers the device for the new account, which supersedes an old unregister still waiting
    /// (sending it later could take the device away from the new account).
    func dropPendingUnregister() { Keychain.set(Self.pendingKey, nil) }

    private static let pendingKey = "pushUnregisterBearer"

    /// Unreachable (0) or a server failure (5xx): try again later.
    nonisolated static func keepsPending(status: Int) -> Bool { status == 0 || (500..<600).contains(status) }

    /// The Reply and Mark as read buttons (titles in the app's language; registered again when it changes).
    static func registerCategory() {
        let reply = UNTextInputNotificationAction(identifier: MailPush.replyAction, title: L("Reply"), options: [],
                                                  textInputButtonTitle: L("Send"), textInputPlaceholder: L("Message"))
        let read = UNNotificationAction(identifier: MailPush.markReadAction, title: L("Mark as read"), options: [])
        let category = UNNotificationCategory(identifier: MailPush.category, actions: [reply, read], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    /// Takes away the chat's notifications once it is opened.
    static func clearDelivered(_ conversationId: Int64) {
        let thread = MailPush.threadId(conversationId)
        UNUserNotificationCenter.current().getDeliveredNotifications { list in
            let ids = list.filter { $0.request.content.threadIdentifier == thread }.map(\.request.identifier)
            if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    nonisolated static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    /// Which APNs the token belongs to: the build's provisioning profile says (every development-signed build, Release
    /// ones from `build.sh device` too, uses the sandbox); App Store and TestFlight builds carry none (production).
    /// The simulator has no profile: Debug counts as the sandbox.
    nonisolated static let sandbox: Bool = {
        if let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
           let data = try? Data(contentsOf: url), let env = apsEnvironment(inProfile: data) {
            return env == "development"
        }
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()

    /// "development" or "production" from a provisioning profile (a signed file with a plain-text plist inside).
    nonisolated static func apsEnvironment(inProfile data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        guard let key = text.range(of: "<key>aps-environment</key>") else { return nil }
        let rest = text[key.upperBound...]
        guard let open = rest.range(of: "<string>"), let close = rest.range(of: "</string>", range: open.upperBound..<rest.endIndex)
        else { return nil }
        return String(rest[open.upperBound..<close.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Registers the notification buttons at launch, passes the APNs token on, and handles what is done with a
/// notification: Reply and Mark as read call the api (also when they come from the Apple Watch, with the app in the
/// background), and a tap opens the chat.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Push.registerCategory()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { Push.shared.registered(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push: no APNs token:", error.localizedDescription) // e.g. the simulator without a signed build
    }

    /// With the app open, a push shows unless its chat is already on screen, or nobody is signed in (a device the
    /// server hasn't forgotten yet).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let push = MailPush(notification.request.content.userInfo)
        Task { @MainActor in
            if push != nil && Keychain.get("token") == nil { completionHandler([]); return }
            completionHandler(MailPush.showsInForeground(push, openChat: Nav.shared.openChat) ? [.banner, .list, .sound] : [])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let push = MailPush(response.notification.request.content.userInfo),
              let action = MailPush.action(response.actionIdentifier, text: (response as? UNTextInputNotificationResponse)?.userText)
        else { completionHandler(); return }
        Task { @MainActor in
            // Signed out: the mail is no one's here now (and a later sign-in, maybe another person, mustn't open it).
            guard Keychain.get("token") != nil else { completionHandler(); return }
            if action == .open {
                Nav.shared.open(conversationId: push.conversationId, title: push.title)
                completionHandler()
                return
            }
            // The app may have been woken in the background just for this: keep it running until the call ends.
            let task = UIApplication.shared.beginBackgroundTask(withName: "notification-action")
            await Self.perform(action, on: push)
            completionHandler()
            if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        }
    }

    /// Calls the api with the saved sign-in (the app's screens may not exist yet). A refused or failed reply is
    /// told in a notification, since nothing else is on screen.
    @MainActor private static func perform(_ action: MailPush.Action, on push: MailPush) async {
        guard let token = Keychain.get("token"), let call = push.call(for: action) else { return }
        let api = API(base: Config.apiBase)
        api.token = token
        do {
            try await api.raw(call.method, call.path, body: call.body)
        } catch is APIError {
            guard case .reply = action else { return }
            notify(L("Couldn't send your reply. Open PhoneMail to try again."), push)
        } catch {}
    }

    private static func notify(_ text: String, _ push: MailPush) {
        let content = UNMutableNotificationContent()
        content.title = push.title
        content.body = text
        content.threadIdentifier = MailPush.threadId(push.conversationId)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
