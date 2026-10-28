import Foundation

// The few api shapes the Apple Watch app reads, straight from the JSON (snake_case, decoded with
// `.convertFromSnakeCase`), and its small rules. Built into the iPhone app too, so its unit tests cover them.

struct WatchPerson: Decodable, Hashable {
    var address: String?
    var displayName: String?
}

/// A row of the Inbox.
struct WatchChat: Decodable, Identifiable, Hashable {
    let conversationId: Int64
    let kind: String
    var name: String?
    var peer: WatchPerson?
    var lastMessageAt: String?
    var snippet: String?
    var unreadCount: Int?

    var id: Int64 { conversationId }
    var unread: Int { unreadCount ?? 0 }
    var title: String {
        if kind == "group" { return WatchMail.nonEmpty(name) ?? L("Group") }
        return WatchMail.nonEmpty(peer?.displayName) ?? WatchMail.nonEmpty(peer?.address) ?? L("Conversation")
    }
}

struct WatchMessage: Decodable, Identifiable, Hashable {
    let id: Int64
    var sender: WatchPerson?
    var subject: String?
    var bodyText: String?
    var snippet: String?
    var parentId: Int64?
    var sentAt: String?
    var isMine: Bool?
    var isReplied: Bool?

    var mine: Bool { isMine == true }
    var senderLabel: String { mine ? L("You") : (WatchMail.nonEmpty(sender?.displayName) ?? sender?.address ?? "") }
    var text: String { WatchMail.nonEmpty(bodyText) ?? snippet ?? "" }
    /// A new email shows its subject; replies never do (as in the iPhone's chats).
    var shownSubject: String? { parentId == nil ? WatchMail.nonEmpty(subject) : nil }
}

struct WatchPage<T: Decodable>: Decodable {
    let items: [T]
}

enum WatchMail {
    /// One tap replies (translated).
    static var quickReplies: [String] { [L("OK"), L("Thanks!"), L("On my way"), L("Call you later")] }

    /// The email a reply from the watch answers: the newest one from someone else (messages oldest first).
    static func replyTarget(_ messages: [WatchMessage]) -> WatchMessage? { messages.last { !$0.mine } }

    /// Newest first, as the api sends them -> oldest first, as shown. Long bodies are cut for the small screen.
    static func shown(_ newestFirst: [WatchMessage], limit: Int = 600) -> [WatchMessage] {
        newestFirst.reversed().map { m in
            var m = m
            if let b = m.bodyText, b.count > limit { m.bodyText = String(b.prefix(limit)) + "…" }
            return m
        }
    }

    static func nonEmpty(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()
}
