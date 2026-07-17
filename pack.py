#!/usr/bin/env python3
"""
pack.py — bundle the whole offline Photopea into ONE self-contained HTML file.

Output: builds/photopea-offline.html  — open it directly (file://) or from any host, no server.

How it works:
  * CSS + the 3 JS bundles are gzip-compressed and decompressed at runtime with the browser's
    built-in DecompressionStream, then executed.
  * The binary runtime assets Photopea fetches (fribidi.wasm, hb.wasm, rsrc/basic/*.zip) and the
    50 UI-language files are embedded and served by rewriting fetch()/XMLHttpRequest to data: URLs.
  * Every embedded blob is stored with a DENSE byte encoding (not base64): each byte is one
    Windows-1252 character (8 bits/char) instead of base64's 6 bits/char -> ~22% smaller than
    base64. The file is therefore saved as windows-1252 (see <meta charset>); do NOT re-save it as
    UTF-8. Bytes that break HTML/JS (NUL, CR, LF, '<', and the 5 undefined cp1252 bytes) are escaped
    with a 0x01 prefix; the remapped 0x80-0x9F range is recovered at runtime via a cp1252 table.
  * Workers are already created from blob: URLs by Photopea, so they work on file://.

Run:  python3 pack.py     (from the project root, AFTER refresh.sh has patched the files)
"""
import base64, datetime, glob, gzip, json, os, subprocess, sys

ROOT   = os.path.dirname(os.path.abspath(__file__))
APP    = os.path.join(ROOT, "photopea.com")
BUILDS = os.path.join(ROOT, "builds")
os.makedirs(BUILDS, exist_ok=True)
os.chdir(APP)

BUNDLE = next((f for f in glob.glob("code/pp/pp*.js") if not f.endswith(".orig")), None)
EXT    = next((f for f in glob.glob("code/ext/ext*.js") if not f.endswith(".orig")), None)
DBS    = next((f for f in glob.glob("code/dbs/DBS*.js") if not f.endswith(".orig")), None)
CSS    = "style/all10.css"
if not all([BUNDLE, EXT, DBS]) or not os.path.exists(CSS):
    sys.exit("ERROR: run from project root; need code/pp/pp*.js, code/ext/ext*.js, code/dbs/DBS*.js, style/all10.css")

# ---- dense encoding (windows-1252, 8 bits/char) ------------------------------------------------
_CP = {}
_UNDEF = []
for _b in range(0x80, 0xA0):
    try: _CP[_b] = ord(bytes([_b]).decode("cp1252"))
    except Exception: _UNDEF.append(_b)
_REV = {u: b for b, u in _CP.items()}          # unicode codepoint -> original byte (for JS)
ESC = [0, 1, 10, 13, 60] + _UNDEF              # NUL, prefix, LF, CR, '<', undefined-cp1252
_EIDX = {b: i for i, b in enumerate(ESC)}
assert len(ESC) <= 0x60, "too many escaped bytes for the 0xA0- marker range"

def dense(data):
    out = bytearray()
    for b in data:
        if b in _EIDX: out += bytes([1, 0xA0 + _EIDX[b]])
        else: out.append(b)
    return bytes(out)

def gz_dense(path):  return dense(gzip.compress(open(path, "rb").read(), 9))
def raw_dense(path): return dense(open(path, "rb").read())

# ---- collect blobs as text/plain <script> blocks -----------------------------------------------
print("Compressing bundles (css/ext/dbs/pp)...")
blocks = [("_c", gz_dense(CSS)), ("_e", gz_dense(EXT)), ("_d", gz_dense(DBS)), ("_p", gz_dense(BUNDLE))]

ASSET_FILES = {   # served raw (already-compressed) via data: URL, dense-encoded
    "code/ext/fribidi.wasm": "code/ext/fribidi.wasm",
    "code/ext/hb.wasm":      "code/ext/hb.wasm",
    "rsrc/basic/basic.zip":  "rsrc/basic/basic.zip",
    "rsrc/basic/fa.zip":     "rsrc/basic/fa.zip",
    "rsrc/sf2/MagicSF.zip":  "rsrc/sf2/MagicSF.zip",   # Jampea soundfont (music playback)
}
print("Embedding binary assets...")
amap = {}
for n, (key, path) in enumerate(p for p in ASSET_FILES.items()):
    if os.path.exists(path):
        bid = "_A%d" % n
        blocks.append((bid, raw_dense(path)))
        amap[bid] = key
    else:
        print("WARNING: %s missing — building without it (download it into photopea.com/ to include)." % path)

