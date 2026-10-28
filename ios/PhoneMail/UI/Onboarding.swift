import Combine
import MessageUI
import SwiftUI

struct Language: Identifiable {
    let code: String
    let name: String
    let native: String
    var id: String { code }
}

/// The languages the app is translated into (Localizable.xcstrings).
let languages = [
    Language(code: "en", name: "English", native: "English"),
    Language(code: "hi", name: "Hindi", native: "हिन्दी"),
    Language(code: "ta", name: "Tamil", native: "தமிழ்"),
]

/// Screen 1: language. Saved on the device now and to the profile after sign-in.
struct LanguageView: View {
    @Environment(Session.self) private var session
    let next: () -> Void
    @State private var picked = "en"

    var body: some View {
        OnboardingPage(title: L("Welcome to PhoneMail"), subtitle: L("Choose your language")) {
            VStack(spacing: 0) {
                ForEach(languages) { l in
                    Button { picked = l.code; session.chooseLanguage(l.code) } label: {
                        HStack(spacing: 14) {
                            Image(systemName: picked == l.code ? "largecircle.fill.circle" : "circle")
                                .font(.title3).foregroundStyle(picked == l.code ? Palette.header : Palette.muted)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(l.native).font(.body).foregroundStyle(Palette.text)
                                if l.native != l.name { Text(l.name).font(.footnote).foregroundStyle(Palette.muted) }
                            }
                            Spacer()
                        }
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 8)
        } footer: {
            PrimaryButton(title: L("Next")) {
                session.chooseLanguage(picked)
                next()
            }
        }
        .onAppear { picked = session.language ?? "en" }
    }
}

/// Screen 2: terms.
struct TermsView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    let next: () -> Void

    private let points = [
        "Your PhoneMail address is your mobile number, like 9884690127@PhoneMail.Net.",
        "We verify the number with a text message. PhoneMail never calls you.",
        "People who don't have the app may get a text when you email them.",
        "Your emails are stored on PhoneMail's server in India and are never sold or shared.",
        "Don't use PhoneMail for spam or to harass anyone; accounts that do are closed.",
    ]

    var body: some View {
        OnboardingPage(title: L("Terms of Service"), subtitle: L("Please read and accept to continue.")) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(points, id: \.self) { Text("•  " + L($0)).foregroundStyle(Palette.text) }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.chipBg, in: RoundedRectangle(cornerRadius: 12))
        } footer: {
            PrimaryButton(title: L("Agree and continue")) {
                session.acceptTerms()
                next()
            }
            Button(L("Read the full terms")) { openURL(Config.termsURL) }.foregroundStyle(Palette.header)
        }
    }
}

/// Screen 3: phone number. iOS does not let apps read the SIM's number, so the person types it;
/// the keyboard offers the number from their contact card.
struct PhoneView: View {
    let next: (String) -> Void
    @State private var digits = ""
    @FocusState private var focused: Bool

    /// A 10-digit Indian mobile number, or one of the server's test numbers (55555…, used by app reviewers).
    private var valid: Bool { digits.range(of: #"^([6-9]\d{9}|55555\d{5})$"#, options: .regularExpression) != nil }

    var body: some View {
        OnboardingPage(title: L("Enter your phone number"), subtitle: L("Your email address will be your number. We'll verify it with a text message.")) {
            HStack(spacing: 12) {
                Text("+91").font(.title3).frame(width: 64, height: 52)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.divider))
                TextField(L("Phone number"), text: $digits)
                    .font(.title3)
                    .keyboardType(.phonePad)
                    .textContentType(.telephoneNumber)
                    .focused($focused)
                    .accessibilityIdentifier("phone")
                    .padding(.horizontal, 14).frame(height: 52)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(focused ? Palette.header : Palette.divider, lineWidth: focused ? 2 : 1))
                    .onChange(of: digits) { _, v in
                        let d = String(v.filter(\.isNumber).suffix(10))
                        if d != v { digits = d }
                    }
            }
            .padding(.top, 16)
            if digits.count == 10 {
                Text(L("Your address: %@", "\(digits)@\(Config.mailDomain)")).foregroundStyle(Palette.muted)
            }
        } footer: {
            PrimaryButton(title: L("Next"), enabled: valid) { next(digits) }
        }
        .onAppear { focused = true }
    }
}

/// Screen 4: verification, with no phone calls anywhere.
///  1. A code by SMS (Twilio Verify); iOS offers it above the keyboard (one-time-code autofill).
///  2. Otherwise the person texts "JOIN <code>" from this phone; the incoming text proves the number.
///  3. A password, the brief's own fallback.
struct VerifyView: View {
    @Environment(Session.self) private var session
    let phone: String
    let changeNumber: () -> Void

