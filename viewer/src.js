// Lightweight PSD viewer — shows the flattened composite instantly, decodes layers lazily on toggle.
// Bundled by make-viewer.sh into a single self-contained viewer.html.
import Psd from '@webtoon/psd';

const BLEND = { // PSD blend mode -> canvas globalCompositeOperation (viewing approximation)
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color dodge': 'color-dodge', 'color burn': 'color-burn',
  'hard light': 'hard-light', 'soft light': 'soft-light', difference: 'difference',
  exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

let psd = null;
let fileBuf = null;               // the raw PSD ArrayBuffer (kept for lazy decode + Photopea hand-off)
let fileName = 'image';
const cache = new Map();          // layer -> offscreen canvas (lazy)
const visible = new Set();        // layers currently shown

const $ = (id) => document.getElementById(id);
const cv = () => $('cv'), ctx = () => cv().getContext('2d');
function status(t) { $('status').textContent = t; }

function layerToCanvas(layer, rgba) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, layer.width); c.height = Math.max(1, layer.height);
  const id = new ImageData(new Uint8ClampedArray(rgba), c.width, c.height);
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

async function ensureLayer(layer) {
  let c = cache.get(layer);
  if (!c) { const rgba = await layer.composite(); c = layerToCanvas(layer, rgba); cache.set(layer, c); }
  return c;
}

async function recomposite() {
  const g = ctx();
  g.clearRect(0, 0, cv().width, cv().height);
  const t0 = performance.now();
  // psd.layers is bottom-to-top already
  for (const layer of psd.layers) {
    if (!visible.has(layer) || !layer.width || !layer.height) continue;
    const c = await ensureLayer(layer);
    g.globalAlpha = (layer.opacity ?? 255) / 255;
    g.globalCompositeOperation = BLEND[(layer.blendMode || 'normal').toLowerCase()] || 'source-over';
    g.drawImage(c, layer.left || 0, layer.top || 0);
  }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  status(`${visible.size}/${psd.layers.length} layers · recomposited in ${Math.round(performance.now() - t0)}ms`);
}

async function showComposite() {
  const g = ctx();
  const t0 = performance.now();
  const rgba = await psd.composite();   // the PSD's flattened preview — fast, accurate
  g.putImageData(new ImageData(new Uint8ClampedArray(rgba), psd.width, psd.height), 0, 0);
  status(`composite ${psd.width}×${psd.height} · ${psd.layers.length} layers · ${Math.round(performance.now() - t0)}ms`);
}

function buildPanel() {
  const p = $('layers'); p.innerHTML = '';
  // list top-to-bottom for readability (reverse of composite order)
  [...psd.layers].reverse().forEach((layer) => {
    const row = document.createElement('label'); row.className = 'row';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !layer.hidden;
    if (cb.checked) visible.add(layer);
    cb.onchange = async () => { cb.checked ? visible.add(layer) : visible.delete(layer); await recomposite(); };
    const name = document.createElement('span'); name.className = 'nm';
    name.textContent = layer.name || '(layer)';
    row.append(cb, name); p.appendChild(row);
  });
}

async function openFile(file) {
  status('reading ' + (file.size / 1073741824).toFixed(2) + ' GB …');
  const t0 = performance.now();
  fileBuf = await file.arrayBuffer();
  fileName = (file.name || 'image').replace(/\.[^.]+$/, '');
  psd = Psd.parse(fileBuf);
  cache.clear(); visible.clear();
  const c = cv(); c.width = psd.width; c.height = psd.height;
  $('title').textContent = file.name;
  await showComposite();
  buildPanel();
  document.querySelectorAll('.needsfile').forEach((b) => (b.disabled = false));
  window.__opened = { ms: Math.round(performance.now() - t0), w: psd.width, h: psd.height, layers: psd.layers.length };
}

// export the current canvas (composite with the current layer toggles)
function exportImage(mime, ext, quality) {
  cv().toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    status('exported ' + a.download + ' (' + Math.round(blob.size / 1024) + ' KB)');
  }, mime, quality);
}
window.__exportImage = exportImage;

// escalate to the full Photopea editor (loads it lazily, hands off THIS file, frees viewer memory)
function editInPhotopea() {
  if (!fileBuf) return;
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#181818';
  ov.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#888;font:14px sans-serif">Loading Photopea…</div>';
  const fr = document.createElement('iframe');
  fr.style.cssText = 'width:100%;height:100%;border:0;position:relative;z-index:1';
  fr.src = 'photopea-offline.html';
  ov.appendChild(fr);
  document.body.appendChild(ov);
  const buf = fileBuf;
  // free the viewer's own decoded data (Photopea will own the file)
  psd = null; cache.clear(); visible.clear(); fileBuf = null;
  const nm = fileName;
  fr.onload = () => setTimeout(() => {
    try {
      // open the file, then set its name in Photopea
      fr.contentWindow.postMessage(buf, '*', [buf]);   // transfer — no copy
      setTimeout(() => { try { fr.contentWindow.postMessage('app.activeDocument.name="' + nm + '.psd";', '*'); } catch (e) {} }, 1500);
    } catch (e) { console.error(e); }
  }, 6500);   // Photopea boots ~5-7s
}
window.__editInPhotopea = editInPhotopea;

// ---- wire up UI ----
window.addEventListener('DOMContentLoaded', () => {
  $('file').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); });
  const drop = document.body;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
  drop.addEventListener('dragleave', () => document.body.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drag'); if (e.dataTransfer.files[0]) openFile(e.dataTransfer.files[0]); });
  // test hook: allow loading by path via a data attribute isn't possible in browser; headless uses the file input
  window.__viewerReady = true;
});
