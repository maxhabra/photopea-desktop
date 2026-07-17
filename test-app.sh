#!/bin/sh
# test-app.sh — verify the native macOS app actually opens a VISIBLE window.
# Guards against regressions like a bad WKPreferences key that throws in
# applicationDidFinishLaunching and aborts window creation (app runs, no window).
#
# Uses CGWindowList (on-screen window list) — reliable, no Accessibility permission needed
# (unlike System Events, whose "count of windows" silently fails without it).
#
#   sh test-app.sh            # builds/Photopea.app
set -e
cd "$(dirname "$0")"

APP="${1:-builds/Photopea.app}"
NAME="$(basename "$APP" .app)"
[ -d "$APP" ] || { echo "ERROR: $APP not found — run 'sh make-mac-app.sh' first." >&2; exit 1; }

# compile the on-screen window counter (fast)
BIN="test/winlist"
swiftc -O -o "$BIN" test/winlist.swift -framework CoreGraphics -framework Foundation

pkill -9 -x "$NAME" 2>/dev/null || true
sleep 1
open "$APP"
# poll up to ~15s for the window to appear
n=0
while [ $n -lt 15 ]; do
  sleep 1; n=$((n+1))
  if "$BIN" "$NAME" >/tmp/_winlist.txt 2>&1; then break; fi
done
COUNT=$(head -1 /tmp/_winlist.txt)
pkill -9 -x "$NAME" 2>/dev/null || true

echo "$COUNT"
if grep -q "windows: 0" /tmp/_winlist.txt || ! grep -q "windows:" /tmp/_winlist.txt; then
  echo "FAIL: $NAME opened no visible window"; exit 1
fi
echo "PASS: $NAME opens a visible window"
