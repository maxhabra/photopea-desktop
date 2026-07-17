#!/bin/sh
# test.sh — smoke-test the offline build in headless Chrome (menu, layout, trimmed UI, editions,
# languages, file dialog). Run after pack.py. Exits non-zero if any check fails.
#
#   sh test.sh                         # test builds/photopea-offline.html
#   sh test.sh builds/other.html       # test a specific file
#   CHROME="/path/to/chrome" sh test.sh
set -e
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$CHROME" ] || { echo "ERROR: Chrome not found at '$CHROME' (set CHROME=/path/to/chrome)." >&2; exit 1; }

TARGET="${1:-builds/photopea-offline.html}"
[ -f "$TARGET" ] || { echo "ERROR: $TARGET not found — run 'python3 pack.py' first." >&2; exit 1; }

# one-time: install puppeteer-core into test/node_modules
if [ ! -d test/node_modules/puppeteer-core ]; then
  echo "Installing puppeteer-core (one-time)..."
  ( cd test && npm init -y >/dev/null 2>&1 || true; npm install --no-fund --no-audit puppeteer-core >/dev/null 2>&1 )
fi

CHROME="$CHROME" node test/run.js "$TARGET"

# hybrid low-RAM proxy: lazy PSD reader unit tests (pure node) + end-to-end in the build
node test/hybrid.test.js
CHROME="$CHROME" node test/hybrid.browser.test.js "$TARGET"
