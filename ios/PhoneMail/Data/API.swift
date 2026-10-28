import Foundation
import UIKit

enum Config {
    /// The api base URL, set per build configuration (project.yml -> Info.plist `PMApiBase`).
    static let apiBase: String = {
        let v = Bundle.main.object(forInfoDictionaryKey: "PMApiBase") as? String ?? ""
        return v.isEmpty || v.hasPrefix("$(") ? "https://mail.phonemail.net/api" : v
    }()
    static let mailDomain = "phonemail.net"
    static let termsURL = URL(string: "https://mail.phonemail.net/terms")!
    static let helpURL = URL(string: "https://phonemail.net/docs/manual/")!
}

/// An api error. `status` 0 means the server could not be reached.
struct APIError: LocalizedError {
    let status: Int
    let message: String
    /// The api's own error code, when it sent one.
    var code: String? = nil
    var errorDescription: String? { message }
}

/// The PhoneMail api at `/api` (the build live on mail.phonemail.net since 30 Sep 2026). Mail calls are under
/// `/api/mail/`; JSON uses snake_case and lists come as {"items": [...]}. Replies are turned into the app's own
/// models (Models.swift) here, so the screens don't change with the server's shapes.
///
/// Signed in, every call sends `Authorization: Bearer <token>`; the sign-in calls send `client: "mobile"`, which
/// makes the api hand out a token instead of a browser cookie. `X-Requested-With` goes on every call (the api asks
/// for it on changes made without a token).
final class API {
    let base: String
    var onUnauthorized: () -> Void = {}

    // Calls run off the main thread, so the token is kept here behind a lock.
    private let lock = NSLock()
    private var _token: String?
    var token: String? {
        get { lock.lock(); defer { lock.unlock() }; return _token }
        set { lock.lock(); _token = newValue; lock.unlock() }
    }

