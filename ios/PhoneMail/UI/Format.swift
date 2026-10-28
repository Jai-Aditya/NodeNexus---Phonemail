import Foundation

/// Longer bodies are cut in the chat; tapping opens the full (traditional) view.
let longMessage = 320

enum Format {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return withFraction.date(from: iso) ?? plain.date(from: iso)
    }

    /// WhatsApp-style list time: time today, "Yesterday", weekday within a week, otherwise dd/MM/yy.
    static func chatTime(_ iso: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let d = date(iso) else { return "" }
        if calendar.isDate(d, inSameDayAs: now) { return d.formatted(date: .omitted, time: .shortened) }
        if let y = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(d, inSameDayAs: y) { return L("Yesterday") }
        if let week = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now)), d >= week {
            return d.formatted(.dateTime.weekday(.wide))
        }
        let f = DateFormatter()
        f.dateFormat = "dd/MM/yy"
        return f.string(from: d)
    }

    /// "532 B", "14 KB", "2.4 MB" (decimal units, like the Files app; the same in every language).
    static func fileSize(_ bytes: Int64) -> String {
        let b = Double(bytes)
        func unit(_ v: Double, _ u: String) -> String {
            v < 9.95 && (v * 10).rounded() != v.rounded() * 10 ? String(format: "%.1f %@", v, u) : String(format: "%.0f %@", v.rounded(), u)
        }
        switch bytes {
        case ..<1000: return "\(bytes) B"
        case ..<1_000_000: return unit(b / 1000, "KB")
        case ..<1_000_000_000: return unit(b / 1_000_000, "MB")
        default: return unit(b / 1_000_000_000, "GB")
        }
    }

    static func bubbleTime(_ iso: String?) -> String {
        date(iso)?.formatted(date: .omitted, time: .shortened) ?? ""
    }

    static func fullTime(_ iso: String?) -> String {
        date(iso)?.formatted(date: .abbreviated, time: .shortened) ?? ""
    }

    static func initials(_ s: String) -> String {
        let name = s.split(separator: "@").first.map(String.init) ?? s
        let letters = name.split(whereSeparator: { $0.isWhitespace }).prefix(2).compactMap { $0.first }.map { String($0).uppercased() }
        return letters.isEmpty ? "#" : letters.joined()
    }

    /// Splits "a, b; c d" into addresses or numbers.
    static func splitAddresses(_ s: String) -> [String] {
        s.split(whereSeparator: { ",; \n\t".contains($0) }).map(String.init).filter { !$0.isEmpty }
    }

    /// The last 10 digits of anything that looks like an Indian mobile number, else nil.
    static func tenDigits(_ s: String) -> String? {
        let digits = s.filter(\.isNumber)
        return digits.count >= 10 ? String(digits.suffix(10)) : nil
    }
}
