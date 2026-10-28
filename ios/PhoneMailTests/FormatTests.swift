import XCTest
@testable import PhoneMail

final class FormatTests: XCTestCase {
    func testSplitsRecipientLists() {
        XCTAssertEqual(Format.splitAddresses(" 9876543210, a@phonemail.net;9123456780 "), ["9876543210", "a@phonemail.net", "9123456780"])
        XCTAssertEqual(Format.splitAddresses(" , ; "), [])
    }

    func testTakesTheLastTenDigits() {
        XCTAssertEqual(Format.tenDigits("+91 98765 43210"), "9876543210")
        XCTAssertEqual(Format.tenDigits("09876543210"), "9876543210")
        XCTAssertNil(Format.tenDigits("12345"))
    }

    func testMakesInitials() {
        XCTAssertEqual(Format.initials("Asha Menon"), "AM")
        XCTAssertEqual(Format.initials("9884690127@phonemail.net"), "9")
        XCTAssertEqual(Format.initials(""), "#")
    }

    func testParsesApiTimes() {
        XCTAssertNotNil(Format.date("2026-09-27T09:59:00.123Z"))
        XCTAssertNotNil(Format.date("2026-09-27T15:29:00+05:30"))
        XCTAssertNil(Format.date("yesterday"))
    }

    func testDecodesAConversation() throws {
        let json = #"{"id":11,"kind":"direct","peerAddress":"9000000322@phonemail.net","peerName":"Ravi Kumar","lastMessageAt":null,"lastMessageId":null,"snippet":"Hi","unreadCount":1,"hasAttachments":false,"favouriteCount":0}"#
        let c = try JSONDecoder().decode(Conversation.self, from: Data(json.utf8))
        XCTAssertEqual(c.title, "Ravi Kumar")
        XCTAssertFalse(c.isGroup)
    }

    func testJsonBodiesLeaveOutNil() {
        let body = API.obj(["subject": "Hi", "draftId": nil as Int64?])
        XCTAssertEqual(body.count, 1)
        XCTAssertEqual(body["subject"] as? String, "Hi")
    }
}
