# Photopea Offline

A fully offline build of [Photopea](https://www.photopea.com) (the image editor) — plus its
sibling editions **Vectorpea** (vectors) and **Jampea** (music). Runs with no internet and no
server: as a single HTML file, a native macOS app, or from the command line for batch jobs.

All 50 UI languages are bundled, and all patches/edits are reproducible from a fresh photopea.com
download via the scripts in this repo.

```
photopea-offline/
├── photopea.com/            # the app source (patched); serve this for the full experience
├── builds/
│   ├── photopea-offline.html   # ONE self-contained file — open it, no server needed
│   └── Photopea.app            # native macOS wrapper of that file
├── cli.js                   # command-line batch converter (headless)
├── refresh.sh  pack.py  make-mac-app.sh   # build pipeline (see refresh.md)
├── test.sh  test-app.sh     # smoke tests
└── refresh.md               # how everything is built/patched (internals)
```

> **This repo ships the tooling only** — not Photopea itself. Photopea is proprietary, so its code
> (`photopea.com/`) and the generated `builds/` are git-ignored and never published here. You supply
> a local Photopea copy, then build locally (below).

---

## Setup (build it first)

```sh
git clone https://github.com/ptrinh/photopea-desktop.git
cd photopea-desktop
npm install                    # puppeteer-core + sharp (for the CLIs/tests)

# 1) put a local copy of the Photopea site into ./photopea.com/
#    (its index.html, code/, style/, rsrc/, promo/, ... from photopea.com)
# 2) build:
sh refresh.sh                  # apply the offline patches
python3 pack.py                # -> builds/photopea-offline.html
sh make-mac-app.sh             # -> builds/Photopea.app   (macOS, optional)
sh make-launchers.sh           # -> Windows/Linux launchers (optional)
```

Once `builds/` exists, use any of the options below.

---

## Ways to use it

### 1. Single file (simplest)
Open **`builds/photopea-offline.html`** in any modern browser (Chrome/Edge/Safari/Firefox) — even
by double-clicking (`file://`). No server, no internet.
- Switch **Photopea / Vectorpea / Jampea** from the toggle at the top-right of the menu bar.
- UI language follows your system language automatically; pick another under the **More** menu.

### 2. Desktop app / launchers
Build once with `sh make-mac-app.sh` (macOS app) and/or `sh make-launchers.sh` (Windows + Linux):

| Platform | File in `builds/` | How |
|---|---|---|
| macOS | `Photopea.app` | native (WKWebView). First launch: **right-click → Open**. |
| Windows | `Photopea.bat` | double-click — opens as an app window in Chrome/Edge |
| Linux/Unix | `photopea.sh` / `Photopea.desktop` | `./photopea.sh`, or copy the `.desktop` to `~/.local/share/applications/` |

The Windows/Linux launchers just open `photopea-offline.html` in an installed Chromium browser's
chromeless "app window" — no bundling, tiny, and no Gatekeeper/SmartScreen app-signing issues.

**Open files from the OS (right-click → Open With)** — PSD/PSB, AI, XD, Fig, Sketch, PDF, SVG,
common images and camera RAW:
- **macOS**: `Photopea.app` registers the types automatically — pick it under **Open With**
  (Finder caches the list; if it doesn't show, run `open builds/Photopea.app` once).
- **Windows**: run `builds/Install-OpenWith-Windows.bat` once (per-user, no admin) — adds
  **Photopea Offline** to the "Open With" menu. Remove with `Uninstall-OpenWith-Windows.bat`.
- **Linux**: run `builds/install-openwith-linux.sh` once — installs the `.desktop` entry with the
  MIME types so file managers list **Photopea** in "Open With".
- Launchers also take file arguments directly: `Photopea.bat image.psd`, `./photopea.sh a.psd b.png`.

**Running the macOS `.app` on ANOTHER Mac** → macOS shows *"Apple could not verify … Move to Trash"*.
That's because the app is ad-hoc signed (not notarized) and gets quarantined when transferred. Fix on
that Mac, any one of:
- Double-click **`Trust-Photopea.command`** (shipped next to the app), then open the app; **or**
- Terminal: `xattr -cr /path/to/Photopea.app` ; **or**
- Open it once → **System Settings → Privacy & Security → Open Anyway**.

**Proper fix — sign + notarize (Apple Developer account):** makes the app open on ANY Mac with no
warning at all. `sh make-mac-app.sh` builds it, then:
```sh
# one-time: store notary credentials (app-specific password from appleid.apple.com)
xcrun notarytool store-credentials "photopea-notary" \
    --apple-id "you@example.com" --team-id "YOURTEAMID" --password "abcd-efgh-ijkl-mnop"

# sign with your Developer ID + notarize + staple:
NOTARY_PROFILE="photopea-notary" sh notarize-mac-app.sh
```
`notarize-mac-app.sh` auto-detects your "Developer ID Application" certificate, signs with the
hardened runtime, submits to Apple, waits for the verdict, and staples the ticket onto the app.
After that the app is trusted everywhere and no `Trust-Photopea.command` / `xattr` is needed.

Without notarization, the **launcher** route (`photopea.sh`, or just opening the HTML in Chrome)
avoids the whole issue since it isn't a signed app.

### 3. Served (best for clipboard & local fonts)
```sh
sh photopea.com/start.sh          # serves on http://localhost:8899/
```
`localhost` is a secure context, so **Paste** and the **Local Fonts** feature work fully there
(they're restricted on `file://`).

---

## Command line (batch) — `cli.js`

Drive Photopea headlessly to convert / resize / export many files at once — in parallel. Uses the
single-file build and Chrome (headless) under the hood — still fully offline.

**Install the `photopea` command (once):**
```sh
npm install          # installs puppeteer-core
npm link             # or: npm install -g .   -> makes `photopea` global
```
(Or skip the global command and run `node cli.js …` directly.)

**Usage**
```sh
photopea <inputs...> --to <format> [options]
```

**Examples**
```sh
photopea photo.psd --to png                             # PSD -> PNG (./out/photo.png)
photopea *.psd --to jpg --quality 90 --out exported      # batch, JPEG q90
photopea a.png b.webp --to jpg --resize 1024x1024         # convert + resize
photopea poster.psd --to pdf                             # export to PDF
photopea logo.ai --to png --resize 512x                  # width 512, height auto
photopea shots/*.psd --to webp --concurrency 8 --out web  # 8 parallel workers
```

**Options**

| Option | Meaning |
|---|---|
| `--to <fmt>` | output format: `png jpg webp gif bmp tiff svg pdf psd ai …` (required) |
| `--out <dir>` | output directory (default `./out`) |
| `--resize <WxH>` | resize before export, e.g. `1920x1080` (`512x` or `x512` keeps aspect) |
| `--quality <0-100>` | quality for `jpg`/`webp` (default 90) |
| `--concurrency <N>` | parallel Photopea workers (default: CPU cores) |
| `--script "<js>"` | run an extra Photopea script per file before export (advanced) |
| `--html <path>` | path to the build (default `builds/photopea-offline.html`) |
| `--chrome <path>` | Chrome/Chromium (auto-detected on macOS/Linux, or `$CHROME`) |

Input formats are anything Photopea reads (PSD, AI, XD, Sketch, FIG, PDF, PNG/JPG/WEBP/GIF/TIFF/SVG,
RAW, …). It opens each file via Photopea's postMessage API, transforms it, then exports via `saveToOE`.

### Performance (server / heavy batch)
Each worker is one headless Photopea instance; `--concurrency N` runs N in parallel and scales
with CPU cores. The ~7 s Photopea boot is paid **once per worker**, then reused for every file that
worker handles — so throughput is best with **many files per run** (don't spawn a new process per
file). On a server add `--no-sandbox` is already set; give it enough RAM (~300–500 MB per worker).

**Should you call the WASM directly instead?** No — it isn't practical for Photopea. Its engine is
obfuscated JavaScript (~2.5 MB) that orchestrates **Canvas/WebGL rendering** plus several *small*
WASM modules (JPEG/WebP/Zstd codecs, FriBidi + HarfBuzz for text). There is no single "photopea.wasm"
to invoke; the compositing/filters/PSD-parsing all live in the JS and need a browser GL context. The
fast path is parallel headless workers (above), not extracting WASM.

**Better yet — skip Photopea for simple raster ops.** If you only convert/resize/crop ordinary
images (PNG/JPG/WEBP/GIF/TIFF), a native tool is **10–100× faster** and lighter than a browser:
- **libvips / sharp** (`npm i sharp`) — extremely fast, low memory, parallel.
- **ImageMagick** / **ffmpeg**.

Use `photopea` (this CLI) specifically for **layered / vector formats** (PSD, AI, XD, Sketch, FIG)
and Photopea-only features. For PSD flatten/export at scale without a browser, also consider native
libs (`libvips` PSD support, ImageMagick, Python `psd-tools`, or Krita's CLI) if their fidelity is
enough for you.

### `convert-smart` — auto-route (best of both)
One command that sends each file to the fastest engine automatically: ordinary raster → **sharp**,
layered/vector → **Photopea**. Same options as `photopea`.
```sh
convert-smart mix/*.{png,psd,ai} --to webp --quality 85 --out web --verbose
```

---

## Building from a fresh photopea.com download

```sh
sh refresh.sh          # apply the offline patches to photopea.com/
python3 pack.py        # -> builds/photopea-offline.html (single file, all editions + languages)
sh make-mac-app.sh     # -> builds/Photopea.app          (macOS native)
sh make-launchers.sh   # -> builds/Photopea.bat + photopea.sh + Photopea.desktop  (Windows/Linux)
```
`refresh.sh --reset` regenerates the patched bundle cleanly from the `.orig` backups. Full details
of every patch are in **refresh.md**.

## Testing
```sh
sh test.sh        # 17 checks in headless Chrome (load, layout, UI, editions, languages, file dialog)
sh test-app.sh    # verifies the native app opens a visible window
```

---

## Notes & limits
- **Clipboard (Paste)**: use **Cmd+V** in the file/app; the menu "Paste" needs a secure context —
  use the served version for full clipboard access.
- **Local system fonts**: the "Local Fonts" toggle (Character panel) works only in the served
  version (Chrome, secure context). Everywhere else, **drag & drop** a `.ttf/.otf/.woff` onto the
  window to add fonts for the session.
- **Jampea** music playback needs a soundfont that isn't shipped offline (the editor still works).
- Requires a Chromium-based or modern browser with `DecompressionStream` (Chrome/Edge, Safari 16.4+,
  Firefox 113+). The macOS app and `cli.js` need Xcode Command Line Tools / Chrome respectively.
