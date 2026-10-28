import SwiftUI

/// Where the main screens navigate to.
enum Route: Hashable {
    case chat(ChatRef)
    case message(Int64)
    case compose(ComposeArgs)
    case folder(String)
    /// A list of chats: a filter from the menu ("unread", "snoozed", "everything"...) or "folder:<id>".
    case chats(String)
    case settings
}

/// A chat to open: an existing conversation, or a new one with `peer` (id 0).
struct ChatRef: Hashable {
    var id: Int64
    var isGroup: Bool
    var title: String
    var peer: String
    var avatar: String? = nil
}

/// Home: no separate Inbox or Sent; every email lives in a chat (brief: "Refer Spike Mail").
struct HomeView: View {
    @Binding var path: [Route]

    var body: some View {
        ChatListView(path: $path, filter: "all", home: true)
    }
}

/// The ☰ menu, as on the web: the chat lists, then Drafts, Scheduled, Spam and Trash, then the user's own
/// folders (with their unread counts) and Settings. `open` gets nil for Inbox, which is Home itself.
struct MenuSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let open: (Route?) -> Void
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Mailbox.filters, id: \.self) { f in
                        row(Mailbox.title(f), Mailbox.icon(f)) { go(f == "all" ? nil : .chats(f)) }
                    }
                }
                Section {
                    row(L("Drafts"), "doc") { go(.folder("drafts")) }
                    row(L("Scheduled"), "calendar.badge.clock") { go(.folder("scheduled")) }
                    row(L("Spam"), "exclamationmark.octagon") { go(.folder("spam")) }
                    row(L("Trash"), "trash") { go(.folder("trash")) }
                }
                Section(L("Folders")) {
                    ForEach(session.folders) { f in
                        row(f.name, "folder", count: f.unreadCount) { go(.chats(Mailbox.folderFilter(f.id))) }
                    }
                    Button { creating = true } label: { Label(L("New folder"), systemImage: "folder.badge.plus") }
                        .accessibilityIdentifier("newFolder")
                }
                Section {
                    row(L("Settings"), "gearshape") { go(.settings) }
                }
            }
            .navigationTitle(L("PhoneMail"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(L("Done")) { dismiss() } } }
            .task { await session.refreshFolders() }
            .sheet(isPresented: $creating) {
                FolderNameSheet(title: L("New folder")) { name in _ = try await session.createFolder(name) }
            }
        }
    }

    private func row(_ title: String, _ icon: String, count: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Label { Text(title).foregroundStyle(Palette.text) } icon: { Image(systemName: icon).foregroundStyle(Palette.header) }
                Spacer()
                if count > 0 {
                    Text("\(count)").font(.caption.bold()).foregroundStyle(Palette.onAccent)
                        .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
                        .background(Palette.accent, in: Capsule())
                }
            }
        }
        .accessibilityIdentifier(title)
    }

    private func go(_ route: Route?) {
        open(route)
        dismiss()
    }
}
