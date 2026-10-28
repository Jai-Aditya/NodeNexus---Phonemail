import XCTest
@testable import PhoneMail

final class MailboxTests: XCTestCase {
    override func setUp() {
        Lang.shared.set("en") // titles are checked in English
    }

    private var utc: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }

    private func at(_ iso: String) -> Date { Format.date(iso)! }

    private func chat(_ id: Int64, archived: Bool? = nil) -> Conversation {
        Conversation(id: id, kind: "direct", name: nil, peerAddress: "9000000322@phonemail.net", peerName: nil, lastMessageAt: nil,
                     lastMessageId: nil, snippet: "", unreadCount: 0, hasAttachments: false, favouriteCount: 0, archived: archived)
    }

    // 14 Oct 2026 is a Wednesday, 16 a Friday, 17 a Saturday, 18 a Sunday, 19 a Monday.

    func testSnoozeChoicesOnAWeekdayMorning() {
        let s = Mailbox.snoozeChoices(now: at("2026-10-14T10:00:00Z"), calendar: utc)
        XCTAssertEqual(s.map(\.id), ["later", "tomorrow", "weekend", "nextWeek"])
        XCTAssertEqual(s.map(\.date), [at("2026-10-14T18:00:00Z"), at("2026-10-15T08:00:00Z"), at("2026-10-17T08:00:00Z"), at("2026-10-19T08:00:00Z")])
    }

    func testNoLaterTodayAfterSix() {
        let s = Mailbox.snoozeChoices(now: at("2026-10-14T19:00:00Z"), calendar: utc)
        XCTAssertEqual(s.map(\.id), ["tomorrow", "weekend", "nextWeek"])
    }

    func testFridaysWeekendIsTomorrow() {
        let s = Mailbox.snoozeChoices(now: at("2026-10-16T10:00:00Z"), calendar: utc)
        XCTAssertEqual(s.map(\.id), ["later", "tomorrow", "nextWeek"])
        XCTAssertEqual(s[1].date, at("2026-10-17T08:00:00Z"))
    }

    func testSundayHasNoWeekendAndMondayIsTomorrow() {
        let s = Mailbox.snoozeChoices(now: at("2026-10-18T10:00:00Z"), calendar: utc)
        XCTAssertEqual(s.map(\.id), ["later", "tomorrow"])
        XCTAssertEqual(s[1].date, at("2026-10-19T08:00:00Z"))
    }

    func testMondaysNextWeekIsSevenDaysOn() {
        let s = Mailbox.snoozeChoices(now: at("2026-10-19T09:00:00Z"), calendar: utc)
        XCTAssertEqual(s.last?.id, "nextWeek")
        XCTAssertEqual(s.last?.date, at("2026-10-26T08:00:00Z"))
    }

    func testCleansFolderNames() {
        XCTAssertEqual(Mailbox.folderName("  Tax   papers \n"), "Tax papers")
        XCTAssertNil(Mailbox.folderName("   "))
        XCTAssertEqual(Mailbox.folderName(String(repeating: "a", count: 40))?.count, 40)
        XCTAssertNil(Mailbox.folderName(String(repeating: "a", count: 41)))
    }

    func testFilterTitles() {
        let folders = [MailFolder(id: 12, name: "Tax papers", chatCount: 3, unreadCount: 1)]
        XCTAssertEqual(Mailbox.title("all"), "Inbox")
        XCTAssertEqual(Mailbox.title("favorites"), "Starred")
        XCTAssertEqual(Mailbox.title("attachments"), "With attachments")
        XCTAssertEqual(Mailbox.title("everything"), "All mail")
        XCTAssertEqual(Mailbox.title("folder:12", folders: folders), "Tax papers")
        XCTAssertEqual(Mailbox.title("folder:99", folders: folders), "Folder")
        XCTAssertEqual(Mailbox.folderId(Mailbox.folderFilter(12)), 12)
        XCTAssertNil(Mailbox.folderId("archived"))
    }

    func testMoveToInboxWhenEveryPickedChatIsArchived() {
        XCTAssertFalse(Mailbox.offersUnarchive([chat(1), chat(2, archived: true)], filter: "everything"))
        XCTAssertTrue(Mailbox.offersUnarchive([chat(1, archived: true), chat(2, archived: true)], filter: "everything"))
        XCTAssertTrue(Mailbox.offersUnarchive([], filter: "archived"))
        XCTAssertTrue(Mailbox.offersUnarchive([chat(1)], filter: "folder:3"))
        XCTAssertFalse(Mailbox.offersUnarchive([], filter: "all"))
    }

    func testMoveToInboxFromAFolderTakesChatsOutOfIt() {
        XCTAssertEqual(Mailbox.inboxAction(filter: "folder:3"), "unfile") // unarchive would leave them in the folder
        XCTAssertEqual(Mailbox.inboxAction(filter: "archived"), "unarchive")
        XCTAssertEqual(Mailbox.inboxAction(filter: "everything"), "unarchive")
    }

    func testUndoReversesEachAction() {
        XCTAssertEqual(Mailbox.undo("archive"), .init(action: "unarchive"))
        XCTAssertEqual(Mailbox.undo("snooze", filter: "folder:3"), .init(action: "unsnooze"))
        XCTAssertNil(Mailbox.undo("trash"))
        XCTAssertNil(Mailbox.undo("read"))
        // A move from Home (or any list that isn't a folder) is undone by taking the chats out of folders...
        XCTAssertEqual(Mailbox.undo("move"), .init(action: "unfile"))
        XCTAssertEqual(Mailbox.undo("move", filter: "everything"), .init(action: "unfile"))
        // ...and from folder 3 (to another folder) by moving them back to 3.
        XCTAssertEqual(Mailbox.undo("move", filter: "folder:3"), .init(action: "move", folderId: 3))
        // Taking chats out of folder 3 is undone by moving them back in; elsewhere there is no folder to go back to.
        XCTAssertEqual(Mailbox.undo("unfile", filter: "folder:3"), .init(action: "move", folderId: 3))
        XCTAssertNil(Mailbox.undo("unfile"))
    }

    func testConfirmations() {
        XCTAssertEqual(Mailbox.done("move", folder: "Tax papers"), "Moved to Tax papers")
        XCTAssertEqual(Mailbox.done("unarchive"), "Moved to Inbox")
    }

    func testDecodesAChatRowWithItsState() throws {
        let json = #"{"conversation_id":7,"kind":"group","name":"Family","member_count":4,"unread_count":2,"archived":true,"muted":true,"snoozed_until":"2999-01-01T08:00:00Z","folder_id":12}"#
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let w = try d.decode(WChat.self, from: Data(json.utf8))
        XCTAssertEqual(w.folderId, 12)
        XCTAssertEqual(w.memberCount, 4)
        XCTAssertEqual(w.archived, true)
        let c = Conversation(id: w.conversationId, kind: w.kind, name: w.name, peerAddress: nil, peerName: nil, lastMessageAt: nil,
                             lastMessageId: nil, snippet: "", unreadCount: w.unreadCount ?? 0, hasAttachments: false, favouriteCount: 0,
                             archived: w.archived, muted: w.muted, snoozedUntil: w.snoozedUntil, folderId: w.folderId)
        XCTAssertTrue(c.isArchived && c.isMuted && c.isSnoozed())
    }
}
