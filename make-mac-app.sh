#!/bin/sh
# make-mac-app.sh — wrap builds/photopea-offline.html into a native macOS app (Photopea.app)
# that shows in the Dock with the Photopea icon. Uses WKWebView, no Chrome needed.
# The app is multi-edition: switch Photopea / Vectorpea / Jampea from the in-app top-bar toggle.
#
# Run:  sh make-mac-app.sh          (after 'python3 pack.py' produced builds/photopea-offline.html)
# Then: open builds/Photopea.app    (first launch: right-click -> Open to pass Gatekeeper)
set -e
cd "$(dirname "$0")"

HTML="builds/photopea-offline.html"
ICON_SRC="photopea.com/promo/icon512.png"
APP="builds/Photopea.app"
TITLE="Photopea"
[ -f "$HTML" ] || { echo "ERROR: $HTML not found — run 'python3 pack.py' first." >&2; exit 1; }
[ -f "$ICON_SRC" ] || { echo "ERROR: $ICON_SRC not found." >&2; exit 1; }

echo "Building $APP ..."
osascript -e 'tell application "Photopea" to quit' >/dev/null 2>&1 || true
pkill -x Photopea 2>/dev/null || true
rm -rf "$APP" build.iconset build_icon.png main.swift
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# icon: flatten to RGBA, then png -> .icns
sips -s format png "$ICON_SRC" --out build_icon.png >/dev/null
mkdir build.iconset
for s in 16 32 64 128 256 512; do
  sips -z $s $s build_icon.png --out "build.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d build_icon.png --out "build.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build.iconset -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf build.iconset build_icon.png

cp "$HTML" "$APP/Contents/Resources/app.html"

cat > main.swift <<SWIFT
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    func setupMenu() {
        let main = NSMenu()
        // App menu — gives Cmd+Q (Quit) and Cmd+H (Hide)
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "Hide ${TITLE}", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(NSMenuItem.separator())
        app.addItem(withTitle: "Quit ${TITLE}", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app
        // Edit menu — standard Cmd+Z/X/C/V/A for native text fields
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z"); redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        // Window menu — Cmd+M minimize, Cmd+W close
        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
    func applicationDidFinishLaunching(_ note: Notification) {
        setupMenu()
        let cfg = WKWebViewConfiguration()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 900)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.center()
        window.title = "${TITLE}"
        web = WKWebView(frame: frame, configuration: cfg)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.uiDelegate = self
        window.contentView = web
        if let url = Bundle.main.url(forResource: "app", withExtension: "html") {
            web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    // WKWebView does not show a file picker on its own — present NSOpenPanel for <input type=file>
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
SWIFT

echo "Compiling..."
swiftc -O -o "$APP/Contents/MacOS/Photopea" main.swift -framework Cocoa -framework WebKit
rm -f main.swift

VER=$(date +%s)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Photopea</string>
  <key>CFBundleDisplayName</key>       <string>Photopea</string>
  <key>CFBundleExecutable</key>        <string>Photopea</string>
  <key>CFBundleIdentifier</key>        <string>local.photopea.offline</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key>           <string>${VER}</string>
  <key>LSMinimumSystemVersion</key>    <string>13.3</string>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
xattr -cr "$APP" 2>/dev/null || true   # strip quarantine/provenance so Gatekeeper doesn't block launch
touch "$APP"

# Ship a one-click "trust" helper: on ANOTHER Mac the app arrives quarantined (it's ad-hoc signed,
# not notarized) and Gatekeeper blocks it. Double-clicking this clears quarantine on the app beside it.
cat > builds/Trust-Photopea.command <<'CMD'
#!/bin/sh
cd "$(dirname "$0")"
xattr -cr Photopea.app 2>/dev/null
xattr -dr com.apple.quarantine Photopea.app 2>/dev/null
echo "Photopea.app is now trusted on this Mac. You can open it (double-click)."
CMD
chmod +x builds/Trust-Photopea.command

echo "Done -> $APP"
echo "Launch:  open $APP     (first time: right-click -> Open to pass Gatekeeper)"
