# Photopea Offline — Refresh / Rebuild Guide

Goal: starting from a freshly downloaded copy of `photopea.com`, recreate the current
offline build that runs on `localhost:8899`. This file lets an AI (or a human) redo the
work quickly next time instead of re-discovering everything from scratch.

> The current build was verified with headless Chrome (puppeteer-core pointed at
> `/Applications/Google Chrome.app`): menus are clickable, layout is full-width, and the
> unwanted UI is hidden.

---

## 0. Structure & smoke test

```
photopea-offline/                 # project root — TOOLSET only
├── refresh.sh                    # patch the app for offline use
├── pack.py                       # -> builds/photopea-offline.html
├── make-mac-app.sh               # -> builds/Photopea.app  (+ Trust-Photopea.command)
├── notarize-mac-app.sh           # sign (Developer ID) + notarize the .app for any Mac
├── make-launchers.sh             # -> builds/Photopea.bat, photopea.sh, Photopea.desktop (Win/Linux)
├── cli.js (photopea) + convert-smart.js   # headless batch CLIs (see README.md)
├── package.json                  # `npm link` -> global `photopea` / `convert-smart`
├── test.sh + test/run.js         # headless-Chrome smoke tests (17 checks)
├── test-app.sh + test/winlist.swift       # native-app window smoke test
├── test-cli.sh + test/cli.test.js         # CLI / convert-smart tests
├── README.md                     # user-facing guide
├── refresh.md                    # this file (build internals)
├── photopea.com/                 # the Photopea app files (the saved site)
│   ├── index.html                #   (index.html.orig = untouched original)
│   ├── start.sh                  #   python3 -m http.server 8899 --bind 127.0.0.1
│   ├── code/pp/pp1784151871.js   #   main bundle (.orig = original). FILENAME CHANGES per version!
│   ├── code/ext, code/dbs, code/lang
│   └── rsrc/ (basic/*.zip = base fonts), promo/, img/, content/, papi/, style/, manifest.json
└── builds/                       # generated artifacts
    ├── photopea-offline.html      # one file, switch editions from the top-bar toggle
    └── Photopea.app               # native wrapper of the same file
```

The scripts know these paths: `refresh.sh` patches files in `photopea.com/`, `pack.py` reads
`photopea.com/` and writes `builds/`, `make-mac-app.sh` reads `builds/photopea-single.html`.

Run the served version: `sh photopea.com/start.sh`, then open **http://localhost:8899/#**
(use `localhost`, NOT `127.0.0.1` — see section 2 for why).

Full pipeline + test:
```sh
sh refresh.sh && python3 pack.py && sh make-mac-app.sh   # patch -> single file -> app
sh test.sh                                               # 17 headless-Chrome checks, exit≠0 on fail
```
`test.sh` drives `builds/photopea-offline.html` in headless Chrome and checks: app loads, no landing,
full-width, trimmed UI (sidebar/Account/Generate-AI/top-right links hidden), File menu opens,
Open From Computer dialog, New Project canvas, 0 console errors, the Vectorpea/Jampea switcher, no
stuck Loading toast, and the Vietnamese translation. Run it after any change to catch regressions.

---

## 1. Rewrite all photopea.com URLs → localhost:8899

Apply to **both `index.html` and `code/pp/*.js`**.

```
https://www.photopea.com   → http://localhost:8899
//www.photopea.com         → //localhost:8899
//blog.photopea.com        → //localhost:8899
www.photopea.com (bare)    → localhost   (in text / domain checks)
```

Then **add the `:8899` port**: every `//localhost` without an existing port → `//localhost:8899`.
(start.sh serves on port 8899; change this number if you change the port.)

**KEEP AS-IS, do not rewrite:**
- `support@photopea.com` (contact email)
- Ad-slot IDs like `/147246189,21623892374/photopea.com_rewarded` (just slot names)
- External links: `github.com/photopea`, `x.com/photopeacom`, social icons
- Domain-check string literals stay as `"localhost"` (do NOT hardcode the port) so changing
  the port later still works.

Domain functions in the JS that must point to localhost (mostly handled by a correct replace):
- `id.$l` → `"//localhost:8899/"`
- `id.xG` → early `return "//localhost:8899/"+B;`
- `cu.iT`, the `.gI` handler, referrer classification, CDN check: `indexOf("photopea.com")` → `indexOf("localhost")`