    enum Step { case choose, otp, join, password }
    @State private var mode: AuthMode?
    @State private var step = Step.choose
    @State private var code = ""
    @State private var password = ""
    @State private var join: JoinStart?
    @State private var busy = false
    @State private var error = ""
    @State private var showMessages = false
    /// Seconds until another code can be asked for (a text can get lost; the api allows one every 30 s).
    @State private var resendIn = 0
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        OnboardingPage(title: L("Verify +91 %@", phone), subtitle: subtitle) {
            VStack(spacing: 14) {
                if mode == nil && error.isEmpty { ProgressView().tint(Palette.header).padding() }
                switch step {
                case .choose: chooseStep
                case .otp: otpStep
                case .join: joinStep
                case .password: passwordStep
                }
                ErrorText(text: error)
            }
            .padding(.top, 12)
        } footer: {
            Button(L("Change number"), action: changeNumber).foregroundStyle(Palette.muted)
        }
        .onReceive(tick) { _ in if resendIn > 0 { resendIn -= 1 } }
        .task { await loadMode() }
        .task(id: join?.code) { await pollJoin() }
        .sheet(isPresented: $showMessages) {
            if let j = join { MessageComposer(recipient: j.smsTo, body: j.text).ignoresSafeArea() }
        }
    }

    private var subtitle: String {
        switch step {
        case .otp: L("Enter the 6-digit code we sent by SMS. Tap it above the keyboard when it arrives.")
        case .join: L("Send the text below from this iPhone. Standard SMS charges may apply.")
        case .password: L("Choose a password for your PhoneMail account.")
        case .choose: L("How would you like to verify this number?")
        }
    }

    @ViewBuilder private var chooseStep: some View {
        if let m = mode {
            if m.mode == "otp" { PrimaryButton(title: L("Send me a code by SMS"), busy: busy) { run { try await startOtp() } } }
            if m.smsJoin {
                PrimaryButton(title: m.mode == "otp" ? L("Or verify by sending a text") : L("Verify by sending a text"), busy: busy) {
                    run { try await startJoin() }
                }
            }
            Button(L("Use a password instead")) { step = .password }.foregroundStyle(Palette.header)
        }
    }

    @ViewBuilder private var otpStep: some View {
        TextField(L("6-digit code"), text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode) // iOS suggests the code from Messages
            .font(.title2.monospacedDigit())
            .multilineTextAlignment(.center)
            .padding(12)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.header))
            .onChange(of: code) { _, v in
                let d = String(v.filter(\.isNumber).prefix(6))
                if d != v { code = d }
                if d.count == 6 && !busy { verifyCode() }
            }
        PrimaryButton(title: L("Verify"), enabled: code.count >= 4, busy: busy) { verifyCode() }
        if resendIn > 0 {
            Text(L("Send a new code in %@", String(format: "%d:%02d", resendIn / 60, resendIn % 60)))
                .font(.footnote.monospacedDigit()).foregroundStyle(Palette.muted)
        } else {
            Button(L("Send a new code")) { code = ""; run { try await startOtp() } }.foregroundStyle(Palette.header)
        }
        if mode?.smsJoin == true {
            Button(L("Didn't get it? Verify by sending a text")) { run { try await startJoin() } }.foregroundStyle(Palette.header)
        }
        Button(L("Use a password instead")) { error = ""; step = .password }.foregroundStyle(Palette.header)
    }

    @ViewBuilder private var joinStep: some View {
        if let j = join {
            VStack(spacing: 6) {
                Text(L("Send this text")).foregroundStyle(Palette.muted)
                Text(j.text).font(.title.bold()).kerning(2).foregroundStyle(Palette.text).textSelection(.enabled)
                Text(L("to %@", j.smsTo)).foregroundStyle(Palette.muted).textSelection(.enabled)
            }
            .padding(20)
            .frame(maxWidth: .infinity)
            .background(Palette.chipBg, in: RoundedRectangle(cornerRadius: 12))
            HStack(spacing: 10) {
                ProgressView().tint(Palette.header)
                Text(L("Waiting for your text… this continues by itself.")).foregroundStyle(Palette.muted)
            }
            PrimaryButton(title: L("Open Messages")) { openMessages() }
            Button(L("Use a password instead")) { step = .password }.foregroundStyle(Palette.header)
        }
    }

    @ViewBuilder private var passwordStep: some View {
        SecureField(L("Password (8 or more characters)"), text: $password)
            .textContentType(.newPassword)
            .accessibilityIdentifier("password")
            .padding(12)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.divider))
        PrimaryButton(title: L("Continue"), enabled: password.count >= 8, busy: busy) { run { try await passwordSignIn() } }
        Text(L("New number? This creates your account. Already registered? It signs you in."))
            .font(.footnote).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        if mode?.mode == "otp" {
            Button(L("Send me a code by SMS instead")) { run { try await startOtp() } }.foregroundStyle(Palette.header)
        }
        if mode?.smsJoin == true {
            Button(L("Verify by sending a text instead")) { run { try await startJoin() } }.foregroundStyle(Palette.header)
        }
    }

    // MARK: actions

    private func run(_ work: @escaping () async throws -> Void) {
        Task {
            busy = true
            error = ""
            do { try await work() } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    private func loadMode() async {
        do { mode = try await session.api.authMode() } catch { self.error = error.localizedDescription }
    }

    private func startOtp() async throws {
        do {
            try await session.api.otpStart(phone: phone)
            step = .otp
            resendIn = 90
        } catch let e as APIError where (e.status == 422 || e.status == 501) && mode?.smsJoin == true {
            // The trial account cannot text this number (or OTP is off): use the JOIN text instead.
            try await startJoin()
        }
    }

    private func startJoin() async throws {
        join = try await session.api.joinStart(phone: phone)
        step = .join
        openMessages()
    }

    private func openMessages() {
        guard let j = join else { return }
        if MFMessageComposeViewController.canSendText() {
            showMessages = true
        } else if let url = URL(string: "sms:\(j.smsTo)&body=\(API.enc(j.text))") {
            UIApplication.shared.open(url)
        }
    }

    private func verifyCode() {
        run { session.signIn(try await session.api.otpVerify(phone: phone, code: code)) }
    }

    private func passwordSignIn() async throws {
        let auth: AuthResponse
        do {
            auth = try await session.api.passwordLogin(phone: phone, password: password)
        } catch let e as APIError where e.status == 401 {
            // With SMS codes on, the api never creates an account from a password (it answers "Sign up with a
            // one-time code instead."), so a 401 is a wrong password or a number without one: say that.
            if mode?.mode == "otp" { throw APIError(status: 401, message: L("Wrong password, or this number has no password yet. Use a code by SMS instead.")) }
            // A new number: create the account. A known number with a wrong password: say so.
            do {
                auth = try await session.api.passwordRegister(phone: phone, password: password)
            } catch let e2 as APIError where e2.status == 409 {
                throw APIError(status: 401, message: L("Wrong password for this number"))
            }
        }
        session.signIn(auth)
    }

    /// While waiting for the JOIN text, ask the api every 2 seconds whether it arrived.
    private func pollJoin() async {
        guard let j = join else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard let st = try? await session.api.joinStatus(code: j.code) else { continue }
            switch st.status {
            case "done":
                if let t = st.token, let u = st.user { session.signIn(AuthResponse(token: t, user: u)) }
                return
            case "expired", "used":
                error = L("The code expired. Start again.")
                join = nil
                step = .choose
                return
            default: continue
            }
        }
    }
}

