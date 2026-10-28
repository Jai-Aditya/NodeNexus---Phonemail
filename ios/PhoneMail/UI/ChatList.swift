import SwiftUI

/// The chats of one filter. Home is "all" with the chips, contact suggestions and the ☰ menu; the menu opens the
/// others (Unread, Snoozed, All mail, Archived, a folder...) under a title. On every list, Select (or a long press
/// on a row) picks several chats to act on together, and a row swiped left offers Archive and Delete.
struct ChatListView: View {
    @Environment(Session.self) private var session
    @Binding var path: [Route]
    let home: Bool
    @State private var filter: String
    @State private var query = ""
    @State private var chats: [Conversation] = []
    @State private var loaded = false
    @State private var error = ""
    @State private var selecting = false
    @State private var picked: Set<Int64> = []
    @State private var longPressed: Int64? // the row a long press just picked (its tap is then ignored)
    @State private var note = ""
    @State private var undo: (() -> Void)?
    @State private var noteSeq = 0
    @State private var showMenu = false
    @State private var showSnooze = false
    @State private var showFolders = false
    @State private var renaming = false
    @State private var confirmDelete = false
    @State private var searching = false
    /// Not covered by a screen pushed on top of it.
    @State private var onScreen = false
    /// In the iPad split view: the sidebar is the menu, and `current` is the chat open beside the list.
    let split: Bool
    let current: Int64?

    init(path: Binding<[Route]>, filter: String, home: Bool = false, split: Bool = false, current: Int64? = nil) {
        _path = path
        _filter = State(initialValue: filter)
        self.home = home
        self.split = split
        self.current = current
    }

    private var folderId: Int64? { Mailbox.folderId(filter) }
    private var folderName: String { Mailbox.title(filter, folders: session.folders) }
    /// The picked chats still shown (a search can hide some; actions never reach those).
    private var pickedChats: [Conversation] { shown.filter { picked.contains($0.id) } }
    private var pickedIds: [Int64] { pickedChats.map(\.id) }
    private var unarchives: Bool { Mailbox.offersUnarchive(pickedChats, filter: filter) }
    private var inboxAction: String { Mailbox.inboxAction(filter: filter) }

