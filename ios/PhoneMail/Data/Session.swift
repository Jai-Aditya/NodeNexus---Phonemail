import Foundation
import Observation

/// Who is signed in, the onboarding choices, and live new-mail events. One instance for the app.
/// The token is in the Keychain and a copy of the profile in UserDefaults, so the app opens straight
/// to Home, even offline.
@MainActor
@Observable
final class Session {
    let api = API(base: Config.apiBase)

    private(set) var user: User?
    private(set) var language: String?
    private(set) var termsAccepted: Bool
    /// The contacts explainer (asked once, right after the number is verified) has been answered.
    private(set) var contactsAsked: Bool
    let contacts = ContactsBook()
    /// Increases whenever new mail arrives; screens watch it with `.onChange` and reload.
    private(set) var mailTick = 0
    /// The user's own folders (A-Z), for the menu and "Move to folder".
    private(set) var folders: [MailFolder] = []
    /// Light, dark or the iPhone's setting (Settings > Appearance); kept on the phone.
    private(set) var appearance: Appearance

    @ObservationIgnored private var token: String? {
        didSet { api.token = token }
    }
    @ObservationIgnored private var live: LiveSocket?
    @ObservationIgnored private let defaults = UserDefaults.standard

    init() {
        token = Keychain.get("token")
        language = defaults.string(forKey: "language")
        termsAccepted = defaults.bool(forKey: "terms")
        contactsAsked = defaults.bool(forKey: "contactsAsked")
        appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        if let data = defaults.data(forKey: "user") { user = try? JSONDecoder().decode(User.self, from: data) }
        // Both or neither: no saved profile, or no token (e.g. a backup restored to a new iPhone brings the profile
        // but not this-device-only keychain items), means signing in again.
        if user == nil || token == nil {
            token = nil
            user = nil
            defaults.removeObject(forKey: "user")
        }
        api.token = token // didSet does not run inside init
        api.onUnauthorized = { [weak self] in Task { @MainActor in self?.signOut() } }
        contacts.load()
        if token != nil {
            connectLive()
            Task { try? await refreshUser() } // a 401 signs out via onUnauthorized
        } else {
            Task { await Push.shared.retryPendingUnregister() } // a sign-out made offline
        }
        tellWatch()
    }

    /// Applies at once (every screen redraws in the new language) and is kept on the device; callers
    /// that are signed in also save it to the profile.
    func chooseLanguage(_ code: String) {
        language = code
        defaults.set(code, forKey: "language")
        Lang.shared.set(code)
        Push.registerCategory() // the notification buttons in the new language
        tellWatch()
    }

    /// The Apple Watch app signs in with this phone's token (and follows its name and language); nil signs it out.
    private func tellWatch() {
        WatchLink.shared.update(token: user == nil ? nil : token, name: user?.label ?? "", language: Lang.shared.code)
    }

    /// Applies to every screen at once.
    func chooseAppearance(_ a: Appearance) {
        appearance = a
        defaults.set(a.rawValue, forKey: "appearance")
        a.apply()
    }

    func refreshFolders() async {
        if let list = try? await api.folders() { folders = list }
    }

    func createFolder(_ name: String) async throws -> MailFolder {
        let f = try await api.createFolder(name)
        await refreshFolders()
        return f
    }

    func renameFolder(_ id: Int64, to name: String) async throws {
        try await api.renameFolder(id, to: name)
        await refreshFolders()
    }

    func deleteFolder(_ id: Int64) async throws {
        try await api.deleteFolder(id)
        folders.removeAll { $0.id == id }
    }

    func contactsAnswered() {
        contactsAsked = true
        defaults.set(true, forKey: "contactsAsked")
        contacts.load()
    }

    static func photoURL(_ name: String) -> URL? { URL(string: Config.apiBase + "/avatars/" + name) }

    func acceptTerms() {
        termsAccepted = true
        defaults.set(true, forKey: "terms")
    }

    func signIn(_ auth: AuthResponse) {
        Push.shared.dropPendingUnregister() // this sign-in registers the device again
        token = auth.token
        Keychain.set("token", auth.token)
        setUser(auth.user)
        connectLive()
        // The language chosen on the first screen goes to the profile.
        if let lang = language, lang != auth.user.language {
            Task { if let u = try? await api.updateMe(["language": lang]) { setUser(u) } }
        }
    }

    func signOut() {
        // No more pushes to this device for the account (sent with the old token; retried later if offline).
        if let old = token { Task { await Push.shared.unregister(bearer: old) } }
        Nav.shared.signedOut()
        live?.stop()
        live = nil
        token = nil
        Keychain.set("token", nil)
        defaults.removeObject(forKey: "user")
        user = nil
        folders = []
        tellWatch()
    }

    func refreshUser() async throws { setUser(try await api.me()) }

    func setUser(_ u: User) {
        user = u
        if language == nil, Lang.supported.contains(u.language) { chooseLanguage(u.language) }
        if let data = try? JSONEncoder().encode(u) { defaults.set(data, forKey: "user") }
        tellWatch()
    }

    private func connectLive() {
        guard let t = token else { return }
        live?.stop()
        live = LiveSocket(apiBase: Config.apiBase, token: t) { [weak self] in
            MainActor.assumeIsolated { self?.mailTick += 1 }
        }
        live?.start()
    }
}
