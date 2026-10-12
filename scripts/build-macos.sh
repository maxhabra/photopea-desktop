#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node scripts/verify-snapshot.cjs
./node_modules/.bin/electron-builder --project desktop --config electron-builder.yml --mac --arm64 --x64 --publish never
