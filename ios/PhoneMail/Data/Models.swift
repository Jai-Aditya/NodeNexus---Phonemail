import Foundation

// The api's JSON shapes (docs-site/static/api/openapi.yaml). Fields the api may leave out are optional.

struct User: Codable, Equatable {
    let id: Int64
    let phone: String
    let address: String
    var displayName: String?
    var language: String
    var avatarUrl: String?
    /// Profile picture: nil = the number bloom; "glyph:<emoji>:<#rrggbb>"; "photo:<name>.jpg".
    var avatar: String?
    var hasPush: Bool
    var createdVia: String
    var hasPassword: Bool?
    var aliases: [String]?

    var label: String { displayName ?? address }
}

/// Someone the user blocked: their direct mail goes to Spam.
struct BlockedPerson: Identifiable, Equatable {
    let userId: Int64
    let address: String
    let name: String?

    var id: Int64 { userId }
    var label: String { name ?? address }
}

struct AuthResponse: Codable {
    let token: String
    let user: User
}

struct AuthMode: Codable {
    let mode: String // "otp" or "password"
    let smsJoin: Bool
    let smsTo: String?
}

struct JoinStart: Codable {
    let code: String
    let smsTo: String
    let text: String
    let qr: String?
    let link: String?
    let expiresAt: String
}

struct JoinStatus: Codable {
    let status: String // waiting, done, used, expired
    let token: String?
    let user: User?
}

struct Conversation: Codable, Identifiable, Hashable {
    let id: Int64
    let kind: String
    let name: String?
    let peerAddress: String?
    let peerName: String?
    var peerAvatar: String?
    let lastMessageAt: String?
    let lastMessageId: Int64?
    let snippet: String
    let unreadCount: Int
    let hasAttachments: Bool
    let favouriteCount: Int
    var memberCount: Int? = nil
    var archived: Bool? = nil
    var muted: Bool? = nil
    /// Hidden from Home until this time (ISO).
    var snoozedUntil: String? = nil
    /// The user's folder it is filed in.
    var folderId: Int64? = nil

    var isGroup: Bool { kind == "group" }
    var title: String { isGroup ? (name ?? L("Group")) : (peerName ?? peerAddress ?? L("Conversation")) }
    var isArchived: Bool { archived == true }
    var isMuted: Bool { muted == true }
    /// Snoozed until a time still ahead.
    func isSnoozed(now: Date = Date()) -> Bool { Format.date(snoozedUntil).map { $0 > now } ?? false }
}

/// One of the user's own folders. Filing chats in a folder archives them, so they leave Home.
struct MailFolder: Codable, Identifiable, Hashable {
    let id: Int64
    let name: String
    let chatCount: Int
    let unreadCount: Int
}

struct Recipient: Codable, Hashable {
    let kind: String
    let address: String?
    let groupId: Int64?
    let groupName: String?
}

struct Message: Codable, Identifiable, Hashable {
    let id: Int64
    let conversationId: Int64?
    let senderId: Int64
    let senderAddress: String
    let senderName: String?
    var senderAvatar: String?
    let subject: String
    let body: String
    let parentId: Int64?
    let rootId: Int64
    let depth: Int
    let sentAt: String
    let hasAttachments: Bool?
    let isRead: Bool
    let isFavourite: Bool
    let isReplied: Bool
    let isMine: Bool
    let folder: String
    let recipients: [Recipient]?
    var attachments: [Attachment]?

    var senderLabel: String { senderName ?? senderAddress }
}

/// A file on a message (or just uploaded, before sending).
struct Attachment: Codable, Identifiable, Hashable {
    let id: Int64
    let filename: String
    let contentType: String
    let size: Int64

    var isImage: Bool { contentType.hasPrefix("image/") }
}

/// The stock profile pictures (GET /avatars/stock).
struct StockAvatars: Codable {
    let glyphs: [String]
    let colors: [String]

    /// Used when the api can't be reached; the same set the server offers.
    static let fallback = StockAvatars(
        glyphs: ["🦚", "🐘", "🐯", "🪷", "🌺", "🥭", "🏏", "🪁", "🎵", "📚", "🚀", "⭐", "🌙", "☕", "🐬", "🦉"],
        colors: ["#4B3FB0", "#1f6feb", "#8250df", "#d1242f", "#bf5700", "#9a6700", "#0e7490", "#be185d"]
    )
}

struct DraftRecipients: Codable, Hashable {
    var to: [String]?
    var cc: [String]?
    var bcc: [String]?
}

struct Draft: Codable, Identifiable, Hashable {
    let id: Int64
    let conversationId: Int64?
    let parentId: Int64?
    let recipients: DraftRecipients
    let subject: String
    let body: String
    let updatedAt: String
    /// When a scheduled draft will be sent (ISO); nil for an ordinary draft.
    var sendAt: String? = nil
}

struct Delivered: Codable {
    let messageId: Int64
    let conversationIds: [Int64]
}

struct GroupMember: Codable, Hashable {
    let userId: Int64
    let address: String
    let role: String
}

/// A named group (called MailGroup so it does not hide SwiftUI's Group view).
struct MailGroup: Codable {
    let id: Int64
    let name: String
    let created: Bool?
    let members: [GroupMember]
}

struct AliasAdded: Codable {
    let alias: String
}
