#!/usr/bin/env python3
"""
pack.py — bundle the whole offline Photopea into ONE self-contained HTML file.

Output: photopea-single.html  — open it directly (file://) or from any host, no server needed.

How it works:
  * CSS + the 3 JS bundles are gzip-compressed, base64-embedded, and decompressed at
    runtime with the browser's built-in DecompressionStream, then executed.
  * The 4 binary runtime assets Photopea still fetches (fribidi.wasm, hb.wasm,
    rsrc/basic/basic.zip, rsrc/basic/fa.zip) are embedded as base64 and served to the
    app by rewriting fetch()/XMLHttpRequest URLs to data: URLs.
  * Workers are already created from blob: URLs by Photopea, so they work on file://.

Run:  python3 pack.py     (from the project root, AFTER refresh.sh has patched the files)
"""
import base64, glob, gzip, os, sys

ROOT   = os.path.dirname(os.path.abspath(__file__))
APP    = os.path.join(ROOT, "photopea.com")   # app source files
BUILDS = os.path.join(ROOT, "builds")         # output
os.makedirs(BUILDS, exist_ok=True)
os.chdir(APP)

BUNDLE = next((f for f in glob.glob("code/pp/pp*.js") if not f.endswith(".orig")), None)
EXT    = next((f for f in glob.glob("code/ext/ext*.js") if not f.endswith(".orig")), None)
DBS    = next((f for f in glob.glob("code/dbs/DBS*.js") if not f.endswith(".orig")), None)
CSS    = "style/all10.css"
if not all([BUNDLE, EXT, DBS]) or not os.path.exists(CSS):
    sys.exit("ERROR: run from project root; need code/pp/pp*.js, code/ext/ext*.js, code/dbs/DBS*.js, style/all10.css")

def gz_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(gzip.compress(f.read(), 9)).decode()

def raw_b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode()

# One build serves all three editions (Photopea/Vectorpea/Jampea). They share the same bundle;
# only the `lg` flag differs, and an in-page top-bar switcher flips it (localStorage + reload).
print("Reading + compressing shared bundles (css/ext/dbs/pp)...")
CSS_GZ = gz_b64(CSS)
EXT_GZ = gz_b64(EXT)
DBS_GZ = gz_b64(DBS)
PP_GZ  = gz_b64(BUNDLE)

# binary assets the app fetches at runtime -> embed raw, serve via data: URL
ASSET_FILES = {
    "code/ext/fribidi.wasm": "code/ext/fribidi.wasm",
    "code/ext/hb.wasm":      "code/ext/hb.wasm",
    "rsrc/basic/basic.zip":  "rsrc/basic/basic.zip",
    "rsrc/basic/fa.zip":     "rsrc/basic/fa.zip",
}
print("Embedding binary assets...")
asset_entries = [
    '  %r: "data:application/octet-stream;base64,%s"' % (key, raw_b64(path))
    for key, path in ASSET_FILES.items() if os.path.exists(path)
]
# img/nft.png is referenced by an <img> but never shipped in this offline copy -> 1x1 transparent PNG
asset_entries.append(
    '  "img/nft.png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="'
)
# storage panels (Open From Storage -> This Device / Dropbox / ...) load code/storages/*.html into an
# iframe; embed them so the panel renders instead of a blank white area.
for p in sorted(glob.glob("code/storages/*.html")):
    key = p.replace(os.sep, "/")
    asset_entries.append('  %r: "data:text/html;charset=utf-8;base64,%s"' % (key, raw_b64(p)))
assets_js = ",\n".join(asset_entries)

# UI translations: code/lang/<index>.js — embed each gzip+base64, decompressed at runtime into __ASSET
import glob as _glob
lang_files = sorted(_glob.glob("code/lang/*.js"), key=lambda p: int(os.path.splitext(os.path.basename(p))[0]) if os.path.splitext(os.path.basename(p))[0].isdigit() else 0)
lang_entries = ['  "%s": "%s"' % (os.path.splitext(os.path.basename(p))[0], gz_b64(p)) for p in lang_files]
lang_js = ",\n".join(lang_entries)
print("Embedding %d language files..." % len(lang_files))

