import SwiftUI

/// The traditional view of one email: full headers, the whole body, and Reply / Report spam / Delete; the menu
/// blocks the sender.
struct MessageDetailView: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let id: Int64
    @Binding var path: [Route]
    /// Leaves the email once it is moved (iPad: it was opened beside a list). Nil: back to the screen before it.
    var onLeave: (() -> Void)? = nil
    @State private var m: Message?
    @State private var error = ""
    @State private var notice = ""
    @State private var confirmBlock = false

    var body: some View {
        Group {
            if let m {
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(m.subject.isEmpty ? L("(no subject)") : m.subject).font(.title2).foregroundStyle(Palette.text)
                        HStack(spacing: 12) {
                            Avatar(label: m.senderLabel, size: 40, address: m.senderAddress, avatar: m.senderAvatar, name: m.senderName)
                            VStack(alignment: .leading) {
                                Text(m.isMine ? L("You") : m.senderLabel).font(.headline).foregroundStyle(Palette.text)
                                Text(Format.fullTime(m.sentAt)).font(.footnote).foregroundStyle(Palette.muted)
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("From: %@", m.senderAddress))
                            ForEach(["To", "Cc", "Bcc"], id: \.self) { kind in
                                let list = (m.recipients ?? []).filter { $0.kind == kind.lowercased() }.map { $0.groupName ?? $0.address ?? "" }
                                if !list.isEmpty { Text(L(kind) + ": " + list.joined(separator: ", ")) }
                            }
                        }
                        .font(.footnote).foregroundStyle(Palette.muted)
                        Text(m.body).font(.body).foregroundStyle(Palette.text).textSelection(.enabled)
                        if let files = m.attachments, !files.isEmpty {
                            Text(files.count == 1 ? L("1 attachment") : L("%lld attachments", files.count))
                                .font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted)
                            AttachmentList(attachments: files)
                        }
                        if !notice.isEmpty { Text(notice).foregroundStyle(Palette.header) }
                        ErrorText(text: error)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .safeAreaInset(edge: .bottom) { actions(m) }
            } else if !error.isEmpty {
                ErrorText(text: error).padding()
            } else {
                ProgressView().tint(Palette.header)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let m {
                Button { change(["favourite": !m.isFavourite]) } label: {
                    Image(systemName: m.isFavourite ? "star.fill" : "star")
                }
                .accessibilityLabel(m.isFavourite ? L("Unstar") : L("Star"))
            }
            if let m, !m.isMine, !m.senderAddress.isEmpty {
                Menu {
                    Button(L("Block %@", m.senderLabel), role: .destructive) { confirmBlock = true }
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel(L("More"))
                .accessibilityIdentifier("messageMore")
            }
        }
        // An alert on the screen itself: the same on iPhone and iPad (no popover anchor needed).
        .alert(L("Block %@?", m?.senderLabel ?? ""), isPresented: $confirmBlock) {
            Button(L("Block"), role: .destructive) { blockSender() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Their emails will go to Spam. You can unblock them in Settings."))
        }
        .task { await load() }
    }

    private func blockSender() {
        guard let m else { return }
        Task {
            error = ""
            do {
                _ = try await session.api.block(m.senderAddress)
                notice = L("%@ is blocked. Their emails will go to Spam.", m.senderLabel)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func actions(_ m: Message) -> some View {
        HStack {
            if m.folder != "inbox" {
                Button(L("Move to Home")) { change(["folder": "inbox"], leave: true) }.frame(maxWidth: .infinity)
            } else {
                Button(L("Reply")) {
                    path.append(.compose(ComposeArgs(conversationId: m.conversationId, replyTo: m.id, title: m.senderLabel)))
                }
                .frame(maxWidth: .infinity)
                if !m.isMine {
                    Button(L("Report spam")) { change(["folder": "spam"], leave: true) }
                        .frame(maxWidth: .infinity).accessibilityIdentifier("reportSpam")
                }
                Button(L("Delete"), role: .destructive) { change(["folder": "trash"], leave: true) }.frame(maxWidth: .infinity)
            }
        }
        .tint(Palette.header)
        .padding(.vertical, 12)
        .background(.bar)
    }

    private func load() async {
        do { m = try await session.api.message(id) } catch { self.error = error.localizedDescription }
    }

    private func change(_ flags: [String: Any], leave: Bool = false) {
        Task {
            do {
                try await session.api.setFlags(id, flags)
                if leave { if let onLeave { onLeave() } else { dismiss() } } else { await load() }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
