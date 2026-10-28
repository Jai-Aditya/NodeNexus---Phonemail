// App Store "Header" artwork for PhoneMail: brand background, icon, name and tagline on the left, three real
// app screens on the right. Run on the Mac:  swift store/make-header.swift <screenshots dir> <out dir>
// Writes header-3840x1646.png (one of the two sizes App Store Connect accepts).
import AppKit

let args = CommandLine.arguments
let shots = URL(fileURLWithPath: args.count > 1 ? args[1] : NSHomeDirectory() + "/pm-shots")
let out = URL(fileURLWithPath: args.count > 2 ? args[2] : NSHomeDirectory() + "/pm-header")
let icon = URL(fileURLWithPath: NSHomeDirectory() + "/Projects/phonemail-backup/ios/PhoneMail/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func render(width: Int, height: Int) {
    let W = CGFloat(width), H = CGFloat(height)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = H / 1646 // everything is laid out for 1646 px high, then scaled

    // Brand background: PhoneMail indigo, a little lighter at the top left, with one soft glow behind the phones.
    NSGradient(colors: [rgb(0x5B4FCF), rgb(0x3A2F99), rgb(0x241D6B)])!.draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -35)
    NSGradient(colors: [rgb(0x8C82F2, 0.45), rgb(0x8C82F2, 0)])!
        .draw(in: NSBezierPath(ovalIn: NSRect(x: W - 1900 * s, y: -200 * s, width: 1700 * s, height: 2000 * s)), relativeCenterPosition: .zero)

    // Left: icon, name, tagline, three short points.
    let left = 230 * s
    if let img = NSImage(contentsOf: icon) {
        let r = NSRect(x: left, y: H - 300 * s - 260 * s, width: 260 * s, height: 260 * s)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: r, xRadius: 58 * s, yRadius: 58 * s).addClip()
        img.draw(in: r)
        NSGraphicsContext.restoreGraphicsState()
    }
    func text(_ str: String, _ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor, at y: CGFloat) {
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size * s, weight: weight), .foregroundColor: color]
        NSAttributedString(string: str, attributes: a).draw(at: NSPoint(x: left, y: y))
    }
    text("PhoneMail", 170, .bold, .white, at: H - 820 * s)
    text("Your phone number is your email address.", 76, .medium, rgb(0xECEAF4), at: H - 940 * s)
    text("Mail that reads like a chat  ·  Folders  ·  Light and dark", 58, .regular, rgb(0xC9C3F5), at: H - 1060 * s)

    // Right: three phones, the middle one larger and in front.
    let files = ["light-4-chat.png", "light-1-home.png", "dark-1-home.png"]
    let phoneH = 1340 * s, phoneW = phoneH * 1320 / 2868
    let centreX = W - 1150 * s
    let frames = [
        NSRect(x: centreX - phoneW * 1.02 - phoneW * 0.5, y: (H - phoneH * 0.9) / 2 - 20 * s, width: phoneW * 0.9, height: phoneH * 0.9),
        NSRect(x: centreX + phoneW * 0.62, y: (H - phoneH * 0.9) / 2 - 20 * s, width: phoneW * 0.9, height: phoneH * 0.9),
        NSRect(x: centreX - phoneW / 2, y: (H - phoneH) / 2, width: phoneW, height: phoneH),
    ]
    for (file, r) in [(files[0], frames[0]), (files[2], frames[1]), (files[1], frames[2])] {
        guard let img = NSImage(contentsOf: shots.appendingPathComponent(file)) else { print("missing \(file)"); continue }
        let radius = r.width * 0.13, bezel = r.width * 0.035
        let body = r.insetBy(dx: -bezel, dy: -bezel)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = rgb(0x000000, 0.45)
        shadow.shadowBlurRadius = 70 * s
        shadow.shadowOffset = NSSize(width: 0, height: -30 * s)
        shadow.set()
        rgb(0x15122A).setFill()
        NSBezierPath(roundedRect: body, xRadius: radius + bezel, yRadius: radius + bezel).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).addClip()
        img.draw(in: r)
        NSGraphicsContext.restoreGraphicsState()
    }

    NSGraphicsContext.restoreGraphicsState()
    let png = rep.representation(using: .png, properties: [:])!
    let url = out.appendingPathComponent("header-\(width)x\(height).png")
    try! png.write(to: url)
    print("wrote \(url.path)")
}

