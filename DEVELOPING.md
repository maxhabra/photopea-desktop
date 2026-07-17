# Developing Photopea Offline

Everything needed to build the apps from source and understand how the offline patch works.
For end-user download/usage, see [README.md](README.md).

## Build

```sh
git clone https://github.com/ptrinh/photopea-desktop.git
cd photopea-desktop
npm install

# 1) put a local copy of the Photopea site into ./photopea.com/
#    (for Jampea sound, include rsrc/sf2/MagicSF.zip — pack.py warns if it's missing)
# 2) build:
sh refresh.sh                # apply the offline patches (details: refresh.md)
python3 pack.py              # -> builds/photopea-offline.html (single file)
sh make-mac-app.sh           # -> builds/Photopea.app                      (macOS, optional)
sh make-launchers.sh         # -> Photopea.bat / photopea.sh launchers     (optional)
sh make-electron-app.sh      # -> standalone Windows/Linux apps            (optional)
```

Photopea's own code is proprietary and **not** in this repo (`photopea.com/` and `builds/` are
git-ignored). Download the site yourself, then the scripts here reproduce everything.

Tests: `sh test.sh` (headless checks) · `sh test-app.sh` (native app opens).
`refresh.sh --reset` rebuilds the patched bundle cleanly from `.orig` backups.

### One-shot release

`sh release.sh <version>` builds everything, signs + notarizes the macOS app, zips per-platform
assets, and publishes a GitHub Release. Needs `gh` (logged in); notarization uses the keychain
profile in `notarize-mac-app.sh` when present.

## How the offline patch works

- **Fully offline** — one self-contained HTML file. `refresh.sh` rewrites photopea.com URLs to
  localhost and disables ads/tracking; `pack.py` inlines the CSS/JS bundles, wasm, and all 50 UI
  language files into a single gzip-compressed, densely-encoded HTML file.
- **Higher memory ceiling** — the standalone Windows/Linux (Electron) apps run Photopea in a
  dedicated process with the V8 heap raised to ~80% of machine RAM (override with the
  `PHOTOPEA_MAX_RAM_MB` env var), instead of a Chrome tab that gets OOM-killed (helps most on
  8–16GB machines). Photopea's wasm modules are 32-bit internally (4GB per module) — no wrapper
  can lift that.
- **Low-RAM mode for big PSDs** — large files open as a downscaled proxy built by a lazy,
  strip-decoding PSD reader (never holds the whole file or a full-res layer in memory: peak RAM
  on a 2GB PSD drops from ~4.4GB to ~1.9GB). The active layer escalates to full resolution on
  demand, and hidden layers aren't decoded until you toggle them on. Toggled via
  **More → Enable Low RAM Mode** (default on; defaults to off on machines with ≥ 23 GB RAM in
  the mac/Electron apps, where the shell injects the real RAM size). Details: `performance.md`.
- **Bounded undo history** — a size-aware history cap; stock Photopea keeps every history state
  until the tab reloads, which alone can eat many GB during a long session.
- **OS integration** — "Open With" file associations, file arguments, single-instance window.

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

## Build requirements

- `python3` + `DecompressionStream`-capable browser to run the output (Chrome/Edge, Safari 16.4+,
  Firefox 113+).
- The macOS app needs Xcode CLT (`swiftc`). Signing/notarization needs a Developer ID cert.
- The Electron apps need `npm install` (electron, electron-builder, png2icons).
- The Windows `.exe` and Linux AppImage are unsigned — Windows SmartScreen shows a one-time
  "More info → Run anyway". To remove it entirely, sign the exe with an EV code-signing
  certificate (electron-builder reads `CSC_LINK` / `CSC_KEY_PASSWORD`).
