#!/bin/sh
# make-electron-app.sh — wrap builds/photopea-offline.html into standalone Electron apps for
# Windows x64 and Linux x64 (no Chrome install needed). The point over the .bat/.sh launchers:
# a dedicated renderer process that no browser OOM-kills or tab-discards, plus a raised V8 heap
# floor (--max-old-space-size ~ 80% of machine RAM; V8's dynamic default is ~half of RAM, which
# hurts most on 8-16GB machines). The wasm32 4GB address space per module is baked into
# Photopea's own binaries and cannot be lifted from outside.
#
#   sh make-electron-app.sh              build win32-x64 + linux-x64 packages + zips
#   sh make-electron-app.sh smoke        build src only and run a local smoke test (uses the
#                                        mac Electron from node_modules; verifies heap + file XHR)
#
# Requires: node_modules (npm install) with electron, @electron/packager, png2icons.
# Produces:  builds/electron-dist/Photopea-win32-x64/   + builds/Photopea-windows-app.zip
#            builds/electron-dist/Photopea-linux-x64/   + builds/Photopea-linux-app.zip
set -e
cd "$(dirname "$0")"

HTML="builds/photopea-offline.html"
ICON_SRC="photopea.com/promo/icon512.png"
SRC="builds/electron-src"
DIST="builds/electron-dist"
[ -f "$HTML" ] || { echo "ERROR: $HTML not found — run 'python3 pack.py' first." >&2; exit 1; }
[ -d node_modules/electron ] || { echo "ERROR: run 'npm install' first (needs electron, @electron/packager, png2icons)." >&2; exit 1; }

# extensions registered for "Open With" (keep in sync with FILE_EXTS in make-mac-app.sh)
EXTS="psd psb ai xd fig sketch pdf eps svg png jpg jpeg jfif gif webp avif bmp ico tif tiff tga dds heic exr ppm pgm dng cr2 cr3 nef arw orf rw2 raf srw pef mid midi gp gp3 gp4 gp5 gpx mscz mscx musicxml mxl sf2 sf3"

echo "== assemble $SRC =="
rm -rf "$SRC"
mkdir -p "$SRC"
cp "$HTML" "$SRC/app.html"
cp "$ICON_SRC" "$SRC/icon.png"

cat > "$SRC/package.json" <<'JSON'
{
  "name": "photopea-offline-desktop",
  "productName": "Photopea",
  "version": "1.0.0",
  "main": "main.js"
}
JSON

cat > "$SRC/main.js" <<'JS'
// Photopea Offline — Electron shell. Loads the single-file build and lifts the browser limits
// that kill big documents: the V8 old-space cap (default ~4GB) is raised to ~80% of machine RAM.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('fs'), os = require('os'), path = require('path');

const SMOKE = process.env.PHOTOPEA_SMOKE === '1';
const heapMB = parseInt(process.env.PHOTOPEA_MAX_RAM_MB || '', 10) ||
               Math.max(4096, Math.round(os.totalmem() / 1048576 * 0.8));
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=' + heapMB);
// the packed page opens OS files via XHR on file:// URLs (#open= fragment) — same flag the
// Chrome launchers pass
app.commandLine.appendSwitch('allow-file-access-from-files');
app.commandLine.appendSwitch('enable-features', 'WebAssemblyMemory64');

let win = null;
let pageLoaded = false;
let pending = [];   // file paths queued until the page has loaded

function fileUrl(p) {
  let u = path.resolve(p).split(path.sep).join('/');
  if (u[0] !== '/') u = '/' + u;                       // C:/x.psd -> /C:/x.psd
  return 'file://' + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/,/g, '%2C');
}
function fileArgs(argv, cwd) {
  return argv.slice(app.isPackaged ? 1 : 2)
    .filter(a => a && a[0] !== '-')
    .map(a => path.resolve(cwd || process.cwd(), a))
    .filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });
}
function openFiles(files) {
  if (!files.length) return;
  if (!pageLoaded || !win) { pending.push(...files); return; }
  const hash = '#open=' + files.map(fileUrl).join(',');
  // __openHashFiles is a global installed by pack.py in the packed page
  win.webContents.executeJavaScript(
    'location.hash=' + JSON.stringify(hash) + ';__openHashFiles();').catch(() => {});
}

