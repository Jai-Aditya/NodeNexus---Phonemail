import XCTest

/// The sign-in screens stay readable when the iPhone is in dark mode (the app is designed light; a typed phone
/// number once showed white on white). Run with the simulator in dark mode:
///   xcrun simctl ui <sim> appearance dark
/// The screenshot goes to $PM_SHOTS. Needs no server: it stops at the phone number.
final class DarkModeTests: XCTestCase {
    func testPhoneNumberIsReadable() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-uiTestReset"]
        app.launch()

        let next = app.buttons["Next"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        next.tap()
        let agree = app.buttons["Agree and continue"]
        XCTAssertTrue(agree.waitForExistence(timeout: 5))
        agree.tap()

        let phone = app.textFields["phone"]
        XCTAssertTrue(phone.waitForExistence(timeout: 10))
        phone.tap()
        phone.typeText("9876543210")

        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = "dark-mode-phone"
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["PM_SHOTS"] {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("dark-mode-phone.png"))
        }
    }
}