## 1b. Disable ads / tracking (if a new download re-enables them)
- `fN.X1=function(){` → add `return 0;` at the start
- `fN.azv=function(){` → add `return;` at the start
- Ad-injection block `if(!fN.zM()&&!fN.X1()&&T&&B*R>300*300){` → change the condition to `if(false){`

---

## 2. FIX dead menus + layout (CRITICAL — caused by serving on localhost)

Photopea gates behavior on the domain: `E.A2()` returns the last two labels of the hostname.
`localhost` has only one label → `E.A2()` returns `""` → two bugs. (See memory
`localhost-breaks-domain-gates`.)

**FIX 1 — Menu bar not clickable** (because `aFq=true` swallows every menu-open event):
```
E.azP=function(){var B=E.A2();if(B=="")return 0;
→ E.azP=function(){var B=E.A2();if(B=="")return 1;
```

**FIX 2 — ~320px empty gap on the right** (reserved ad column that never fills offline):
In `e5.prototype.Fh`, the no-ads flag `n`:
```
var T=fN.I$,n=!this.R6||...||E.A2()==j_.ai("YMVVHAj=FA");
→ ...||E.A2()==j_.ai("YMVVHAj=FA")||true;     // append ||true
```

---

## 3. Hide unwanted UI (optional — matches the current build)

**Left sidebar on the Home screen** (Home/This Device/PeaDrive/.../Jampea) — in `jv.prototype.Fh`:
```
if(this.xL){U=[[[1,19,3],null,"strg/home"]].concat(U.concat(jv.WW));
→ if(this.xL){D=0;this.et.style.display="none";U=[[[1,19,3],null,"strg/home"]].concat(...
```
(only hides it on Home where `xL==true`; the Open/Save dialog keeps its sidebar)

**"Generate with AI" button** (the 5th Home button) — in `jv.Fo.prototype.W`, right after the
innerHTML-assignment loop:
```
...+ee.get(R[f]);      // end of the for loop
+ add:  if(B[4])B[4].style.display="none";
```

**Top-right link cluster** (About / Report a bug / Learn / Blog / API / reddit / twitter / facebook)
— in `eO.prototype` (topbar layout), where `acT` visibility is computed:
```
var e=this.agR&&B>U+m;   →   var e=false;
```

**"Account" (red) button** — in `gq.prototype` (topbar), where `cF` is appended:
```
if(B.AX){U.appendChild(this.cF.$)}   →   if(false){U.appendChild(this.cF.$)}
```

**Go straight to the app, skip the landing page** — opening `localhost:8899` (without `#`)
shows the landing page by default ("Free Online Photo Editor" + Start using Photopea button).
In `index.html` (~line 280):
```
if(href.indexOf("#")!=-1 || href.indexOf("=")!=-1 || ppp["capShown"]=="false") addPP();
→ if(true) addPP();
```
(`addPP()` hides the landing `#cap` and loads all10.css + the 3 JS files.)

---

## 4. Notes & gotchas

- **DO NOT** coerce `lg` to a boolean. `lg` is a mode enum (0=Photopea, 1=Vectorpea, 2=Jampea)
  used ~138 times (`lg==0/1/2`, `arr[lg]`). On localhost it is 0 = correct Photopea mode.
  `lg==true` would wrongly trigger Vectorpea and break array indexing.
- After editing the JS, **hard-refresh** (Cmd+Shift+R) — the browser caches the bundle.
- Harmless 404s offline: `img/*.webp`, `img/goats.mp4`, requests to `doubleclick` /
  `googlesyndication` (ads).
- The bundle filename is versioned (`pp<digits>.js`) — a new download has a different number;
  match it with the pattern `code/pp/pp*.js`.
- The edit anchors are strings inside minified JS; if a new download renames identifiers
  (E, fN, jv, gq, eO, e5, cF, acT, xL...), re-locate them by context (search for the labels
  "Generate with AI", "Account", `E.azP`, `e5.prototype.Fh`...).

---

## 5b. Single-file build (pack.py)

`pack.py` bundles the whole patched app into one self-contained `builds/photopea-offline.html`
(~4.4 MB) that runs directly from `file://` — no server, no external requests.