async function smoke() {
  try {
    const probe = fileUrl(path.join(__dirname, 'package.json'));
    const r = await win.webContents.executeJavaScript(`(async () => {
      const xhr = await new Promise(res => {
        const x = new XMLHttpRequest(); x.open('GET', ${JSON.stringify(probe)}, true);
        x.onload = () => res(x.response && x.response.length > 0);
        x.onerror = () => res(false); x.send();
      });
      return { openFn: typeof __openHashFiles, fileXHR: xhr };
    })()`);
    console.log('SMOKE ' + JSON.stringify(r));
    app.exit(r.openFn === 'function' && r.fileXHR === true ? 0 : 1);
  } catch (e) { console.log('SMOKE ERROR ' + e); app.exit(1); }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv, wd) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    openFiles(fileArgs(argv, wd));
  });
  app.on('open-file', (e, p) => { e.preventDefault(); openFiles([p]); }); // macOS dev runs
  app.whenReady().then(() => {
    pending.push(...fileArgs(process.argv));
    win = new BrowserWindow({
      width: 1440, height: 900, show: !SMOKE,
      icon: path.join(__dirname, 'icon.png'),
      autoHideMenuBar: true,
    });
    win.removeMenu();
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-finish-load', () => {
      pageLoaded = true;
      const f = pending; pending = [];
      openFiles(f);
      if (SMOKE) smoke();
    });
    win.loadFile('app.html');
    win.on('closed', () => { win = null; });
  });
  app.on('window-all-closed', () => app.quit());
}
JS

if [ "$1" = "smoke" ]; then
  echo "== smoke test (local Electron) =="
  PHOTOPEA_SMOKE=1 npx electron "$SRC"
  echo "smoke OK"
  exit 0
fi

echo "== windows icon (.ico) =="
npx png2icons "$SRC/icon.png" "$SRC/icon" -icowe >/dev/null 2>&1 || \
npx png2icons "$SRC/icon.png" "$SRC/icon" -ico   >/dev/null 2>&1 || \
echo "WARN: png2icons failed — Windows exe keeps the default Electron icon"

echo "== package (win32-x64, linux-x64) =="
EVER=$(node -p "require('electron/package.json').version")
rm -rf "$DIST"
npx @electron/packager "$SRC" Photopea \
  --platform=win32,linux --arch=x64 \
  --electron-version="$EVER" \
  --out="$DIST" --overwrite --asar \
  --icon="$SRC/icon" \
  --app-copyright="photopea.com" >/dev/null

WIN="$DIST/Photopea-win32-x64"
LIN="$DIST/Photopea-linux-x64"
[ -f "$WIN/Photopea.exe" ] || { echo "ERROR: Windows package missing." >&2; exit 1; }
[ -f "$LIN/Photopea" ]     || { echo "ERROR: Linux package missing." >&2; exit 1; }

# ---------- Windows: per-user "Open With" registration (no admin) ----------
{
  printf '@echo off\r\n'
  printf 'rem Registers this Photopea app in the "Open With" menu for design/image files (current user).\r\n'
  printf 'setlocal\r\n'
  printf 'reg add "HKCU\\Software\\Classes\\PhotopeaOffline.App" /ve /t REG_SZ /d "Photopea Offline" /f >nul\r\n'
  printf 'reg add "HKCU\\Software\\Classes\\PhotopeaOffline.App\\DefaultIcon" /ve /t REG_SZ /d "\\"%%~dp0Photopea.exe\\",0" /f >nul\r\n'
  printf 'reg add "HKCU\\Software\\Classes\\PhotopeaOffline.App\\shell\\open\\command" /ve /t REG_SZ /d "\\"%%~dp0Photopea.exe\\" \\"%%%%1\\"" /f >nul\r\n'
  for e in $EXTS; do
    printf 'reg add "HKCU\\Software\\Classes\\.%s\\OpenWithProgids" /v PhotopeaOffline.App /t REG_NONE /f >nul\r\n' "$e"
  done
  printf 'echo Done. Right-click a PSD/image ^> Open With ^> Photopea Offline.\r\n'
  printf 'pause\r\n'
} > "$WIN/Install-OpenWith.bat"
{
  printf '@echo off\r\n'
  printf 'rem Removes the Photopea Offline "Open With" association (current user).\r\n'
  printf 'reg delete "HKCU\\Software\\Classes\\PhotopeaOffline.App" /f >nul 2>nul\r\n'
  for e in $EXTS; do
    printf 'reg delete "HKCU\\Software\\Classes\\.%s\\OpenWithProgids" /v PhotopeaOffline.App /f >nul 2>nul\r\n' "$e"
  done
  printf 'echo Removed.\r\n'
  printf 'pause\r\n'
} > "$WIN/Uninstall-OpenWith.bat"