lang_files = sorted(glob.glob("code/lang/*.js"),
                    key=lambda p: int(os.path.splitext(os.path.basename(p))[0]) if os.path.splitext(os.path.basename(p))[0].isdigit() else 0)
lids = []
for p in lang_files:
    idx = os.path.splitext(os.path.basename(p))[0]
    bid = "_L" + idx
    blocks.append((bid, gz_dense(p)))
    lids.append(bid)
print("Embedding %d language files..." % len(lang_files))

# nft.png (1x1 transparent) stays a tiny inline data URL; favicon too
NFT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

# ---- bootstrap (placeholders @X@ avoid % / {} conflicts) ---------------------------------------
BOOTSTRAP = """<script>
var __ASSET = { "img/nft.png": "@NFT@" };
var __AMAP = @AMAP@;      // block-id -> asset path (raw bytes -> data: URL at startup)
var __LIDS = @LIDS@;      // language block-ids (index = id.slice(2))
var __REV = @REV@, __ESC = @ESC@;   // cp1252 recovery table + escaped bytes
function __dz(id){ var S=document.getElementById(id).textContent, u=new Uint8Array(S.length), n=0, cc;
  for(var i=0;i<S.length;){ cc=S.charCodeAt(i++); if(cc===1){ u[n++]=__ESC[(S.charCodeAt(i++)&255)-0xA0]; } else if(cc<256){ u[n++]=cc; } else { u[n++]=__REV[cc]; } }
  return u.subarray(0,n); }
function __matchAsset(u){ u=String(u); for(var k in __ASSET){ if(u.indexOf(k)!==-1) return k; } return null; }
function __isDead(u){ u=String(u); return u.indexOf("papi/")!==-1 || u.indexOf("mirror.php")!==-1 || u.indexOf("//localhost")!==-1 || u.indexOf("zoner.com")!==-1 || u.indexOf("gallery.json")!==-1 || u.indexOf("rsrc/sf2")!==-1; }
(function(){
  var of = window.fetch ? window.fetch.bind(window) : null;
  if(of) window.fetch = function(u,o){ var k=__matchAsset(u); if(k) return of(__ASSET[k], o); if(__isDead(u)) return Promise.resolve(new Response("[]",{status:200})); return of(u, o); };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ var a=[].slice.call(arguments); var k=__matchAsset(u); this.__dead=false; if(k){ a[1]=__ASSET[k]; } else if(__isDead(u)){ this.__dead=true; a[1]="data:,"; } return oo.apply(this,a); };
  XMLHttpRequest.prototype.send = function(){ if(this.__dead){ var s=this; setTimeout(function(){ if(typeof s.onerror==="function"){ try{ s.onerror(new Event("error")); }catch(e){} } },0); return; } return os.apply(this,arguments); };
  var osa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n,v){ if(n==="src"||n==="href"){ var k=__matchAsset(v); if(k) return osa.call(this,n,__ASSET[k]); } return osa.call(this,n,v); };
  ["showOpenFilePicker","showSaveFilePicker","showDirectoryPicker"].forEach(function(k){
    try{ Object.defineProperty(window,k,{value:undefined,configurable:true,writable:true}); }
    catch(e){ try{ window[k]=undefined; }catch(e2){} }
  });
})();
function __bytesToB64(u8){ var s="",CH=0x8000; for(var i=0;i<u8.length;i+=CH){ s+=String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(s); }
async function __ungz(id){
  if(typeof DecompressionStream==="undefined"){ alert("This browser lacks DecompressionStream (need Chrome/Edge/Safari 16.4+/Firefox 113+)."); throw "no DecompressionStream"; }
  var st=new Blob([__dz(id)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(st).arrayBuffer());
}
async function __ungzBytes(id){
  var st=new Blob([__dz(id)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(st).arrayBuffer());
}
function __loadAssets(){ for(var id in __AMAP){ __ASSET[__AMAP[id]]="data:application/octet-stream;base64,"+__bytesToB64(__dz(id)); } }
async function __loadLangs(){ await Promise.all(__LIDS.map(async function(id){ try{ var by=await __ungzBytes(id); __ASSET["code/lang/"+id.slice(2)+".js"]="data:application/javascript;charset=utf-8;base64,"+__bytesToB64(by); }catch(e){} })); }
function __run(code){ var s=document.createElement("script"); s.textContent=code; document.body.appendChild(s); }
var __LG_ANCHOR='var lg=window.location.hostname.endsWith("jampea.com")?2:window.location.hostname=="www.vectorpea.com"?1:0';
var __BUILD="@BUILD@";
var __BTC="bc1ps44wjx3wpu4s0xj746gz2lu45nspsm9059d3ym8xz0nrhu4psyasdgwwhx";
function __showAbout(){
  if(document.getElementById("__aboutov")) return;
  var ov=document.createElement("div"); ov.id="__aboutov";
  ov.style.cssText="position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:13px/1.55 -apple-system,'Segoe UI',sans-serif;";
  var bx=document.createElement("div");
  bx.style.cssText="max-width:440px;background:#2a2a2a;color:#e8e8e8;border-radius:10px;padding:22px 24px;box-shadow:0 10px 40px rgba(0,0,0,.6);position:relative;";
  var x=document.createElement("div"); x.textContent="\\u00d7";
  x.style.cssText="position:absolute;top:8px;right:14px;font-size:22px;cursor:pointer;color:#aaa;line-height:1;";
  x.onclick=function(){ ov.remove(); };
  var copy=document.createElement("span");
  copy.textContent=" (Click to Copy)"; copy.style.cssText="cursor:pointer;color:#3482f6;";
  var btc=document.createElement("code");
  btc.textContent=__BTC; btc.style.cssText="word-break:break-all;color:#f0b429;cursor:pointer;";
  function doCopy(){ var t=document.createElement("textarea"); t.value=__BTC; document.body.appendChild(t); t.select();
    try{ document.execCommand("copy"); }catch(e){} try{ navigator.clipboard&&navigator.clipboard.writeText(__BTC); }catch(e){}
    t.remove(); copy.textContent=" (Copied!)"; setTimeout(function(){ copy.textContent=" (Click to Copy)"; },1500); }
  btc.onclick=doCopy; copy.onclick=doCopy;
  var h=document.createElement("div");
  h.style.cssText="font-size:15px;font-weight:600;margin-bottom:2px;";
  h.textContent="High performance offline patch, based on Photopea";
  var v=document.createElement("div"); v.style.cssText="color:#9aa;margin-bottom:2px;"; v.textContent="Version "+__BUILD;
  var by=document.createElement("div"); by.style.cssText="color:#9aa;margin-bottom:14px;"; by.textContent="By ptrinh @ SenPrints";
  var hr=document.createElement("div"); hr.style.cssText="border-top:1px solid #444;margin:0 0 14px;";
  var d1=document.createElement("div"); d1.style.cssText="margin-bottom:4px;"; d1.textContent="To donate to ptrinh for the patch:";
  var d2=document.createElement("div"); d2.style.cssText="margin-bottom:16px;"; d2.appendChild(document.createTextNode("Send BTC to ")); d2.appendChild(btc); d2.appendChild(copy);
  var d3=document.createElement("div"); d3.style.cssText="margin-bottom:4px;"; d3.textContent="To donate to Photopea for his dedicated work:";
  var a=document.createElement("a"); a.href="https://www.photopea.com"; a.target="_blank"; a.rel="noopener";
  a.textContent="https://photopea.com"; a.style.cssText="color:#3482f6;";
  var d4=document.createElement("div"); d4.appendChild(a);
  bx.appendChild(x); bx.appendChild(h); bx.appendChild(v); bx.appendChild(by); bx.appendChild(hr);
  bx.appendChild(d1); bx.appendChild(d2); bx.appendChild(d3); bx.appendChild(d4);
  ov.appendChild(bx);
  ov.onclick=function(e){ if(e.target===ov) ov.remove(); };
  document.body.appendChild(ov);
}
function __installBadge(){
  function add(){
    if(document.getElementById("__eov")) return;
    var imgs=document.getElementsByTagName("img");
    for(var i=0;i<imgs.length;i++){ var im=imgs[i];
      if(im.clientWidth>250 && String(im.src).lastIndexOf("data:image/svg",0)===0 && im.className.indexOf("gsicon")===-1){
        var d=document.createElement("div"); d.id="__eov"; d.textContent="Enhanced Offline Version";
        d.style.cssText="position:relative;z-index:5;text-align:center;color:#fff;font:600 22px/1 -apple-system,'Segoe UI',sans-serif;letter-spacing:.04em;cursor:pointer;margin:-14px 0 12px;-webkit-user-select:none;user-select:none;";
        d.onmouseenter=function(){ d.style.textDecoration="underline"; };
        d.onmouseleave=function(){ d.style.textDecoration="none"; };
        function open(e){ e.stopPropagation(); e.preventDefault(); __showAbout(); }
        d.addEventListener("mousedown",open,true); d.addEventListener("click",function(e){ e.stopPropagation(); },true);
        im.parentNode.insertBefore(d, im.nextSibling);
        return;
      }
    }
  }
  add();
  new MutationObserver(add).observe(document.body,{childList:true,subtree:true});
}
// ---- open local files passed by the OS (file association / "Open With") ----------------------
// Injects bytes as a synthetic drag-and-drop so Photopea keeps the real file name.
function __openU8(name,u8){
  var tries=0;
  (function go(){
    var tgt=document.querySelector("div.body");
    if(!tgt||!document.querySelector("div.topbar")){ if(tries++<150) setTimeout(go,300); return; }
    setTimeout(function(){
      try{
        var f=new File([u8],name),dt=new DataTransfer(); dt.items.add(f);
        var ev=new Event("drop",{bubbles:true,cancelable:true});
        Object.defineProperty(ev,"dataTransfer",{value:dt});
        tgt.dispatchEvent(ev);
      }catch(e){ try{ window.postMessage(u8.buffer,"*"); }catch(e2){} }
    },400);
  })();
}
window.__openLocalB64=function(name,b64){ var bin=atob(b64),u=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); __openU8(name,u); };
function __openHashFiles(){
  var h=location.hash||"";
  if(h.lastIndexOf("#open=",0)!==0) return;
  try{ history.replaceState(null,"",location.pathname+location.search); }catch(e){}
  h.slice(6).split(",").forEach(function(p){
    if(!p) return;
    var url=p.indexOf("%")!==-1?p:encodeURI(p);   // accept both encoded and raw file:// URLs
    var name;
    try{ name=decodeURIComponent(url.split("/").pop().split("?")[0]); }catch(e){ name=url.split("/").pop(); }
    var x=new XMLHttpRequest();                    // XHR (not fetch): file:// works with the browser flag
    x.open("GET",url,true); x.responseType="arraybuffer";
    x.onload=function(){ if(x.response) __openU8(name,new Uint8Array(x.response)); };
    x.onerror=function(){ alert("Could not open: "+name); };
    x.send();
  });
}
function __getMode(){ try{ return parseInt(localStorage.getItem("__ppmode")||"0",10)||0; }catch(e){ return 0; } }
function __installSwitcher(mode){
  var names=["Photopea","Vectorpea","Jampea"];
  function add(){
    if(document.getElementById("__modesw")) return;
    var bar=document.createElement("div"); bar.id="__modesw";
    bar.style.cssText="position:fixed;top:4px;right:12px;z-index:2147483647;display:flex;gap:3px;font:11px -apple-system,'Segoe UI',sans-serif;-webkit-user-select:none;user-select:none;";
    var ab=document.createElement("div"); ab.textContent="About Patch";
    ab.style.cssText="padding:3px 9px;border-radius:5px;cursor:pointer;color:#fff;background:rgba(255,255,255,0.13);";
    ab.onmouseenter=function(){ ab.style.background="rgba(255,255,255,0.25)"; };
    ab.onmouseleave=function(){ ab.style.background="rgba(255,255,255,0.13)"; };
    ab.onclick=__showAbout; bar.appendChild(ab);
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
  add(); setTimeout(add,1500); setTimeout(add,4000);
  function killToast(){ var t=document.querySelectorAll(".alertcont .alertpanel"); for(var k=0;k<t.length;k++){ if(/^Loading/i.test((t[k].textContent||"").trim())) t[k].style.display="none"; } }
  setTimeout(killToast,6000); setTimeout(killToast,10000);
}
(async function(){
  try{
    var cap=document.getElementById("cap"); if(cap) cap.style.display="none";
    try{ var pp=JSON.parse(localStorage.getItem("_ppp")||"{}"); pp.capShown="false"; localStorage.setItem("_ppp",JSON.stringify(pp)); }catch(e){}
    var __mode=__getMode();
    __loadAssets();
    var st=document.createElement("style"); st.textContent=await __ungz("_c"); document.head.appendChild(st);
    __run(await __ungz("_e"));
    __run(await __ungz("_d"));
    await __loadLangs();
    var __pp=await __ungz("_p");
    if(__mode===1||__mode===2){ __pp=__pp.replace(__LG_ANCHOR,"var lg="+__mode); }
    __run(__pp);
    __installSwitcher(__mode);
    __installBadge();
    __openHashFiles();
  }catch(e){ document.body.innerHTML="<p style='color:#eee;font:16px sans-serif;padding:2em'>Failed to start: "+e+"</p>"; }
})();
</script>"""
BUILD = datetime.datetime.now().strftime("%Y%m%d%H%M")
BOOTSTRAP = (BOOTSTRAP.replace("@BUILD@", BUILD)
                     .replace("@NFT@", NFT)
                     .replace("@AMAP@", json.dumps(amap))
                     .replace("@LIDS@", json.dumps(lids))
                     .replace("@REV@", json.dumps(_REV))
                     .replace("@ESC@", json.dumps(ESC)))

