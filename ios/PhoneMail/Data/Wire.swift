import Foundation

// The JSON the PhoneMail api sends (mail.phonemail.net since 30 Sep 2026): snake_case names (decoded with
// `.convertFromSnakeCase`), lists wrapped in {"items": [...]}. API.swift turns these into the app's own models
// (Models.swift), so the screens don't depend on the server's shapes.

struct WUser: Decodable {
    let id: Int64
    var phone: String = ""
    var address: String = ""
    var displayName: String?
    var language: String?
    var avatarUrl: String?
    var hasPush: Bool?
    var hasPassword: Bool?
    var createdVia: String?
    var aliases: [String]?
}

struct WAuth: Decodable {
    let token: String?
    let user: WUser
}

struct WAuthConfig: Decodable {
    let mode: String
    let signupNumber: String?
}

struct WPerson: Decodable {
    var userId: Int64?
    var address: String?
    var displayName: String?
    var avatarUrl: String?
}

struct WChat: Decodable {
    let conversationId: Int64
    let kind: String
    let name: String?
    let peer: WPerson?
    let lastMessageAt: String?
    let lastMessageId: Int64?
    let snippet: String?
    let unreadCount: Int?
    let hasAttachments: Bool?
    let favouriteCount: Int?
    let memberCount: Int?
    let archived: Bool?      // left out when false
    let muted: Bool?
    let snoozedUntil: String?
    let folderId: Int64?     // left out when not in a folder
}

struct WFolder: Decodable {
    let id: Int64
    let name: String
    let chatCount: Int?
    let unreadCount: Int?
}

struct WChanged: Decodable {
    let changed: Int
}

struct WRecipient: Decodable {
    let kind: String
    let person: WPerson?
    let groupId: Int64?
    let groupName: String?
}

struct WAttachment: Decodable {
    let id: Int64
    let filename: String
    let contentType: String?
    let sizeBytes: Int64?
}

struct WMessage: Decodable {
    let id: Int64
    let conversationId: Int64?
    let sender: WPerson?
    let subject: String?
    let bodyText: String?
    let snippet: String?
    let parentId: Int64?
    let rootId: Int64?
    let depth: Int?
    let hasAttachments: Bool?
    let sentAt: String?
    let folder: String?
    let isRead: Bool?
    let isFavourite: Bool?
    let isReplied: Bool?
    let isMine: Bool?
    let recipients: [WRecipient]?
    let attachments: [WAttachment]?
}

struct WPage<T: Decodable>: Decodable {
    let items: [T]
}

struct WSearch: Decodable {
    let messages: [WMessage]
}

struct WTo: Decodable {
    let address: String?
    let groupId: Int64?
}

/// A draft's recipients. The api writes a single To as one object and two or more as a list.
struct WDraftRecipients: Decodable {
    var to: [WTo] = []
    var cc: [WTo] = []
    var bcc: [WTo] = []

    private enum Keys: String, CodingKey { case to, cc, bcc }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let list = try? c.decode([WTo].self, forKey: .to) {
            to = list
        } else if let one = try? c.decode(WTo.self, forKey: .to) {
            to = [one]
        }
        cc = (try? c.decode([WTo].self, forKey: .cc)) ?? []
        bcc = (try? c.decode([WTo].self, forKey: .bcc)) ?? []
    }
}

struct WDraft: Decodable {
    let id: Int64
    let conversationId: Int64?
    let parentId: Int64?
    let recipients: WDraftRecipients?
    let subject: String?
    let bodyText: String?
    let updatedAt: String?
    let sendAt: String?      // scheduled drafts only
}

struct WSent: Decodable {
    let messageId: Int64
    let conversationIds: [Int64]?
}

struct WMember: Decodable {
    let userId: Int64?
    let address: String?
    let role: String?
}

struct WGroup: Decodable {
    let conversationId: Int64
    let name: String
    let created: Bool?
    let members: [WMember]?
}

struct WSuggestions: Decodable {
    let people: [WSuggestion]
}

struct WSuggestion: Decodable {
    let address: String?
    let conversationId: Int64?
    let known: Bool?
}
