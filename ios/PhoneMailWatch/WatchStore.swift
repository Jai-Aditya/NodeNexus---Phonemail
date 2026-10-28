import Foundation
import Observation
import WatchConnectivity

/// An api error on the watch. `status` 0 means the server could not be reached.
struct WatchError: LocalizedError {
    let status: Int
    let message: String
    var code: String? = nil
    var errorDescription: String? { message }
}

/// The watch's sign-in (sent by the iPhone app, kept in the watch's keychain) and its few api calls. The same api
/// as the iPhone's (`Authorization: Bearer <token>`), called directly over the watch's own connection.
@MainActor
@Observable
final class WatchStore {
    static let shared = WatchStore()

    private(set) var token: String?
    private(set) var name: String
    /// The iPhone app's language ("en", "hi", "ta"); the screens are redrawn when it changes.
    private(set) var lang: String
    /// A chat to open (from a tapped notification), until the chat list takes it.
    var pendingChat: Int64?
    /// Increases after a reply or a read from a notification, so the list reloads.
    private(set) var changed = 0

    @ObservationIgnored private var apiBase: String
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let http: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c)
    }()

    private init() {
        token = Keychain.get("token")
        name = defaults.string(forKey: "name") ?? ""
        lang = WatchLang.code
        apiBase = defaults.string(forKey: "apiBase") ?? "https://mail.phonemail.net/api"
        #if DEBUG
        // Screenshots on a watch simulator with no paired iPhone: `-uiTestToken <token>`, and `-uiTestChat <id>`
        // to open that chat.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-uiTestToken"), i + 1 < args.count {
            token = args[i + 1]
            if let c = args.firstIndex(of: "-uiTestChat"), c + 1 < args.count { pendingChat = Int64(args[c + 1]) }
        }
        #endif
        PhoneLink.shared.start()
    }

    /// The iPhone's application context: {"token", "apiBase", "name", "lang"}; an empty token signs out.
    func apply(_ context: [String: Any]) {
        guard let t = context["token"] as? String else { return }
        if let code = context["lang"] as? String, WatchLang.supported.contains(code) {
            defaults.set(code, forKey: "lang")
            lang = code
        }
        guard !t.isEmpty else { signOut(); return }
        if let base = context["apiBase"] as? String, !base.isEmpty {
            apiBase = base
            defaults.set(base, forKey: "apiBase")
        }
        name = context["name"] as? String ?? name
        defaults.set(name, forKey: "name")
        if t != token {
            Keychain.set("token", t)
            token = t
        }
    }

    func signOut() {
        Keychain.set("token", nil)
        token = nil
    }

    func didChange() { changed += 1 }

    // MARK: api

    @discardableResult
    func raw(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        guard let url = URL(string: apiBase + path) else { throw WatchError(status: 0, message: L("Request failed (%lld)", 0)) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("mobile", forHTTPHeaderField: "X-Client")
        req.setValue("PhoneMailWatch", forHTTPHeaderField: "X-Requested-With")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if method != "GET" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await http.data(for: req)
        } catch {
            throw WatchError(status: 0, message: L("Cannot reach PhoneMail. Check your connection and try again."))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 { signOut(); PhoneLink.shared.ask() } // the phone signs it in again, if it can
            let err = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
            throw WatchError(status: status, message: err?["message"] as? String ?? L("Request failed (%lld)", status),
                             code: err?["code"] as? String)
        }
        return data
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await raw("GET", path)
        do {
            return try WatchMail.decoder.decode(T.self, from: data)
        } catch {
            throw WatchError(status: 0, message: L("Unexpected reply from PhoneMail"))
        }
    }

    /// The Inbox, newest first.
    func chats() async throws -> [WatchChat] {
        let page: WatchPage<WatchChat> = try await get("/mail/conversations?filter=all&limit=50")
        return page.items
    }

    /// The newest 30 messages, oldest first. Opening a chat marks it read.
    func messages(_ conversationId: Int64) async throws -> [WatchMessage] {
        let page: WatchPage<WatchMessage> = try await get("/mail/conversations/\(conversationId)/messages?limit=30")
        _ = try? await raw("POST", "/mail/conversations/\(conversationId)/read")
        return WatchMail.shown(page.items)
    }

    func reply(to messageId: Int64, conversationId: Int64, text: String) async throws {
        let push = MailPush(conversationId: conversationId, messageId: messageId)
        guard let call = push.call(for: .reply(text)) else { return }
        try await raw(call.method, call.path, body: call.body)
    }
}

/// The watch's end of WatchConnectivity: takes the sign-in the iPhone sends, and asks for it when there is none.
final class PhoneLink: NSObject, WCSessionDelegate {
    static let shared = PhoneLink()

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Asks the iPhone app for the sign-in now (it is woken in the background to answer).
    func ask() {
        let s = WCSession.default
        guard s.activationState == .activated, s.isReachable else { return }
        s.sendMessage(["want": "signIn"], replyHandler: { reply in
            Task { @MainActor in WatchStore.shared.apply(reply) }
        }, errorHandler: nil)
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor in
            if !context.isEmpty { WatchStore.shared.apply(context) }
            if WatchStore.shared.token == nil { self.ask() }
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in WatchStore.shared.apply(applicationContext) }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in if WatchStore.shared.token == nil { self.ask() } }
    }
}
