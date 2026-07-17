#!/bin/sh
# notarize-mac-app.sh — sign builds/Photopea.app with your Developer ID and notarize it with Apple,
# so it runs on ANY Mac with no security warning (no "move to trash", no quarantine prompt).
#
# One-time prerequisites (you have an Apple Developer account):
#   1. A "Developer ID Application" certificate in your login keychain.
#      Xcode ▸ Settings ▸ Accounts ▸ (your Apple ID) ▸ Manage Certificates ▸ + ▸ Developer ID Application
#      (or create it at developer.apple.com/account/resources/certificates and download+install it).
#   2. An app-specific password for notarytool, stored as a keychain profile (do this once):
#        xcrun notarytool store-credentials "photopea-notary" \
#            --apple-id "you@example.com" --team-id "YOURTEAMID" \
#            --password "abcd-efgh-ijkl-mnop"     # app-specific password from appleid.apple.com
#
# Run:
#   sh notarize-mac-app.sh                         # auto-detects the Developer ID identity
#   SIGN_ID="Developer ID Application: Name (TEAMID)" NOTARY_PROFILE="photopea-notary" sh notarize-mac-app.sh
#   # or without a stored profile:
#   APPLE_ID=you@ex.com TEAM_ID=XXXX APP_PASSWORD=abcd-efgh-ijkl-mnop sh notarize-mac-app.sh
set -e
cd "$(dirname "$0")"

APP="builds/Photopea.app"
[ -d "$APP" ] || { echo "ERROR: $APP not found — run 'sh make-mac-app.sh' first." >&2; exit 1; }
command -v xcrun >/dev/null 2>&1 || { echo "ERROR: Xcode command line tools required (xcrun/notarytool)." >&2; exit 1; }

# --- signing identity ---
if [ -z "$SIGN_ID" ]; then
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" | head -1 | sed -E 's/.*"(Developer ID Application: [^"]+)".*/\1/')
fi
[ -n "$SIGN_ID" ] || { echo "ERROR: no 'Developer ID Application' identity found. Set SIGN_ID=... or install the cert (see header)." >&2; exit 1; }
echo "Signing identity: $SIGN_ID"

# --- 1. sign (hardened runtime + secure timestamp; required for notarization) ---
echo "Signing $APP ..."
codesign --force --deep --options runtime --timestamp --sign "$SIGN_ID" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" && echo "  signature OK"

# --- 2. zip for submission ---
ZIP="builds/Photopea-notarize.zip"
rm -f "$ZIP"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"

# --- 3. notarize (wait for Apple's verdict) ---
echo "Submitting to Apple notary service (this can take a few minutes)..."
if [ -n "$NOTARY_PROFILE" ]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
elif [ -n "$APPLE_ID" ] && [ -n "$TEAM_ID" ] && [ -n "$APP_PASSWORD" ]; then
  xcrun notarytool submit "$ZIP" --apple-id "$APPLE_ID" --team-id "$TEAM_ID" --password "$APP_PASSWORD" --wait
else
  echo "ERROR: no notary credentials. Set NOTARY_PROFILE=... (recommended) or APPLE_ID+TEAM_ID+APP_PASSWORD (see header)." >&2
  rm -f "$ZIP"; exit 1
fi

# --- 4. staple the ticket onto the app (so it validates offline) ---
echo "Stapling ..."
xcrun stapler staple "$APP"
rm -f "$ZIP"

# --- 5. verify Gatekeeper acceptance ---
echo "Gatekeeper check:"
spctl -a -vv "$APP" 2>&1 || true

echo
echo "Done. $APP is signed + notarized — it now opens on any Mac with no warning."
echo "Distribute it (zip/dmg); the stapled ticket travels with the app."
