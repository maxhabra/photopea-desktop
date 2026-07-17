#!/bin/sh
# make-launchers.sh — package the single-file build as a lightweight "app" on Windows and Linux
# (and macOS, as an alternative to the native .app). Each launcher opens photopea-offline.html in
# an installed Chromium browser's chromeless "app window" (Chrome/Edge/Chromium/Brave) — no bundling,
# no toolchain, tiny. Fully offline.
#
#   sh make-launchers.sh        (after 'python3 pack.py')
#
# Produces in builds/:
#   Photopea.bat        Windows  (Chrome or Edge --app)
#   photopea.sh         Linux/Unix/macOS  (chmod +x)
#   Photopea.desktop    Linux menu entry (absolute paths for this machine)
#   photopea-icon.png   icon used by the .desktop entry
set -e
cd "$(dirname "$0")"
[ -f builds/photopea-offline.html ] || { echo "ERROR: builds/photopea-offline.html missing — run 'python3 pack.py'." >&2; exit 1; }
BUILDS="$(cd builds && pwd)"

cp -f photopea.com/promo/icon512.png builds/photopea-icon.png

# ---------- Windows (.bat) ----------
cat > builds/Photopea.bat <<'BAT'
@echo off
rem Photopea Offline — opens the local single-file build as an app window (Chrome or Edge).
rem Optional argument: a file to open (used by "Open With" — see Install-OpenWith-Windows.bat).
setlocal
set "HTML=file:///%~dp0photopea-offline.html"
set "HTML=%HTML:\=/%"
if not "%~1"=="" (
  for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "$p=(Get-Item -LiteralPath '%~f1').FullName -replace '\\','/'; [uri]::EscapeUriString($p).Replace('#','%%23').Replace('?','%%3F').Replace(',','%%2C')"`) do set "HTML=%HTML%#open=file:///%%U"
)
set "UDD=%LOCALAPPDATA%\PhotopeaOffline"
set "FLAGS=--app=%HTML% --user-data-dir=%UDD% --allow-file-access-from-files --no-first-run"
for %%C in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do if exist "%%~C" ( start "" "%%~C" %FLAGS% & goto :eof )
where chrome >nul 2>nul && ( start "" chrome %FLAGS% & goto :eof )
rem fall back to Microsoft Edge (present on all Windows 10/11)
start "" msedge %FLAGS%
BAT

# ---------- Linux / Unix / macOS (.sh) ----------
cat > builds/photopea.sh <<'SH'
#!/bin/sh
# Photopea Offline — opens the local single-file build as an app window (Chromium-based browser).
# Any file paths given as arguments (or via "Open With" from the file manager) are opened in it.
DIR="$(cd "$(dirname "$0")" && pwd)"
HTML="file://$DIR/photopea-offline.html"

# build "#open=file:///a.psd,file:///b.png" from file arguments (URL-encoded)
enc() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,urllib.parse; p=sys.argv[1]; print("file://"+urllib.parse.quote(p, safe="/"))' "$1"
  else
    printf 'file://%s\n' "$1" | sed 's/ /%20/g; s/#/%23/g; s/?/%3F/g; s/,/%2C/g'
  fi
}
LIST=""
for f in "$@"; do
  [ -f "$f" ] || continue
  case "$f" in /*) ABS="$f";; *) ABS="$(pwd)/$f";; esac
  U="$(enc "$ABS")"
  [ -n "$LIST" ] && LIST="$LIST,$U" || LIST="$U"
done
[ -n "$LIST" ] && HTML="$HTML#open=$LIST"

UDD="${XDG_DATA_HOME:-$HOME/.local/share}/PhotopeaOffline"
FLAGS="--app=$HTML --user-data-dir=$UDD --allow-file-access-from-files --no-first-run"
for B in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser vivaldi; do
  if command -v "$B" >/dev/null 2>&1; then exec "$B" $FLAGS; fi
done
# macOS-installed Chrome (not on PATH)
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" $FLAGS
fi
echo "No Chromium-based browser found. Install Chrome/Chromium/Edge, or open:"
echo "  $HTML"
command -v xdg-open >/dev/null 2>&1 && xdg-open "$HTML"
SH
chmod +x builds/photopea.sh

# file extensions offered in "Open With" (keep in sync with FILE_EXTS in make-mac-app.sh)
EXTS="psd psb ai xd fig sketch pdf eps svg png jpg jpeg jfif gif webp avif bmp ico tif tiff tga dds heic exr ppm pgm dng cr2 cr3 nef arw orf rw2 raf srw pef mid midi gp gp3 gp4 gp5 gpx mscz mscx musicxml mxl sf2 sf3"

# ---------- Linux desktop entry (absolute paths for this machine) ----------
MIME="image/vnd.adobe.photoshop;application/x-photoshop;application/postscript;application/illustrator;application/pdf;image/svg+xml;image/png;image/jpeg;image/gif;image/webp;image/avif;image/bmp;image/vnd.microsoft.icon;image/tiff;image/heif;image/x-tga;image/x-exr;image/x-portable-pixmap;image/x-portable-graymap;image/x-adobe-dng;image/x-canon-cr2;image/x-canon-cr3;image/x-nikon-nef;image/x-sony-arw;image/x-olympus-orf;image/x-panasonic-rw2;image/x-fuji-raf;image/x-samsung-srw;image/x-pentax-pef;audio/midi;audio/x-midi;application/vnd.recordare.musicxml;application/vnd.recordare.musicxml+xml;application/x-musescore;application/octet-stream;"
cat > builds/Photopea.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Photopea
Comment=Offline Photopea / Vectorpea / Jampea
Exec=$BUILDS/photopea.sh %F
Icon=$BUILDS/photopea-icon.png
Terminal=false
Categories=Graphics;Photography;
MimeType=$MIME
DESKTOP

# ---------- Linux: install the menu entry + "Open With" association ----------
cat > builds/install-openwith-linux.sh <<'SH'
#!/bin/sh
# Registers Photopea Offline so it appears in the file manager's "Open With" menu.
DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
cp "$DIR/Photopea.desktop" "$APPS/Photopea.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS"
echo "Installed. Right-click a PSD/image -> Open With -> Photopea."
echo "Uninstall: rm '$APPS/Photopea.desktop'"
SH
chmod +x builds/install-openwith-linux.sh

# ---------- Windows: register/unregister the "Open With" association (per-user, no admin) ----------
{
  printf '@echo off\r\n'
  printf 'rem Registers Photopea Offline in the "Open With" menu for design/image files (current user).\r\n'
  printf 'setlocal\r\n'
  printf 'reg add "HKCU\\Software\\Classes\\PhotopeaOffline.File" /ve /t REG_SZ /d "Photopea Offline" /f >nul\r\n'
  printf 'reg add "HKCU\\Software\\Classes\\PhotopeaOffline.File\\shell\\open\\command" /ve /t REG_SZ /d "\\"%%~dp0Photopea.bat\\" \\"%%%%1\\"" /f >nul\r\n'
  for e in $EXTS; do
    printf 'reg add "HKCU\\Software\\Classes\\.%s\\OpenWithProgids" /v PhotopeaOffline.File /t REG_NONE /f >nul\r\n' "$e"
  done
  printf 'echo Done. Right-click a PSD/image ^> Open With ^> Photopea Offline.\r\n'
  printf 'pause\r\n'
} > builds/Install-OpenWith-Windows.bat

{
  printf '@echo off\r\n'
  printf 'rem Removes the Photopea Offline "Open With" association (current user).\r\n'
  printf 'reg delete "HKCU\\Software\\Classes\\PhotopeaOffline.File" /f >nul 2>nul\r\n'
  for e in $EXTS; do
    printf 'reg delete "HKCU\\Software\\Classes\\.%s\\OpenWithProgids" /v PhotopeaOffline.File /f >nul 2>nul\r\n' "$e"
  done
  printf 'echo Removed.\r\n'
  printf 'pause\r\n'
} > builds/Uninstall-OpenWith-Windows.bat

echo "Done. In builds/:"
echo "  Windows:      Photopea.bat        (double-click; accepts a file argument)"
echo "                Install-OpenWith-Windows.bat / Uninstall-OpenWith-Windows.bat"
echo "  Linux/Unix:   photopea.sh [files] (./photopea.sh, or install Photopea.desktop)"
echo "  Linux menu:   ./builds/install-openwith-linux.sh   (adds 'Open With > Photopea')"
echo "  macOS:        Photopea.app (native, from make-mac-app.sh) or photopea.sh"
