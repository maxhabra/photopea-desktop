#!/bin/sh
# make-viewer.sh — bundle the lightweight lazy PSD viewer into one self-contained builds/viewer.html.
# Shows the flattened composite instantly and decodes layers only when toggled (low RAM, fast open).
#   sh make-viewer.sh
set -e
cd "$(dirname "$0")"
[ -x node_modules/.bin/esbuild ] || { echo "Run 'npm install' first (needs esbuild + @webtoon/psd)."; exit 1; }

mkdir -p builds
BUNDLE=$(node_modules/.bin/esbuild viewer/src.js --bundle --format=iife --minify)

cat > builds/viewer.html <<HTML
<!doctype html>
<html><head><meta charset="utf-8"><title>PSD Viewer</title>
<style>
  :root{color-scheme:dark}
  html,body{margin:0;height:100%;background:#1e1e1e;color:#ddd;font:13px -apple-system,'Segoe UI',sans-serif;overflow:hidden}
  #bar{height:34px;display:flex;align-items:center;gap:12px;padding:0 12px;background:#2a2a2a;border-bottom:1px solid #000}
  #bar b{font-size:13px} #title{opacity:.7}
  button{background:#3a3a3a;color:#eee;border:0;border-radius:5px;padding:5px 12px;cursor:pointer}
  button:hover{background:#4a4a4a}
  #main{display:flex;height:calc(100% - 34px)}
  #stage{flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;background:#141414;background-image:linear-gradient(45deg,#222 25%,transparent 25%),linear-gradient(-45deg,#222 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#222 75%),linear-gradient(-45deg,transparent 75%,#222 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
  #cv{max-width:100%;max-height:100%;box-shadow:0 0 30px #000}
  #side{width:250px;background:#242424;border-left:1px solid #000;display:flex;flex-direction:column}
  #side h3{margin:0;padding:8px 12px;font-size:12px;color:#999;border-bottom:1px solid #000}
  #layers{flex:1;overflow:auto}
  .row{display:flex;align-items:center;gap:8px;padding:5px 12px;cursor:pointer;border-bottom:1px solid #2e2e2e}
  .row:hover{background:#2e2e2e} .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #status{padding:5px 12px;font-size:11px;color:#888;border-top:1px solid #000}
  body.drag #stage{outline:3px dashed #3482f6;outline-offset:-8px}
  #hint{color:#777;text-align:center}
</style></head>
<body>
  <div id="bar"><b>PSD Viewer</b><span id="title"></span><span style="flex:1"></span>
    <button onclick="document.getElementById('file').click()">Open PSD…</button>
    <button class="needsfile" disabled onclick="window.__exportImage('image/png','png')">Export PNG</button>
    <button class="needsfile" disabled onclick="window.__exportImage('image/jpeg','jpg',0.92)">Export JPG</button>
    <button class="needsfile" disabled onclick="window.__editInPhotopea()" style="background:#3482f6">Edit in Photopea →</button>
    <input id="file" type="file" accept=".psd,.psb" style="display:none">
  </div>
  <div id="main">
    <div id="stage"><canvas id="cv" width="1" height="1"></canvas><div id="hint">Drop a .psd here, or click "Open PSD…"</div></div>
    <div id="side"><h3>LAYERS</h3><div id="layers"></div><div id="status">ready</div></div>
  </div>
  <script>$BUNDLE</script>
  <script>document.getElementById('file').addEventListener('change',function(){var h=document.getElementById('hint');if(h)h.style.display='none'});</script>
</body></html>
HTML

echo "Wrote builds/viewer.html ($(du -h builds/viewer.html | cut -f1)). Open it and drop a PSD."
