import ContactsUI
import SwiftUI

/// What the editor was opened for.
struct ComposeArgs: Hashable {
    var to = ""
    var groupId: Int64?
    var conversationId: Int64?
    var replyTo: Int64?
    var title = ""
    var draftId: Int64?
    /// This opening of the editor: what is typed in it is kept under this (Nav's unsent store) while it is open,
    /// so an iPad window resized between wide and narrow gets it back. Each new ComposeArgs is a new editor.
    var instance = UUID()

    /// Opened from a chat: recipients are locked (brief: no new To/Cc inside a chat).
    var locked: Bool { conversationId != nil || groupId != nil }
    var isReply: Bool { replyTo != nil }
}

/// The traditional email editor.
///  - From Home: To / Cc / Bcc are editable; 2+ people in To starts a group chat (brief), which is then mailed.
///  - From a chat: recipients are locked. Reply: no subject; the reply links to the original.
///  - Leaving without sending keeps the email as a draft (Home only).
struct ComposeView: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let args: ComposeArgs

    @State private var to = ""
    @State private var cc = ""
    @State private var bcc = ""
    @State private var groupName = ""
    @State private var subject = ""
    @State private var text = ""
    @State private var busy = false
    @State private var error = ""
    @State private var draftId: Int64?
    @State private var sent = false
    @State private var tray = AttachmentTray()

    private var toList: [String] { Format.splitAddresses(to) }
    private var makesGroup: Bool { !args.locked && !args.isReply && toList.count > 1 }
    /// The entry being typed in To, if it is a name (not a number or address).
    private var lastTyped: String {
        guard !to.hasSuffix(","), !to.hasSuffix(" "), let last = to.split(separator: ",").last else { return "" }
        let t = last.trimmingCharacters(in: .whitespaces)
        return t.contains("@") || t.allSatisfy(\.isNumber) ? "" : t
    }

    var body: some View {
        Form {
            Section {
                if args.locked || args.isReply {
                    LabeledContent(L("To")) {
                        Label(args.title.isEmpty ? (args.to.isEmpty ? L("This chat") : args.to) : args.title, systemImage: "lock.fill")
                            .foregroundStyle(Palette.text)
                    }
                } else {
                    HStack {
                        TextField(L("To: names, phone numbers or addresses"), text: $to)
                            .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("composeTo")
                        Button { ContactPicking.pick { n in to = (toList + [n]).uniqued().joined(separator: ", ") } } label: {
                            Image(systemName: "person.crop.circle.badge.plus")
                        }
                        .accessibilityLabel(L("Pick from contacts"))
                    }
                    // Contacts matching the name being typed (the last entry in To).
                    ForEach(session.contacts.search(lastTyped, limit: 4)) { p in
                        Button {
                            let before = to.split(separator: ",").dropLast().map { $0.trimmingCharacters(in: .whitespaces) }
                            to = (before + [p.digits]).filter { !$0.isEmpty }.uniqued().joined(separator: ", ") + ", "
                        } label: {
                            HStack(spacing: 10) {
                                Avatar(label: p.name, size: 30, address: p.address, name: p.name)
                                Text(p.name).foregroundStyle(Palette.text)
                                Spacer()
                                Text(p.digits).font(.footnote).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    TextField(L("Cc"), text: $cc).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField(L("Bcc"), text: $bcc).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            if makesGroup {
                Section {
                    TextField(L("Group name (optional)"), text: $groupName).accessibilityIdentifier("groupName")
                } footer: {
                    Text(L("Sending to %lld people starts a group chat. Later emails to one of them stay in your one-to-one chat.", toList.count))
                }
            }
            Section {
                if !args.isReply { TextField(L("Subject"), text: $subject).accessibilityIdentifier("composeSubject") }
                TextField(args.isReply ? L("Write your reply") : L("Compose email"), text: $text, axis: .vertical)
                    .lineLimit(10...)
                    .accessibilityIdentifier("composeBody")
            }
            Section {
                TrayChips(tray: tray)
                HStack {
                    AttachButton(tray: tray)
                    Text(tray.isEmpty ? L("Attach photos or files (up to 25 MB)") : L("Add more")).foregroundStyle(Palette.muted)
                }
            }
            if !error.isEmpty { Section { ErrorText(text: error) } }
        }
        .navigationTitle(args.isReply ? L("Reply") : L("Compose"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { send() } label: {
                    if busy { ProgressView() } else { Image(systemName: "paperplane.fill") }
                }
                .disabled((text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && tray.ids.isEmpty) || tray.uploading || busy)
                .accessibilityLabel(L("Send"))
                .accessibilityIdentifier("Send")
            }
        }
        .task {
            if let u = Nav.shared.unsentEmails[args.instance] { restore(u) } else { await openDraft() }
        }
        .onChange(of: [to, cc, bcc, groupName, subject, text]) { keepUnsent() }
        .onDisappear {
            saveDraftIfNeeded()
            if !sent { tray.discardAll(api: session.api) } // uploads are not kept on drafts
        }
    }

    /// The same editor, rebuilt (iPad resize): what was typed, and the draft it was saved as.
    private func restore(_ u: Nav.EmailUnsent) {
        (to, cc, bcc, groupName, subject, text) = (u.to, u.cc, u.bcc, u.groupName, u.subject, u.text)
        if let id = u.draftId { draftId = id }
    }

    private func keepUnsent() {
        guard !sent else { return }
        var u = Nav.shared.unsentEmails[args.instance] ?? Nav.EmailUnsent()
        (u.to, u.cc, u.bcc, u.groupName, u.subject, u.text) = (to, cc, bcc, groupName, subject, text)
        if let draftId { u.draftId = draftId }
        Nav.shared.unsentEmails[args.instance] = u
    }

    private func openDraft() async {
        guard let id = args.draftId, draftId == nil else { return }
        draftId = id
        guard let d = try? await session.api.drafts().first(where: { $0.id == id }) else { return }
        to = (d.recipients.to ?? []).joined(separator: ", ")
        cc = (d.recipients.cc ?? []).joined(separator: ", ")
        bcc = (d.recipients.bcc ?? []).joined(separator: ", ")
        subject = d.subject
        text = d.body
    }

    private func saveDraftIfNeeded() {
        guard !sent, !args.locked, !args.isReply,
              !(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && subject.trimmingCharacters(in: .whitespaces).isEmpty)
        else { return }
        let api = session.api
        let key = args.instance
        // The draft this editor was already saved as (also by an earlier copy of it, before an iPad resize).
        let known = draftId ?? Nav.shared.unsentEmails[key]?.draftId
        let (t, c, b, s, body) = (toList, Format.splitAddresses(cc), Format.splitAddresses(bcc), subject, text)
        Task {
            guard let d = try? await api.saveDraft(id: known, to: t, cc: c, bcc: b, subject: s, body: body) else { return }
            Nav.shared.unsentEmails[key]?.draftId = d.id // the next save (a rebuilt editor) updates this one
        }
    }

    private func send() {
        Task {
            busy = true
            error = ""
            defer { busy = false }
            do {
                if let r = args.replyTo {
                    _ = try await session.api.reply(to: r, conversationId: args.conversationId ?? 0, body: text, attachmentIds: tray.ids)
                } else if args.locked {
                    let target: API.Target = args.groupId.map { .group($0) } ?? .person(args.to)
                    _ = try await session.api.send(to: target, subject: subject, body: text, attachmentIds: tray.ids)
                } else {
                    guard let first = toList.first else { throw APIError(status: 400, message: L("Add at least one recipient")) }
                    var target = API.Target.person(first)
                    if makesGroup {
                        let fallback = String(toList.map { $0.split(separator: "@").first.map(String.init) ?? $0 }.joined(separator: ", ").prefix(60))
                        let name = groupName.trimmingCharacters(in: .whitespaces).isEmpty ? fallback : groupName
                        target = .group(try await session.api.createGroup(name: name, members: toList).id)
                    }
                    _ = try await session.api.send(to: target, cc: Format.splitAddresses(cc), bcc: Format.splitAddresses(bcc),
                                                   subject: subject, body: text, draftId: draftId, attachmentIds: tray.ids)
                }
                sent = true
                Nav.shared.unsentEmails[args.instance] = nil
                haptic()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

extension Array where Element: Hashable {
    func uniqued() -> [Element] {
        var seen = Set<Element>()
        return filter { seen.insert($0).inserted }
    }
}

/// Picks one phone number with the system contact picker. It runs outside the app, so no contacts
/// permission is needed (brief: ask for permissions only when needed).
@MainActor
enum ContactPicking {
    private static var delegate: PickerDelegate?

    static func pick(_ onNumber: @escaping (String) -> Void) {
        let picker = CNContactPickerViewController()
        picker.displayedPropertyKeys = [CNContactPhoneNumbersKey]
        picker.predicateForEnablingContact = NSPredicate(format: "phoneNumbers.@count > 0")
        picker.predicateForSelectionOfProperty = NSPredicate(format: "key == 'phoneNumbers'")
        let d = PickerDelegate { number in
            if let n = Format.tenDigits(number) { onNumber(n) }
            delegate = nil
        }
        delegate = d
        picker.delegate = d
        topController()?.present(picker, animated: true)
    }

    private static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }

    private final class PickerDelegate: NSObject, CNContactPickerDelegate {
        let done: (String) -> Void
        init(done: @escaping (String) -> Void) { self.done = done }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contactProperty: CNContactProperty) {
            if let phone = contactProperty.value as? CNPhoneNumber { done(phone.stringValue) }
        }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
            if let phone = contact.phoneNumbers.first?.value { done(phone.stringValue) }
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) {}
    }
}
