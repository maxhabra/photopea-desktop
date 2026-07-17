#!/bin/sh
# test-cli.sh — tests the batch CLIs (cli.js / photopea and convert-smart.js) end-to-end:
# real PSD/PNG conversions, --resize, batch, and the sharp/Photopea routing. Exits non-zero on fail.
#   sh test-cli.sh
set -e
cd "$(dirname "$0")"

[ -d node_modules/puppeteer-core ] && [ -d node_modules/sharp ] || {
  echo "Installing deps (one-time)..."; npm install --no-fund --no-audit >/dev/null 2>&1; }
[ -f builds/photopea-offline.html ] || { echo "ERROR: builds/photopea-offline.html missing — run 'python3 pack.py'." >&2; exit 1; }

node test/cli.test.js
