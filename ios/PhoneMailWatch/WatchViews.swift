import SwiftUI

/// Shown until the iPhone app has sent a sign-in.
struct SignedOutView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "iphone").font(.system(size: 34)).foregroundStyle(.tint)
            Text(L("Open PhoneMail on your iPhone to sign in.")).multilineTextAlignment(.center)
        }
        .padding()
        .onAppear { PhoneLink.shared.ask() }
    }
}

/// The Inbox, newest first, with unread counts. Pull down to refresh.
struct InboxView: View {
    @Environment(WatchStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var chats: [WatchChat] = []
    @State private var loaded = false
    @State private var error = ""
    @State private var path: [WatchChat] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if !error.isEmpty {
                    Text(error).font(.footnote).foregroundStyle(.red)
                    Button(L("Try again")) { Task { await load() } }
                } else if loaded && chats.isEmpty {
                    Text(L("Nothing here.")).foregroundStyle(.secondary)
                }
                ForEach(chats) { c in
                    NavigationLink(value: c) { ChatRowView(c: c) }
                }
            }
            .overlay { if !loaded { ProgressView() } }
            .navigationTitle(L("Inbox"))
            .navigationDestination(for: WatchChat.self) { c in WatchChatView(chat: c) }
            .refreshable { await load() }
            .task { await load() }
            .onChange(of: store.changed) { Task { await load() } }
            .onChange(of: path) { if path.isEmpty { Task { await load() } } } // back from a chat: read now
            // Raising the wrist brings the app back as it was left: fetch what arrived meanwhile (an open chat
            // reloads itself).
            .onChange(of: scenePhase) { _, phase in if phase == .active && path.isEmpty { Task { await load() } } }
            .onChange(of: store.pendingChat, initial: true) { Task { await openPending() } }
        }
    }

    private func load() async {
        do {
            chats = try await store.chats()
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    /// A tapped notification opens its chat.
    private func openPending() async {
        guard let id = store.pendingChat else { return }
        store.pendingChat = nil
        if !chats.contains(where: { $0.id == id }) { await load() }
        if let c = chats.first(where: { $0.id == id }) { path = [c] }
    }
}

private struct ChatRowView: View {
    let c: WatchChat

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                Text(c.title).font(.headline.weight(c.unread > 0 ? .bold : .regular)).lineLimit(1)
                if let s = WatchMail.nonEmpty(c.snippet) {
                    Text(s).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
            if c.unread > 0 {
                Text("\(c.unread)").font(.caption2.bold()).foregroundStyle(.black)
                    .padding(.horizontal, 6).frame(minWidth: 20, minHeight: 20)
                    .background(Color(red: 0xF2 / 255, green: 0xA3 / 255, blue: 0x3A / 255), in: Capsule()) // Pip's orange
            }
        }
    }
}

/// One chat, oldest message first; opening it marks it read. At the bottom, a reply to the newest email from
/// someone else: typed, dictated or scribbled, or one of the quick replies.
struct WatchChatView: View {
    @Environment(WatchStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    let chat: WatchChat
    @State private var messages: [WatchMessage] = []
    @State private var loaded = false
    @State private var error = ""
    @State private var text = ""
    @State private var sending = false
    @State private var note = ""

    private var target: WatchMessage? { WatchMail.replyTarget(messages) }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                if !error.isEmpty { Text(error).font(.footnote).foregroundStyle(.red) }
                ForEach(messages) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.senderLabel).font(.caption2).foregroundStyle(m.mine ? Color.secondary : Color.accentColor)
                        if let s = m.shownSubject { Text(s).font(.footnote.bold()) }
                        Text(m.text).font(.footnote)
                    }
                    .listRowBackground(Color.clear)
                    .id(m.id)
                }
                if let t = target { replySection(t) }
            }
            .overlay { if !loaded { ProgressView() } }
            .onChange(of: messages.last?.id) { _, id in if let id { proxy.scrollTo(id, anchor: .bottom) } }
        }
        .navigationTitle(chat.title)
        .task { await load() }
        .onChange(of: scenePhase) { _, phase in if phase == .active && !sending { Task { await load() } } }
        .onChange(of: store.changed) { Task { await load() } } // a reply sent from a notification
    }

    @ViewBuilder private func replySection(_ t: WatchMessage) -> some View {
        Section {
            TextField(L("Reply"), text: $text).onSubmit { send(text) }.disabled(sending)
            ForEach(WatchMail.quickReplies, id: \.self) { q in
                Button(q) { send(q) }.disabled(sending)
            }
            if sending { ProgressView() }
            if !note.isEmpty { Text(note).font(.footnote).foregroundStyle(.secondary) }
        } header: {
            Text(L("Reply to %@", t.senderLabel))
        }
    }

    private func load() async {
        do {
            messages = try await store.messages(chat.id)
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func send(_ body: String) {
        let body = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let t = target, !body.isEmpty, !sending else { return }
        Task {
            sending = true
            note = ""
            do {
                try await store.reply(to: t.id, conversationId: chat.id, text: body)
                text = ""
                note = L("Sent")
                await load()
            } catch {
                note = error.localizedDescription
            }
            sending = false
        }
    }
}
