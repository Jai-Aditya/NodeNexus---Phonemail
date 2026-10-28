import Foundation
import UserNotifications

/// A new-mail push as the server sends it (shared by the iPhone and Apple Watch apps):
/// {"aps": {"alert": {"title": "<sender>", "body": "<subject>"}, "thread-id": "conv-<id>", "category": "NEW_MAIL", ...},
///  "conversation_id": <int>, "message_id": <int>}.
/// Its actions, Reply (with text) and Mark as read, also show on a paired Apple Watch.
struct MailPush: Equatable {
    static let category = "NEW_MAIL"
    static let replyAction = "REPLY"
    static let markReadAction = "MARK_READ"

    let conversationId: Int64
    let messageId: Int64
    var title = ""
    var body = ""

    init(conversationId: Int64, messageId: Int64, title: String = "", body: String = "") {
        self.conversationId = conversationId
        self.messageId = messageId
        self.title = title
        self.body = body
    }

    /// Nil for anything that isn't a new-mail push (e.g. the app's own local notices).
    init?(_ userInfo: [AnyHashable: Any]) {
        let aps = userInfo["aps"] as? [String: Any]
        let thread = (aps?["thread-id"] as? String).flatMap { $0.hasPrefix("conv-") ? Int64($0.dropFirst(5)) : nil }
        guard let c = Self.number(userInfo["conversation_id"]) ?? thread, let m = Self.number(userInfo["message_id"]) else { return nil }
        let alert = aps?["alert"] as? [String: Any]
        self.init(conversationId: c, messageId: m, title: alert?["title"] as? String ?? "", body: alert?["body"] as? String ?? "")
    }

    /// JSON numbers arrive as NSNumber; a string of digits is taken too.
    private static func number(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return n.int64Value }
        if let s = v as? String { return Int64(s) }
        return nil
    }

    static func threadId(_ conversationId: Int64) -> String { "conv-\(conversationId)" }

    /// What the person did with the notification.
    enum Action: Equatable {
        case open
        case reply(String)
        case markRead
    }

    /// Nil when there is nothing to do: dismissed, or Reply with no text.
    static func action(_ identifier: String, text: String? = nil) -> Action? {
        switch identifier {
        case UNNotificationDefaultActionIdentifier: return .open
        case markReadAction: return .markRead
        case replyAction:
            let t = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? nil : .reply(t)
        default: return nil
        }
    }

    /// The api call (under /api) an action makes; opening the chat makes none.
    struct Call {
        let method: String
        let path: String
        let body: [String: Any]?
    }

    func call(for action: Action) -> Call? {
        switch action {
        case .open: return nil
        case .markRead: return Call(method: "POST", path: "/mail/conversations/\(conversationId)/read", body: nil)
        case .reply(let text):
            return Call(method: "POST", path: "/mail/messages/\(messageId)/reply", body: ["conversation_id": conversationId, "body_text": text])
        }
    }

    /// While the app is open, a push shows unless its chat is the one on screen. Other notices always show.
    static func showsInForeground(_ push: MailPush?, openChat: Int64?) -> Bool {
        guard let push, let openChat else { return true }
        return push.conversationId != openChat
    }
}
