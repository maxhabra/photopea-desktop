#!/bin/sh
# release.sh — one command to build everything, sign+notarize the macOS app, zip per-platform
# assets, and publish a new GitHub Release. Targets the (private) repo.
#
#   sh release.sh <version>            e.g.  sh release.sh v1.1.0
#   REPO=owner/name NOTARY_PROFILE=photopea-notary sh release.sh v1.1.0
#
# Prereqs: python3, Xcode CLT (swiftc), gh (logged in). Notarization is used automatically if the
# keychain profile exists (see notarize-mac-app.sh); otherwise the app is left ad-hoc signed.
set -e
cd "$(dirname "$0")"

VERSION="$1"
[ -n "$VERSION" ] || { echo "Usage: sh release.sh <version>   e.g. sh release.sh v1.1.0" >&2; exit 2; }
case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo ptrinh/photopea-desktop)}"
NOTARY_PROFILE="${NOTARY_PROFILE:-photopea-notary}"

[ -d photopea.com ] || { echo "ERROR: photopea.com/ (the app source) is missing." >&2; exit 1; }
gh release view "$VERSION" --repo "$REPO" >/dev/null 2>&1 && { echo "ERROR: release $VERSION already exists on $REPO — pick a new version." >&2; exit 1; }

echo "== 1/4 build =="
python3 pack.py
sh make-mac-app.sh >/dev/null
if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  echo "== notarize (profile: $NOTARY_PROFILE) =="
  NOTARY_PROFILE="$NOTARY_PROFILE" sh notarize-mac-app.sh
else
  echo "############################################################"
  echo "# WARNING: notary profile '$NOTARY_PROFILE' not found."
  echo "# The macOS app will be AD-HOC signed only -> it shows a"
  echo "# security warning on other Macs. To notarize, run once:"
  echo "#   xcrun notarytool store-credentials \"$NOTARY_PROFILE\" \\"
  echo "#     --apple-id you@ex.com --team-id TEAMID --password app-specific-pw"
  echo "# then re-run this release (or notarize-mac-app.sh + gh release upload)."
  echo "############################################################"
  [ "$ALLOW_UNNOTARIZED" = "1" ] || { echo "Aborting. Set ALLOW_UNNOTARIZED=1 to release without notarization." >&2; exit 1; }
fi
sh make-launchers.sh >/dev/null
if [ -d node_modules/electron ]; then
  echo "== electron apps (win/linux) =="
  sh make-electron-app.sh >/dev/null
else
  echo "WARNING: node_modules/electron missing — skipping standalone Windows/Linux apps (run 'npm install' to include them)."
fi

echo "== 2/4 package =="
REL="builds/_rel"
rm -rf "$REL"; mkdir -p "$REL/_w" "$REL/_l"
cp builds/photopea-offline.html "$REL/"
/usr/bin/ditto -c -k --keepParent builds/Photopea.app "$REL/Photopea-macos.zip"
cp builds/Photopea.bat builds/Install-OpenWith-Windows.bat builds/Uninstall-OpenWith-Windows.bat builds/photopea-offline.html "$REL/_w/"; /usr/bin/ditto -c -k "$REL/_w" "$REL/Photopea-windows.zip"
cp builds/photopea.sh builds/Photopea.desktop builds/install-openwith-linux.sh builds/photopea-icon.png builds/photopea-offline.html "$REL/_l/"; /usr/bin/ditto -c -k "$REL/_l" "$REL/Photopea-linux.zip"
rm -rf "$REL/_w" "$REL/_l"
EXTRA_ASSETS=""
[ -f builds/Photopea-windows-app.zip ] && { cp builds/Photopea-windows-app.zip "$REL/"; EXTRA_ASSETS="$EXTRA_ASSETS $REL/Photopea-windows-app.zip"; }
[ -f builds/Photopea-linux-app.zip ]   && { cp builds/Photopea-linux-app.zip "$REL/";   EXTRA_ASSETS="$EXTRA_ASSETS $REL/Photopea-linux-app.zip"; }

echo "== 3/4 verify macOS app =="
spctl -a -vv builds/Photopea.app 2>&1 | head -2 || true

echo "== 4/4 publish release $VERSION -> $REPO =="
gh release create "$VERSION" \
  "$REL/photopea-offline.html" "$REL/Photopea-macos.zip" "$REL/Photopea-windows.zip" "$REL/Photopea-linux.zip" $EXTRA_ASSETS \
  --repo "$REPO" --title "Photopea Desktop $VERSION" \
  --notes "Offline Photopea / Vectorpea / Jampea (top-bar toggle), all 50 UI languages bundled. Private release, internal use.

Assets: photopea-offline.html (single file, any browser) · Photopea-macos.zip (native app) · Photopea-windows.zip (Photopea.bat + html) · Photopea-linux.zip (photopea.sh + .desktop + html) · Photopea-windows-app.zip / Photopea-linux-app.zip (standalone Electron apps, no Chrome needed, raised memory ceiling)."

rm -rf "$REL"
echo "Done: https://github.com/$REPO/releases/tag/$VERSION"
