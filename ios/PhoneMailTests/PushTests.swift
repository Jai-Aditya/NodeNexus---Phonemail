import SwiftUI
import UserNotifications
import XCTest
@testable import PhoneMail

final class PushTests: XCTestCase {
    /// The payload the server sends, as UNNotificationContent.userInfo has it after JSON decoding.
    private func payload(_ json: String) -> [AnyHashable: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [AnyHashable: Any]
    }

    private let server = #"{"aps":{"alert":{"title":"Asha","body":"Dinner on Friday?"},"sound":"default","thread-id":"conv-42","category":"NEW_MAIL","mutable-content":1},"conversation_id":42,"message_id":907}"#

    func testParsesTheServersPayload() {
        let p = MailPush(payload(server))
        XCTAssertEqual(p, MailPush(conversationId: 42, messageId: 907, title: "Asha", body: "Dinner on Friday?"))
    }

    func testIgnoresNotificationsThatAreNotNewMail() {
        XCTAssertNil(MailPush(payload(#"{"aps":{"alert":"Hello"}}"#)))
        XCTAssertNil(MailPush(payload(#"{"aps":{"thread-id":"conv-4"}}"#))) // no message to answer
        XCTAssertNil(MailPush([:]))
    }

    func testTakesTheChatFromTheThreadWhenItsIdIsMissing() {
        let p = MailPush(payload(#"{"aps":{"thread-id":"conv-8"},"message_id":"55"}"#))
        XCTAssertEqual(p?.conversationId, 8)
        XCTAssertEqual(p?.messageId, 55)
        XCTAssertEqual(p?.title, "")
    }

    func testRoutesEachAction() {
        XCTAssertEqual(MailPush.action(UNNotificationDefaultActionIdentifier), .open)
        XCTAssertEqual(MailPush.action("MARK_READ"), .markRead)
        XCTAssertEqual(MailPush.action("REPLY", text: "  See you then \n"), .reply("See you then"))
        XCTAssertNil(MailPush.action("REPLY", text: "   ")) // nothing typed: nothing sent
        XCTAssertNil(MailPush.action(UNNotificationDismissActionIdentifier))
    }

    func testEachActionsApiCall() throws {
        let p = MailPush(conversationId: 42, messageId: 907)
        let reply = try XCTUnwrap(p.call(for: .reply("Yes!")))
        XCTAssertEqual(reply.method, "POST")
        XCTAssertEqual(reply.path, "/mail/messages/907/reply")
        XCTAssertEqual(reply.body as NSDictionary?, ["conversation_id": 42, "body_text": "Yes!"] as NSDictionary)
        let read = try XCTUnwrap(p.call(for: .markRead))
        XCTAssertEqual(read.path, "/mail/conversations/42/read")
        XCTAssertNil(read.body)
        XCTAssertNil(p.call(for: .open))
    }

    func testForegroundPushesStayQuietOnlyInTheirOwnChat() {
        let p = MailPush(conversationId: 42, messageId: 1)
        XCTAssertFalse(MailPush.showsInForeground(p, openChat: 42))
        XCTAssertTrue(MailPush.showsInForeground(p, openChat: 7))
        XCTAssertTrue(MailPush.showsInForeground(p, openChat: nil))
        XCTAssertTrue(MailPush.showsInForeground(nil, openChat: 42)) // the app's own notices
    }

    func testDeviceTokenAsHex() {
        XCTAssertEqual(Push.hex(Data([0x00, 0x0f, 0xa0, 0xff])), "000fa0ff")
    }

    func testReadsTheApnsEnvironmentFromAProfile() {
        let profile = Data("\u{30}\u{82}garbage<plist><dict><key>Entitlements</key><dict><key>aps-environment</key>\n\t\t<string>development</string></dict></dict></plist>tail".utf8)
        XCTAssertEqual(Push.apsEnvironment(inProfile: profile), "development")
        XCTAssertNil(Push.apsEnvironment(inProfile: Data("<plist><dict></dict></plist>".utf8)))
    }

    func testLayoutFollowsTheWidth() {
        XCTAssertEqual(MainLayout.choose(.regular), .split)
        XCTAssertEqual(MainLayout.choose(.compact), .stack)
        XCTAssertEqual(MainLayout.choose(nil), .stack)
    }

    func testSplitViewRoutesWhatScreensPush() {
        let ref = ChatRef(id: 3, isGroup: false, title: "Asha", peer: "9000000001@phonemail.net")
        XCTAssertEqual(SplitTarget.of(.chat(ref), fromDetail: false), .detail(.chat(ref)))
        // An email from a list (Spam, Trash) fills the right column; from the chat there, it is pushed on it.
        XCTAssertEqual(SplitTarget.of(.message(9), fromDetail: false), .detail(.message(9)))
        XCTAssertEqual(SplitTarget.of(.message(9), fromDetail: true), .push(.message(9)))
        let reply = ComposeArgs(replyTo: 9)
        XCTAssertEqual(SplitTarget.of(.compose(reply), fromDetail: true), .compose(reply))
        XCTAssertEqual(SplitTarget.of(.settings, fromDetail: false), .settings)
        XCTAssertEqual(SplitTarget.of(.folder("spam"), fromDetail: false), .place(.folder("spam")))
        XCTAssertEqual(SplitTarget.of(.chats("folder:12"), fromDetail: false), .place(.chats("folder:12")))
    }

    // An iPad window resized between wide and narrow keeps its screens.

    func testWideToNarrowKeepsTheOpenScreens() {
        let ref = ChatRef(id: 3, isGroup: false, title: "Asha", peer: "9000000001@phonemail.net")
        let editor = ComposeArgs(conversationId: 3, replyTo: 9)
        var s = SplitState()
        s.place = .chats("folder:12")
        s.detail = .chat(ref)
        s.detailPath = [.message(9)]
        s.composing = editor
        XCTAssertEqual(s.stack, [.chats("folder:12"), .chat(ref), .message(9), .compose(editor)])
        XCTAssertEqual(SplitState().stack, []) // the Inbox is Home itself
        var settings = SplitState()
        settings.place = .folder("spam")
        settings.settings = true
        XCTAssertEqual(settings.stack, [.folder("spam"), .settings])
    }

    func testNarrowToWideKeepsTheOpenScreens() {
        let ref = ChatRef(id: 3, isGroup: false, title: "Asha", peer: "9000000001@phonemail.net")
        let editor = ComposeArgs()
        let s = SplitState(stack: [.chats("unread"), .chat(ref), .message(9), .compose(editor)])
        XCTAssertEqual(s.place, .chats("unread"))
        XCTAssertEqual(s.detail, .chat(ref))
        XCTAssertEqual(s.detailPath, [.message(9)])
        XCTAssertEqual(s.composing, editor)
        // An email from Spam fills the right column; Settings and the editor can't both be sheets (the editor wins).
        XCTAssertEqual(SplitState(stack: [.folder("spam"), .message(4)]).detail, .message(4))
        let both = SplitState(stack: [.settings, .compose(editor)])
        XCTAssertFalse(both.settings)
        XCTAssertEqual(both.composing, editor)
        // There and back again.
        let path: [Route] = [.folder("trash"), .message(4), .settings]
        XCTAssertEqual(SplitState(stack: path).stack, path)
    }

    @MainActor func testModelMovesScreensWhenTheLayoutChanges() {
        let ref = ChatRef(id: 3, isGroup: false, title: "Asha", peer: "")
        let m = MainNavModel()
        m.switchTo(.stack) // the first width: nothing to move
        m.path = [.chat(ref)]
        m.switchTo(.split)
        XCTAssertEqual(m.split.detail, .chat(ref))
        XCTAssertEqual(m.path, [])
        m.switchTo(.stack)
        XCTAssertEqual(m.path, [.chat(ref)])
    }

    func testFailedSignOutUnregisterIsKeptOnlyWhenTheServerWasNotReached() {
        XCTAssertTrue(Push.keepsPending(status: 0))   // offline
        XCTAssertTrue(Push.keepsPending(status: 503))
        XCTAssertFalse(Push.keepsPending(status: 401)) // that sign-in is gone: drop it
        XCTAssertFalse(Push.keepsPending(status: 404))
    }
}
