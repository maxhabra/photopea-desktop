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

print("\n[2d] size-aware History cap to cut RAM on big files. Photopea keeps up to 20 undo states")
print("     (40 premium) regardless of document size — on a huge canvas that's GBs of snapshots.")
print("     Scale the cap by document pixel size: keep as many states as fit a ~1 GB budget")
print("     (one state costed as a full doc canvas, w*h*4), never fewer than 2, never more than")
print("     stock. Small docs are unaffected. Tunable at runtime: window.__ppHistBudget = bytes.")
# dX.prototype.Kj — the history-push trimmer; this = the document (s/T = pixel width/height).
# id.wr() (premium check) can throw in the offline build, which in STOCK code silently aborts
# the trimming right here -> history grows unbounded offline. Guard it (fall back to 20).
s = patch(s, "size-aware history cap (RAM)",
          'var R=id.wr()?40:20,b=0;',
          'var R=20,b=0;try{R=id.wr()?40:20}catch(e){}R=Math.max(2,Math.min(R,Math.floor((window.__ppHistBudget||1073741824)/(this.s*this.T*4||1))));window.__ppHistCap=R;')

print("\n[2e] Automate dialogs (Files -> Automate: Batch / Convert / Resize / ...): keep only the")
print("     'Local' source, drop 'Storage' (the cloud/storage browser doesn't work offline).")
s = patch(s, "Automate source: Local only",
          'this.qI=new iU([12,70],["Local",[1,19,0]]);',
          'this.qI=new iU([12,70],["Local"]);')

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
s = patch(s, "remove Window -> Plugins",
          ',{name:"Plugins",PX:!0}',
          '')
# More menu: drop 'Install Photopea' (PWA install — pointless offline) and 'About Photopea'.
# items[] and q_[] are parallel arrays built by .push(); remove BOTH pushes so they stay aligned.
s = patch(s, "remove More -> Install Photopea",
          'A.items.push({name:lg==0?[0,17,6]:"Install Vectorpea",d:function(F,$){return{d:$.fI!=null}}});\nA.q_.push({N:G.E.b,I:{v:G.m.bc}});',
          '')
s = patch(s, "remove More -> About Photopea",
          'A.items.push({name:"",d:function(F,$){return $.AX?{lh:"About "+["Photopea","Vectorpea"][lg],d:!0}:{lh:"",d:!1}}});\nA.q_.push({N:G.E.b,I:{v:G.m.Po,sY:"aboutpp"}});',
          '')
# File -> Open More: drop 'From Storage...' (cloud browser, dead offline) and 'PSD Templates...'
# (online gallery). items[].sub and q_[].sub are PARALLEL, so remove the same indices (1 and 4)
# in both to keep 'From Any Folder', 'Open from URL', 'Take a picture' aligned with their handlers.
s = patch(s, "Open More labels: drop Storage + PSD Templates",
          '[{name:"From Any Folder"},{name:[1,19,1],jF:!0,E9:[D,R,B.u2]},{name:[1,5],jF:!0},{name:[11,0],jF:!0},{name:["PSD VAR0",[25,0]],jF:!0}]',
          '[{name:"From Any Folder"},{name:[1,5],jF:!0},{name:[11,0],jF:!0}]')
s = patch(s, "Open More handlers: drop Storage + PSD Templates",
          '[{N:G.E.b,I:{v:G.m.pv,gn:!0}},{N:G.E.b,I:{v:G.m.Po,sY:"storwindow",kk:0}},{N:G.E.b,I:{v:G.m.Po,sY:"open_from_url"}},{N:G.E.b,I:{v:G.m.Po,sY:"camera"}},{N:G.E.b,I:{v:G.m.Po,sY:"res0"}}]',
          '[{N:G.E.b,I:{v:G.m.pv,gn:!0}},{N:G.E.b,I:{v:G.m.Po,sY:"open_from_url"}},{N:G.E.b,I:{v:G.m.Po,sY:"camera"}}]')

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
