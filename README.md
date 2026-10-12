# Photopea Desktop — personal macOS build

Private offline macOS app for maxhabra, based on the repository history of
[raphlafalaf/photopea-desktop](https://github.com/raphlafalaf/photopea-desktop).
The new `desktop/` application uses Electron/Chromium on macOS, with its own teal
Photopea icon and native macOS menu. Photopea itself remains proprietary; this is
an unofficial personal build, not an official Photopea release.

## Install

Download the matching ZIP from this repository's Releases:

- `Photopea-Desktop-1.0.0-macOS-arm64.zip`: Apple Silicon (M1 and later).
- `Photopea-Desktop-1.0.0-macOS-x64.zip`: Intel Macs.

Unzip and drag **Photopea Desktop.app** to Applications. These builds are **ad-hoc
signed, not Apple notarized**. If macOS blocks the downloaded app, use System
Settings → Privacy & Security → Open Anyway after attempting to open it.
No system-wide security changes are needed. Electron 43 requires macOS 12 or later.

## Offline behavior

The editor and 61 required snapshot assets are bundled inside the application.
HTTP and HTTPS requests are handled locally; missing resources fail instead of
falling back to the internet. WebSockets are blocked. Normal use requires no
server, browser installation, or network connection, including on first launch.

Image editing, clipboard copy/paste, local file opening and exports work locally.
Cloud storage, account login, AI services, online templates, remote URLs, and fonts
not installed or bundled are unavailable. Some of these remain visible in the
editor interface. The app does not claim to make every Photopea feature offline.
Use local fonts and files. Save your work before quitting.

The default window is resizable, View offers zoom/full screen, and a narrowly
validated layout patch reclaims the empty 320-pixel advertising column. The
renderer is sandboxed with Node integration disabled; clipboard and local font
permissions apply only to this editor window.

## Build

```sh
npm ci
python3 scripts/fetch-snapshot.py  # only when photopea.com/ is absent
sh scripts/build-macos.sh
```

The downloader verifies every asset against `desktop/snapshot.json`. Photopea can
remove older versioned files or change unversioned assets; it fails on any mismatch.
For an exact rebuild, recover `Contents/Resources/photopea.com` from the release app
into the repository's `photopea.com/` directory, then run the build command.
The downloaded proprietary files and generated builds are excluded from Git.

Local development:

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron desktop
```

`desktop/` is the macOS release entrypoint. The upstream packer, WKWebView wrapper,
and release scripts are retained as reference only; they do not build this release.
Their minified-code patches no longer match the current Photopea snapshot. Do not
run `refresh.sh`, `pack.py`, or `release.sh` for this macOS application.

## Provenance

Upstream commit: `d014fde`. Editor snapshot: `pp1791725206.js`.
Runtime: Electron 43.1.1. Exact asset SHA-256 hashes: `desktop/snapshot.json`.
The original project documentation is retained in `docs/UPSTREAM-README.md` and
`DEVELOPING.md`. No redistribution license for Photopea is implied by this private
repository. The Photopea name, icon, and editor belong to their respective owners.