BOOTSTRAP_TMPL = """<script>
// ---- serve embedded binary assets to the app (fetch + XHR -> data: URL) ----
var __ASSET = {
%(ASSETS)s
};
// UI translations, gzip+base64 (index -> data). Decompressed into __ASSET at startup.
var __LANG = {
%(LANGS)s
};
function __matchAsset(u){ u=String(u); for(var k in __ASSET){ if(u.indexOf(k)!==-1) return k; } return null; }
// dead endpoints in the offline build (analytics / search / external services / Jampea soundfont we don't ship)
function __isDead(u){ u=String(u); return u.indexOf("papi/")!==-1 || u.indexOf("mirror.php")!==-1 || u.indexOf("//localhost")!==-1 || u.indexOf("zoner.com")!==-1 || u.indexOf("gallery.json")!==-1 || u.indexOf("rsrc/sf2")!==-1; }
(function(){
  // fetch: embedded asset -> data URL; dead endpoint -> resolve empty (analytics ignore the body)
  var of = window.fetch ? window.fetch.bind(window) : null;
  if(of) window.fetch = function(u,o){ var k=__matchAsset(u); if(k) return of(__ASSET[k], o); if(__isDead(u)) return Promise.resolve(new Response("[]",{status:200})); return of(u, o); };
  // XHR: embedded asset -> data URL; dead endpoint -> fail cleanly (fire onerror, never onload,
  //      so response parsers like aR.a2x never run on fake data)
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ var a=[].slice.call(arguments); var k=__matchAsset(u); this.__dead=false; if(k){ a[1]=__ASSET[k]; } else if(__isDead(u)){ this.__dead=true; a[1]="data:,"; } return oo.apply(this,a); };
  XMLHttpRequest.prototype.send = function(){ if(this.__dead){ var s=this; setTimeout(function(){ if(typeof s.onerror==="function"){ try{ s.onerror(new Event("error")); }catch(e){} } },0); return; } return os.apply(this,arguments); };
  // <img>/<link> src|href point at an embedded asset (e.g. img/nft.png) -> rewrite to data URL
  var osa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n,v){ if(n==="src"||n==="href"){ var k=__matchAsset(v); if(k) return osa.call(this,n,__ASSET[k]); } return osa.call(this,n,v); };
  // File System Access API doesn't work on file:// (not a secure context) and is absent in WKWebView.
  // Disable it so Photopea falls back to <input type=file> for open and <a download> for save.
  ["showOpenFilePicker","showSaveFilePicker","showDirectoryPicker"].forEach(function(k){
    try{ Object.defineProperty(window,k,{value:undefined,configurable:true,writable:true}); }
    catch(e){ try{ window[k]=undefined; }catch(e2){} }
  });
})();

// ---- gzip self-extract of CSS + JS bundles ----
var __CSS=%(CSS)s, __EXT=%(EXT)s, __DBS=%(DBS)s, __PP=%(PP)s;
async function __ungz(b64){
  var bin=atob(b64), u=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  if(typeof DecompressionStream==="undefined"){ alert("This browser lacks DecompressionStream (need Chrome/Edge/Safari 16.4+/Firefox 113+)."); throw "no DecompressionStream"; }
  var st=new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(st).arrayBuffer());
}
async function __ungzBytes(b64){
  var bin=atob(b64), u=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  var st=new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
function __bytesToB64(u8){ var s="",CH=0x8000; for(var i=0;i<u8.length;i+=CH){ s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(s); }
async function __loadLangs(){   // decompress each UI translation into __ASSET as a data: URL (served to the app's XHR)
  await Promise.all(Object.keys(__LANG).map(async function(k){
    try{ var by=await __ungzBytes(__LANG[k]); __ASSET["code/lang/"+k+".js"]="data:application/javascript;charset=utf-8;base64,"+__bytesToB64(by); }catch(e){}
  }));
}
function __run(code){ var s=document.createElement("script"); s.textContent=code; document.body.appendChild(s); }
// the single line in pp.js that picks the edition from the hostname; we overwrite it to force a mode
var __LG_ANCHOR='var lg=window.location.hostname.endsWith("jampea.com")?2:window.location.hostname=="www.vectorpea.com"?1:0';
function __getMode(){ try{ return parseInt(localStorage.getItem("__ppmode")||"0",10)||0; }catch(e){ return 0; } }
function __installSwitcher(mode){
  var names=["Photopea","Vectorpea","Jampea"];
  function add(){
    if(document.getElementById("__modesw")) return;
    var bar=document.createElement("div"); bar.id="__modesw";
    bar.style.cssText="position:fixed;top:4px;right:12px;z-index:2147483647;display:flex;gap:3px;font:11px -apple-system,'Segoe UI',sans-serif;-webkit-user-select:none;user-select:none;";
    for(var i=0;i<3;i++){ (function(i){
      var b=document.createElement("div"); b.textContent=names[i];
      b.style.cssText="padding:3px 9px;border-radius:5px;cursor:pointer;color:#fff;background:"+(mode===i?"#3482f6":"rgba(255,255,255,0.13)")+";";
      b.onmouseenter=function(){ if(mode!==i) b.style.background="rgba(255,255,255,0.25)"; };
      b.onmouseleave=function(){ if(mode!==i) b.style.background="rgba(255,255,255,0.13)"; };
      b.onclick=function(){ try{ localStorage.setItem("__ppmode",String(i)); }catch(e){} location.reload(); };
      bar.appendChild(b);
    })(i); }
    document.body.appendChild(bar);
  }
  add(); setTimeout(add,1500); setTimeout(add,4000);   // re-assert if the app re-lays-out the body
  // the "Loading local fonts" toast can hang in Vectorpea/Jampea offline — hide the stuck startup one (non-blocking)
  function killToast(){ var t=document.querySelectorAll(".alertcont .alertpanel"); for(var k=0;k<t.length;k++){ if(/^Loading/i.test((t[k].textContent||"").trim())) t[k].style.display="none"; } }
  setTimeout(killToast,6000); setTimeout(killToast,10000);
}
(async function(){
  try{
    var cap=document.getElementById("cap"); if(cap) cap.style.display="none";   // keep in DOM (showCap refs it), just hide
    try{ var pp=JSON.parse(localStorage.getItem("_ppp")||"{}"); pp.capShown="false"; localStorage.setItem("_ppp",JSON.stringify(pp)); }catch(e){}  // skip landing overlay at startup
    var __mode=__getMode();
    var st=document.createElement("style"); st.textContent=await __ungz(__CSS); document.head.appendChild(st);
    __run(await __ungz(__EXT));
    __run(await __ungz(__DBS));
    await __loadLangs();   // make all UI translations available before the app boots
    var __pp=await __ungz(__PP);
    if(__mode===1||__mode===2){ __pp=__pp.replace(__LG_ANCHOR,"var lg="+__mode); }   // Vectorpea / Jampea
    __run(__pp);                                                                       // pp.js self-initializes the app
    __installSwitcher(__mode);
  }catch(e){ document.body.innerHTML="<p style='color:#eee;font:16px sans-serif;padding:2em'>Failed to start: "+e+"</p>"; }
})();
</script>"""

