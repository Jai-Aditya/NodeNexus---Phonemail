import Foundation
import WatchConnectivity

/// Signs the Apple Watch app in: the phone's sign-in token, the api address, the person's name and the app's
/// language go to the watch as its application context (the latest one always arrives, even if the watch app is
/// closed now). Signing out sends an empty token, which signs the watch out too. The watch can also ask for it.
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()

    private let lock = NSLock()
    private var _context: [String: Any] = ["token": ""]
    /// What the watch should have now.
    private var context: [String: Any] {
        get { lock.lock(); defer { lock.unlock() }; return _context }
        set { lock.lock(); _context = newValue; lock.unlock() }
    }

    private var session: WCSession? { WCSession.isSupported() ? WCSession.default : nil } // never on iPad

    /// `token` nil: signed out.
    func update(token: String?, name: String, language: String) {
        context = ["token": token ?? "", "apiBase": Config.apiBase, "name": name, "lang": language]
        guard let session else { return }
        if session.activationState == .activated {
            send()
        } else {
            session.delegate = self
            session.activate() // sent once active
        }
    }

    private func send() {
        guard let session, session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        do { try session.updateApplicationContext(context) } catch { print("watch: context not sent:", error.localizedDescription) }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        send()
    }

    /// The watch app was just installed, or another watch paired.
    func sessionWatchStateDidChange(_ session: WCSession) { send() }

    /// The watch asks for its sign-in (e.g. right after it was installed).
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler(context)
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}

    /// Switched to another watch: start again with it.
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