    private var shown: [Conversation] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return chats }
        return chats.filter { c in [title(c), c.peerAddress ?? "", c.snippet].contains { $0.lowercased().contains(q) } }
    }

    private var typedNumber: String? {
        home && query.filter(\.isNumber).count >= 10 ? Format.tenDigits(query) : nil
    }

    var body: some View {
        List {
            Section {
                if home {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(chips, id: \.0) { chip in
                                let on = filter == chip.0
                                Button(L(chip.1)) { filter = chip.0 }
                                    .font(.subheadline.weight(on ? .semibold : .regular))
                                    .foregroundStyle(on ? Palette.header : Palette.muted)
                                    .padding(.horizontal, 14).padding(.vertical, 7)
                                    .background(on ? Palette.chipOnBg : Palette.chipBg, in: Capsule())
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Palette.background)
                }

                if let n = typedNumber {
                    Button {
                        path.append(.chat(ChatRef(id: 0, isGroup: false, title: n, peer: "\(n)@\(Config.mailDomain)")))
                    } label: {
                        HStack(spacing: 14) {
                            Avatar(label: n, size: 44, address: "\(n)@\(Config.mailDomain)")
                            VStack(alignment: .leading) {
                                Text(L("Chat with %@", n)).font(.headline).foregroundStyle(Palette.text)
                                Text("\(n)@\(Config.mailDomain)").font(.subheadline).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    .listRowBackground(Palette.background)
                }

                // People from the phone's contacts matching what was typed (when access was allowed).
                ForEach(home && typedNumber == nil ? session.contacts.search(query) : []) { p in
                    Button {
                        path.append(.chat(ChatRef(id: 0, isGroup: false, title: p.name, peer: p.address)))
                    } label: {
                        HStack(spacing: 14) {
                            Avatar(label: p.name, size: 44, address: p.address, name: p.name)
                            VStack(alignment: .leading) {
                                Text(p.name).font(.headline).foregroundStyle(Palette.text)
                                Text(L("From your contacts · %@", p.digits)).font(.subheadline).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    .listRowBackground(Palette.background)
                    .accessibilityIdentifier("contactSuggestion")
                }

                if loaded && shown.isEmpty {
                    Text(error.isEmpty ? (home && filter == "all" && query.isEmpty ? L("No chats yet. Tap the pencil to write your first email.") : L("Nothing here.")) : error)
                        .foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity).padding(.top, 40)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Palette.background)
                }

                ForEach(shown) { c in
                    let on = picked.contains(c.id)
                    Button { tap(c) } label: {
                        HStack(spacing: 12) {
                            if selecting {
                                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                    .font(.title2).foregroundStyle(on ? Palette.header : Palette.muted)
                                    .accessibilityHidden(true)
                            }
                            ChatRow(c: c, title: title(c), filter: filter)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(on || c.id == current ? Palette.chipOnBg : Palette.background)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .simultaneousGesture(LongPressGesture(minimumDuration: 0.5).onEnded { _ in longPress(c) })
                    .swipeActions(edge: .trailing) {
                        if !selecting { // acting would end the selection
                            let toInbox = Mailbox.offersUnarchive([c], filter: filter)
                            Button(role: .destructive) { act([c.id], "trash") } label: { Label(L("Delete"), systemImage: "trash") }
                            Button { toInbox ? moveToInbox([c.id]) : act([c.id], "archive") } label: {
                                Label(toInbox ? L("Move to Inbox") : L("Archive"), systemImage: toInbox ? "tray.and.arrow.up" : "archivebox")
                            }
                            .tint(Palette.header)
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .overlay(alignment: .bottom) {
            if !note.isEmpty { Toast(text: note, undo: undo) }
        }
        .navigationTitle(selecting ? L("%lld selected", pickedIds.count) : (home && !split ? L("PhoneMail") : Mailbox.title(filter, folders: session.folders)))
        .navigationBarBackButtonHidden(selecting)
        .searchable(text: $query, isPresented: $searching, prompt: home ? L("Search chats, contacts or a phone number") : L("Search chats"))
        .refreshable { await load() }
        .toolbar { toolbar }
        // Alerts on the list itself: they show the same on iPhone and iPad (no popover anchor needed).
        .alert(L("Snooze until"), isPresented: $showSnooze) {
            ForEach(Mailbox.snoozeChoices()) { s in
                Button(s.title + " · " + Mailbox.shortTime(s.date)) { act(pickedIds, "snooze", until: s.date) }
            }
            Button(L("Cancel"), role: .cancel) {}
        }
        .alert(L("Delete the folder “%@”?", folderName), isPresented: $confirmDelete) {
            Button(L("Delete folder"), role: .destructive) { deleteFolder() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Its conversations stay in All mail."))
        }
        .sheet(isPresented: $showFolders) {
            FolderPicker(current: folderId) { f in act(pickedIds, "move", folderId: f.id) }
        }
        .sheet(isPresented: $renaming) {
            FolderNameSheet(title: L("Rename folder"), initial: folderName) { name in
                if let id = folderId { try await session.renameFolder(id, to: name) }
            }
        }
        .sheet(isPresented: $showMenu) {
            MenuSheet { route in
                if let route { path.append(route) } else { filter = "all" }
            }
        }
        .task(id: filter) { await load() }
        .task { await session.refreshFolders() }
        .onChange(of: query) { picked.formIntersection(shown.map(\.id)) } // a search drops the picks it hides
        .onChange(of: session.mailTick) { Task { await load() } } // live: new mail arrived
        .onChange(of: Nav.shared.searchTick) { if onScreen { searching = true } } // ⌘F: only the list on show
        .onAppear { onScreen = true; Task { await load() } } // back from a chat
        .onDisappear { onScreen = false }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if selecting {
            ToolbarItem(placement: .topBarLeading) {
                Button(pickedIds.count == shown.count && !shown.isEmpty ? L("Select none") : L("Select all")) {
                    picked = pickedIds.count == shown.count ? [] : Set(shown.map(\.id))
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(L("Done")) { stopSelecting() }.fontWeight(.semibold)
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button { unarchives ? moveToInbox(pickedIds) : act(pickedIds, "archive") } label: {
                    Label(unarchives ? L("Move to Inbox") : L("Archive"), systemImage: unarchives ? "tray.and.arrow.up" : "archivebox")
                }
                Spacer()
                Button { act(pickedIds, "trash") } label: { Label(L("Delete"), systemImage: "trash") }
                Spacer()
                if filter == "snoozed" {
                    Button { act(pickedIds, "unsnooze") } label: { Label(L("Unsnooze"), systemImage: "clock.badge.xmark") }
                } else {
                    Button { showSnooze = true } label: { Label(L("Snooze"), systemImage: "clock") }
                }
                Spacer()
                Button { showFolders = true } label: { Label(L("Move to folder"), systemImage: "folder") }
                Spacer()
                Menu {
                    Button { act(pickedIds, "read") } label: { Label(L("Mark as read"), systemImage: "envelope.open") }
                    Button { act(pickedIds, "unread") } label: { Label(L("Mark as unread"), systemImage: "envelope.badge") }
                    if folderId != nil {
                        Button { act(pickedIds, "unfile") } label: { Label(L("Remove from folder"), systemImage: "folder.badge.minus") }
                    }
                } label: { Label(L("More"), systemImage: "ellipsis.circle") }
            }
        } else if home {
            if !split { // the iPad's sidebar is the menu
                ToolbarItem(placement: .topBarLeading) {
                    Button { showMenu = true } label: { Image(systemName: "line.3.horizontal") }
                        .accessibilityLabel(L("Menu"))
                        .accessibilityIdentifier("Menu")
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(L("Select")) { selecting = true }.disabled(chats.isEmpty)
                composeButton
                Button { path.append(.settings) } label: {
                    Avatar(label: session.user?.label ?? "?", size: 30, address: session.user?.address,
                           avatar: session.user?.avatar, name: session.user?.displayName)
                }
                .accessibilityLabel(L("Profile and settings"))
                .accessibilityIdentifier("Profile and settings")
            }
        } else {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button(L("Select")) { selecting = true }.disabled(chats.isEmpty)
                if split { composeButton } // every list can start an email on the iPad
                if folderId != nil {
                    Menu {
                        Button { renaming = true } label: { Label(L("Rename folder"), systemImage: "pencil") }
                        Button(role: .destructive) { confirmDelete = true } label: { Label(L("Delete folder"), systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel(L("More"))
                    .accessibilityIdentifier("folderMore")
                }
            }
        }
    }

    private var composeButton: some View {
        Button { path.append(.compose(ComposeArgs())) } label: { Image(systemName: "square.and.pencil") }
            .accessibilityLabel(L("Compose"))
            .accessibilityIdentifier("Compose")
    }

    /// The server's name, else the name saved in the phone's contacts, else the address.
    private func title(_ c: Conversation) -> String {
        if c.isGroup || c.peerName != nil { return c.title }
        return session.contacts.name(for: c.peerAddress) ?? c.title
    }

    private func tap(_ c: Conversation) {
        if longPressed == c.id { longPressed = nil; return } // the end of the long press that picked it
        if selecting {
            if picked.contains(c.id) { picked.remove(c.id) } else { picked.insert(c.id) }
        } else {
            path.append(.chat(ChatRef(id: c.id, isGroup: c.isGroup, title: title(c), peer: c.peerAddress ?? "", avatar: c.peerAvatar)))
        }
    }

    private func longPress(_ c: Conversation) {
        guard !selecting else { return }
        haptic()
        longPressed = c.id
        picked = [c.id]
        selecting = true
    }

    private func stopSelecting() {
        selecting = false
        picked = []
        longPressed = nil
    }

    private func load() async {
        do {
            chats = try await session.api.conversations(filter: filter)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        picked.formIntersection(chats.map(\.id))
        loaded = true
    }

    /// Out of Archived, or out of this folder, back to Home.
    private func moveToInbox(_ ids: [Int64]) { act(ids, inboxAction, said: L("Moved to Inbox")) }

    /// Runs `action` on the chats, then confirms it (with Undo where it can be reversed: archive, snooze, moves
    /// between folders) and reloads. An Undo's own confirmation offers no Undo.
    private func act(_ ids: [Int64], _ action: String, until: Date? = nil, folderId: Int64? = nil, said: String? = nil,
                     undoable: Bool = true) {
        guard !ids.isEmpty else { return }
        let back = undoable ? Mailbox.undo(action, filter: filter) : nil
        let folder = folderId.flatMap { id in session.folders.first { $0.id == id }?.name }
        Task {
            do {
                try await session.api.chatAction(ids, action, until: until, folderId: folderId)
                stopSelecting()
                flash(said ?? Mailbox.done(action, until: until, folder: folder),
                      undo: back.map { b in { act(ids, b.action, folderId: b.folderId, undoable: false) } })
                await load()
                await session.refreshFolders() // unread counts and filed chats change
            } catch {
                flash(error.localizedDescription)
            }
        }
    }

    private func deleteFolder() {
        guard let id = folderId else { return }
        Task {
            do {
                try await session.deleteFolder(id)
                if !path.isEmpty { path.removeLast() }
            } catch {
                flash(error.localizedDescription)
            }
        }
    }

    private func flash(_ t: String, undo: (() -> Void)? = nil) {
        noteSeq += 1
        let seq = noteSeq
        withAnimation { note = t; self.undo = undo }
        Task {
            try? await Task.sleep(for: .seconds(undo == nil ? 2.5 : 5))
            if noteSeq == seq { withAnimation { note = ""; self.undo = nil } }
        }
    }
}

private let chips = [("all", "All"), ("unread", "Unread"), ("attachments", "Attachments"), ("favorites", "Favorites")] // labels via L

private struct ChatRow: View {
    let c: Conversation
    let title: String
    var filter = "all"

    /// "Until <time>" in Snoozed; otherwise the last message's time.
    private var time: String {
        if filter == "snoozed", let d = Format.date(c.snoozedUntil) { return L("Until %@", Mailbox.shortTime(d)) }
        return Format.chatTime(c.lastMessageAt)
    }

    var body: some View {
        let unread = c.unreadCount > 0
        HStack(spacing: 14) {
            Avatar(label: title, group: c.isGroup, address: c.peerAddress, avatar: c.peerAvatar, name: c.peerName)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(title).font(.system(size: 17, weight: unread ? .bold : .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                    Spacer()
                    Text(time).font(.caption).foregroundStyle(unread ? Palette.header : Palette.muted).lineLimit(1)
                }
                HStack(spacing: 4) {
                    if c.isMuted { Image(systemName: "bell.slash").font(.caption).foregroundStyle(Palette.muted) }
                    if c.hasAttachments { Image(systemName: "paperclip").font(.caption).foregroundStyle(Palette.muted) }
                    if c.favouriteCount > 0 { Image(systemName: "star.fill").font(.caption).foregroundStyle(Palette.star) }
                    Text(c.snippet.isEmpty ? (c.isGroup ? L("Group created") : "") : c.snippet)
                        .font(.subheadline).foregroundStyle(unread ? Palette.text : Palette.muted).lineLimit(1)
                    Spacer()
                    if filter == "everything" && c.isArchived {
                        Text(L("Archived")).font(.caption2.weight(.semibold)).foregroundStyle(Palette.muted)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Palette.chipBg, in: Capsule())
                    }
                    if unread {
                        Text("\(c.unreadCount)").font(.caption.bold()).foregroundStyle(Palette.onAccent)
                            .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
                            .background(Palette.accent, in: Capsule())
                    }
                }
            }
        }
        .contentShape(Rectangle())
    }
}

/// "Move to folder": the user's folders, or a new one (the chats go straight into it).
struct FolderPicker: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    /// The folder the chats are in now; not offered.
    var current: Int64? = nil
    let pick: (MailFolder) -> Void
    @State private var creating = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(session.folders.filter { $0.id != current }) { f in
                    Button { pick(f); dismiss() } label: {
                        Label { Text(f.name).foregroundStyle(Palette.text) } icon: { Image(systemName: "folder").foregroundStyle(Palette.header) }
                    }
                }
                Button { creating = true } label: { Label(L("New folder"), systemImage: "folder.badge.plus") }
                    .accessibilityIdentifier("newFolder")
            }
            .navigationTitle(L("Move to folder"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } } }
            .task { await session.refreshFolders() }
            .sheet(isPresented: $creating) {
                FolderNameSheet(title: L("New folder")) { name in
                    let f = try await session.createFolder(name)
                    pick(f)
                    dismiss()
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Names a new folder, or renames one. When the server refuses a name (taken, too long, or a built-in one like
/// Inbox) its message shows here and the sheet stays open.
struct FolderNameSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    var initial = ""
    let save: (String) async throws -> Void
    @State private var name = ""
    @State private var busy = false
    @State private var error = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(L("Folder name"), text: $name)
                        .focused($focused)
                        .submitLabel(.done)
                        .onSubmit(submit)
                        .accessibilityIdentifier("folderName")
                } footer: {
                    Text(L("Up to 40 characters."))
                }
                if !error.isEmpty { Section { ErrorText(text: error) } }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save"), action: submit).disabled(Mailbox.folderName(name) == nil || busy).accessibilityIdentifier("saveFolder")
                }
            }
            .onAppear { name = initial; focused = true }
        }
        .presentationDetents([.medium])
    }

    private func submit() {
        guard let n = Mailbox.folderName(name), !busy else { return }
        Task {
            busy = true
            error = ""
            do {
                try await save(n)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}
