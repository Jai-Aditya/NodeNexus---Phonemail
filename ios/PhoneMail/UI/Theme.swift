import SwiftUI
import UIKit

/// WhatsApp's layout (brief: "every screen should follow WhatsApp's design language") in PhoneMail's colours:
/// indigo, with Pip's orange as the accent, the same as the web app at mail.phonemail.net. Every colour has a
/// light and a dark value (the web app's dark palette), so each screen follows Settings > Appearance.
enum Palette {
    static let header = Color(light: 0x4B3FB0, dark: 0x8C82F2)       // indigo app bar, links, buttons
    static let onHeader = Color(light: 0xFFFFFF, dark: 0x121019)     // text and icons on the indigo
    static let accent = Color(hex: 0xF2A33A)                         // compose button, unread badge (Pip's orange)
    static let onAccent = Color(hex: 0x3B2500)                       // text and icons on the orange
    static let background = Color(light: 0xFFFFFF, dark: 0x121019)   // screens and lists
    static let field = Color(light: 0xFFFFFF, dark: 0x221E2D)        // text fields and cards on the chat wallpaper
    static let chatBg = Color(light: 0xEFECF7, dark: 0x0E0C14)       // chat wallpaper
    static let bubbleMine = Color(light: 0xE1DCFA, dark: 0x3A3370)
    static let bubbleTheirs = Color(light: 0xFFFFFF, dark: 0x221E2D)
    static let text = Color(light: 0x1F1C33, dark: 0xECEAF4)
    static let muted = Color(light: 0x6B6680, dark: 0xA49FB8)
    static let divider = Color(light: 0xE4DFD4, dark: 0x332E42)
    static let chipBg = Color(light: 0xF1EEE7, dark: 0x221E2D)
    static let chipOnBg = Color(light: 0xECEAFB, dark: 0x2E2856)
    static let danger = Color(light: 0xEA0038, dark: 0xFF5C7A)
    static let star = Color(light: 0xF5B400, dark: 0xFFC93D)
    static let notice = Color(light: 0xFDF0DC, dark: 0x3A2E1A)
    static let groupAvatar = Color(light: 0xDFE5E7, dark: 0x3A3548) // a group's picture, behind the people icon
    static let toast = Color(light: 0x1F1C33, dark: 0xECEAF4)       // short confirmations (the reverse of the screen)
    static let onToast = Color(light: 0xFFFFFF, dark: 0x121019)
    static let toastAction = Color(light: 0xC9C2FF, dark: 0x4B3FB0) // Undo on a confirmation
}

/// Light or dark: the iPhone's own setting (the default), or always one of them. Kept on the phone.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return L("System")
        case .light: return L("Light")
        case .dark: return L("Dark")
        }
    }

    var style: UIUserInterfaceStyle {
        switch self {
        case .system: return .unspecified
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// Applies to the app's windows at once, sheets included (the palette's colours follow the window's style).
    @MainActor func apply() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for window in scene.windows { window.overrideUserInterfaceStyle = style }
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// One colour in light mode and another in dark mode.
    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
