import Foundation
import Observation

/// The app's language, switchable without a restart. Every visible string goes through `L(_:)`, which
/// looks it up in Localizable.xcstrings (compiled into en/hi/ta.lproj) for the chosen language.
/// `Lang.shared` is observable, so every view that called `L` redraws when the language changes.
@Observable
final class Lang {
    static let shared = Lang()

    /// Languages with full translations. The api accepts any code; these are the ones offered.
    static let supported = ["en", "hi", "ta"]

    private(set) var code: String
    @ObservationIgnored private var bundle: Bundle

    private init() {
        let saved = UserDefaults.standard.string(forKey: "language")
        let c = saved.flatMap { Lang.supported.contains($0) ? $0 : nil } ?? "en"
        code = c
        bundle = Lang.bundle(for: c)
    }

    func set(_ c: String) {
        let c = Lang.supported.contains(c) ? c : "en"
        guard c != code else { return }
        bundle = Lang.bundle(for: c)
        code = c
    }

    func text(_ key: String) -> String {
        // Reading `code` also registers the view for a redraw when the language changes. English is the
        // source text itself (never the phone's own language).
        if code == "en" { return key }
        return bundle.localizedString(forKey: key, value: key, table: nil)
    }

    private static func bundle(for code: String) -> Bundle {
        if let p = Bundle.main.path(forResource: code, ofType: "lproj"), let b = Bundle(path: p) { return b }
        return Bundle.main
    }
}

/// The translation of an English source string, e.g. `L("Next")` or `L("Chat with %@", number)`.
func L(_ key: String, _ args: CVarArg...) -> String {
    let s = Lang.shared.text(key)
    return args.isEmpty ? s : String(format: s, arguments: args) // phone numbers stay in plain digits
}