# ---- hybrid low-RAM preview (bundled from ../viewer/hybrid.js via esbuild) ---------------------
# Installs a FileReader hook that opens large PSDs as a downscaled proxy (real layer tree, low RAM)
# and escalates to the full-res original on demand. Must run BEFORE Photopea reads any file.
HYBRID = ""
_hybrid_src = os.path.join(ROOT, "viewer", "hybrid.js")
_esbuild = os.path.join(ROOT, "node_modules", ".bin", "esbuild")
if os.path.exists(_hybrid_src) and os.path.exists(_esbuild):
    print("Bundling hybrid preview (esbuild)...")
    js = subprocess.check_output([_esbuild, _hybrid_src, "--bundle", "--format=iife", "--minify"],
                                 cwd=ROOT).decode("utf-8")
    js.encode("latin-1")                       # fail loudly if the bundle isn't windows-1252 safe
    HYBRID = "<script>" + js.replace("</script>", "<\\/script>") + "</script>"
else:
    print("WARNING: viewer/hybrid.js or esbuild missing — building without hybrid preview.")

# ---- assemble the page as bytes (windows-1252) -------------------------------------------------
import re
index_html = open("index.html", encoding="utf-8-sig").read()   # utf-8-sig strips a leading BOM
_icon = "promo/icon512.png"
favicon = ("data:image/png;base64," + base64.b64encode(open(_icon, "rb").read()).decode()) if os.path.exists(_icon) else "data:,"