/// The "Search Results" asset (3:2): icon, name and tagline across the top, three phones rising from the bottom edge.
func renderSearch(width: Int, height: Int) {
    let W = CGFloat(width), H = CGFloat(height)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let k = W / 3840 // laid out for 3840 px wide, then scaled

    NSGradient(colors: [rgb(0x5B4FCF), rgb(0x3A2F99), rgb(0x241D6B)])!.draw(in: NSRect(x: 0, y: 0, width: W, height: H), angle: -60)
    NSGradient(colors: [rgb(0x8C82F2, 0.40), rgb(0x8C82F2, 0)])!
        .draw(in: NSBezierPath(ovalIn: NSRect(x: W * 0.15, y: -H * 0.35, width: W * 0.7, height: H * 1.0)), relativeCenterPosition: .zero)

    // Top: icon beside the name, tagline under them.
    let iconSize = 300 * k, left = 300 * k, topY = H - 170 * k - iconSize
    if let img = NSImage(contentsOf: icon) {
        let r = NSRect(x: left, y: topY, width: iconSize, height: iconSize)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: r, xRadius: 66 * k, yRadius: 66 * k).addClip()
        img.draw(in: r)
        NSGraphicsContext.restoreGraphicsState()
    }
    func text(_ str: String, _ size: CGFloat, _ weight: NSFont.Weight, _ color: NSColor, x: CGFloat, y: CGFloat) {
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size * k, weight: weight), .foregroundColor: color]
        NSAttributedString(string: str, attributes: a).draw(at: NSPoint(x: x, y: y))
    }
    text("PhoneMail", 190, .bold, .white, x: left + iconSize + 80 * k, y: topY + 60 * k)
    text("Your phone number is your email address.", 92, .medium, rgb(0xECEAF4), x: left, y: topY - 190 * k)
    text("Mail that reads like a chat  ·  Folders  ·  Light and dark", 66, .regular, rgb(0xC9C3F5), x: left, y: topY - 320 * k)

    // Bottom: three phones side by side, running off the bottom edge.
    let phoneH = H * 0.80, phoneW = phoneH * 1320 / 2868, gap = 200 * k
    let startX = (W - (3 * phoneW + 2 * gap)) / 2, phoneTop = H * 0.55
    for (i, file) in ["light-1-home.png", "light-2-menu.png", "dark-1-home.png"].enumerated() {
        guard let img = NSImage(contentsOf: shots.appendingPathComponent(file)) else { print("missing \(file)"); continue }
        let r = NSRect(x: startX + CGFloat(i) * (phoneW + gap), y: phoneTop - phoneH, width: phoneW, height: phoneH)
        let radius = r.width * 0.13, bezel = r.width * 0.035
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = rgb(0x000000, 0.45)
        shadow.shadowBlurRadius = 80 * k
        shadow.shadowOffset = NSSize(width: 0, height: -30 * k)
        shadow.set()
        rgb(0x15122A).setFill()
        NSBezierPath(roundedRect: r.insetBy(dx: -bezel, dy: -bezel), xRadius: radius + bezel, yRadius: radius + bezel).fill()
        NSGraphicsContext.restoreGraphicsState()
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius).addClip()
        img.draw(in: r)
        NSGraphicsContext.restoreGraphicsState()
    }

    NSGraphicsContext.restoreGraphicsState()
    let url = out.appendingPathComponent("search-results-\(width)x\(height).png")
    try! rep.representation(using: .png, properties: [:])!.write(to: url)
    print("wrote \(url.path)")
}

render(width: 3840, height: 1646) // Header: this wide layout suits 3840 x 1646
renderSearch(width: 3840, height: 2560) // Search Results (3:2)
