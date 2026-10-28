import UIKit
import XCTest
@testable import PhoneMail

/// Each style keeps the 512 x 512 square and really changes the picture (Original leaves it as it is).
final class PhotoStyleTests: XCTestCase {
    /// A test photo: a colour gradient with a dark circle and a light bar, so every style has edges and colour.
    private func sample() -> CGImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600), format: format).image { ctx in
            let c = ctx.cgContext
            let colors = [UIColor.systemTeal.cgColor, UIColor.systemOrange.cgColor] as CFArray
            let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 1])!
            c.drawLinearGradient(g, start: .zero, end: CGPoint(x: 800, y: 600), options: [])
            c.setFillColor(UIColor(white: 0.1, alpha: 1).cgColor)
            c.fillEllipse(in: CGRect(x: 250, y: 150, width: 300, height: 300))
            c.setFillColor(UIColor(white: 0.95, alpha: 1).cgColor)
            c.fill(CGRect(x: 100, y: 480, width: 600, height: 40))
            // Fine texture (like hair or fabric in a real photo): a 6 px checker in two colours over the top half.
            for y in stride(from: 0, to: 300, by: 6) {
                for x in stride(from: 100, to: 700, by: 6) where (x / 6 + y / 6) % 2 == 0 {
                    c.setFillColor((x / 6) % 3 == 0 ? UIColor.systemPurple.cgColor : UIColor.systemYellow.cgColor)
                    c.fill(CGRect(x: x, y: y, width: 6, height: 6))
                }
            }
        }.cgImage!
    }

    private func changedFraction(_ a: Pixels, _ b: Pixels) -> Double {
        var changed = 0
        for p in 0..<(a.side * a.side) {
            let i = p * 4
            if abs(Int(a.data[i]) - Int(b.data[i])) + abs(Int(a.data[i + 1]) - Int(b.data[i + 1])) + abs(Int(a.data[i + 2]) - Int(b.data[i + 2])) > 12 {
                changed += 1
            }
        }
        return Double(changed) / Double(a.side * a.side)
    }

    func testEveryStyleKeeps512AndChangesThePicture() throws {
        let data = UIImage(cgImage: sample()).pngData()!
        let square = try XCTUnwrap(AvatarPhoto.square(data))
        XCTAssertEqual(square.width, 512)
        XCTAssertEqual(square.height, 512)
        let original = Pixels(square, side: 512)
        for style in PhotoStyle.allCases {
            let out = style.apply(to: square)
            XCTAssertEqual(out.width, 512, "\(style)")
            XCTAssertEqual(out.height, 512, "\(style)")
            let changed = changedFraction(original, Pixels(out, side: 512))
            if style == .original {
                XCTAssertLessThan(changed, 0.001, "Original must not change the picture")
            } else {
                XCTAssertGreaterThan(changed, 0.05, "\(style) must change the picture (changed \(changed))")
            }
            XCTAssertNotNil(AvatarPhoto.jpeg(out), "\(style) must encode as JPEG")
        }
    }

    func testPixelMakesA20By20Grid() {
        let px = PhotoStyle.pixelate(Pixels(sample(), side: 512), cells: 20)
        // Inside one cell every pixel has the same colour.
        let cell = 512 / 20
        let first = Array(px.data[0..<4])
        for y in 0..<cell { for x in 0..<cell { XCTAssertEqual(Array(px.data[(y * 512 + x) * 4..<(y * 512 + x) * 4 + 4]), first) } }
    }

    func testOutlineIsTwoColours() {
        let px = PhotoStyle.outline(Pixels(sample(), side: 512))
        var seen = Set<UInt8>()
        for p in 0..<(512 * 512) { seen.insert(px.data[p * 4]) }
        XCTAssertEqual(seen, [0x1b, 0xfa])
    }
}
