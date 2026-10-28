import Contacts
import Foundation
import Observation

/// The phone's contacts, when the person allowed access (asked once, right after sign-up). Used to suggest
/// people in search and when writing, and to name chats whose PhoneMail user has not set a name.
@MainActor
@Observable
final class ContactsBook {
    struct Person: Identifiable, Hashable {
        let name: String
        let digits: String // last 10 digits
        var id: String { digits + name }
        var address: String { "\(digits)@\(Config.mailDomain)" }
    }

    private(set) var people: [Person] = []
    @ObservationIgnored private var byDigits: [String: String] = [:]

    static var status: CNAuthorizationStatus { CNContactStore.authorizationStatus(for: .contacts) }
    static var allowed: Bool {
        if status == .authorized { return true }
        if #available(iOS 18.0, *), status == .limited { return true }
        return false
    }

    /// Asks iOS for access (shows the system prompt the first time).
    func requestAccess() async -> Bool {
        let ok = (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
        load()
        return ok
    }

    func load() {
        guard Self.allowed else { return }
        Task.detached(priority: .utility) {
            let found = Self.fetch()
            await MainActor.run {
                self.people = found
                self.byDigits = Dictionary(found.map { ($0.digits, $0.name) }, uniquingKeysWith: { a, _ in a })
            }
        }
    }

    private nonisolated static func fetch() -> [Person] {
        let keys = [CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey, CNContactPhoneNumbersKey] as [CNKeyDescriptor]
        let req = CNContactFetchRequest(keysToFetch: keys)
        req.sortOrder = .givenName
        var out: [Person] = []
        var seen = Set<String>()
        try? CNContactStore().enumerateContacts(with: req) { c, _ in
            let name = [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " ")
            let label = name.isEmpty ? c.organizationName : name
            guard !label.isEmpty else { return }
            for n in c.phoneNumbers {
                if let d = Format.tenDigits(n.value.stringValue), seen.insert(d + label).inserted {
                    out.append(Person(name: label, digits: d))
                }
            }
        }
        return out
    }

    /// The contact's name for a PhoneMail address, if it is in the phone's contacts.
    func name(for address: String?) -> String? {
        guard let d = Bloom.digits(of: address) else { return nil }
        return byDigits[d.map(String.init).joined()]
    }

    /// Up to `limit` contacts whose name or number matches what was typed.
    func search(_ query: String, limit: Int = 5) -> [Person] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 2 else { return [] }
        let qd = q.filter(\.isNumber)
        return Array(people.lazy.filter { p in
            p.name.lowercased().contains(q) || (qd.count >= 3 && qd.count == q.count && p.digits.contains(qd))
        }.prefix(limit))
    }
}