    /// The draft carrying the files being attached (the api keeps attachments on a draft until it is sent).
    private var _fileDraft: Int64?
    private var fileDraft: Int64? {
        get { lock.lock(); defer { lock.unlock() }; return _fileDraft }
        set { lock.lock(); _fileDraft = newValue; lock.unlock() }
    }

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c)
    }()
    private let wire: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    init(base: String) { self.base = base }

    /// Builds a JSON body, leaving out nil values.
    static func obj(_ pairs: KeyValuePairs<String, Any?>) -> [String: Any] {
        var d: [String: Any] = [:]
        for (k, v) in pairs { if let v { d[k] = v } }
        return d
    }

    /// "displayName" -> "display_name" (the app's names to the api's).
    static func snake(_ k: String) -> String {
        var out = ""
        for ch in k {
            if ch.isUppercase { out += "_" + ch.lowercased() } else { out.append(ch) }
        }
        return out
    }

    /// People as the api takes them: [{"address": "9876543210"}, ...].
    static func people(_ list: [String]) -> [[String: Any]] { list.map { ["address": $0] } }

    private func request(_ method: String, _ path: String) throws -> URLRequest {
        guard let url = URL(string: base + path) else { throw APIError(status: 0, message: L("Bad address")) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("mobile", forHTTPHeaderField: "X-Client")
        req.setValue("PhoneMailiOS", forHTTPHeaderField: "X-Requested-With")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        return req
    }

    /// Checks the status of a finished request; api errors carry {"error": {"code", "message"}}.
    private func checked(_ data: Data, _ response: URLResponse, path: String, hadToken: Bool) throws -> Data {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401, hadToken, !path.hasPrefix("/auth/") { onUnauthorized() }
        guard (200..<300).contains(status) else {
            let err = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"]
            let msg = (err as? [String: Any])?["message"] as? String ?? err as? String
            let code = (err as? [String: Any])?["code"] as? String
            if status == 413 { throw APIError(status: status, message: msg ?? L("That file is too big."), code: code) }
            throw APIError(status: status, message: msg ?? L("Request failed (%lld)", status), code: code)
        }
        return data
    }

    private static var offline: APIError { APIError(status: 0, message: L("Cannot reach PhoneMail. Check your connection and try again.")) }

    @discardableResult
    func raw(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        var req = try request(method, path)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        } else if method != "GET" && method != "DELETE" {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data("{}".utf8)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw Self.offline
        }
        return try checked(data, response, path: path, hadToken: token != nil)
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        try decode(try await raw(method, path, body: body))
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try wire.decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, message: L("Unexpected reply from PhoneMail"))
        }
    }

    /// Sends `data` as the request body (file uploads), reporting progress from 0 to 1.
    private func upload<T: Decodable>(_ method: String, _ path: String, data: Data, headers: [String: String],
                                      progress: (@Sendable (Double) -> Void)? = nil) async throws -> T {
        var req = try request(method, path)
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let out: Data
        let response: URLResponse
        do {
            (out, response) = try await session.upload(for: req, from: data, delegate: progress.map(UploadProgress.init))
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw Self.offline
        }
        return try decode(try checked(out, response, path: path, hadToken: token != nil))
    }

    static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s
    }

    // MARK: sign-up and sign-in (no phone calls anywhere)

    func authMode() async throws -> AuthMode {
        let c: WAuthConfig = try await call("GET", "/auth/config")
        // Texting JOIN still creates an account, but the api can't link that text to this phone's sign-in.
        return AuthMode(mode: c.mode, smsJoin: false, smsTo: c.signupNumber)
    }
    func otpStart(phone: String) async throws { try await raw("POST", "/auth/otp/start", body: ["phone": phone]) }
    func otpVerify(phone: String, code: String) async throws -> AuthResponse {
        auth(try await call("POST", "/auth/otp/verify", body: ["phone": phone, "code": code, "client": "mobile"]))
    }
    func joinStart(phone: String) async throws -> JoinStart {
        throw APIError(status: 501, message: L("Signing in by text isn't available in the app. Use the code we text you, or a password."))
    }
    func joinStatus(code: String) async throws -> JoinStatus { JoinStatus(status: "expired", token: nil, user: nil) }
    func passwordLogin(phone: String, password: String) async throws -> AuthResponse {
        auth(try await call("POST", "/auth/login", body: ["phone": phone, "password": password, "client": "mobile"]))
    }
    /// Works only when the server is in password mode; otherwise the api asks for a code instead (its message is shown).
    func passwordRegister(phone: String, password: String) async throws -> AuthResponse {
        auth(try await call("POST", "/auth/register", body: ["phone": phone, "password": password, "client": "mobile"]))
    }

    private func auth(_ a: WAuth) -> AuthResponse { AuthResponse(token: a.token ?? "", user: user(a.user)) }

    // MARK: profile

    func me() async throws -> User { user(try await call("GET", "/me")) }
    /// Fields by the app's names (displayName, language).
    func updateMe(_ fields: [String: Any]) async throws -> User {
        var body: [String: Any] = [:]
        for (k, v) in fields { body[Self.snake(k)] = v }
        return user(try await call("PATCH", "/me", body: body))
    }
    /// The api asks for the current password whenever one exists.
    func changePassword(current: String?, new: String) async throws {
        try await raw("PUT", "/me/password", body: Self.obj(["current_password": current, "new_password": new]))
    }
    func addAlias(_ alias: String) async throws -> AliasAdded { try await call("POST", "/me/aliases", body: ["alias": alias]) }
    func removeAlias(_ alias: String) async throws { try await raw("DELETE", "/me/aliases/\(Self.enc(alias))") }
    /// Erases the account for good. Confirmed with the password, or (accounts without one) a code from `otpStart`.
    func deleteAccount(password: String?, code: String?) async throws {
        try await raw("DELETE", "/me", body: Self.obj(["password": password, "code": code]))
    }

    // MARK: push notifications (this device's APNs token; `sandbox` for development-signed builds)

    func registerPush(token: String, sandbox: Bool) async throws {
        try await raw("POST", "/push/devices", body: ["platform": "ios", "token": token, "sandbox": sandbox])
    }
    func unregisterPush(token: String) async throws { try await raw("DELETE", "/push/devices", body: ["token": token]) }

    // MARK: blocking (a blocked person's direct mail goes to Spam; groups are not affected)

    func blocks() async throws -> [BlockedPerson] {
        let page: WPage<WPerson> = try await call("GET", "/mail/blocks")
        return page.items.map(blocked)
    }
    /// A number, address or alias; people outside PhoneMail can be blocked too.
    func block(_ address: String) async throws -> BlockedPerson {
        blocked(try await call("POST", "/mail/blocks", body: ["address": address]))
    }
    func unblock(_ userId: Int64) async throws { try await raw("DELETE", "/mail/blocks/\(userId)") }

    /// "9876543210" and "9876543210@phonemail.net" (any case) are the same person.
    static func sameAddress(_ a: String, _ b: String) -> Bool {
        func key(_ s: String) -> String {
            let l = s.lowercased().trimmingCharacters(in: .whitespaces)
            return l.hasSuffix("@" + Config.mailDomain) ? String(l.dropLast(Config.mailDomain.count + 1)) : l
        }
        return key(a) == key(b)
    }

    // MARK: mail

    /// `filter`: all, unread, attachments, favorites, snoozed, archived, everything, or folder:<id>.
    func conversations(filter: String) async throws -> [Conversation] {
        let page: WPage<WChat> = try await call("GET", "/mail/conversations?filter=\(Self.enc(filter))&limit=100")
        return page.items.map(conversation)
    }
    /// One chat's row (archived, muted, snoozed, folder...).
    func conversation(id: Int64) async throws -> Conversation {
        let c: WChat = try await call("GET", "/mail/conversations/\(id)")
        return conversation(c)
    }

    /// Acts on chats together (up to 100): archive, unarchive, trash, read, unread, mute, unmute, snooze (`until`),
    /// unsnooze, move (files them in `folderId`, which archives them) or unfile (back to Home). Returns how many changed.
    @discardableResult
    func chatAction(_ ids: [Int64], _ action: String, until: Date? = nil, folderId: Int64? = nil) async throws -> Int {
        let r: WChanged = try await call("POST", "/mail/conversations/actions", body: Self.obj([
            "conversation_ids": ids, "action": action, "until": until.map(Self.iso), "folder_id": folderId,
        ]))
        return r.changed
    }

    static func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

    // MARK: the user's own folders (A-Z)

    func folders() async throws -> [MailFolder] {
        let page: WPage<WFolder> = try await call("GET", "/mail/folders")
        return page.items.map(mailFolder)
    }
    /// The api refuses a taken name (409), an empty or long one, or a built-in one like Inbox (400); its message is shown.
    func createFolder(_ name: String) async throws -> MailFolder {
        let f: WFolder = try await call("POST", "/mail/folders", body: ["name": name])
        return mailFolder(f)
    }
    func renameFolder(_ id: Int64, to name: String) async throws { try await raw("PATCH", "/mail/folders/\(id)", body: ["name": name]) }
    /// Its chats stay archived (in All mail).
    func deleteFolder(_ id: Int64) async throws { try await raw("DELETE", "/mail/folders/\(id)") }

    /// The newest messages first; the first page also marks the chat read. Older pages: `before` and `beforeId`
    /// are the oldest message already shown (the api pages by time and id together).
    func chatMessages(_ conversationId: Int64, before: String? = nil, beforeId: Int64? = nil) async throws -> [Message] {
        var q = "?limit=50"
        if let before { q += "&before=\(Self.enc(before))" + (beforeId.map { "&before_id=\($0)" } ?? "") }
        let page: WPage<WMessage> = try await call("GET", "/mail/conversations/\(conversationId)/messages\(q)")
        if before == nil { _ = try? await raw("POST", "/mail/conversations/\(conversationId)/read") }
        return page.items.map(toMessage)
    }
    func message(_ id: Int64) async throws -> Message { toMessage(try await call("GET", "/mail/messages/\(id)")) }

    enum Target { case person(String), group(Int64) }

    /// With files, the message goes out through the draft that holds them; `draftId` (the editor's autosave) is
    /// then removed.
    func send(to: Target, cc: [String] = [], bcc: [String] = [], subject: String, body: String, draftId: Int64? = nil,
              attachmentIds: [Int64] = []) async throws -> Delivered {
        let t: [String: Any]
        switch to {
        case .person(let p): t = ["address": p]
        case .group(let g): t = ["group_id": g]
        }
        if !attachmentIds.isEmpty, let carrier = fileDraft {
            let _: WDraft = try await call("PUT", "/mail/drafts/\(carrier)", body: [
                "recipients": ["to": t, "cc": Self.people(cc), "bcc": Self.people(bcc)], "subject": subject, "body_text": body,
            ])
            let sent: WSent = try await call("POST", "/mail/drafts/\(carrier)/send", body: [:])
            fileDraft = nil
            if let draftId { try? await deleteDraft(draftId) }
            return delivered(sent)
        }
        let sent: WSent = try await call("POST", "/mail/messages", body: Self.obj([
            "to": t, "cc": Self.people(cc), "bcc": Self.people(bcc), "subject": subject, "body_text": body, "draft_id": draftId,
        ]))
        return delivered(sent)
    }

    func reply(to messageId: Int64, conversationId: Int64, body: String, attachmentIds: [Int64] = []) async throws -> Delivered {
        if !attachmentIds.isEmpty, let carrier = fileDraft {
            let _: WDraft = try await call("PUT", "/mail/drafts/\(carrier)", body: [
                "conversation_id": conversationId, "parent_id": messageId, "recipients": [String: Any](), "subject": "", "body_text": body,
            ])
            let sent: WSent = try await call("POST", "/mail/drafts/\(carrier)/send", body: [:])
            fileDraft = nil
            return delivered(sent)
        }
        let sent: WSent = try await call("POST", "/mail/messages/\(messageId)/reply", body: ["conversation_id": conversationId, "body_text": body])
        return delivered(sent)
    }

    // MARK: attachments (they live on a draft until it is sent)

    private func carrierDraft() async throws -> Int64 {
        if let d = fileDraft { return d }
        let d: WDraft = try await call("POST", "/mail/drafts", body: ["recipients": [String: Any](), "subject": "", "body_text": ""])
        fileDraft = d.id
        return d.id
    }

    func uploadAttachment(_ data: Data, filename: String, contentType: String,
                          progress: (@Sendable (Double) -> Void)? = nil) async throws -> Attachment {
        let draft = try await carrierDraft()
        let boundary = "PhoneMail-\(UUID().uuidString)"
        let safeName = filename.replacingOccurrences(of: "\"", with: "'")
        var form = Data()
        form.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8))
        form.append(data)
        form.append(Data("\r\n--\(boundary)--\r\n".utf8))
        let a: WAttachment = try await upload("POST", "/mail/drafts/\(draft)/attachments", data: form,
                                              headers: ["Content-Type": "multipart/form-data; boundary=\(boundary)"], progress: progress)
        return attachment(a)
    }

    func discardAttachment(_ id: Int64) async throws {
        if let d = fileDraft { try await raw("DELETE", "/mail/drafts/\(d)/attachments/\(id)") }
    }

    /// Downloads a file (with the sign-in token) into the caches folder, once; returns its local URL.
    func download(_ a: Attachment) async throws -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("attachments/\(a.id)", isDirectory: true)
        let name = a.filename.replacingOccurrences(of: "/", with: "_")
        let file = dir.appendingPathComponent(name.isEmpty ? "file" : name)
        if FileManager.default.fileExists(atPath: file.path) { return file }
        let req = try request("GET", "/mail/attachments/\(a.id)")
        let tmp: URL
        let response: URLResponse
        do {
            (tmp, response) = try await session.download(for: req)
        } catch {
            throw Self.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            _ = try checked((try? Data(contentsOf: tmp)) ?? Data(), response, path: "/mail/attachments", hadToken: true)
            throw APIError(status: status, message: L("Request failed (%lld)", status))
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: tmp, to: file)
        return file
    }

    // MARK: profile picture

    /// The api has no stock list: the app's own set is used, and a glyph is drawn into a picture on the phone.
    func stockAvatars() async throws -> StockAvatars { StockAvatars.fallback }

    /// The glyph centred on its colour, uploaded as the profile picture (the api stores pictures only).
    func setGlyph(_ glyph: String, color: String) async throws -> User {
        let size = CGSize(width: 512, height: 512)
        let png = UIGraphicsImageRenderer(size: size).pngData { ctx in
            (UIColor(hexString: color) ?? UIColor(red: 0x4B / 255, green: 0x3F / 255, blue: 0xB0 / 255, alpha: 1)).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let text = NSAttributedString(string: glyph, attributes: [.font: UIFont.systemFont(ofSize: 280)])
            let b = text.size()
            text.draw(at: CGPoint(x: (size.width - b.width) / 2, y: (size.height - b.height) / 2))
        }
        return try await uploadAvatar(png, contentType: "image/png")
    }

    /// A square JPEG, already resized (see `AvatarPhoto.prepare`).
    func uploadAvatarPhoto(_ jpeg: Data) async throws -> User { try await uploadAvatar(jpeg, contentType: "image/jpeg") }

    private func uploadAvatar(_ data: Data, contentType: String) async throws -> User {
        let u: WUser = try await upload("PUT", "/me/avatar", data: data, headers: ["Content-Type": contentType])
        return user(u)
    }

    func resetAvatar() async throws -> User { user(try await call("DELETE", "/me/avatar")) }
    func avatarPhotoURL(_ name: String) -> URL? { URL(string: base + "/avatars/" + name) }

    /// Flags by the app's names (isRead, isFavourite, folder).
    func setFlags(_ messageId: Int64, _ flags: [String: Any]) async throws {
        var body: [String: Any] = [:]
        for (k, v) in flags { body[Self.snake(k)] = v }
        try await raw("PATCH", "/mail/mailbox/\(messageId)", body: body)
    }
    func folder(_ name: String) async throws -> [Message] {
        let page: WPage<WMessage> = try await call("GET", "/mail/folders/\(name)?limit=100")
        return page.items.map(toMessage)
    }

    func drafts() async throws -> [Draft] {
        let page: WPage<WDraft> = try await call("GET", "/mail/drafts")
        return page.items.map(draft)
    }
    func saveDraft(id: Int64?, to: [String], cc: [String], bcc: [String], subject: String, body: String) async throws -> Draft {
        let payload: [String: Any] = [
            "recipients": ["to": Self.people(to), "cc": Self.people(cc), "bcc": Self.people(bcc)], "subject": subject, "body_text": body,
        ]
        if let id { return draft(try await call("PUT", "/mail/drafts/\(id)", body: payload)) }
        return draft(try await call("POST", "/mail/drafts", body: payload))
    }
    func deleteDraft(_ id: Int64) async throws { try await raw("DELETE", "/mail/drafts/\(id)") }
    /// Cancels a scheduled send; the message stays as an ordinary draft.
    func unschedule(_ id: Int64) async throws -> Draft { draft(try await call("POST", "/mail/drafts/\(id)/unschedule")) }

    func createGroup(name: String, members: [String]) async throws -> MailGroup {
        let g: WGroup = try await call("POST", "/mail/groups", body: ["name": name, "members": Self.people(members)])
        return MailGroup(id: g.conversationId, name: g.name, created: g.created,
                         members: (g.members ?? []).map { GroupMember(userId: $0.userId ?? 0, address: $0.address ?? "", role: $0.role ?? "member") })
    }

    // MARK: from the server's shapes to the app's

    private func avatar(_ url: String?) -> String? {
        guard let url, url.hasPrefix("/api/avatars/") else { return nil }
        return "photo:" + url.dropFirst("/api/avatars/".count)
    }

    private func nonEmpty(_ s: String?) -> String? { (s?.isEmpty ?? true) ? nil : s }

    private func user(_ u: WUser) -> User {
        User(id: u.id, phone: u.phone, address: u.address, displayName: nonEmpty(u.displayName), language: u.language ?? "en",
             avatarUrl: nil, avatar: avatar(u.avatarUrl), hasPush: u.hasPush ?? false, createdVia: u.createdVia ?? "",
             hasPassword: u.hasPassword, aliases: u.aliases)
    }

    private func conversation(_ c: WChat) -> Conversation {
        Conversation(id: c.conversationId, kind: c.kind, name: nonEmpty(c.name), peerAddress: c.peer?.address,
                     peerName: nonEmpty(c.peer?.displayName), peerAvatar: avatar(c.peer?.avatarUrl), lastMessageAt: c.lastMessageAt,
                     lastMessageId: c.lastMessageId, snippet: c.snippet ?? "", unreadCount: c.unreadCount ?? 0,
                     hasAttachments: c.hasAttachments ?? false, favouriteCount: c.favouriteCount ?? 0, memberCount: c.memberCount,
                     archived: c.archived, muted: c.muted, snoozedUntil: c.snoozedUntil, folderId: c.folderId)
    }

    private func mailFolder(_ f: WFolder) -> MailFolder {
        MailFolder(id: f.id, name: f.name, chatCount: f.chatCount ?? 0, unreadCount: f.unreadCount ?? 0)
    }

    private func blocked(_ p: WPerson) -> BlockedPerson {
        BlockedPerson(userId: p.userId ?? 0, address: p.address ?? "", name: nonEmpty(p.displayName))
    }

    private func attachment(_ a: WAttachment) -> Attachment {
        Attachment(id: a.id, filename: a.filename, contentType: a.contentType ?? "application/octet-stream", size: a.sizeBytes ?? 0)
    }

    private func toMessage(_ m: WMessage) -> Message {
        let body = m.bodyText ?? ""
        return Message(
            id: m.id, conversationId: m.conversationId, senderId: m.sender?.userId ?? 0, senderAddress: m.sender?.address ?? "",
            senderName: nonEmpty(m.sender?.displayName), senderAvatar: avatar(m.sender?.avatarUrl), subject: m.subject ?? "",
            body: body.isEmpty ? (m.snippet ?? "") : body, parentId: m.parentId, rootId: m.rootId ?? m.id, depth: m.depth ?? 0,
            sentAt: m.sentAt ?? "", hasAttachments: m.hasAttachments, isRead: m.isRead ?? false, isFavourite: m.isFavourite ?? false,
            isReplied: m.isReplied ?? false, isMine: m.isMine ?? false, folder: m.folder ?? "inbox",
            recipients: (m.recipients ?? []).map { Recipient(kind: $0.kind, address: $0.person?.address, groupId: $0.groupId, groupName: $0.groupName) },
            attachments: (m.attachments ?? []).map(attachment)
        )
    }

    private func draft(_ d: WDraft) -> Draft {
        let r = d.recipients
        return Draft(id: d.id, conversationId: d.conversationId, parentId: d.parentId,
                     recipients: DraftRecipients(to: r?.to.compactMap(\.address), cc: r?.cc.compactMap(\.address), bcc: r?.bcc.compactMap(\.address)),
                     subject: d.subject ?? "", body: d.bodyText ?? "", updatedAt: d.updatedAt ?? "", sendAt: nonEmpty(d.sendAt))
    }

    private func delivered(_ s: WSent) -> Delivered { Delivered(messageId: s.messageId, conversationIds: s.conversationIds ?? []) }
}

private extension UIColor {
    /// "#4B3FB0" -> a colour.
    convenience init?(hexString: String) {
        let s = hexString.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

/// Reports upload progress for one request.
private final class UploadProgress: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let report: @Sendable (Double) -> Void
    init(_ report: @escaping @Sendable (Double) -> Void) { self.report = report }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard totalBytesExpectedToSend > 0 else { return }
        report(Double(totalBytesSent) / Double(totalBytesExpectedToSend))
    }
}
