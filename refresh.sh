#!/bin/sh
# refresh.sh — rebuild the Photopea offline patch on top of a fresh photopea.com download.
#
# Usage:
#   sh refresh.sh            # patch index.html + the code/pp/pp*.js bundle in place (idempotent)
#   sh refresh.sh --reset    # first restore each file from its .orig backup, then patch
#
# See refresh.md for the rationale behind every change. Safe to re-run: each edit is guarded,
# already-applied edits are skipped, and URL rewrites are naturally idempotent.
set -e
cd "$(dirname "$0")/photopea.com"   # the app lives here; tools stay in the parent

# --- locate the main bundle (filename is versioned, e.g. pp1784151871.js) ---
BUNDLE=$(ls code/pp/pp*.js 2>/dev/null | grep -v '\.orig$' | head -n1)
INDEX="index.html"
if [ -z "$BUNDLE" ] || [ ! -f "$INDEX" ]; then
  echo "ERROR: could not find index.html and/or code/pp/pp*.js — run from the project root." >&2
  exit 1
fi
echo "Bundle: $BUNDLE"
echo "Index:  $INDEX"

# --- optional: restore pristine copies from .orig backups ---
if [ "$1" = "--reset" ]; then
  for f in "$INDEX" "$BUNDLE"; do
    if [ -f "$f.orig" ]; then cp "$f.orig" "$f"; echo "reset $f from $f.orig"; fi
  done
fi

# --- do the actual work in Python (regex for URLs, literal guarded edits for logic) ---
BUNDLE="$BUNDLE" INDEX="$INDEX" python3 - <<'PYEOF'
import os, re, sys

BUNDLE = os.environ["BUNDLE"]
INDEX  = os.environ["INDEX"]
PORT   = "8899"                      # change here if you serve on a different port
ok = warn = 0

def rewrite_urls(s):
    # https://[www.]photopea.com  and  http://photopea.com  ->  http://localhost
    s = re.sub(r'https?://(?:www\.)?photopea\.com', 'http://localhost', s)
    # //www.photopea.com , //blog.photopea.com  (protocol-relative)  ->  //localhost
    s = re.sub(r'//(?:www|blog)\.photopea\.com', '//localhost', s)
    # bare "www.Photopea.com" in visible text
    s = re.sub(r'www\.[Pp]hotopea\.com', 'localhost', s)
    # bare photopea.com in domain checks/text, but NOT when preceded by word char / @ / / / .
    #   -> keeps support@photopea.com, ad-slot IDs (.../photopea.com_rewarded), *.photopea.com
    s = re.sub(r'(?<![\w@/.])photopea\.com', 'localhost', s)
    # restore the contact email if the previous rule happened to catch it
    s = s.replace('support@localhost', 'support@photopea.com')
    # add the port to every //localhost that doesn't already have one
    s = re.sub(r'//localhost(?![:.\w])', '//localhost:' + PORT, s)
    return s

def patch(s, name, before, after):
    """Idempotent literal replace. Reports applied / already-done / anchor-missing."""
    global ok, warn
    if after in s and before not in s:
        print("  = already applied: %s" % name); ok += 1; return s
    n = s.count(before)
    if n == 1:
        print("  + patched: %s" % name); ok += 1; return s.replace(before, after)
    if n == 0:
        print("  ! ANCHOR NOT FOUND: %s  (bundle may have changed — fix by hand)" % name); warn += 1; return s
    print("  ! anchor not unique (%dx): %s — skipped" % (n, name)); warn += 1
    return s

# ---------- bundle (code/pp/pp*.js) ----------
s = open(BUNDLE, encoding="utf-8").read()
print("\n[1] URL rewrites -> localhost:%s (bundle)" % PORT)
s = rewrite_urls(s)
print("  + done")

print("\n[1b] disable ads / tracking")
s = patch(s, "id.xG local CDN",
          'id.xG=function(B){var R=location.href;',
          'id.xG=function(B){return "//localhost:%s/"+B;\nvar R=location.href;' % PORT)
