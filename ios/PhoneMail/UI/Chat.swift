import SwiftUI

/// Reply by default: the chat box answers the newest email when it came from someone else, as if it had been swiped.
enum AutoReply {
    /// The newest email in the chat, by time (then id).
    static func newest(_ messages: [Message]) -> Message? {
        messages.max { a, b in
            let ta = Format.date(a.sentAt) ?? .distantPast, tb = Format.date(b.sentAt) ?? .distantPast
            return ta == tb ? a.id < b.id : ta < tb
        }
    }

    /// The email the box replies to when the user hasn't picked one: the newest, unless it is the user's own, they
    /// can't write here, or they cancelled replying to it (`dismissed`: the newest id when they did). Nil: a new email.
    static func target(_ messages: [Message], canWrite: Bool = true, dismissed: Int64? = nil) -> Message? {
        guard canWrite, let m = newest(messages), !m.isMine, m.id != dismissed else { return nil }
        return m
    }
}

/// A chat: every email between you and one person (or one group), WhatsApp-style.
/// `ref.id` 0 is a new chat with `ref.peer`; the first send creates it.
struct ChatView: View {
    @Environment(Session.self) private var session
    let ref: ChatRef
    @Binding var path: [Route]
    /// Leaves the chat (after Mark as unread). Nil: back to the screen before it (the iPhone's stack).
    var onLeave: (() -> Void)? = nil
    @FocusState private var typing: Bool

    @State private var convId: Int64 = 0
    @State private var messages: [Message] = [] // oldest first, as shown
    @State private var loading = false
    @State private var hasOlder = true
    @State private var subject = ""
    @State private var text = ""
    @State private var replyTo: Message?
    @State private var pickedReply = false // replyTo was swiped or ⌘R'd, not set by AutoReply
    @State private var dismissedReply: Int64? // the newest email when the user cancelled a reply
    @State private var sending = false
    @State private var notice = ""
    @State private var undo: (() -> Void)?
    @State private var noticeSeq = 0
    @State private var tray = AttachmentTray()
    @State private var blockedId: Int64? // the peer's user id while they are blocked
    @State private var confirmBlock = false
    @State private var chat: Conversation? // archived, muted, snoozed, folder (for the ⋯ menu)
    @State private var showSnooze = false
    @State private var showFolders = false

