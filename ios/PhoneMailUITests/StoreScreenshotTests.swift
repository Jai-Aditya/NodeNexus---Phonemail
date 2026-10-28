import XCTest

/// App Store screenshots: signs in to the live server as the review demo account and saves one picture per
/// screen to $PM_SHOTS, each name starting with $PM_SHOT_PREFIX (e.g. "light-" or "dark-"; the simulator's
/// appearance decides which). Needs PM_DEMO_PHONE and PM_DEMO_PASSWORD (pass them as TEST_RUNNER_PM_...).
/// Skipped unless those are set, so ordinary test runs never touch the live server.
final class StoreScreenshotTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipIf(env["PM_DEMO_PHONE"] == nil || env["PM_DEMO_PASSWORD"] == nil, "no demo account given")
        app = XCUIApplication()
    }

    func testStoreScreens() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad || wide, "iPhone screens (testIPadScreens covers iPad and wide screens)")
        signIn()
        shot("1-home")

        // The menu: every place, the user's folders, Settings.
        tap(app.buttons["Menu"])
        sleep(1)
        shot("2-menu")
        tap(app.buttons["Bills"].exists ? app.buttons["Bills"] : app.staticTexts["Bills"])
        XCTAssertTrue(app.staticTexts["Ravi Kumar"].waitForExistence(timeout: 15))
        shot("3-folder")

        reopen()
        tap(app.staticTexts["Asha Rao"], timeout: 15)
        sleep(2)
        shot("4-chat")

        reopen()
        tap(app.staticTexts["Family"], timeout: 15)
        sleep(2)
        shot("5-group")

        reopen()
        tap(app.buttons["Select"], timeout: 15)
        tap(app.staticTexts["Dev Shah"])
        tap(app.staticTexts["Family"])
        sleep(1)
        shot("6-select")

        reopen()
        tap(app.buttons["Compose"], timeout: 15)
        sleep(1)
        shot("7-compose")

        reopen()
        tap(app.buttons["Profile and settings"], timeout: 15)
        sleep(2)
        shot("8-settings")
    }

    /// iPad, landscape: the menu, the list and the open chat side by side. Also any phone that shows the same split
    /// layout, e.g. the unfolded iPhone Duo (PM_WIDE=1).
    func testIPadScreens() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad || wide, "iPad or wide screens only")
        XCUIDevice.shared.orientation = .landscapeLeft
        signIn()
        shot("ipad-1-inbox")

        tap(app.staticTexts["Asha Rao"], timeout: 15)
        sleep(2)
        shot("ipad-2-chat")

        // The sidebar (places and the user's folders) starts hidden; show it and open a folder.
        // (it may still be open from the last run)
        if app.buttons["Show Sidebar"].waitForExistence(timeout: 5) && !app.buttons["Bills"].exists && !app.staticTexts["Bills"].exists {
            app.buttons["Show Sidebar"].tap()
            sleep(1)
        }
        if wide {
            // On a wide phone (the unfolded iPhone Duo) the sidebar opens over the screen, and XCUITest doesn't see
            // the rows inside it (Xcode 27.1): show it as it is, then close it.
            sleep(1)
            shot("ipad-3-sidebar")
            if app.buttons["Hide Sidebar"].firstMatch.exists { app.buttons["Hide Sidebar"].firstMatch.tap() }
            sleep(1)
        } else {
            let bills = app.buttons["Bills"].exists ? app.buttons["Bills"] : app.staticTexts["Bills"]
            tap(bills, timeout: 10)
            tap(app.staticTexts["Ravi Kumar"], timeout: 15)
            sleep(2)
            shot("ipad-3-folder")
        }

        tap(app.buttons["Compose"].firstMatch, timeout: 10)
        sleep(2)
        shot("ipad-4-compose")
    }

    // MARK: helpers

    /// A phone showing the iPad's split layout (PM_WIDE=1), e.g. the unfolded iPhone Duo.
    private var wide: Bool { env["PM_WIDE"] == "1" }

    /// From a fresh install: language, terms, number, password, then skip the contacts step.
    private func signIn() {
        app.launchArguments = ["-uiTestReset"]
        app.launch()
        tap(app.buttons["Next"], timeout: 15)
        tap(app.buttons["Agree and continue"])
        let phone = app.textFields["phone"]
        XCTAssertTrue(phone.waitForExistence(timeout: 10))
        phone.tap()
        phone.typeText(env["PM_DEMO_PHONE"]!)
        tap(app.buttons["Next"])
        tap(app.buttons["Use a password instead"], timeout: 20)
        let pw = app.secureTextFields["password"]
        XCTAssertTrue(pw.waitForExistence(timeout: 5))
        pw.tap()
        pw.typeText(env["PM_DEMO_PASSWORD"]!)
        tap(app.buttons["Continue"])
        // The contacts screen (only with -uiTestContacts) has one Continue, then iOS's prompt: answer Don't Allow.
        if app.staticTexts["Find people you know"].waitForExistence(timeout: 10) {
            tap(app.buttons["Continue"])
            let prompt = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
            if prompt.waitForExistence(timeout: 5) { prompt.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch.tap() }
        }
        // The demo inbox's newest chat shows once Home (or the iPad's list column) has loaded.
        XCTAssertTrue(app.staticTexts["Dev Shah"].waitForExistence(timeout: 20), "Home should open after sign-in")
        sleep(2) // let the chat list and pictures load
    }

    /// Back to Home: relaunch, still signed in (the token is in the keychain).
    private func reopen() {
        app.terminate()
        app.launchArguments = ["-uiTestNoPush"] // no notifications alert over the screenshots
        app.launch()
        XCTAssertTrue(app.buttons["Compose"].waitForExistence(timeout: 20))
        sleep(2)
    }

    private func tap(_ e: XCUIElement, timeout: TimeInterval = 5) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "missing: \(e)")
        e.tap()
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = env["PM_SHOTS"] {
            let file = URL(fileURLWithPath: dir).appendingPathComponent((env["PM_SHOT_PREFIX"] ?? "") + name)
            try? png.write(to: file.appendingPathExtension("png"))
            // Devices whose test screenshots come out black (the iPhone Duo simulator in Xcode 27.1): PM_SHOT_PAUSE=<s>
            // writes <name>.ready and holds the screen still, so `simctl io screenshot` on the Mac can take it instead.
            if let pause = env["PM_SHOT_PAUSE"].flatMap(UInt32.init) {
                try? Data().write(to: file.appendingPathExtension("ready"))
                sleep(pause)
            }
        }
    }
}