s = patch(s, "fN.X1 return 0",
          'fN.X1=function(){var B=',
          'fN.X1=function(){return 0;\nvar B=')
s = patch(s, "fN.azv return",
          'fN.azv=function(){var B=',
          'fN.azv=function(){return;\nvar B=')
s = patch(s, "ad-injection off",
          'if(!fN.zM()&&!fN.X1()&&T&&B*R>300*300){',
          'if(false){')

print("\n[2] localhost domain-gate fixes (menus + layout)")
s = patch(s, "azP menu fix",
          'E.azP=function(){var B=E.A2();if(B=="")return 0;',
          'E.azP=function(){var B=E.A2();if(B=="")return 1;')
s = patch(s, "no-ad full width",
          '||E.A2()==j_.ai("YMVVHAj=FA");',
          '||E.A2()==j_.ai("YMVVHAj=FA")||true;')

print("\n[2b] file:// / WKWebView: open-file picker uses input.click() (a synthetic dispatchEvent is untrusted and won't open the dialog)")
s = patch(s, "open-file uses .click()",
          'var l=document.createEvent("MouseEvents");l.initMouseEvent("click",!0,!0,document.defaultView,1,0,0,0,0,!1,!1,!1,!1,0,null);\nm.dispatchEvent(l)',
          'm.click()')

print("\n[2c] File->Open uses the native OS file picker instead of the 'Open From Storage' dialog")
print("     (the storage browser needs File System Access / a real origin, which don't work offline -> blank panel)")
s = patch(s, "File->Open goes native",
          'if(F!=!0&&$!=!0&&this.GM("open"))return;',
          'if(F!=!0&&$!=!0&&false)return;')

print("\n[2d] lower default History states to cut RAM on big files (j1=general, HH=large-doc; each undo step keeps pixel data in RAM). Users can still change these in Edit -> Settings.")
s = patch(s, "fewer history states (RAM)",
          'j1:20,HH:0',
          'j1:12,HH:4')

print("\n[3] hide unwanted UI")
s = patch(s, "hide Home sidebar",
          'if(this.xL){U=[[[1,19,3],null,"strg/home"]].concat(U.concat(jv.WW));',
          'if(this.xL){D=0;this.et.style.display="none";U=[[[1,19,3],null,"strg/home"]].concat(U.concat(jv.WW));')
s = patch(s, "hide Generate with AI",
          '"+ee.get(R[f]);\nvar D="l"+"o"+"g"+"o"',
          '"+ee.get(R[f]);\nif(B[4])B[4].style.display="none";\nvar D="l"+"o"+"g"+"o"')
s = patch(s, "hide top-right links",
          'var e=this.agR&&B>U+m;',
          'var e=false;')
s = patch(s, "hide Account button",
          'if(B.AX){U.appendChild(this.cF.$)}',
          'if(false){U.appendChild(this.cF.$)}')

open(BUNDLE, "w", encoding="utf-8").write(s)

# ---------- index.html ----------
h = open(INDEX, encoding="utf-8").read()
print("\n[1] URL rewrites -> localhost:%s (index.html)" % PORT)
h = rewrite_urls(h)
print("  + done")
print("\n[3] skip landing page, go straight to the app")
h = patch(h, "skip landing page",
          'if(href.indexOf("#")!=-1 || href.indexOf("=")!=-1 || ppp["capShown"]=="false") addPP();',
          'if(true) addPP();')
open(INDEX, "w", encoding="utf-8").write(h)

print("\nSummary: %d applied/ok, %d warnings" % (ok, warn))
sys.exit(1 if warn else 0)
PYEOF

echo
echo "Done. Start with:  sh start.sh   then open  http://localhost:8899/"
echo "(hard-refresh the browser tab: Cmd+Shift+R — the bundle is cached)"
