import XCTest
@testable import PhoneMail

final class AutoReplyTests: XCTestCase {
    private func msg(_ id: Int64, mine: Bool, at: String) -> Message {
        Message(id: id, conversationId: 7, senderId: mine ? 1 : 2, senderAddress: mine ? "9000000001@phonemail.net" : "9000000322@phonemail.net",
                senderName: nil, senderAvatar: nil, subject: "", body: "Hi", parentId: nil, rootId: id, depth: 0, sentAt: at,
                hasAttachments: nil, isRead: true, isFavourite: false, isReplied: false, isMine: mine, folder: "inbox", recipients: nil)
    }

    func testRepliesToTheNewestIncomingEmail() {
        let chat = [msg(1, mine: true, at: "2026-10-18T09:00:00Z"), msg(2, mine: false, at: "2026-10-18T10:00:00Z")]
        XCTAssertEqual(AutoReply.target(chat)?.id, 2)
    }

    func testGoesByTimeNotListOrder() {
        let chat = [msg(3, mine: false, at: "2026-10-18T10:00:00.250Z"), msg(2, mine: true, at: "2026-10-18T10:00:00Z")]
        XCTAssertEqual(AutoReply.target(chat)?.id, 3)
    }

    func testNewEmailWhenTheNewestIsMine() {
        let chat = [msg(1, mine: false, at: "2026-10-18T09:00:00Z"), msg(2, mine: true, at: "2026-10-18T10:00:00Z")]
        XCTAssertNil(AutoReply.target(chat))
    }

    func testCancelledStaysCancelledUntilANewerEmail() {
        let chat = [msg(1, mine: true, at: "2026-10-18T09:00:00Z"), msg(2, mine: false, at: "2026-10-18T10:00:00Z")]
        let dismissed = AutoReply.newest(chat)?.id
        XCTAssertNil(AutoReply.target(chat, dismissed: dismissed))
        let more = chat + [msg(3, mine: false, at: "2026-10-18T11:00:00Z")]
        XCTAssertEqual(AutoReply.target(more, dismissed: dismissed)?.id, 3)
    }

    func testNothingInAnEmptyChatOrOneThatCantBeWritten() {
        XCTAssertNil(AutoReply.target([]))
        XCTAssertNil(AutoReply.target([msg(2, mine: false, at: "2026-10-18T10:00:00Z")], canWrite: false))
    }
}
