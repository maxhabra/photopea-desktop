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
setlocal
set "HTML=file:///%~dp0photopea-offline.html"
set "HTML=%HTML:\=/%"
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
DIR="$(cd "$(dirname "$0")" && pwd)"
HTML="file://$DIR/photopea-offline.html"
UDD="${XDG_DATA_HOME:-$HOME/.local/share}/PhotopeaOffline"
FLAGS="--app=$HTML --user-data-dir=$UDD --allow-file-access-from-files --no-first-run"
for B in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser vivaldi; do
  if command -v "$B" >/dev/null 2>&1; then exec "$B" $FLAGS "$@"; fi
done
# macOS-installed Chrome (not on PATH)
if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" $FLAGS "$@"
fi
echo "No Chromium-based browser found. Install Chrome/Chromium/Edge, or open:"
echo "  $HTML"
command -v xdg-open >/dev/null 2>&1 && xdg-open "$HTML"
SH
chmod +x builds/photopea.sh

# ---------- Linux desktop entry (absolute paths for this machine) ----------
cat > builds/Photopea.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Photopea
Comment=Offline Photopea / Vectorpea / Jampea
Exec=$BUILDS/photopea.sh
Icon=$BUILDS/photopea-icon.png
Terminal=false
Categories=Graphics;Photography;
DESKTOP

echo "Done. In builds/:"
echo "  Windows:      Photopea.bat        (double-click)"
echo "  Linux/Unix:   photopea.sh         (./photopea.sh, or install Photopea.desktop)"
echo "  Linux menu:   cp builds/Photopea.desktop ~/.local/share/applications/"
echo "  macOS:        Photopea.app (native, from make-mac-app.sh) or photopea.sh"
