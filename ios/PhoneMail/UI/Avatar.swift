import SwiftUI

/// The default profile picture, the "number bloom": drawn the same way on every PhoneMail client from the
/// 10 digits of a phone number, so no two numbers bloom alike.
///  - hue H = (sum of digits x 37 + the last 4 digits as a number) mod 360; background hsl(H, 55%, 42%)
///  - 10 petals, one per digit, at i x 36 degrees clockwise from the top, each an ellipse along its ray
///    from 0.22r out to r(0.46 + 0.05d), width 0.22r, white at opacity 0.35 + 0.065d
///  - drawn over the petals, a centre disc of radius 0.26r in hsl(H, 55%, 30%) with the initials
///    (or the last two digits)
enum Bloom {
    /// The 10 digits of a PhoneMail address (`9884690127@phonemail.net`), else nil (people outside PhoneMail).
    static func digits(of address: String?) -> [Int]? {
        guard let address else { return nil }
        let parts = address.lowercased().split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2, parts[0].count == 10, parts[0].allSatisfy(\.isNumber),
              [Config.mailDomain, "jaiaditya.org"].contains(parts[1]) else { return nil }
        return parts[0].compactMap(\.wholeNumberValue)
    }

    static func hue(_ d: [Int]) -> Int {
        let last4 = d.suffix(4).reduce(0) { $0 * 10 + $1 }
        return (d.reduce(0, +) * 37 + last4) % 360
    }

    /// Radius of the centre disc and where every petal starts, as fractions of the radius.
    static let disc = 0.26
    static let petalStart = 0.22

    struct Petal: Equatable {
        let angle: Double   // degrees clockwise from the top
        let inner: Double   // fractions of the radius, measured from the centre along the ray
        let outer: Double
        let width: Double
        let opacity: Double
    }

    static func petals(_ d: [Int]) -> [Petal] {
        d.prefix(10).enumerated().map { i, v in
            Petal(angle: Double(i) * 36, inner: petalStart, outer: 0.46 + 0.05 * Double(v), width: 0.22, opacity: 0.35 + 0.065 * Double(v))
        }
    }

    /// hsl (degrees, 0-1, 0-1) to rgb (0-1 each).
    static func rgb(h: Double, s: Double, l: Double) -> (Double, Double, Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r, g, b): (Double, Double, Double)
        switch hp {
        case ..<1: (r, g, b) = (c, x, 0)
        case ..<2: (r, g, b) = (x, c, 0)
        case ..<3: (r, g, b) = (0, c, x)
        case ..<4: (r, g, b) = (0, x, c)
        case ..<5: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        let m = l - c / 2
        return (r + m, g + m, b + m)
    }

    static func color(h: Int, l: Double) -> Color {
        let (r, g, b) = rgb(h: Double(h), s: 0.55, l: l)
        return Color(red: r, green: g, blue: b)
    }

    /// Centre text: 1-2 initials of the name, or the last two digits when there is no name.
    static func centre(name: String?, digits d: [Int]) -> String {
        if let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty, !n.contains("@") {
            let i = Format.initials(n)
            if i != "#" { return i }
        }
        return d.suffix(2).map(String.init).joined()
    }
}

/// Parses an avatar value from the api.
enum AvatarValue: Equatable {
    case bloom
    case glyph(String, String) // emoji, #rrggbb
    case photo(String)         // file name

    init(_ raw: String?) {
        guard let raw, !raw.isEmpty else { self = .bloom; return }
        if raw.hasPrefix("photo:") {
            self = .photo(String(raw.dropFirst(6)))
        } else if raw.hasPrefix("glyph:") {
            let rest = raw.dropFirst(6)
            if let i = rest.lastIndex(of: ":") {
                self = .glyph(String(rest[..<i]), String(rest[rest.index(after: i)...]))
            } else {
                self = .bloom
            }
        } else {
            self = .bloom
        }
    }
}

extension Color {
    /// "#rrggbb" to a colour (grey if unreadable).
    init(hexString: String) {
        let h = hexString.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        self.init(hex: UInt32(h, radix: 16) ?? 0x667781)
    }
}

/// A round profile picture. People: their photo or glyph if they chose one, else the number bloom (PhoneMail
/// numbers) or initials (people outside PhoneMail). Groups: a group icon.
struct Avatar: View {
    let label: String
    var group = false
    var size: CGFloat = 48
    /// The person's address (the bloom needs the digits).
    var address: String? = nil
    /// The api's avatar value.
    var avatar: String? = nil
    /// The display name, for the initials in the bloom.
    var name: String? = nil

    var body: some View {
        content
            .frame(width: size, height: size)
            .clipShape(Circle())
            .accessibilityHidden(true)
    }

    @ViewBuilder private var content: some View {
        if group {
            ZStack {
                Circle().fill(Palette.groupAvatar)
                Image(systemName: "person.2.fill").font(.system(size: size * 0.38)).foregroundStyle(.white)
            }
        } else {
            switch AvatarValue(avatar) {
            case .glyph(let emoji, let hex):
                ZStack {
                    Circle().fill(Color(hexString: hex))
                    Text(emoji).font(.system(size: size * 0.55))
                }
            case .photo(let name):
                AsyncImage(url: Session.photoURL(name)) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() } else { fallback }
                }
            case .bloom:
                fallback
            }
        }
    }

    @ViewBuilder private var fallback: some View {
        if let d = Bloom.digits(of: address) {
            NumberBloom(digits: d, centre: Bloom.centre(name: name, digits: d), size: size)
        } else {
            Initials(label: label, size: size)
        }
    }
}

struct NumberBloom: View {
    let digits: [Int]
    let centre: String
    let size: CGFloat

    var body: some View {
        let h = Bloom.hue(digits)
        ZStack {
            Canvas { ctx, sz in
                let r = min(sz.width, sz.height) / 2
                let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)), with: .color(Bloom.color(h: h, l: 0.42)))
                for p in Bloom.petals(digits) {
                    // An ellipse lying along the ray, from `inner` out to `outer`.
                    let w = r * p.width
                    var t = ctx
                    t.translateBy(x: c.x, y: c.y)
                    t.rotate(by: .degrees(p.angle - 90))
                    t.fill(Path(ellipseIn: CGRect(x: r * p.inner, y: -w / 2, width: r * (p.outer - p.inner), height: w)),
                           with: .color(.white.opacity(p.opacity)))
                }
                let cr = r * Bloom.disc
                ctx.fill(Path(ellipseIn: CGRect(x: c.x - cr, y: c.y - cr, width: 2 * cr, height: 2 * cr)), with: .color(Bloom.color(h: h, l: 0.30)))
            }
            Text(centre)
                .font(.system(size: size * (centre.count > 1 ? 0.17 : 0.20), weight: .bold))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.5)
                .frame(width: size * 0.46)
        }
        .frame(width: size, height: size)
    }
}

private let initialsColors: [Color] = [
    Color(hex: 0x0B8A7A), Color(hex: 0x7B61FF), Color(hex: 0xE66A2C), Color(hex: 0xD6336C),
    Color(hex: 0x1E88E5), Color(hex: 0x6D8B2F), Color(hex: 0x8E5A3C), Color(hex: 0x00838F),
]

/// Initials on a colour taken from the name (people outside PhoneMail).
private struct Initials: View {
    let label: String
    let size: CGFloat

    var body: some View {
        let idx = abs(label.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }) % initialsColors.count
        ZStack {
            Circle().fill(initialsColors[idx])
            Text(Format.initials(label)).font(.system(size: size * 0.36, weight: .semibold)).foregroundStyle(.white)
        }
    }
}
