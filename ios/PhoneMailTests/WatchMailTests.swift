import XCTest
@testable import PhoneMail

/// The Apple Watch app's models and rules (Shared/WatchMail.swift, built into the iPhone app too).
final class WatchMailTests: XCTestCase {
    override func tearDown() {
        Lang.shared.set("en")
    }

    private func messages(_ json: String) throws -> [WatchMessage] {
        try WatchMail.decoder.decode(WatchPage<WatchMessage>.self, from: Data(json.utf8)).items
    }

    // As the api sends them: newest first.
    private let page = #"""
    {"items":[
      {"id":3,"sender":{"address":"9000000001@phonemail.net"},"body_text":"","is_mine":true,"parent_id":2,"subject":"Re: Dinner"},
      {"id":2,"sender":{"address":"9000000002@phonemail.net","display_name":"Asha"},"body_text":"Friday works","parent_id":1,"subject":"Re: Dinner","is_replied":true},
      {"id":1,"sender":{"address":"9000000001@phonemail.net"},"body_text":"Dinner?","subject":"Dinner","is_mine":true}
    ]}
    """#

    func testShowsMessagesOldestFirstWithSubjectsOnNewEmailsOnly() throws {
        let shown = WatchMail.shown(try messages(page))
        XCTAssertEqual(shown.map(\.id), [1, 2, 3])
        XCTAssertEqual(shown[0].shownSubject, "Dinner")
        XCTAssertNil(shown[1].shownSubject) // a reply
        XCTAssertEqual(shown[1].senderLabel, "Asha")
        XCTAssertEqual(shown[1].text, "Friday works")
    }

    func testRepliesToTheNewestEmailFromSomeoneElse() throws {
        let shown = WatchMail.shown(try messages(page))
        XCTAssertEqual(WatchMail.replyTarget(shown)?.id, 2)
        XCTAssertEqual(WatchMail.replyTarget(shown)?.isReplied, true) // replied before: it is still the one to answer
        XCTAssertNil(WatchMail.replyTarget(shown.filter(\.mine)))
    }

    func testCutsLongBodies() throws {
        let long = String(repeating: "a", count: 700)
        let shown = WatchMail.shown([WatchMessage(id: 1, bodyText: long)], limit: 600)
        XCTAssertEqual(shown[0].text.count, 601)
        XCTAssertTrue(shown[0].text.hasSuffix("…"))
    }

    func testChatTitles() throws {
        let json = #"{"items":[{"conversation_id":7,"kind":"group","name":"Family","unread_count":2},{"conversation_id":8,"kind":"direct","peer":{"address":"9000000002@phonemail.net"}}]}"#
        let chats = try WatchMail.decoder.decode(WatchPage<WatchChat>.self, from: Data(json.utf8)).items
        XCTAssertEqual(chats.map(\.title), ["Family", "9000000002@phonemail.net"])
        XCTAssertEqual(chats.map(\.unread), [2, 0])
    }

    func testQuickRepliesAreTranslated() {
        Lang.shared.set("en")
        XCTAssertEqual(WatchMail.quickReplies, ["OK", "Thanks!", "On my way", "Call you later"])
        for code in ["hi", "ta"] {
            Lang.shared.set(code)
            let q = WatchMail.quickReplies
            XCTAssertEqual(q.count, 4)
            XCTAssertTrue(zip(q, ["OK", "Thanks!", "On my way", "Call you later"]).allSatisfy { $0 != $1 }, "\(code): \(q)")
        }
    }
}
