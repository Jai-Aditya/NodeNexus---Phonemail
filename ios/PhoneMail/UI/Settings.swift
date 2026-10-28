import PhotosUI
import SwiftUI

/// Profile and settings: picture, name, language, appearance, password, alias addresses, sign out.
struct SettingsView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var name = ""
    @State private var alias = ""
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var newPassword2 = ""
    @State private var message = ""
    @State private var error = ""
    @State private var photoItem: PhotosPickerItem?
    @State private var showGlyphs = false
    @State private var pictureBusy = false
    @State private var styling: StylingPhoto?
    @State private var blocked: [BlockedPerson] = []
    @State private var showDelete = false

    var body: some View {
        Form {
            if let u = session.user {
                Section {
                    HStack(spacing: 16) {
                        Avatar(label: u.label, size: 64, address: u.address, avatar: u.avatar, name: u.displayName)
                        VStack(alignment: .leading) {
                            Text(u.displayName ?? L("Add your name")).font(.title3.weight(.semibold))
                            Text(u.address).foregroundStyle(Palette.muted)
                        }
                    }
                }
                pictureSection(u)
                Section(L("Your name")) {
                    HStack {
                        TextField(L("Name shown to others"), text: $name)
                        Button(L("Save")) { act(L("Name saved")) { _ = try await session.api.updateMe(["displayName": name.trimmingCharacters(in: .whitespaces)]) } }
                    }
                }
                Section(L("Language")) {
                    Picker(L("Language"), selection: Binding(
                        get: { Lang.shared.code },
                        set: { code in
                            session.chooseLanguage(code) // every screen switches now
                            act(L("Language saved")) { _ = try await session.api.updateMe(["language": code]) }
                        }
                    )) {
                        ForEach(languages) { l in Text(l.native == l.name ? l.name : "\(l.native) (\(l.name))").tag(l.code) }
                    }
                    .accessibilityIdentifier("languagePicker")
                }
                Section {
                    // Kept on this iPhone only; every screen switches now.
                    Picker(L("Appearance"), selection: Binding(get: { session.appearance }, set: { session.chooseAppearance($0) })) {
                        ForEach(Appearance.allCases) { a in Text(a.title).tag(a) }
                    }
                    .accessibilityIdentifier("appearancePicker")
                } header: {
                    Text(L("Appearance"))
                } footer: {
                    Text(L("System follows your iPhone's light or dark setting."))
                }
                notificationsSection
                Section {
                    if u.hasPassword == true {
                        SecureField(L("Current password"), text: $currentPassword)
                            .textContentType(.password).accessibilityIdentifier("currentPassword")
                    }
                    SecureField(L("New password (8+ characters)"), text: $newPassword)
                        .textContentType(.newPassword).accessibilityIdentifier("newPassword")
                    SecureField(L("New password again"), text: $newPassword2)
                        .textContentType(.newPassword).accessibilityIdentifier("newPassword2")
                    Button(u.hasPassword == true ? L("Change password") : L("Set password")) {
                        guard newPassword == newPassword2 else { error = L("The new passwords don't match"); message = ""; return }
                        let cur = currentPassword.isEmpty ? nil : currentPassword
                        let new = newPassword
                        act(u.hasPassword == true ? L("Password changed") : L("Password set")) {
                            try await session.api.changePassword(current: cur, new: new)
                            currentPassword = ""; newPassword = ""; newPassword2 = ""
                        }
                    }
                    .disabled(newPassword.count < 8)
                } header: {
                    Text(u.hasPassword == true ? L("Change password") : L("Set a password"))
                } footer: {
                    Text(u.hasPassword == true
                         ? L("Forgot it? Use “Forgot password” on the sign-in page at mail.phonemail.net to set a new one with an SMS code.")
                         : L("You sign in with an SMS code. A password lets you sign in without one."))
                }
                Section {
                    ForEach(u.aliases ?? [], id: \.self) { a in
                        Text(a).swipeActions {
                            Button(L("Remove"), role: .destructive) { act(L("Alias removed")) { try await session.api.removeAlias(a) } }
                        }
                    }
                    HStack {
                        TextField("new.alias", text: $alias).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("@\(Config.mailDomain)").foregroundStyle(Palette.muted)
                        Button(L("Add")) {
                            let a = alias.lowercased().trimmingCharacters(in: .whitespaces)
                            act(L("Alias added")) { _ = try await session.api.addAlias(a); alias = "" }
                        }
                        .disabled(alias.count < 3)
                    }
                } header: {
                    Text(L("Other addresses (aliases)"))
                } footer: {
                    Text(L("People can also email you at an alias. Mail to it arrives in your chats."))
                }
                Section {
                    if blocked.isEmpty {
                        Text(L("No one is blocked.")).foregroundStyle(Palette.muted)
                    }
                    ForEach(blocked) { p in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(p.label)
                                if p.name != nil { Text(p.address).font(.footnote).foregroundStyle(Palette.muted) }
                            }
                            Spacer()
                            Button(L("Unblock")) {
                                act(L("%@ is unblocked", p.label)) {
                                    try await session.api.unblock(p.userId)
                                    blocked.removeAll { $0.userId == p.userId }
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                } header: {
                    Text(L("Blocked people"))
                } footer: {
                    Text(L("Mail from people you block goes to Spam."))
                }
                if !message.isEmpty || !error.isEmpty {
                    Section {
                        if !message.isEmpty { Text(message).foregroundStyle(Palette.header).accessibilityIdentifier("settingsMessage") }
                        ErrorText(text: error)
                    }
                }
                Section {
                    Button(L("Terms of Service")) { openURL(Config.termsURL) }
                    Button(L("Help (user manual)")) { openURL(Config.helpURL) }
                    Button(L("Sign out"), role: .destructive) { session.signOut() } // the root view returns to sign-in
                        .accessibilityIdentifier("Sign out")
                } footer: {
                    Text("PhoneMail \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")")
                }
                Section {
                    Button(L("Delete account"), role: .destructive) { showDelete = true }
                        .accessibilityIdentifier("deleteAccount")
                }
            }
        }
        .tint(Palette.header)
        .navigationTitle(L("Profile and settings"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { name = session.user?.displayName ?? "" }
        // Back from iOS Settings: notifications may have been turned on or off there.
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await Push.shared.start() } } }
        .task {
            await Push.shared.refresh()
            try? await session.refreshUser()
            if let list = try? await session.api.blocks() { blocked = list }
        }
        .sheet(isPresented: $showGlyphs) { GlyphPicker() }
        .sheet(isPresented: $showDelete) { DeleteAccountSheet() }
        .sheet(item: $styling) { p in
            PhotoStyleSheet(square: p.image) { jpeg in
                setPicture(L("Photo saved")) { try await session.api.uploadAvatarPhoto(jpeg) }
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { await uploadPhoto(item) }
        }
    }

    /// On or off; when turned off in iOS Settings, a way there.
    private var notificationsSection: some View {
        let push = Push.shared
        return Section {
            LabeledContent(L("Notifications"), value: push.isOn ? L("On") : L("Off"))
                .accessibilityIdentifier("notificationsState")
            if push.status == .denied {
                Button(L("Open iOS Settings")) {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { openURL(url) }
                }
            } else if push.status == .notDetermined {
                Button(L("Turn on notifications")) { Task { await push.start() } }
            }
        } header: {
            Text(L("Notifications"))
        } footer: {
            Text(push.status == .denied
                 ? L("Notifications are off for PhoneMail. Turn them on in iOS Settings to hear about new emails.")
                 : L("New emails show on this device and on your Apple Watch. Reply or mark them read from the notification."))
        }
    }

    @ViewBuilder private func pictureSection(_ u: User) -> some View {
        Section {
            HStack {
                Spacer()
                ZStack {
                    Avatar(label: u.label, size: 112, address: u.address, avatar: u.avatar, name: u.displayName)
                    if pictureBusy { ProgressView().tint(.white).scaleEffect(1.4) }
                }
                .accessibilityIdentifier("bigAvatar")
                Spacer()
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden) // the picture floats on the page: no line under it
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label(L("Upload photo"), systemImage: "photo")
            }
            Button { showGlyphs = true } label: { Label(L("Pick a glyph"), systemImage: "face.smiling") }
                .accessibilityIdentifier("pickGlyph")
            if AvatarValue(u.avatar) != .bloom {
                Button { setPicture(L("Your number bloom is back")) { try await session.api.resetAvatar() } } label: {
                    Label(L("Use my number bloom"), systemImage: "camera.macro")
                }
                .accessibilityIdentifier("useBloom")
            }
        } header: {
            Text(L("Profile picture"))
        } footer: {
            Text(L("Your default picture is drawn from your phone number — no two numbers bloom alike."))
        }
    }

    /// The picked photo is cropped here, then styled on the phone (PhotoStyleSheet) before anything is uploaded.
    private func uploadPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self), let square = AvatarPhoto.square(data) else {
            error = L("Could not read that photo."); return
        }
        styling = StylingPhoto(image: square)
    }

    private func setPicture(_ done: String, _ work: @escaping () async throws -> User) {
        Task {
            pictureBusy = true
            message = ""
            error = ""
            do {
                session.setUser(try await work())
                message = done
            } catch {
                self.error = error.localizedDescription
            }
            pictureBusy = false
        }
    }

    private func act(_ done: String, _ work: @escaping () async throws -> Void) {
        Task {
            message = ""
            error = ""
            do {
                try await work()
                try await session.refreshUser()
                message = done
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Profile photos: a centred 512 x 512 square (PhotoStyles.swift), sent as JPEG (the api takes up to 2 MB).
enum AvatarPhoto {}

/// The stock glyphs: pick one and a colour, see it live, then save.
struct GlyphPicker: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var stock = StockAvatars.fallback
    @State private var glyph = StockAvatars.fallback.glyphs[0]
    @State private var color = StockAvatars.fallback.colors[0]
    @State private var busy = false
    @State private var error = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Avatar(label: "", size: 120, avatar: "glyph:\(glyph):\(color)")
                        .padding(.top, 12)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                        ForEach(stock.glyphs, id: \.self) { g in
                            Button { glyph = g } label: {
                                Text(g).font(.system(size: 34)).frame(width: 60, height: 60)
                                    .background(glyph == g ? Palette.chipOnBg : Palette.chipBg, in: Circle())
                                    .overlay(Circle().stroke(glyph == g ? Palette.header : .clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("glyph-\(g)")
                        }
                    }
                    HStack(spacing: 10) {
                        ForEach(stock.colors, id: \.self) { c in
                            Button { color = c } label: {
                                Circle().fill(Color(hexString: c)).frame(width: 34, height: 34)
                                    .overlay(Circle().stroke(Palette.text, lineWidth: color == c ? 3 : 0).padding(-4))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(c)
                        }
                    }
                    ErrorText(text: error)
                }
                .padding(20)
            }
            .navigationTitle(L("Pick a glyph"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Save")) { save() }.disabled(busy).accessibilityIdentifier("saveGlyph")
                }
            }
            .task {
                if let s = try? await session.api.stockAvatars(), !s.glyphs.isEmpty, !s.colors.isEmpty {
                    stock = s
                    if !s.glyphs.contains(glyph) { glyph = s.glyphs[0] }
                    if !s.colors.contains(color) { color = s.colors[0] }
                }
                if case .glyph(let g, let c) = AvatarValue(session.user?.avatar) { glyph = g; color = c }
            }
        }
        .presentationDetents([.large])
    }

    private func save() {
        Task {
            busy = true
            error = ""
            do {
                session.setUser(try await session.api.setGlyph(glyph, color: color))
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            busy = false
        }
    }
}

/// Deleting the account (App Store rule 5.1.1(v)): confirmed with the password, or with an SMS code when the account
/// has none, so a borrowed unlocked phone isn't enough. Afterwards the app is signed out.
struct DeleteAccountSheet: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var code = ""
    @State private var codeSent = false
    @State private var busy = false
    @State private var error = ""

    private var usesPassword: Bool { session.user?.hasPassword == true }
    private var ready: Bool { usesPassword ? !password.isEmpty : code.count >= 4 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(L("Deleting your account erases your number, profile, aliases and your copies of mail. Mail you already sent stays with the people who received it. This can't be undone."))
                }
                Section {
                    if usesPassword {
                        SecureField(L("Your password"), text: $password)
                            .textContentType(.password).accessibilityIdentifier("deletePassword")
                    } else {
                        Button(L("Send me a code by SMS")) { sendCode() }.disabled(busy)
                        if codeSent {
                            TextField(L("6-digit code"), text: $code)
                                .keyboardType(.numberPad).textContentType(.oneTimeCode).accessibilityIdentifier("deleteCode")
                        }
                    }
                } footer: {
                    Text(usesPassword ? L("Confirm with your password.") : L("Confirm with a code we text you."))
                }
                if !error.isEmpty { Section { ErrorText(text: error) } }
                Section {
                    Button(L("Delete my account"), role: .destructive) { delete() }
                        .disabled(!ready || busy)
                        .accessibilityIdentifier("confirmDeleteAccount")
                }
            }
            .navigationTitle(L("Delete account"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } } }
        }
    }

    private func sendCode() {
        guard let phone = session.user?.phone else { return }
        Task {
            busy = true
            error = ""
            do { try await session.api.otpStart(phone: phone); codeSent = true } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    private func delete() {
        Task {
            busy = true
            error = ""
            do {
                await Push.shared.unregister(using: session.api) // best effort, while the account still exists
                try await session.api.deleteAccount(password: usesPassword ? password : nil,
                                                   code: usesPassword ? nil : code.filter(\.isNumber))
                dismiss()
                session.signOut() // the root view returns to sign-in
            } catch {
                self.error = error.localizedDescription
                await Push.shared.start() // still here: notifications back on
            }
            busy = false
        }
    }
}

struct StylingPhoto: Identifiable {
    let id = UUID()
    let image: CGImage
}

/// Styles for the new profile photo, all made on this phone: five live tiles, a large preview, then
/// "Use this picture" uploads only the chosen result.
struct PhotoStyleSheet: View {
    @Environment(\.dismiss) private var dismiss
    let square: CGImage
    let use: (Data) -> Void
    @State private var styled: [PhotoStyle: CGImage] = [:]
    @State private var chosen = PhotoStyle.original

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    ZStack {
                        if let img = styled[chosen] {
                            Image(uiImage: UIImage(cgImage: img)).resizable().scaledToFill()
                        } else {
                            Rectangle().fill(Palette.chipBg)
                            ProgressView().tint(Palette.header)
                        }
                    }
                    .frame(width: 260, height: 260)
                    .clipShape(Circle())
                    .accessibilityIdentifier("stylePreview")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(PhotoStyle.allCases) { s in
                                Button { chosen = s } label: {
                                    VStack(spacing: 6) {
                                        ZStack {
                                            if let img = styled[s] {
                                                Image(uiImage: UIImage(cgImage: img)).resizable().scaledToFill()
                                            } else {
                                                Rectangle().fill(Palette.chipBg)
                                                ProgressView().tint(Palette.header)
                                            }
                                        }
                                        .frame(width: 72, height: 72)
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(chosen == s ? Palette.header : .clear, lineWidth: 3))
                                        Text(s.title).font(.caption).foregroundStyle(chosen == s ? Palette.header : Palette.text)
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("style-\(s.rawValue)")
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    Text(L("Styles are applied on your device — only the picture you choose is uploaded."))
                        .font(.footnote).foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(.horizontal, 24)
                    PrimaryButton(title: L("Use this picture"), enabled: styled[chosen] != nil) {
                        if let img = styled[chosen], let jpeg = AvatarPhoto.jpeg(img) {
                            use(jpeg)
                            dismiss()
                        }
                    }
                    .accessibilityIdentifier("usePicture")
                    .padding(.horizontal, 24)
                }
                .padding(.vertical, 20)
            }
            .navigationTitle(L("Choose a style"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } } }
            .task {
                // Each style is made off the main thread, and its tile fills in as soon as it is ready.
                let src = square
                await withTaskGroup(of: (PhotoStyle, CGImage).self) { group in
                    for s in PhotoStyle.allCases { group.addTask(priority: .userInitiated) { (s, s.apply(to: src)) } }
                    for await (s, img) in group { styled[s] = img }
                }
            }
        }
    }
}