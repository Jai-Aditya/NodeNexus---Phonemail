import SwiftUI

/// Drafts, Scheduled, Spam or Trash (from the Home menu). Scheduled lists the drafts waiting for their send
/// time; cancelling one keeps it in Drafts.
struct FolderView: View {
    @Environment(Session.self) private var session
    let name: String
    @Binding var path: [Route]
    @State private var messages: [Message] = []
    @State private var drafts: [Draft] = []
    @State private var loaded = false
    @State private var error = ""
    @State private var notice = ""

    private var usesDrafts: Bool { name == "drafts" || name == "scheduled" }
    /// Scheduled drafts show only under Scheduled.
    private var shownDrafts: [Draft] { drafts.filter { ($0.sendAt != nil) == (name == "scheduled") } }
    private var isEmpty: Bool { usesDrafts ? shownDrafts.isEmpty : messages.isEmpty }

    private var title: String {
        switch name {
        case "drafts": return L("Drafts")
        case "scheduled": return L("Scheduled")
        case "spam": return L("Spam")
        default: return L("Trash")
        }
    }

    var body: some View {
        List {
            if loaded && isEmpty {
                Text(error.isEmpty ? (name == "trash" ? L("Trash is empty.") : L("Nothing here.")) : error)
                    .foregroundStyle(Palette.muted).frame(maxWidth: .infinity).padding(.top, 40).listRowSeparator(.hidden)
                    .listRowBackground(Palette.background)
            }
            if name == "drafts" {
                ForEach(shownDrafts) { d in
                    Button { path.append(.compose(ComposeArgs(draftId: d.id))) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("To") + ": " + recipients(d)).font(.subheadline).foregroundStyle(Palette.danger).lineLimit(1)
                            Text(d.subject.isEmpty ? L("(no subject)") : d.subject).font(.headline).foregroundStyle(Palette.text).lineLimit(1)
                            Text(d.body).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(1)
                        }
                    }
                    .listRowBackground(Palette.background)
                    .swipeActions {
                        Button(L("Discard"), role: .destructive) {
                            Task { try? await session.api.deleteDraft(d.id); await load() }
                        }
                    }
                }
            } else if name == "scheduled" {
                ForEach(shownDrafts) { d in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L("To") + ": " + recipients(d)).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(1)
                            Text(d.subject.isEmpty ? L("(no subject)") : d.subject).font(.headline).foregroundStyle(Palette.text).lineLimit(1)
                            Label(L("Sends %@", Format.fullTime(d.sendAt)), systemImage: "clock")
                                .font(.subheadline).foregroundStyle(Palette.header).lineLimit(1)
                        }
                        Spacer()
                        Button(L("Cancel send")) { cancelSend(d) }
                            .buttonStyle(.borderless).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.danger)
                    }
                    .listRowBackground(Palette.background)
                }
            } else {
                ForEach(messages) { m in
                    Button { path.append(.message(m.id)) } label: {
                        HStack(spacing: 12) {
                            Avatar(label: m.senderLabel, size: 40, address: m.senderAddress, avatar: m.senderAvatar, name: m.senderName)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(m.isMine ? L("You") : m.senderLabel).font(.headline).foregroundStyle(Palette.text).lineLimit(1)
                                    Spacer()
                                    Text(Format.chatTime(m.sentAt)).font(.caption).foregroundStyle(Palette.muted)
                                }
                                Text(m.subject.isEmpty ? m.body : m.subject).font(.subheadline).foregroundStyle(Palette.muted).lineLimit(1)
                            }
                        }
                    }
                    .listRowBackground(Palette.background)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Palette.background)
        .overlay(alignment: .bottom) {
            if !notice.isEmpty { Toast(text: notice) }
        }
        .navigationTitle(title)
        .refreshable { await load() }
        .onAppear { Task { await load() } }
    }

    private func recipients(_ d: Draft) -> String {
        (d.recipients.to ?? []).isEmpty ? L("(no one yet)") : (d.recipients.to ?? []).joined(separator: ", ")
    }

    /// The draft stays, unscheduled, in Drafts.
    private func cancelSend(_ d: Draft) {
        Task {
            var said = L("Send cancelled. It's in Drafts now.")
            do {
                _ = try await session.api.unschedule(d.id)
                await load()
            } catch {
                said = error.localizedDescription
            }
            withAnimation { notice = said }
            try? await Task.sleep(for: .seconds(2.5))
            withAnimation { if notice == said { notice = "" } }
        }
    }

    private func load() async {
        do {
            if usesDrafts { drafts = try await session.api.drafts() } else { messages = try await session.api.folder(name) }
            error = ""
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}
