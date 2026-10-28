import Observation
import SwiftUI

/// Requests from outside the screens: a tapped notification opens its chat, and the iPad keyboard shortcuts
/// (⌘N new email, ⌘F search, ⌘R reply). The main view (stack or split) and the screens on show act on them.
@MainActor
@Observable
final class Nav {
    static let shared = Nav()

    /// A chat to open (from a notification), until the main view takes it.
    private(set) var pendingChat: PendingChat?
    /// The chat on screen now, if any: its new-mail pushes don't show while it is open.
    @ObservationIgnored var openChat: Int64?
    /// Each increases when its shortcut is pressed; screens watch them with `.onChange`.
    private(set) var composeTick = 0
    private(set) var searchTick = 0
    private(set) var replyTick = 0

    struct PendingChat: Equatable {
        let conversationId: Int64
        let title: String
    }

    /// What was typed and not sent, per chat and per editor, so a screen rebuilt when an iPad window is resized
    /// between wide and narrow gets it back. Kept in memory only (cleared on sign-out).
    @ObservationIgnored var unsentChats: [String: ChatUnsent] = [:]
    @ObservationIgnored var unsentEmails: [UUID: EmailUnsent] = [:]

    struct ChatUnsent {
        var subject = ""
        var text = ""
        var replyTo: Message?
        var picked = false // replyTo was chosen by the user, not by reply-by-default
        var dismissed: Int64? // the newest email when the user cancelled a reply
    }

    struct EmailUnsent {
        var to = "", cc = "", bcc = "", groupName = "", subject = "", text = ""
        /// The server draft it was saved as, so the next save updates it instead of making another.
        var draftId: Int64?
    }

    func open(conversationId: Int64, title: String) { pendingChat = PendingChat(conversationId: conversationId, title: title) }

    /// Nothing of the last person's carries over to the next sign-in.
    func signedOut() {
        pendingChat = nil
        openChat = nil
        unsentChats = [:]
        unsentEmails = [:]
    }
    func compose() { composeTick += 1 }
    func search() { searchTick += 1 }
    func reply() { replyTick += 1 }

    /// The pending chat as a chat to open (its row from the api, for the name and picture), and clears it.
    func takePending(_ session: Session) async -> ChatRef? {
        guard let p = pendingChat else { return nil }
        pendingChat = nil
        guard let c = try? await session.api.conversation(id: p.conversationId) else {
            return ChatRef(id: p.conversationId, isGroup: false, title: p.title, peer: "")
        }
        let title = c.isGroup || c.peerName != nil ? c.title : (session.contacts.name(for: c.peerAddress) ?? c.title)
        return ChatRef(id: c.id, isGroup: c.isGroup, title: title, peer: c.peerAddress ?? "", avatar: c.peerAvatar)
    }
}

/// The keyboard shortcuts (iPad with a keyboard, or an iPhone with one). Hold ⌘ to see them.
struct MailCommands: Commands {
    let session: Session

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(L("New email")) { Nav.shared.compose() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(session.user == nil)
        }
        CommandMenu(L("Mail")) {
            Button(L("Search chats")) { Nav.shared.search() }
                .keyboardShortcut("f", modifiers: .command)
                .disabled(session.user == nil)
            Button(L("Reply")) { Nav.shared.reply() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(session.user == nil)
        }
    }
}