/// The system Messages sheet with the JOIN text filled in; the person only taps Send.
struct MessageComposer: UIViewControllerRepresentable {
    let recipient: String
    let body: String
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let vc = MFMessageComposeViewController()
        vc.recipients = [recipient]
        vc.body = body
        vc.messageComposeDelegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: MFMessageComposeViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(dismiss: dismiss) }

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let dismiss: DismissAction
        init(dismiss: DismissAction) { self.dismiss = dismiss }
        func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            dismiss()
        }
    }
}

/// Right after the number is verified: why PhoneMail would like the contacts, then iOS's own prompt.
/// The user decides in iOS's prompt (Allow or Don't Allow); the answer is remembered and never asked again.
struct ContactsIntroView: View {
    @Environment(Session.self) private var session
    @State private var busy = false

    var body: some View {
        OnboardingPage(title: L("Find people you know"), subtitle: L("PhoneMail can use your contacts to suggest people when you write, and to show their names on your chats.")) {
            VStack(alignment: .leading, spacing: 12) {
                Label(L("Type a name to email someone; no need to remember numbers."), systemImage: "magnifyingglass")
                Label(L("Chats show the names saved in your contacts."), systemImage: "person.crop.circle")
                Label(L("Your contacts stay on this device. They are never uploaded."), systemImage: "lock")
            }
            .foregroundStyle(Palette.text)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.chipBg, in: RoundedRectangle(cornerRadius: 12))
            .padding(.top, 8)
        } footer: {
            // App Review 5.1.1(iv): the button before iOS's own prompt must not say "Allow", and there is no
            // "Not now": this screen always leads to the prompt, where the user can choose Don't Allow.
            PrimaryButton(title: L("Continue"), busy: busy) {
                Task {
                    busy = true
                    _ = await session.contacts.requestAccess()
                    busy = false
                    session.contactsAnswered()
                }
            }
        }
    }
}