# ---------- Linux: menu entry + "Open With" (generates .desktop with absolute paths) ----------
MIME="image/vnd.adobe.photoshop;application/x-photoshop;application/postscript;application/illustrator;application/pdf;image/svg+xml;image/png;image/jpeg;image/gif;image/webp;image/avif;image/bmp;image/vnd.microsoft.icon;image/tiff;image/heif;image/x-tga;image/x-exr;image/x-portable-pixmap;image/x-portable-graymap;image/x-adobe-dng;image/x-canon-cr2;image/x-canon-cr3;image/x-nikon-nef;image/x-sony-arw;image/x-olympus-orf;image/x-panasonic-rw2;image/x-fuji-raf;image/x-samsung-srw;image/x-pentax-pef;audio/midi;audio/x-midi;application/vnd.recordare.musicxml;application/vnd.recordare.musicxml+xml;application/x-musescore;application/octet-stream;"
cp "$ICON_SRC" "$LIN/photopea-icon.png"
cat > "$LIN/install-openwith-linux.sh" <<SH
#!/bin/sh
# Installs a menu entry + "Open With" association for this Photopea app (current user).
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
APPS="\${XDG_DATA_HOME:-\$HOME/.local/share}/applications"
mkdir -p "\$APPS"
cat > "\$APPS/Photopea.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Photopea
Comment=Offline Photopea / Vectorpea / Jampea
Exec=\$DIR/Photopea %F
Icon=\$DIR/photopea-icon.png
Terminal=false
Categories=Graphics;Photography;
MimeType=$MIME
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "\$APPS"
echo "Installed. Right-click a PSD/image -> Open With -> Photopea."
echo "Uninstall: rm '\$APPS/Photopea.desktop'"
SH
chmod +x "$LIN/install-openwith-linux.sh" "$LIN/Photopea" 2>/dev/null || true

cat > "$WIN/README.txt" <<'TXT'
Photopea Offline (standalone, no Chrome needed)
  - Run Photopea.exe. Big-file friendly: the memory ceiling is raised to ~80% of your RAM
    (override: set PHOTOPEA_MAX_RAM_MB=16384 before launching).
  - Install-OpenWith.bat adds "Open With > Photopea Offline" for PSD/images (per-user, no admin).
  - Files opened while the app is running are sent to the existing window.
TXT
cat > "$LIN/README.txt" <<'TXT'
Photopea Offline (standalone, no Chrome needed)
  - Run ./Photopea. Big-file friendly: the memory ceiling is raised to ~80% of your RAM
    (override: PHOTOPEA_MAX_RAM_MB=16384 ./Photopea).
  - ./install-openwith-linux.sh adds a menu entry + "Open With" for PSD/images (per-user).
  - Files opened while the app is running are sent to the existing window.
TXT

echo "== zip =="
/usr/bin/ditto -c -k --norsrc --keepParent "$WIN" builds/Photopea-windows-app.zip
/usr/bin/ditto -c -k --norsrc --keepParent "$LIN" builds/Photopea-linux-app.zip

echo "Done:"
echo "  $WIN  -> builds/Photopea-windows-app.zip"
echo "  $LIN  -> builds/Photopea-linux-app.zip"
