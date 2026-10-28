import Foundation

/// The watch shows the language chosen in the iPhone app (sent with the sign-in), from its own
/// Localizable.xcstrings (built from l10n/strings.tsv like the iPhone's). English is the source text itself.
enum WatchLang {
    static let supported = ["en", "hi", "ta"]

    private static let lock = NSLock()
    private static var cache: (code: String, bundle: Bundle)?

    static var code: String {
        let c = UserDefaults.standard.string(forKey: "lang") ?? "en"
        return supported.contains(c) ? c : "en"
    }

    static func text(_ key: String) -> String {
        let c = code
        if c == "en" { return key }
        return bundle(c).localizedString(forKey: key, value: key, table: nil)
    }

    private static func bundle(_ code: String) -> Bundle {
        lock.lock(); defer { lock.unlock() }
        if let cache, cache.code == code { return cache.bundle }
        let b = Bundle.main.path(forResource: code, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .main
        cache = (code, b)
        return b
    }
}

/// The translation of an English source string, e.g. `L("Inbox")` (the same helper as the iPhone app's).
func L(_ key: String, _ args: CVarArg...) -> String {
    let s = WatchLang.text(key)
    return args.isEmpty ? s : String(format: s, arguments: args)
}