import re
index_html = open("index.html", encoding="utf-8").read()

def build_page(bootstrap, favicon):
    html = index_html
    # strip external head refs that only 404 offline (SEO links, manifest, external thumbnail)
    html = re.sub(r'\s*<link rel="(canonical|alternate)"[^>]*>', '', html)
    html = re.sub(r'\s*<link[^>]*manifest[^>]*>', '', html)
    html = re.sub(r'\s*<meta name="thumbnail"[^>]*>', '', html)
    # embed the icon as favicon; blank data: URL also suppresses the /favicon.ico 404 on file://
    html = html.replace('</head>', '\t\t<link rel="icon" href="%s">\n\t</head>' % favicon, 1)
    # collapse the marketing landing block to an empty hidden placeholder (showCap only needs #cap to exist)
    i = html.rfind("<script>")
    cap = html.find('<div id="cap">')
    if cap != -1 and cap < i:
        html = html[:cap] + '<div id="cap" style="display:none"></div>\n\t\t' + html[i:]
    i = html.rfind("<script>")
    j = html.index("</script>", i) + len("</script>")
    if i == -1:
        sys.exit("ERROR: could not find the loader <script> in index.html")
    return html[:i] + bootstrap + html[j:]

bootstrap = BOOTSTRAP_TMPL % {"ASSETS": assets_js, "LANGS": lang_js, "CSS": '"'+CSS_GZ+'"',
                              "EXT": '"'+EXT_GZ+'"', "DBS": '"'+DBS_GZ+'"', "PP": '"'+PP_GZ+'"'}
_icon = "promo/icon512.png"
favicon = ("data:image/png;base64," + raw_b64(_icon)) if os.path.exists(_icon) else "data:,"
page = build_page(bootstrap, favicon)
OUT = os.path.join(BUILDS, "photopea-offline.html")
with open(OUT, "w", encoding="utf-8") as f:
    f.write(page)
print("\nWrote %s  (%.1f MB)" % (os.path.relpath(OUT, ROOT), os.path.getsize(OUT)/1024/1024))
print("Open it in a browser (file://). Switch Photopea / Vectorpea / Jampea from the top-right toggle.")
