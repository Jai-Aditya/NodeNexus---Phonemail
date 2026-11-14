import Foundation
import LocalAuthentication
import Security

/// Sign in with Face ID, Touch ID or Optic ID, when the person turns it on: the account's password is kept in the
/// Keychain behind the device's biometrics (this device only; iOS drops it when a face or finger is added). The
/// number is kept in UserDefaults, so the phone screen can offer it without asking for biometrics first.
/// One account per device: turning it on for another number replaces the first.
enum Biometric {
    private static let service = "org.jaiaditya.phonemail.biometric"
    private static let phoneKey = "biometricPhone"

    /// "Face ID", "Touch ID" or "Optic ID"; nil when the device has none set up.
    static var name: String? {
        let c = LAContext()
        guard c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
        switch c.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return nil
        }
    }

    static var symbol: String {
        switch LAContext().biometryType {
        case .touchID: "touchid"
        case .opticID: "opticid"
        default: "faceid"
        }
    }

    /// The phone screen offers Face ID by itself once, when the app opens signed out; not again that run, and not after
    /// a sign-in (so signing out never pops it up straight away). Set by Session.signIn.
    @MainActor static var offered = false

    /// The number whose password is saved, if any.
    static var phone: String? { UserDefaults.standard.string(forKey: phoneKey) }

    /// Checks the face or finger once (iOS asks for permission the first time), then saves the password.
    /// False when the person cancels or the device can't.
    static func save(phone: String, password: String) async -> Bool {
        let ctx = LAContext()
        let ok = (try? await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics,
                                                 localizedReason: L("Sign in to PhoneMail as +91 %@", phone))) ?? false
        guard ok, let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
                                                               .biometryCurrentSet, nil) else { return false }
        forget()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: phone,
            kSecValueData as String: Data(password.utf8),
            kSecAttrAccessControl as String: access,
            kSecUseAuthenticationContext as String: ctx,
        ]
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return false }
        UserDefaults.standard.set(phone, forKey: phoneKey)
        return true
    }

    /// The saved password, after the face or finger matches. Nil when cancelled; when iOS has dropped it (the
    /// biometrics changed) it is forgotten here too.
    static func password() async -> String? {
        guard let phone else { return nil }
        let reason = L("Sign in to PhoneMail as +91 %@", phone)
        // SecItemCopyMatching waits for the face or finger, so it runs off the main thread.
        let (status, data) = await Task.detached { () -> (OSStatus, Data?) in
            let ctx = LAContext()
            ctx.localizedReason = reason
            let q: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: phone,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
                kSecUseAuthenticationContext as String: ctx,
            ]
            var out: AnyObject?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            return (status, out as? Data)
        }.value
        if status == errSecSuccess, let data { return String(data: data, encoding: .utf8) }
        if status != errSecUserCanceled { forget() }
        return nil
    }

    static func forget() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        UserDefaults.standard.removeObject(forKey: phoneKey)
    }
}