html = index_html
html = re.sub(r'<meta charset="[^"]*"\s*/?>', '<meta charset="windows-1252">', html, count=1)
html = re.sub(r'\s*<link rel="(canonical|alternate)"[^>]*>', '', html)
html = re.sub(r'\s*<link[^>]*manifest[^>]*>', '', html)
html = re.sub(r'\s*<meta name="thumbnail"[^>]*>', '', html)
html = html.replace('</head>', '\t\t<link rel="icon" href="%s">\n\t</head>' % favicon, 1)
i = html.rfind("<script>")
cap = html.find('<div id="cap">')
if cap != -1 and cap < i:
    html = html[:cap] + '<div id="cap" style="display:none"></div>\n\t\t' + html[i:]
i = html.rfind("<script>")
j = html.index("</script>", i) + len("</script>")

blocks_bytes = b"".join(('<script type="text/plain" id="%s">' % bid).encode("latin-1") + data + b"</script>"
                        for bid, data in blocks)

page = (html[:i].encode("latin-1") + blocks_bytes + HYBRID.encode("latin-1")
        + BOOTSTRAP.encode("latin-1") + html[j:].encode("latin-1"))
OUT = os.path.join(BUILDS, "photopea-offline.html")
with open(OUT, "wb") as f:
    f.write(page)
print("\nWrote %s  (%.2f MB, dense/windows-1252)" % (os.path.relpath(OUT, ROOT), len(page)/1024/1024))
print("Open it in a browser (file://). Switch Photopea / Vectorpea / Jampea from the top-right toggle.")