```sh
sh refresh.sh      # patch photopea.com/ first
python3 pack.py    # -> builds/photopea-offline.html
```

### Editions: one file, top-bar switcher (Photopea / Vectorpea / Jampea)
Photopea, Vectorpea and Jampea are the SAME bundle; only the `lg` flag differs
(0/1/2), set at startup from the hostname:
`var lg=window.location.hostname.endsWith("jampea.com")?2:...=="www.vectorpea.com"?1:0`.
Rather than build 3 files, the bootstrap reads `localStorage.__ppmode` and, when it is 1 or 2,
string-replaces that line in the decompressed pp.js text (`…?1:0` → `var lg=1`) before running it.
A small fixed toggle is injected top-right (the menu-bar area freed up by hiding the About/…/social
links); clicking sets `__ppmode` and reloads. So one HTML/app covers all three editions.
- Vectorpea/Jampea show a "Loading local fonts" toast that never dismisses offline (the fonts it
  waits for aren't shipped). It's a non-blocking `.alertpanel`; the bootstrap hides the stuck
  startup one after a few seconds.
- Jampea's soundfont (`rsrc/sf2/MagicSF.zip`, 7 MB) is embedded by pack.py when present in the
  offline copy (download it from photopea.com if missing) → music playback works. If absent,
  the URL stays dead-listed (editor still works, just no sound) and pack.py prints a warning.

Why it works:
- CSS + the 3 JS bundles are gzip+base64 embedded and decompressed at runtime via the
  browser's `DecompressionStream`, then executed as injected `<script>` elements
  (avoids `</script>`-in-string breakage and keeps the file small).
- The only binary assets the app still fetches at runtime — `code/ext/fribidi.wasm`,
  `code/ext/hb.wasm`, `rsrc/basic/basic.zip`, `rsrc/basic/fa.zip` — are embedded as base64
  and served by rewriting `fetch()` / `XMLHttpRequest` URLs to `data:` URLs.
  (Codec wasm jpg/webp/zstd/dt are already embedded inside pp.js via `ha.sd`.)
- Web Workers already use `blob:` URLs (`URL.createObjectURL`), which are allowed on file://.
- Startup gotcha: the bundle calls `window.showCap()` on first visit, which needs the
  `#cap` element. Keep a hidden `<div id="cap" style="display:none">` in the DOM AND set
  `localStorage._ppp.capShown="false"` before running pp.js, so the landing overlay is skipped.
- Dead endpoints (`papi/…`, `mirror.php`, `//localhost…`, `zoner.com`, `gallery.json`):
  dead **fetch** resolves empty (analytics ignore the body); dead **XHR** fails cleanly
  (fires `onerror`, never `onload`) so response parsers like `aR.a2x` (which expects
  `{hits:[…]}`) never run on fake data.
- `img/nft.png` (an `<img>` the offline copy never shipped) is embedded as a 1×1 transparent
  PNG; a `setAttribute("src"/"href", …)` hook rewrites it (and any embedded-asset path) to its
  data URL, since `<img>` loads bypass fetch/XHR.

Requirements:
- Browser needs `DecompressionStream` (Chrome/Edge, Safari 16.4+, Firefox 113+).
- Verified with headless Chrome (`--allow-file-access-from-files`), 3 consecutive runs: app
  loads, menus open, New Project renders a canvas, layout is full-width, **0 console errors**.

## 5c. macOS app (make-mac-app.sh)

`make-mac-app.sh` wraps `photopea-single.html` into a native `Photopea.app` (WKWebView, no
Chrome needed) that shows in the Dock with the Photopea icon.

```sh
python3 pack.py        # produce builds/photopea-offline.html
sh make-mac-app.sh     # -> builds/Photopea.app   (icon from photopea.com/promo/icon512.png)
open builds/Photopea.app   # or drag to /Applications and pin to the Dock
```

One app covers all three editions (switch from the in-app top-bar toggle). Notes:
- "Open From Computer" needs the app's `WKUIDelegate.runOpenPanelWith` (present) to show the
  NSOpenPanel — WKWebView won't show a file picker on its own.
- Clipboard/Paste: use **Cmd+V** in the app / file:// (the paste event works). The menu "Paste"
  uses `navigator.clipboard.read()` which needs a secure context — for full clipboard, use the
  served version on `localhost` (secure). **Do NOT** try to enable it with `WKPreferences`
  `setValue(forKey:"javaScriptCanAccessClipboard")` — an unknown KVC key throws
  `NSUnknownKeyException` inside `applicationDidFinishLaunching`, which aborts window creation
  → **the app launches but shows no window** (this exact bug happened). Verify with `sh test-app.sh`.
- Verify the window actually appears: **`sh test-app.sh`** (launches the app, counts on-screen
  windows via CGWindowList — reliable; `System Events`'s window count needs Accessibility
  permission and silently mis-reports 0, so don't rely on it).
- Gatekeeper: the app is ad-hoc signed. The script runs `xattr -cr` to strip quarantine, but on
  a fresh Mac double-click may still be blocked — **right-click → Open** once.
- Icon: the script bumps `CFBundleVersion` (timestamp) so the Dock icon refreshes on rebuild.

What it does: png→.icns via `sips`+`iconutil`; a tiny Swift/WKWebView host compiled with
`swiftc` (`setActivationPolicy(.regular)` = Dock icon; window title bound to the page title);
`Info.plist` with the icon; ad-hoc `codesign`. Requires Xcode Command Line Tools (swiftc).
Verified via a WKWebView probe: `.app` boots, File menu present, `DecompressionStream`
available in WebKit (macOS 13.3+).

### file:// / WKWebView open-file fix (also baked into refresh.sh, step 2b)
"Open From Computer" used the File System Access API (`showOpenFilePicker`), which fails on
`file://` (not a secure context) and is absent in WKWebView. Two changes make it work:
- `pack.py` bootstrap sets `showOpenFilePicker/showSaveFilePicker/showDirectoryPicker = undefined`
  so Photopea falls back to `<input type=file>` / `<a download>`.
- The fallback itself dispatched a **synthetic** MouseEvent (`isTrusted=false`) which browsers
  ignore for file dialogs; refresh.sh step 2b rewrites it to `m.click()` so the picker actually
  opens under the user gesture. Verified with `waitForFileChooser` (dialog opens).

## 5a. UI languages (all 50 embedded)

Photopea loads UI translations from `code/lang/<index>.js` where `<index>` is the position in
`LNG.langs` (defined in the DBS bundle) — e.g. `31.js` = Tiếng Việt. NOT the language code.
- All 50 files were downloaded from `https://www.photopea.com/code/lang/<index>.js` into
  `photopea.com/code/lang/` (~924 KB raw). The served version uses them as-is.
- `pack.py` embeds every `code/lang/*.js` gzip+base64 in `__LANG`, and `__loadLangs()` decompresses
  them into `__ASSET` (as `data:...;charset=utf-8` URLs) before pp.js boots, so the app's XHR
  (`id.$l("code/lang/"+i+".js")`) is served locally. Adds ~300 KB to the single file (~276 KB gz).
- Selection: Photopea auto-picks from `navigator.languages` (so the app follows the macOS system
  language), and there's a manual list under the **More** menu (`ee.a3m()`). Verified: forcing
  `vi` renders "Tệp / Chỉnh sửa / Hình ảnh / Mở Tệp từ Máy tính".
- Re-download all: `cd photopea.com/code/lang && for i in $(seq 0 49); do curl -sfO "https://www.photopea.com/code/lang/$i.js"; done`

## 5. Fonts

- Local system fonts: Photopea has a **"Local Fonts"** toggle (Character panel) that calls the
  Local Font Access API `queryLocalFonts()`. Works in Chrome/Edge on a **secure context** with a
  permission grant → use the served version (`sh photopea.com/start.sh`, localhost is secure).
  NOT available on `file://` (not secure) nor in WKWebView (WebKit lacks the API) → the single
  file and the .app can't use it.
- Everywhere (incl. file:// and the app): **drag & drop** a `.ttf/.otf/.woff` (or a zip/.pxz) onto
  the window to add fonts for the session. Code path: opening a zip scans `.woff/.ttf/.otf` and
  calls `cu.iT({name:$},...)`.
- The full CDN font library isn't bundled (offline ships only `rsrc/basic/*.zip`). To bake fonts
  in permanently you'd embed them like the language files and register them — not implemented.