    private var byId: [Int64: Message] { Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) }) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if hasOlder && !messages.isEmpty {
                            Color.clear.frame(height: 1).onAppear { Task { await loadOlder() } }
                        }
                        ForEach(messages) { m in
                            SwipeToReply(onReply: { startReply(m) }) {
                                Bubble(m: m, parent: m.parentId.flatMap { byId[$0] }, showSender: ref.isGroup)
                                    .onTapGesture { path.append(.message(m.id)) }
                            }
                            .id(m.id)
                        }
                    }
                    .padding(.vertical, 8)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: messages.last?.id) { _, id in
                    if let id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            .overlay {
                if messages.isEmpty && !loading {
                    Text(convId == 0 ? L("Start your first email to %@. Add a subject, type your message and send.", ref.title) : L("No messages yet."))
                        .foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        .padding(12).background(Palette.notice, in: RoundedRectangle(cornerRadius: 8)).padding(32)
                } else if loading && messages.isEmpty {
                    ProgressView().tint(Palette.header)
                }
            }
            if !notice.isEmpty { Toast(text: notice, undo: undo) }
            composer
        }
        .background(Palette.chatBg)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    Avatar(label: ref.title, group: ref.isGroup, size: 32, address: ref.peer, avatar: ref.avatar,
                           name: ref.title == ref.peer ? nil : ref.title)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(ref.title).font(.headline).lineLimit(1)
                        if !ref.isGroup && !ref.peer.isEmpty && ref.peer != ref.title {
                            Text(ref.peer).font(.caption).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // The traditional editor (brief: takes the place of WhatsApp's camera button).
                Button { openEditor(replyTo: nil) } label: { Image(systemName: "envelope") }
                    .accessibilityLabel(L("Write in full editor"))
            }
            if convId != 0 || (!ref.isGroup && !ref.peer.isEmpty) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu { moreMenu } label: { Image(systemName: "ellipsis.circle") }
                        .accessibilityLabel(L("More"))
                        .accessibilityIdentifier("chatMore")
                }
            }
        }
        // Alerts on the screen itself: they show the same on iPhone and iPad (no popover anchor needed).
        .alert(L("Block %@?", ref.title), isPresented: $confirmBlock) {
            Button(L("Block"), role: .destructive) { toggleBlock() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Their emails will go to Spam. You can unblock them in Settings."))
        }
        .alert(L("Snooze until"), isPresented: $showSnooze) {
            ForEach(Mailbox.snoozeChoices()) { s in
                Button(s.title + " · " + Mailbox.shortTime(s.date)) { chatAct("snooze", until: s.date) }
            }
            Button(L("Cancel"), role: .cancel) {}
        }
        .sheet(isPresented: $showFolders) {
            FolderPicker(current: chat?.folderId) { f in chatAct("move", folderId: f.id) }
        }
        .task {
            if convId == 0 { convId = ref.id }
            if text.isEmpty && subject.isEmpty, let u = Nav.shared.unsentChats[unsentKey] { // rebuilt (iPad resize)
                subject = u.subject
                text = u.text
                replyTo = u.replyTo
                pickedReply = u.picked
                dismissedReply = u.dismissed
            }
            await load()
            await loadChat()
            await loadBlocked()
        }
        .onChange(of: blockedId) { followNewest() }
        .onChange(of: session.mailTick) { Task { await load() } }
        // While the chat is on screen its pushes stay quiet, and the ones already shown are taken away.
        .onAppear { onScreen(convId == 0 ? ref.id : convId) }
        .onChange(of: convId) { _, id in onScreen(id) }
        .onDisappear { if Nav.shared.openChat == convId { Nav.shared.openChat = nil } }
        .onChange(of: Nav.shared.replyTick) { replyToNewest() } // ⌘R
        .onChange(of: text) { keepUnsent() }
        .onChange(of: subject) { keepUnsent() }
        .onChange(of: replyTo) { keepUnsent() }
        .onChange(of: pickedReply) { keepUnsent() }
        .onChange(of: dismissedReply) { keepUnsent() }
    }

    /// This chat's entry in Nav's unsent store.
    private var unsentKey: String { ref.id != 0 ? "c\(ref.id)" : "p\(ref.peer)" }

    /// A reply AutoReply chose, with nothing typed, isn't kept: it is chosen again on load.
    private func keepUnsent() {
        Nav.shared.unsentChats[unsentKey] = text.isEmpty && subject.isEmpty && !pickedReply && dismissedReply == nil
            ? nil : Nav.ChatUnsent(subject: subject, text: text, replyTo: replyTo, picked: pickedReply, dismissed: dismissedReply)
    }

    /// Reply by default: unless the user picked an email or has typed (or attached) something, the box replies to
    /// the newest email from someone else (AutoReply), following new mail as it comes.
    private func followNewest() {
        guard !pickedReply, text.isEmpty, subject.isEmpty, tray.ids.isEmpty else { return }
        replyTo = AutoReply.target(messages, canWrite: blockedId == nil, dismissed: dismissedReply)
    }

    /// Cancel on the reply bar: a new email, until a newer email comes in.
    private func cancelReply() {
        replyTo = nil
        pickedReply = false
        dismissedReply = AutoReply.newest(messages)?.id
    }

    private func onScreen(_ id: Int64) {
        guard id != 0 else { return }
        Nav.shared.openChat = id
        Push.clearDelivered(id)
    }

    /// ⌘R: answers the newest email from someone else in this chat.
    private func replyToNewest() {
        guard convId != 0, Nav.shared.openChat == convId, let m = messages.last(where: { !$0.isMine }) else { return }
        startReply(m)
        typing = true
    }

    /// The ⋯ menu, as on the web: archive, snooze, mute, folder and unread for any chat; Block for a person.
    @ViewBuilder private var moreMenu: some View {
        if convId != 0, let chat {
            // Filed chats are archived too; Move to Inbox takes them out of their folder.
            let toInbox = chat.isArchived || chat.folderId != nil
            Button { chatAct(toInbox ? Mailbox.inboxAction(filter: context) : "archive", said: toInbox ? L("Moved to Inbox") : nil) } label: {
                Label(toInbox ? L("Move to Inbox") : L("Archive"), systemImage: toInbox ? "tray.and.arrow.up" : "archivebox")
            }
            if chat.isSnoozed() {
                Button { chatAct("unsnooze") } label: { Label(L("Unsnooze"), systemImage: "clock.badge.xmark") }
            } else {
                Button { showSnooze = true } label: { Label(L("Snooze…"), systemImage: "clock") }
            }
            if chat.isMuted {
                Button { chatAct("unmute") } label: { Label(L("Unmute"), systemImage: "bell") }
            } else {
                Button { chatAct("mute") } label: { Label(L("Mute"), systemImage: "bell.slash") }
            }
            Button { showFolders = true } label: { Label(L("Move to folder…"), systemImage: "folder") }
            if chat.folderId != nil {
                Button { chatAct("unfile") } label: { Label(L("Remove from folder"), systemImage: "folder.badge.minus") }
            }
            Button { chatAct("unread") } label: { Label(L("Mark as unread"), systemImage: "envelope.badge") }
        } else if convId != 0 {
            // The chat's state (archived, snoozed, muted, folder) didn't load: no guessing.
            Button { Task { await loadChat() } } label: { Label(L("Try again"), systemImage: "arrow.clockwise") }
        }
        if !ref.isGroup && !ref.peer.isEmpty {
            Section {
                if blockedId != nil {
                    Button(L("Unblock %@", ref.title)) { toggleBlock() }
                } else {
                    Button(L("Block %@", ref.title), role: .destructive) { confirmBlock = true }
                }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if let r = replyTo {
                HStack(spacing: 8) {
                    Rectangle().fill(Palette.header).frame(width: 4)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.isMine ? L("Replying to yourself") : L("Replying to %@", r.senderLabel)).font(.footnote.weight(.semibold)).foregroundStyle(Palette.header)
                        Text(r.body).font(.footnote).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                    Spacer()
                    Button(L("Full editor")) { openEditor(replyTo: r.id) }.font(.footnote.weight(.semibold)).foregroundStyle(Palette.header)
                    Button { cancelReply() } label: { Image(systemName: "xmark").foregroundStyle(Palette.muted) }
                        .accessibilityLabel(L("Cancel reply"))
                }
                .frame(height: 40)
                .padding(8)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 12))
            } else {
                // A new email in this chat gets a subject; replies never show one (brief).
                TextField(L("Subject"), text: $subject)
                    .accessibilityIdentifier("chatSubject")
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(Palette.field, in: Capsule())
            }
            TrayChips(tray: tray)
            HStack(alignment: .bottom, spacing: 6) {
                AttachButton(tray: tray)
                TextField(L("Message"), text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($typing)
                    .accessibilityIdentifier("chatMessage")
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Palette.field, in: RoundedRectangle(cornerRadius: 22))
                let canSend = (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !tray.ids.isEmpty) && !tray.uploading && !sending
                Button(action: send) {
                    ZStack {
                        Circle().fill(Palette.header.opacity(canSend ? 1 : 0.5))
                        if sending { ProgressView().tint(Palette.onHeader) } else { Image(systemName: "paperplane.fill").foregroundStyle(Palette.onHeader) }
                    }
                    .frame(width: 44, height: 44)
                }
                .disabled(!canSend)
                .accessibilityLabel(L("Send"))
                .accessibilityIdentifier("Send")
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
    }

    // MARK: actions

    private func load() async {
        guard convId != 0 else { return }
        loading = true
        do {
            // Newest first from the api; the first page also marks the chat read.
            messages = try await session.api.chatMessages(convId).reversed()
            hasOlder = true
            followNewest()
        } catch {
            flash(error.localizedDescription)
        }
        loading = false
    }

    private func loadOlder() async {
        guard convId != 0, hasOlder, !loading, let oldest = messages.first else { return }
        guard let older = try? await session.api.chatMessages(convId, before: oldest.sentAt, beforeId: oldest.id) else { return }
        let known = Set(messages.map(\.id))
        let fresh = older.filter { !known.contains($0.id) } // never the same message twice
        if fresh.isEmpty { hasOlder = false } else { messages = fresh.reversed() + messages }
    }

    private func startReply(_ m: Message) {
        haptic()
        replyTo = m
        pickedReply = true
    }

    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let files = tray.ids
        guard !body.isEmpty || !files.isEmpty, !tray.uploading, !sending else { return }
        Task {
            sending = true
            defer { sending = false }
            do {
                if let r = replyTo {
                    _ = try await session.api.reply(to: r.id, conversationId: convId, body: body, attachmentIds: files)
                } else {
                    let to: API.Target = ref.isGroup ? .group(convId) : .person(ref.peer)
                    let res = try await session.api.send(to: to, subject: subject.trimmingCharacters(in: .whitespaces), body: body, attachmentIds: files)
                    if convId == 0 { convId = res.conversationIds.first ?? 0 }
                }
                text = ""
                subject = ""
                replyTo = nil
                pickedReply = false
                tray.clearSent()
                await load() // replies by default again if the newest email is someone else's
                if chat == nil { await loadChat() } // a new chat now exists
            } catch {
                flash(error.localizedDescription)
            }
        }
    }

    private func loadChat() async {
        guard convId != 0, let c = try? await session.api.conversation(id: convId) else { return }
        chat = c
    }

    /// The list this chat is in, for Move to Inbox and Undo: its folder's, else Home's.
    private var context: String { chat?.folderId.map(Mailbox.folderFilter) ?? "all" }

    /// Archive, snooze, mute, folders, unread on this chat. Marking it unread goes back to the list (staying would
    /// read it again). An Undo's own confirmation offers no Undo.
    private func chatAct(_ action: String, until: Date? = nil, folderId: Int64? = nil, said: String? = nil, undoable: Bool = true) {
        guard convId != 0 else { return }
        let back = undoable ? Mailbox.undo(action, filter: context) : nil
        let folder = folderId.flatMap { id in session.folders.first { $0.id == id }?.name }
        Task {
            do {
                try await session.api.chatAction([convId], action, until: until, folderId: folderId)
                if action == "unread" {
                    if let onLeave { onLeave() } else if !path.isEmpty { path.removeLast() }
                    return
                }
                flash(said ?? Mailbox.done(action, until: until, folder: folder),
                      undo: back.map { b in { chatAct(b.action, folderId: b.folderId, undoable: false) } })
                await loadChat()
                if action == "move" || action == "unfile" { await session.refreshFolders() }
            } catch {
                flash(error.localizedDescription)
            }
        }
    }

    private func loadBlocked() async {
        guard !ref.isGroup, !ref.peer.isEmpty, let list = try? await session.api.blocks() else { return }
        blockedId = list.first { API.sameAddress($0.address, ref.peer) }?.userId
    }

    /// Blocking sends their future direct mail to Spam; mail already here stays.
    private func toggleBlock() {
        Task {
            do {
                if let id = blockedId {
                    try await session.api.unblock(id)
                    blockedId = nil
                    flash(L("%@ is unblocked", ref.title))
                } else {
                    blockedId = try await session.api.block(ref.peer).userId
                    flash(L("%@ is blocked. Their emails will go to Spam.", ref.title))
                }
            } catch {
                flash(error.localizedDescription)
            }
        }
    }

    private func openEditor(replyTo: Int64?) {
        path.append(.compose(ComposeArgs(
            to: ref.isGroup ? "" : ref.peer,
            groupId: ref.isGroup ? convId : nil,
            conversationId: convId == 0 ? nil : convId,
            replyTo: replyTo,
            title: ref.title
        )))
    }

    private func flash(_ t: String, undo: (() -> Void)? = nil) {
        noticeSeq += 1
        let seq = noticeSeq
        withAnimation { notice = t; self.undo = undo }
        Task {
            try? await Task.sleep(for: .seconds(undo == nil ? 2.5 : 5))
            if noticeSeq == seq { withAnimation { notice = ""; self.undo = nil } }
        }
    }
}

