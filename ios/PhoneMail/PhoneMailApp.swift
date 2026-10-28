import SwiftUI

@main
struct PhoneMailApp: App {
    /// Push notifications: the APNs token, and Reply / Mark as read from a notification (Push.swift).
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session: Session

    init() {
        // UI tests start from a fresh install state (no sign-in, no onboarding choices).
        if ProcessInfo.processInfo.arguments.contains("-uiTestReset") {
            Keychain.set("token", nil)
            for key in ["user", "language", "terms", "contactsAsked", "appearance"] { UserDefaults.standard.removeObject(forKey: key) }
            // The walkthrough answers the contacts step itself; skip it unless the test asks for it.
            if !ProcessInfo.processInfo.arguments.contains("-uiTestContacts") { UserDefaults.standard.set(true, forKey: "contactsAsked") }
        }
        let s = Session()
        Push.shared.api = s.api
        _session = State(initialValue: s)
    }

    var body: some Scene {
        WindowGroup {
            Localized { RootView() }
                .environment(session)
                .tint(Palette.header)
                .onAppear { session.appearance.apply() } // light, dark or the iPhone's own (Settings > Appearance)
        }
        .commands { MailCommands(session: session) } // ⌘N, ⌘F, ⌘R with a keyboard
    }
}

/// Onboarding until someone is signed in, then the mail screens. Signing out (or an expired token)
/// comes back here automatically, because `session.user` becomes nil.
struct RootView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
            // Back in the app while signed out: an earlier sign-out's push unregister that couldn't reach the server.
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && session.user == nil { Task { await Push.shared.retryPendingUnregister() } }
            }
    }

    @ViewBuilder private var content: some View {
        if session.user != nil {
            // Asked once, straight after sign-up (brief: request permissions at the right stage of onboarding).
            if !session.contactsAsked && ContactsBook.status == .notDetermined {
                ContactsIntroView()
            } else {
                MainView()
            }
        } else {
            OnboardingFlow()
        }
    }
}

/// Keeps the app in the chosen language: every string goes through L, which redraws on a change.
private struct Localized<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content.environment(\.locale, Locale(identifier: Lang.shared.code))
    }
}

private enum Step: Hashable { case terms, phone, verify(String) }

private struct OnboardingFlow: View {
    @Environment(Session.self) private var session
    @State private var path: [Step] = []

    var body: some View {
        NavigationStack(path: $path) {
            first
                .navigationDestination(for: Step.self) { step in
                    switch step {
                    case .terms: TermsView { path.append(.phone) }
                    case .phone: PhoneView { path.append(.verify($0)) }
                    case .verify(let phone): VerifyView(phone: phone) { path.removeLast() }
                    }
                }
        }
    }

    // Returning people skip the language and terms screens they have already seen.
    @ViewBuilder private var first: some View {
        if session.language == nil {
            LanguageView { path.append(session.termsAccepted ? .phone : .terms) }
        } else if !session.termsAccepted {
            TermsView { path.append(.phone) }
        } else {
            PhoneView { path.append(.verify($0)) }
        }
    }
}

/// The mail screens: the iPhone's stack, or on a wide iPad the split view (Split.swift). Notifications are asked
/// for here, once someone is signed in and past the contacts step.
/// A window resized between wide and narrow (iPad multitasking) carries the open screens over (MainNavModel); what
/// was typed comes back from Nav's unsent store.
private struct MainView: View {
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var model = MainNavModel()

    var body: some View {
        Group {
            switch model.layout ?? MainLayout.choose(sizeClass) {
            case .split: SplitMainView(model: model)
            case .stack: StackMainView(model: model)
            }
        }
        .onChange(of: sizeClass, initial: true) { model.switchTo(MainLayout.choose(sizeClass)) }
        .task { await Push.shared.start() }
    }
}

private struct StackMainView: View {
    @Environment(Session.self) private var session
    @Bindable var model: MainNavModel

    var body: some View {
        NavigationStack(path: $model.path) {
            HomeView(path: $model.path)
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .chat(let ref): ChatView(ref: ref, path: $model.path)
                    case .message(let id): MessageDetailView(id: id, path: $model.path)
                    case .compose(let args): ComposeView(args: args)
                    case .folder(let name): FolderView(name: name, path: $model.path)
                    case .chats(let filter): ChatListView(path: $model.path, filter: filter)
                    case .settings: SettingsView()
                    }
                }
        }
        .onChange(of: Nav.shared.composeTick) { model.path.append(.compose(ComposeArgs())) }
        // A tapped notification opens its chat on top of Home.
        .onChange(of: Nav.shared.pendingChat, initial: true) {
            Task { if let ref = await Nav.shared.takePending(session) { model.path = [.chat(ref)] } }
        }
    }
}
