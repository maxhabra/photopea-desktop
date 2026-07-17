# Photopea Offline

A fully offline build of [Photopea](https://www.photopea.com). **One app, three tools** —
switch between them from the toggle at the top-right:

- **Photopea** — photo/image editor, a free alternative to Adobe Photoshop (PSD, layers,
  filters, RAW, …)
- **Vectorpea** — vector graphics editor, a free alternative to Illustrator (AI, SVG, PDF)
- **Jampea** — music/MIDI editor with piano-roll and sheet views

No internet, no server. All 50 UI languages bundled; everything reproducible from a fresh
photopea.com download via the scripts here.

![Photopea Offline](docs/screenshot.png)

> **This repo ships tooling only.** Photopea is proprietary — `photopea.com/` and `builds/` are
> git-ignored and never published. You supply a local Photopea copy, then build locally.

## What's different vs photopea.com

- **Fully offline** — one self-contained HTML file (or native apps), no internet, no ads.
- **Higher memory ceiling** — the standalone Windows/Linux (Electron) apps run Photopea in a
  dedicated process with the V8 heap raised to ~80% of machine RAM, instead of a Chrome tab
  that gets OOM-killed (helps most on 8–16GB machines).
- **Low-RAM mode for big PSDs** — large files open as a downscaled proxy built by a lazy,
  strip-decoding PSD reader (never holds the whole file or a full-res layer in memory: peak RAM
  on a 2GB PSD drops from ~4.4GB to ~1.9GB). The active layer escalates to full resolution
  on demand, and hidden layers aren't decoded until you toggle them on.
- **Bounded undo history** — a size-aware history cap; stock Photopea keeps every history state
  until the tab reloads, which alone can eat many GB during a long session.
- **OS integration** — "Open With" file associations, file arguments, single-instance window,
  plus a headless CLI for batch conversion. Details on the RAM work: `performance.md`.

## Build

```sh
git clone https://github.com/ptrinh/photopea-desktop.git
cd photopea-desktop
npm install

# 1) put a local copy of the Photopea site into ./photopea.com/
# 2) build:
sh refresh.sh                # apply the offline patches (details: refresh.md)
python3 pack.py              # -> builds/photopea-offline.html (single file)
sh make-mac-app.sh           # -> builds/Photopea.app                      (macOS, optional)
sh make-launchers.sh         # -> Photopea.bat / photopea.sh launchers     (optional)
sh make-electron-app.sh      # -> standalone Windows/Linux apps            (optional)
```

Tests: `sh test.sh` (headless checks) · `sh test-app.sh` (native app opens).
`refresh.sh --reset` rebuilds the patched bundle cleanly from `.orig` backups.

## Ways to use it

**1. Single file** — open `builds/photopea-offline.html` in any modern browser, even by
double-click (`file://`). Switch Photopea / Vectorpea / Jampea from the top-right toggle;
UI language follows the system (change under **More**).

**2. Desktop apps**

| Platform | What | Notes |
|---|---|---|
| macOS | `Photopea.app` | native WKWebView, signed + notarized — opens on any Mac |
| Windows | `Photopea-windows-app.zip` → `Photopea.exe` | standalone (Electron), no Chrome needed |
| Linux | `Photopea-linux-app.zip` → `./Photopea` | standalone (Electron), no Chrome needed |
| any | `Photopea.bat` / `photopea.sh` | tiny launchers — open the HTML in an installed Chrome/Edge app window |

The standalone Windows/Linux apps are the big-file-friendly option (see *What's different*
above; override the memory ceiling with the `PHOTOPEA_MAX_RAM_MB` env var). They're unsigned —
Windows SmartScreen asks "More info → Run anyway" once. Note: Photopea's wasm modules are
32-bit internally (4GB per module) — no wrapper can lift that.

**Open With from the OS** (PSD/PSB, AI, XD, Fig, Sketch, PDF, SVG, images, RAW):
- macOS: `Photopea.app` registers automatically (run it once if Finder doesn't list it).
- Windows: run `Install-OpenWith.bat` (in the app folder) or `builds/Install-OpenWith-Windows.bat`
  for the launcher — per-user, no admin. Matching Uninstall scripts included.
- Linux: run `install-openwith-linux.sh` (in the app folder or `builds/`).
- All apps/launchers also take file arguments: `Photopea.bat a.psd`, `./Photopea a.psd b.png`.
  Files opened while the app runs land in the existing window.

**3. Served** — serve the build with any static server, e.g.
`cd builds && python3 -m http.server 8899 --bind 127.0.0.1` → http://localhost:8899/photopea-offline.html.
As a secure context this unlocks full **clipboard Paste** and the **Local Fonts** panel (both
restricted on `file://`; elsewhere use Cmd+V and drag-drop `.ttf/.otf` fonts).

## Command line — `cli.js`

Headless batch convert/resize/export (parallel workers, offline, uses Chrome headless):

```sh
npm link                     # once -> global `photopea` command (or: node cli.js …)
photopea photo.psd --to png
photopea *.psd --to jpg --quality 90 --out exported
photopea a.png b.webp --to jpg --resize 1024x1024
photopea shots/*.psd --to webp --concurrency 8
```

| Option | Meaning |
|---|---|
| `--to <fmt>` | output: `png jpg webp gif bmp tiff svg pdf psd ai …` (required) |
| `--out <dir>` | output directory (default `./out`) |
| `--resize <WxH>` | e.g. `1920x1080`; `512x` / `x512` keeps aspect |
| `--quality <0-100>` | for jpg/webp (default 90) |
| `--concurrency <N>` | parallel workers (default: CPU cores) |
| `--script "<js>"` | extra Photopea script per file (advanced) |
| `--html` / `--chrome` | paths to the build / the browser (auto-detected) |

Throughput tip: the ~7s Photopea boot is paid once per worker, so batch many files per run.
For plain raster conversions, native tools (sharp/libvips, ImageMagick) are 10–100× faster —
use this CLI for layered/vector formats (PSD, AI, XD, Sketch, FIG). `convert-smart` does the
routing automatically: raster → sharp, layered → Photopea (same options).

## Notes & limits

- Clipboard Paste and Local Fonts need the served version (secure context) — see above.
- Jampea music playback needs a soundfont that isn't shipped (the editor itself works).
- Needs a modern browser with `DecompressionStream` (Chrome/Edge, Safari 16.4+, Firefox 113+).
  The macOS app needs Xcode CLT to build; `cli.js` needs Chrome; the Electron apps need `npm install`.