private struct Bubble: View {
    let m: Message
    let parent: Message?
    let showSender: Bool

    var body: some View {
        let mine = m.isMine
        let long = m.body.count > longMessage
        HStack(alignment: .top) {
            if mine { Spacer(minLength: 48) }
            if showSender && !mine {
                Avatar(label: m.senderLabel, size: 28, address: m.senderAddress, avatar: m.senderAvatar, name: m.senderName)
            }
            VStack(alignment: .leading, spacing: 3) {
                if showSender && !mine {
                    Text(m.senderLabel).font(.footnote.weight(.semibold)).foregroundStyle(Palette.header)
                }
                if m.parentId != nil {
                    HStack(spacing: 6) {
                        Rectangle().fill(Palette.header).frame(width: 4)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(parent.map { $0.isMine ? L("You") : $0.senderLabel } ?? L("Earlier message"))
                                .font(.footnote.weight(.semibold)).foregroundStyle(Palette.header)
                            if let p = parent { Text(p.body).font(.footnote).foregroundStyle(Palette.muted).lineLimit(2) }
                        }
                        .padding(.vertical, 6)
                        Spacer(minLength: 0)
                    }
                    .background(Palette.text.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
                } else if !m.subject.isEmpty {
                    Text(m.subject).font(.body.bold()).foregroundStyle(Palette.text)
                }
                if let files = m.attachments, !files.isEmpty {
                    AttachmentList(attachments: files, compact: true).frame(maxWidth: 260)
                }
                if !m.body.isEmpty {
                    Text(long ? String(m.body.prefix(longMessage)) + "…" : m.body).foregroundStyle(Palette.text)
                }
                if long { Text(L("Read more")).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.header) }
                HStack(spacing: 4) {
                    Spacer(minLength: 0)
                    if m.isFavourite { Image(systemName: "star.fill").font(.system(size: 10)).foregroundStyle(Palette.star) }
                    Text(Format.bubbleTime(m.sentAt)).font(.caption2).foregroundStyle(Palette.muted)
                }
            }
            .padding(.horizontal, 10).padding(.top, 6).padding(.bottom, 4)
            .background(
                mine ? Palette.bubbleMine : Palette.bubbleTheirs,
                in: UnevenRoundedRectangle(topLeadingRadius: mine ? 10 : 2, bottomLeadingRadius: 10, bottomTrailingRadius: 10, topTrailingRadius: mine ? 2 : 10)
            )
            .shadow(color: .black.opacity(0.08), radius: 0.5, y: 1)
            .contentShape(Rectangle())
            if !mine { Spacer(minLength: 48) }
        }
        .padding(.horizontal, 10)
    }
}

/// Swipe a message to the right to reply (brief: "swipe right to reply, like WhatsApp").
private struct SwipeToReply<Content: View>: View {
    let onReply: () -> Void
    @ViewBuilder let content: Content
    @State private var dx: CGFloat = 0
    private let trigger: CGFloat = 64

    var body: some View {
        ZStack(alignment: .leading) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .foregroundStyle(Palette.header)
                .padding(.leading, 16)
                .opacity(Double(min(dx / trigger, 1)))
            content.offset(x: dx)
        }
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .onChanged { g in
                    // Only horizontal, rightward drags; vertical ones scroll the chat.
                    guard abs(g.translation.width) > abs(g.translation.height) else { return }
                    dx = min(max(g.translation.width, 0), trigger * 1.4)
                }
                .onEnded { _ in
                    if dx >= trigger { onReply() }
                    withAnimation(.spring(duration: 0.25)) { dx = 0 }
                }
        )
    }
}
