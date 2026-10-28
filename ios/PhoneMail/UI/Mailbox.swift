import Foundation

/// The chat lists and the actions on chats, the same as the web app's: the menu's filters and their titles,
/// what each action says when done, snooze times and folder names.
enum Mailbox {
    /// The menu's chat lists in order (the api's `filter` for each). "all" is Home (Inbox).
    static let filters = ["all", "unread", "attachments", "favorites", "snoozed", "everything", "archived"]

    static func folderFilter(_ id: Int64) -> String { "folder:\(id)" }

    /// 12 for "folder:12", else nil.
    static func folderId(_ filter: String) -> Int64? {
        guard filter.hasPrefix("folder:") else { return nil }
        return Int64(filter.dropFirst("folder:".count))
    }

    /// A list's title: "Inbox" for "all", "All mail" for "everything", a folder's own name for "folder:<id>".
    static func title(_ filter: String, folders: [MailFolder] = []) -> String {
        if let id = folderId(filter) { return folders.first { $0.id == id }?.name ?? L("Folder") }
        switch filter {
        case "unread": return L("Unread")
        case "attachments": return L("With attachments")
        case "favorites": return L("Starred")
        case "snoozed": return L("Snoozed")
        case "everything": return L("All mail")
        case "archived": return L("Archived")
        default: return L("Inbox")
        }
    }

    static func icon(_ filter: String) -> String {
        switch filter {
        case "all": return "tray"
        case "unread": return "envelope.badge"
        case "attachments": return "paperclip"
        case "favorites": return "star"
        case "snoozed": return "clock"
        case "everything": return "tray.full"
        case "archived": return "archivebox"
        default: return "folder"
        }
    }

    /// "Move to Inbox" takes Archive's place in Archived and in a folder (filed chats are archived), or when every
    /// picked chat is archived.
    static func offersUnarchive(_ picked: [Conversation], filter: String) -> Bool {
        filter == "archived" || folderId(filter) != nil || (!picked.isEmpty && picked.allSatisfy(\.isArchived))
    }

    /// What "Move to Inbox" sends: `unfile` in a folder's list (the server's unarchive leaves a chat in its folder),
    /// else `unarchive`.
    static func inboxAction(filter: String) -> String { folderId(filter) != nil ? "unfile" : "unarchive" }

    /// An action that reverses another: the action, and the folder for a move back.
    struct Step: Equatable {
        let action: String
        var folderId: Int64? = nil
    }

    /// The confirmation's Undo for `action` done in the list `filter` (for one chat: its folder's filter, or "all").
    /// Archive and snooze undo plainly; a move goes back to the folder it was made from (made anywhere else, out of
    /// folders again); chats taken out of a folder go back into it.
    static func undo(_ action: String, filter: String = "all") -> Step? {
        switch action {
        case "archive": return Step(action: "unarchive")
        case "snooze": return Step(action: "unsnooze")
        case "move": return folderId(filter).map { Step(action: "move", folderId: $0) } ?? Step(action: "unfile")
        case "unfile": return folderId(filter).map { Step(action: "move", folderId: $0) }
        default: return nil
        }
    }

    /// The short confirmation after an action on chats.
    static func done(_ action: String, until: Date? = nil, folder: String? = nil) -> String {
        switch action {
        case "archive": return L("Archived")
        case "unarchive": return L("Moved to Inbox")
        case "trash": return L("Moved to Trash")
        case "read": return L("Marked as read")
        case "unread": return L("Marked as unread")
        case "snooze": return L("Snoozed until %@", until.map { shortTime($0) } ?? "")
        case "unsnooze": return L("Unsnoozed")
        case "mute": return L("Muted")
        case "unmute": return L("Unmuted")
        case "move": return L("Moved to %@", folder ?? L("Folder"))
        case "unfile": return L("Removed from folder")
        default: return L("Done")
        }
    }

    /// A folder name as it is sent: spaces trimmed and runs of them made one. Nil when empty or longer than 40
    /// characters. Taken and built-in names (Inbox, Spam...) are refused by the server, whose message is shown.
    static func folderName(_ s: String) -> String? {
        let name = s.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return name.isEmpty || name.count > 40 ? nil : name
    }

    struct SnoozeChoice: Identifiable, Equatable {
        let id: String
        let title: String
        let date: Date
    }

    /// Later today (18:00, while still ahead), Tomorrow (08:00), This weekend (Saturday 08:00, Monday to Saturday)
    /// and Next week (Monday 08:00). A time an earlier choice already offers is left out (on a Friday, the weekend
    /// is tomorrow).
    static func snoozeChoices(now: Date = Date(), calendar: Calendar = .current) -> [SnoozeChoice] {
        let today = calendar.startOfDay(for: now)
        func at(_ days: Int, _ hour: Int) -> Date? {
            calendar.date(byAdding: .day, value: days, to: today).flatMap { calendar.date(bySettingHour: hour, minute: 0, second: 0, of: $0) }
        }
        let weekday = calendar.component(.weekday, from: today) // 1 Sunday ... 7 Saturday
        var out: [SnoozeChoice] = []
        func add(_ id: String, _ title: String, _ date: Date?) {
            guard let date, date > now, !out.contains(where: { $0.date == date }) else { return }
            out.append(SnoozeChoice(id: id, title: title, date: date))
        }
        add("later", L("Later today"), at(0, 18))
        add("tomorrow", L("Tomorrow"), at(1, 8))
        if weekday != 1 { add("weekend", L("This weekend"), at(7 - weekday, 8)) }
        let toMonday = (9 - weekday) % 7
        add("nextWeek", L("Next week"), at(toMonday == 0 ? 7 : toMonday, 8))
        return out
    }

    /// "18:00" today, "Sat 08:00" within the week ahead, else "24 Oct, 08:00" (in the phone's own format).
    static func shortTime(_ d: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(d, inSameDayAs: now) { return d.formatted(date: .omitted, time: .shortened) }
        if d > now, d < now.addingTimeInterval(6 * 86_400) { return d.formatted(.dateTime.weekday(.abbreviated).hour().minute()) }
        return d.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }
}
