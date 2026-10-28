import XCTest
@testable import PhoneMail

/// The number bloom must look the same on every client, so its maths is pinned here.
final class BloomTests: XCTestCase {
    private let jai = [9, 8, 8, 4, 6, 9, 0, 1, 2, 7] // 9884690127

    func testReadsDigitsOnlyFromPhoneMailNumbers() {
        XCTAssertEqual(Bloom.digits(of: "9884690127@phonemail.net"), jai)
        XCTAssertEqual(Bloom.digits(of: "9884690127@PhoneMail.Net"), jai)
        XCTAssertEqual(Bloom.digits(of: "9884690127@jaiaditya.org"), jai) // the prototype's domain
        XCTAssertNil(Bloom.digits(of: "9884690127@gmail.com"))              // outside people get initials
        XCTAssertNil(Bloom.digits(of: "asha@phonemail.net"))
        XCTAssertNil(Bloom.digits(of: "98846901@phonemail.net"))
        XCTAssertNil(Bloom.digits(of: nil))
    }

    func testHue() {
        // (54 x 37 + 127) mod 360 = 2125 mod 360 = 325
        XCTAssertEqual(Bloom.hue(jai), 325)
        XCTAssertEqual(Bloom.hue([Int](repeating: 0, count: 10)), 0)
        XCTAssertEqual(Bloom.hue([Int](repeating: 9, count: 10)), (90 * 37 + 9999) % 360)
    }

    func testPetals() {
        let p = Bloom.petals(jai)
        XCTAssertEqual(p.count, 10)
        XCTAssertEqual(p[0].angle, 0)
        XCTAssertEqual(p[0].inner, 0.22, accuracy: 1e-9)
        XCTAssertEqual(p[0].outer, 0.91, accuracy: 1e-9)
        XCTAssertEqual(p[0].width, 0.22, accuracy: 1e-9)
        XCTAssertEqual(p[0].opacity, 0.935, accuracy: 1e-9)
        XCTAssertEqual(p[6].angle, 216)
        XCTAssertEqual(p[6].outer, 0.46, accuracy: 1e-9)   // a 0 still shows beyond the centre disc
        XCTAssertGreaterThan(p[6].outer, Bloom.disc)
        XCTAssertEqual(p[6].opacity, 0.35, accuracy: 1e-9)
        XCTAssertEqual(p[9].outer, 0.46 + 0.35, accuracy: 1e-9)
        XCTAssertEqual(Bloom.disc, 0.26)
    }

    func testHslToRgb() {
        func near(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Bool {
            abs(a.0 - b.0) < 1e-9 && abs(a.1 - b.1) < 1e-9 && abs(a.2 - b.2) < 1e-9
        }
        XCTAssertTrue(near(Bloom.rgb(h: 0, s: 1, l: 0.5), (1, 0, 0)))
        XCTAssertTrue(near(Bloom.rgb(h: 120, s: 1, l: 0.5), (0, 1, 0)))
        XCTAssertTrue(near(Bloom.rgb(h: 240, s: 1, l: 0.5), (0, 0, 1)))
        XCTAssertTrue(near(Bloom.rgb(h: 360, s: 1, l: 0.5), (1, 0, 0)))
        let (r, g, b) = Bloom.rgb(h: 325, s: 0.55, l: 0.42)
        XCTAssertEqual(r, 0.651, accuracy: 0.001)
        XCTAssertEqual(g, 0.189, accuracy: 0.001)
        XCTAssertEqual(b, 0.459, accuracy: 0.001)
    }

    func testCentreText() {
        XCTAssertEqual(Bloom.centre(name: "Jai Aditya", digits: jai), "JA")
        XCTAssertEqual(Bloom.centre(name: nil, digits: jai), "27")
        XCTAssertEqual(Bloom.centre(name: "9884690127@phonemail.net", digits: jai), "27")
    }

    func testParsesAvatarValues() {
        XCTAssertEqual(AvatarValue(nil), .bloom)
        XCTAssertEqual(AvatarValue("glyph:🦚:#008069"), .glyph("🦚", "#008069"))
        XCTAssertEqual(AvatarValue("photo:0123456789abcdef0123456789abcdef.jpg"), .photo("0123456789abcdef0123456789abcdef.jpg"))
        XCTAssertEqual(AvatarValue("something else"), .bloom)
    }

    func testFileSizes() {
        XCTAssertEqual(Format.fileSize(532), "532 B")
        XCTAssertEqual(Format.fileSize(999), "999 B")
        XCTAssertEqual(Format.fileSize(1_500), "1.5 KB")
        XCTAssertEqual(Format.fileSize(5_000), "5 KB")
        XCTAssertEqual(Format.fileSize(14_000), "14 KB")
        XCTAssertEqual(Format.fileSize(2_400_000), "2.4 MB")
        XCTAssertEqual(Format.fileSize(26_214_400), "26 MB")
        XCTAssertEqual(Format.fileSize(1_000_000_000), "1 GB")
    }

    func testTranslationsSwitchAtOnce() {
        defer { Lang.shared.set("en") }
        Lang.shared.set("hi")
        XCTAssertEqual(L("Next"), "आगे")
        XCTAssertEqual(L("Chat with %@", "9884690127"), "9884690127 से चैट करें")
        Lang.shared.set("ta")
        XCTAssertEqual(L("Next"), "அடுத்து")
        XCTAssertEqual(L("At most %lld files per email.", 20), "ஒரு மின்னஞ்சலில் அதிகபட்சம் 20 கோப்புகள்.")
        Lang.shared.set("en")
        XCTAssertEqual(L("Next"), "Next")
        XCTAssertEqual(L("A string with no translation"), "A string with no translation")
    }

    func testDecodesAttachmentsAndAvatars() throws {
        let json = #"{"id":5,"conversationId":2,"senderId":7,"senderAddress":"9884690127@phonemail.net","senderAvatar":"glyph:🦚:#008069","subject":"Minutes","body":"","rootId":5,"depth":0,"sentAt":"2026-09-29T09:00:00Z","hasAttachments":true,"isRead":true,"isFavourite":false,"isReplied":false,"isMine":false,"folder":"inbox","attachments":[{"id":3,"filename":"Minutes.pdf","contentType":"application/pdf","size":16}]}"#
        let m = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(m.attachments?.first?.filename, "Minutes.pdf")
        XCTAssertEqual(m.senderAvatar, "glyph:🦚:#008069")
        XCTAssertFalse(m.attachments?.first?.isImage ?? true)
    }
}
