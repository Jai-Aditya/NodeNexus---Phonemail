import XCTest

/// Walks through PhoneMail on the simulator against the staging api, like a person would, and saves a
/// screenshot per step to $PM_SHOTS (pass TEST_RUNNER_PM_SHOTS=/some/dir to xcodebuild).
final class WalkthroughTests: XCTestCase {
    // Staging api; build.sh walkthrough passes PM_API (default the Pi on the home LAN).
    private let api = ProcessInfo.processInfo.environment["PM_API"] ?? "http://10.28.28.33:8090/api"
    private var app: XCUIApplication!
    private var step = 0

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-uiTestReset"]
    }

    func testWholeApp() throws {
        // Fresh numbers each run: me, a peer who writes to me, and a third person for the group.
        let stamp = String(Int(Date().timeIntervalSince1970) % 100_000_000).leftPad(8)
        let me = "93" + stamp, ravi = "94" + stamp, meena = "95" + stamp
        let raviToken = try register(ravi, name: "Ravi Kumar")
        _ = try register(meena, name: "Meena Iyer")

        app.launch()

        // 1-2. Language and terms
        tap(app.buttons["Next"])
        shot("01-language-done")
        tap(app.buttons["Agree and continue"])

        // 3. Phone number
        let phone = app.textFields["phone"]
        XCTAssertTrue(phone.waitForExistence(timeout: 10))
        phone.tap()
        phone.typeText(me)
        XCTAssertTrue(app.staticTexts["Your address: \(me)@phonemail.net"].exists)
        shot("02-phone")
        tap(app.buttons["Next"])

        // 4. Verify: staging has no OTP service, so use the password route (creates the account).
        tap(app.buttons["Use a password instead"], timeout: 15)
        shot("03-verify")
        let pw = app.secureTextFields["password"]
        XCTAssertTrue(pw.waitForExistence(timeout: 5))
        pw.tap()
        pw.typeText("ios-test-pass-1")
        tap(app.buttons["Continue"])

        // 5. Home, then live mail from Ravi (Socket.IO)
        XCTAssertTrue(app.navigationBars["PhoneMail"].waitForExistence(timeout: 15))
        shot("04-home-empty")
        try send(from: raviToken, to: me, subject: "Society meeting on Sunday",
                 body: "Hi! The block B meeting moves to Sunday 10 am at the clubhouse. Can you bring the September accounts?")
        let row = app.staticTexts["Ravi Kumar"]
        XCTAssertTrue(row.waitForExistence(timeout: 20), "new mail should appear live on Home")
        shot("05-home-live")
        // Ravi also sends a file.
        let file = try upload(from: raviToken, name: "Agenda.txt", type: "text/plain",
                              data: Data("1. Water tank cleaning\n2. Parking stickers\n3. Diwali plan\n".utf8))
        try send(from: raviToken, to: me, subject: "Agenda", body: "The agenda is attached.", attachmentIds: [file])

        // 6. Chat: swipe right on the message to reply
        row.tap()
        let original = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'block B meeting'")).element(boundBy: 0)
        XCTAssertTrue(original.waitForExistence(timeout: 10))
        shot("06-chat")

        // 6b. Open the attached file (downloaded with the sign-in token, shown in Quick Look).
        let agenda = app.buttons["attachment-Agenda.txt"]
        XCTAssertTrue(agenda.waitForExistence(timeout: 15), "the attachment should show on the message")
        shot("06b-chat-attachment")
        agenda.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Water tank'")).firstMatch.waitForExistence(timeout: 15)
                      || app.textViews.firstMatch.waitForExistence(timeout: 5), "Quick Look should show the file")
        shot("06c-attachment-open")
        tap(app.buttons["QLOverlayDoneButtonAccessibilityIdentifier"], timeout: 10) // Quick Look's close button
        original.swipeRight()
        XCTAssertTrue(app.staticTexts["Replying to Ravi Kumar"].waitForExistence(timeout: 5), "swipe right should start a reply")
        let msg = app.textFields["chatMessage"].exists ? app.textFields["chatMessage"] : app.textViews["chatMessage"]
        msg.tap()
        msg.typeText("Sure, I will bring the accounts.")
        shot("07-replying")
        tap(app.buttons["Send"])
        XCTAssertTrue(app.staticTexts["Sure, I will bring the accounts."].waitForExistence(timeout: 10))
        shot("08-replied")

        // 7. Reply again: a second swipe on the same message starts another reply. First clear the keyboard (and its
        // one-time tip) and scroll back up to the original, which the reply pushed under the title bar.
        // Scroll by dragging a visible message (a swipe on the scroll view can land on the keyboard, whose
        // swipe-typing then types words), and start the swipe inside the bubble: a swipe from the screen's
        // left edge is iOS's "go back" gesture.
        if app.buttons["Continue"].exists { app.buttons["Continue"].tap() }
        let agendaText = app.staticTexts["The agenda is attached."]
        if agendaText.exists {
            let from = agendaText.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            from.press(forDuration: 0.1, thenDragTo: from.withOffset(CGVector(dx: 0, dy: 450)))
        }
        let firstMail = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'block B meeting'")).element(boundBy: 0)
        XCTAssertTrue(firstMail.waitForExistence(timeout: 5) && firstMail.isHittable, "the first email should be back in view")
        let start = firstMail.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 180, dy: 0)))
        XCTAssertTrue(app.staticTexts["Replying to Ravi Kumar"].waitForExistence(timeout: 5), "a replied email can be replied to again")
        shot("09-reply-again")
        tap(app.buttons["Cancel reply"]) // the photo below goes as a new email

        // 7b. Send a photo from the chat: paperclip -> Photos -> first photo -> Add; it uploads, then sends.
        tap(app.buttons["attach"])
        tap(app.buttons["Photos"])
        // The system picker (multi-select, "Select up to 10 items") may first show a one-time welcome banner.
        if app.buttons["Close"].waitForExistence(timeout: 5) { app.buttons["Close"].tap() }
        let photo = app.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo'")).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 15), "the photo picker should show the library")
        // The picker runs in a separate process, so XCTest can't compute a hit point: tap its position instead.
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        if app.buttons["Add"].waitForExistence(timeout: 3) { app.buttons["Add"].tap() }
        else if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        XCTAssertTrue(app.otherElements["trayChip"].firstMatch.waitForExistence(timeout: 15) || app.buttons.matching(identifier: "trayChip").firstMatch.exists)
        let msg2 = app.textFields["chatMessage"].exists ? app.textFields["chatMessage"] : app.textViews["chatMessage"]
        msg2.tap()
        msg2.typeText("Photo of the notice board")
        let send = app.buttons["Send"]
        XCTAssertTrue(send.waitForEnabled(timeout: 30), "Send is enabled once the upload finishes")
        shot("09b-photo-attached")
        send.tap()
        XCTAssertTrue(app.staticTexts["Photo of the notice board"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'attachment-Photo-'")).firstMatch.waitForExistence(timeout: 10),
                      "the sent photo should show on the message")
        shot("09c-photo-sent")

        // 8. Full message view
        app.staticTexts["Society meeting on Sunday"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["From: \(ravi)@phonemail.net"].waitForExistence(timeout: 10))
        shot("10-message-view")
        app.navigationBars.buttons.element(boundBy: 0).tap() // back to chat
        app.navigationBars.buttons.element(boundBy: 0).tap() // back to Home

        // 9. Compose to two people -> a group chat
        tap(app.buttons["Compose"], timeout: 10)
        let to = app.textFields["composeTo"]
        XCTAssertTrue(to.waitForExistence(timeout: 5))
        to.tap()
        to.typeText("\(ravi), \(meena)")
        let group = app.textFields["groupName"]
        XCTAssertTrue(group.waitForExistence(timeout: 5), "2+ people in To should offer a group")
        group.tap()
        group.typeText("Block B committee")
        let subject = app.textFields["composeSubject"]
        subject.tap()
        subject.typeText("Clubhouse booking")
        let body = app.textFields["composeBody"].exists ? app.textFields["composeBody"] : app.textViews["composeBody"]
        body.tap()
        body.typeText("Booked the clubhouse for Sunday 10 to 12.")
        shot("11-compose-group")
        tap(app.buttons["Send"])
        XCTAssertTrue(app.staticTexts["Block B committee"].waitForExistence(timeout: 15), "the group chat should be on Home")
        shot("12-home-group")

        // 10. Settings, then sign out -> back to the phone-number screen
        tap(app.buttons["Profile and settings"])
        XCTAssertTrue(app.staticTexts["\(me)@phonemail.net"].waitForExistence(timeout: 10))
        shot("13-settings")

        // 10b. Profile picture: the number bloom by default; pick a glyph.
        tap(app.buttons["pickGlyph"])
        tap(app.buttons["glyph-🐘"], timeout: 10)
        shot("13b-glyph-picker")
        tap(app.buttons["saveGlyph"])
        XCTAssertTrue(app.buttons["useBloom"].waitForExistence(timeout: 10), "a glyph replaces the bloom")
        shot("13c-glyph-saved")

        // 10c. Language: Hindi applies at once, then back to English.
        app.swipeUp()
        tap(app.buttons["languagePicker"].exists ? app.buttons["languagePicker"] : app.otherElements["languagePicker"])
        tap(app.buttons["हिन्दी (Hindi)"])
        XCTAssertTrue(app.staticTexts["प्रोफ़ाइल और सेटिंग्स"].waitForExistence(timeout: 10), "the screen should switch to Hindi")
        shot("13d-hindi")
        tap(app.buttons["languagePicker"].exists ? app.buttons["languagePicker"] : app.otherElements["languagePicker"])
        tap(app.buttons["English"])
        XCTAssertTrue(app.staticTexts["Profile and settings"].waitForExistence(timeout: 10))

        let signOut = app.buttons["Sign out"]
        app.swipeUp()
        tap(signOut)
        XCTAssertTrue(app.textFields["phone"].waitForExistence(timeout: 10), "signing out should return to sign-in")
        shot("14-signed-out")
    }

    // MARK: helpers

    private func tap(_ e: XCUIElement, timeout: TimeInterval = 5) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing: \(e)")
        e.tap()
    }

    private func shot(_ name: String) {
        step += 1
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["PM_SHOTS"] {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    private func call(_ method: String, _ path: String, _ body: [String: Any], token: String? = nil) throws -> [String: Any] {
        var req = URLRequest(url: URL(string: api + path)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("web", forHTTPHeaderField: "X-Client")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        var out: (Data?, Int) = (nil, 0)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, r, _ in
            out = (d, (r as? HTTPURLResponse)?.statusCode ?? 0)
            done.signal()
        }.resume()
        done.wait()
        guard (200..<300).contains(out.1), let d = out.0 else { throw NSError(domain: "api", code: out.1) }
        return (try JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
    }

    private func register(_ phone: String, name: String) throws -> String {
        let auth = try call("POST", "/auth/password/register", ["phone": phone, "password": "ui-test-pass-1"])
        let token = auth["token"] as! String
        _ = try call("PATCH", "/me", ["displayName": name], token: token)
        return token
    }

    private func send(from token: String, to: String, subject: String, body: String, attachmentIds: [Int64] = []) throws {
        _ = try call("POST", "/messages", ["to": [to], "subject": subject, "body": body, "attachmentIds": attachmentIds], token: token)
    }

    /// Uploads a file as `token`'s user; returns its attachment id.
    private func upload(from token: String, name: String, type: String, data: Data) throws -> Int64 {
        var req = URLRequest(url: URL(string: api + "/attachments")!)
        req.httpMethod = "POST"
        req.setValue(type, forHTTPHeaderField: "Content-Type")
        req.setValue(name, forHTTPHeaderField: "X-Filename")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = data
        var out: (Data?, Int) = (nil, 0)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { d, r, _ in
            out = (d, (r as? HTTPURLResponse)?.statusCode ?? 0)
            done.signal()
        }.resume()
        done.wait()
        guard out.1 == 201, let d = out.0, let j = try JSONSerialization.jsonObject(with: d) as? [String: Any],
              let id = (j["id"] as? NSNumber)?.int64Value else { throw NSError(domain: "upload", code: out.1) }
        return id
    }
}

private extension String {
    func leftPad(_ n: Int) -> String { String(repeating: "0", count: max(0, n - count)) + self }
}

private extension XCUIElement {
    func waitForEnabled(timeout: TimeInterval) -> Bool {
        let p = NSPredicate(format: "exists == true AND enabled == true")
        return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: self)], timeout: timeout) == .completed
    }
}
