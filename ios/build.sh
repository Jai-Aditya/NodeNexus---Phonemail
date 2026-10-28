#!/bin/bash
# Build, test and ship the PhoneMail iOS app. Run on the Mac in ios/.
#   bash build.sh test                 unit tests on an iPhone simulator (Debug -> staging api)
#   bash build.sh walkthrough          UI walkthrough against staging; screenshots in build/shots
#   bash build.sh watch                compile the Apple Watch app on its own (for the watchOS simulator)
#   bash build.sh device TEAM_ID [free]  install a Release build (production api) on the iPhone plugged into this Mac.
#                                      Uses the app ID org.jaiaditya.phonemail.dev so a free Personal Team never
#                                      claims the real ID (the watch app gets org.jaiaditya.phonemail.dev.watchkitapp);
#                                      free-team installs stop opening after 7 days. Push needs the paid team: with a
#                                      free Personal Team add "free", which builds without the push entitlement.
#   bash build.sh testflight TEAM_ID   archive a Release build (production api) and upload it to TestFlight
# Needs Xcode, and for TestFlight an Apple Developer account signed in under Xcode > Settings > Accounts.
set -euo pipefail
cd "$(dirname "$0")"
XG="$HOME/.local/xcodegen/bin/xcodegen"
# Translations (English, Hindi, Tamil): l10n/*.tsv -> the String Catalogs; stops if a string lacks one.
python3 l10n/build-strings.py
"$XG" generate --quiet

case "${1:-test}" in
  test)
    SIM=$(xcrun simctl list devices available | grep -E '^ +iPhone' | tail -1 | grep -oE '[0-9A-F-]{36}')  # newest runtime's last iPhone
    echo "== tests on: $SIM"
    xcodebuild test -project PhoneMail.xcodeproj -scheme PhoneMail -destination "platform=iOS Simulator,id=$SIM" \
      -only-testing:PhoneMailTests -quiet
    ;;
  walkthrough)
    SIM=$(xcrun simctl list devices available | grep -E '^ +iPhone' | tail -1 | grep -oE '[0-9A-F-]{36}')  # newest runtime's last iPhone
    rm -rf build/shots && mkdir -p build/shots
    # Staging api (default: the Pi on the home LAN). Plain HTTP must be a local-network address: App Transport
    # Security blocks others (e.g. the Tailscale 100.x address), so run this with the Mac on the home network.
    PM_API=${PM_API:-http://10.28.28.33:8090/api}
    echo "== UI walkthrough on: $SIM against $PM_API"
    TEST_RUNNER_PM_SHOTS="$PWD/build/shots" TEST_RUNNER_PM_API="$PM_API" xcodebuild test -project PhoneMail.xcodeproj \
      -scheme PhoneMail -destination "platform=iOS Simulator,id=$SIM" -only-testing:PhoneMailUITests \
      PM_API_BASE="$PM_API" -quiet
    ls build/shots
    ;;
  device)
    TEAM="${2:?usage: bash build.sh device TEAM_ID}"
    # The UDID column: 00008120-001... on newer iPhones, or a 40-character hex id on older ones.
    DEV=$(xcrun devicectl list devices 2>/dev/null | grep physical | grep -iE 'iphone' | grep -oE '[0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40}' | head -1)
    [ -n "$DEV" ] || { echo "No iPhone connected: plug it in by USB, unlock it and tap Trust."; exit 1; }
    if xcrun devicectl device info ddiServices --device "$DEV" 2>&1 | grep -q 'Developer Mode is turned off'; then
      echo "Developer Mode is off on the iPhone: Settings > Privacy & Security > Developer Mode, restart, then confirm."; exit 1
    fi
    # A free Personal Team can't sign the Push Notifications capability: leave the entitlement out (no pushes).
    NOPUSH=()
    if [ "${3:-}" = "free" ]; then NOPUSH=(CODE_SIGN_ENTITLEMENTS=); echo "(free team: built without push)"; fi
    # The .dev app ID by default; PM_APP_ID=org.jaiaditya.phonemail installs under the real ID instead (paid team),
    # so the server's notifications (sent for the real ID) reach it.
    APP_ID="${PM_APP_ID:-org.jaiaditya.phonemail.dev}"
    echo "== build for device $DEV (team $TEAM, app ID $APP_ID)"
    xcodebuild build -project PhoneMail.xcodeproj -scheme PhoneMail -configuration Release \
      -destination "platform=iOS,id=$DEV" \
      -derivedDataPath build/device DEVELOPMENT_TEAM="$TEAM" PM_APP_ID="$APP_ID" ${NOPUSH[@]+"${NOPUSH[@]}"} \
      -allowProvisioningUpdates -allowProvisioningDeviceRegistration -quiet
    echo "== install"
    xcrun devicectl device install app --device "$DEV" build/device/Build/Products/Release-iphoneos/PhoneMail.app
    echo "Installed. First launch: iPhone Settings > General > VPN & Device Management > trust the developer."
    ;;
  testflight)
    TEAM="${2:?usage: bash build.sh testflight TEAM_ID}"
    rm -rf build/PhoneMail.xcarchive
    echo "== archive (Release, production api)"
    xcodebuild archive -project PhoneMail.xcodeproj -scheme PhoneMail -configuration Release \
      -destination 'generic/platform=iOS' -archivePath build/PhoneMail.xcarchive \
      DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates -quiet
    echo "== upload to App Store Connect (TestFlight)"
    cp ExportOptions.plist build/ExportOptions.plist
    /usr/libexec/PlistBuddy -c "Add :teamID string $TEAM" build/ExportOptions.plist
    xcodebuild -exportArchive -archivePath build/PhoneMail.xcarchive -exportOptionsPlist build/ExportOptions.plist \
      -exportPath build/export -allowProvisioningUpdates
    echo "Uploaded. The build shows in TestFlight after Apple's processing (usually 5-30 minutes)."
    ;;
  watch)
    # The Apple Watch app on its own (no watch simulator needed): proves it compiles.
    echo "== build the watch app"
    xcodebuild build -project PhoneMail.xcodeproj -scheme PhoneMailWatch -destination 'generic/platform=watchOS Simulator' \
      CODE_SIGNING_ALLOWED=NO -quiet
    ;;
  *) echo "usage: bash build.sh test | walkthrough | watch | device TEAM_ID [free] | testflight TEAM_ID"; exit 1 ;;
esac
