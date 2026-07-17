// Hybrid preview/edit for the offline Photopea (real Photopea UI, low RAM by default).
//
// When a large PSD is opened we don't hand Photopea the full file (a 2 GB PSD decodes to
// ~6 GB of RAM). Instead we build a DOWNSCALED PROXY PSD: the same layer tree — groups,
// names, order, visibility, opacity, blend modes — but every layer's raster shrunk to a
// preview resolution. Photopea opens that, so its ORIGINAL UI works fully: the layers panel
// is populated and show/hide / opacity all work, at a fraction of the memory.
//
// The proxy is built LAZILY (performance.md A1+A2): the file is never read whole. lazy-psd.js
// parses just the layer records (a few MB) via blob.slice, then each layer is decoded in
// horizontal strips straight into its downscaled canvas — peak RAM is one strip, not one
// full-res layer, and not the 2 GB file. Files >4 GB (which can't even be arrayBuffer()'d)
// become possible. If the lazy path can't handle a file (CMYK, 32-bit, ...), we fall back to
// the old whole-buffer @webtoon/psd path for files small enough to load, else open the original.
//
// The user "escalates" to the full-resolution original (all pixels) either explicitly (badge
// button) or by picking an edit tool. Escalation re-reads the original file from disk and
// hands it to Photopea via postMessage — the app is NOT reloaded, it just opens the real
// document (a brief freeze while decoding is expected).
//
// Bundled by esbuild and inlined by pack.py BEFORE Photopea runs, so the FileReader hook is
// in place when Photopea reads a picked/dropped file.
import Psd from '@webtoon/psd';
import { writePsd } from 'ag-psd';
import { parseLazyPsd, readChannelRows } from './lazy-psd.js';

let previewMode = true;      // true until the user escalates for the current doc
let stashedFile = null;      // the original File/Blob (disk-backed -> cheap; re-read on escalate)

const isPsd = (name) => /\.ps[db]$/i.test(name || '');

// biggest file the whole-buffer fallback path may attempt (needs file + one full-res layer in RAM)
const FULL_FALLBACK_MAX = 1.5e9;

// Proxy only kicks in for large files; the downscale factor is tiered by the original file size
// (bytes). Small files open at full resolution — no proxy overhead. Each layer is scaled by the
// same factor, so per-layer RAM drops with scale^2.
const SIZE_TIERS = [
  { min: 4e9,   scale: 0.3 },   // > 4 GB
  { min: 2e9,   scale: 0.4 },   // > 2 GB
  { min: 800e6, scale: 0.5 },   // > 800 MB
];
function scaleForSize(bytes) {
  for (const t of SIZE_TIERS) if (bytes > t.min) return t.scale;
  return 1;                     // <= 800 MB: no proxy, open the original as-is
}

function countLayers(nodes) {
  let n = 0;
  for (const node of nodes || []) n += node.type === 'Group' ? countLayers(node.children) : 1;
  return n;
}

// PSD blend-mode 4-char keys -> ag-psd human names.
const BLEND = {
  'pass': 'pass through', 'norm': 'normal', 'diss': 'dissolve', 'dark': 'darken',
  'mul ': 'multiply', 'idiv': 'color burn', 'lbrn': 'linear burn', 'dkCl': 'darker color',
  'lite': 'lighten', 'scrn': 'screen', 'div ': 'color dodge', 'lddg': 'linear dodge',
  'lgCl': 'lighter color', 'over': 'overlay', 'sLit': 'soft light', 'hLit': 'hard light',
  'vLit': 'vivid light', 'lLit': 'linear light', 'pLit': 'pin light', 'hMix': 'hard mix',
  'diff': 'difference', 'smud': 'exclusion', 'fsub': 'subtract', 'fdiv': 'divide',
  'hue ': 'hue', 'sat ': 'saturation', 'colr': 'color', 'lum ': 'luminosity',
};

// ---- lazy proxy build (primary path; A1 lazy slicing + A2 strip decoding) --------------------

const DEST_STRIP_ROWS = 256;    // strips sized so each maps to ~256 rows of the downscaled canvas

// decode one pixel layer from the blob in horizontal strips, straight into a scaled canvas
async function lazyLayerCanvas(blob, meta, rec, scale) {
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  if (w <= 0 || h <= 0) return null;
  const chById = {};
  for (const ch of rec.channels) chById[ch.id] = ch;
  const rgb = meta.mode === 3;
  if (!chById[0] || (rgb && (!chById[1] || !chById[2]))) return null;  // adjustment/fill layer
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  const dst = document.createElement('canvas');
  dst.width = sw; dst.height = sh;
  const g = dst.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const strip = document.createElement('canvas');
  strip.width = w;
  const srcStrip = Math.max(1, Math.round(DEST_STRIP_ROWS / scale));
  for (let y0 = 0; y0 < h; y0 += srcStrip) {
    const y1 = Math.min(h, y0 + srcStrip), rows = y1 - y0;
    const r = await readChannelRows(blob, meta, chById[0], w, h, y0, y1);
    const gr = rgb ? await readChannelRows(blob, meta, chById[1], w, h, y0, y1) : r;
    const b = rgb ? await readChannelRows(blob, meta, chById[2], w, h, y0, y1) : r;
    const a = chById[-1] ? await readChannelRows(blob, meta, chById[-1], w, h, y0, y1) : null;
    const rgba = new Uint8ClampedArray(w * rows * 4);
    for (let i = 0, n = w * rows; i < n; i++) {
      rgba[i * 4] = r[i]; rgba[i * 4 + 1] = gr[i]; rgba[i * 4 + 2] = b[i];
      rgba[i * 4 + 3] = a ? a[i] : 255;
    }
    try { await bakeMaskStrip(blob, meta, rec, chById[-2], rgba, w, y0, y1); }
    catch (e) { console.warn('[hybrid] mask apply failed:', rec.name, e); }
    strip.height = rows;                                        // setting height also clears it
    strip.getContext('2d').putImageData(new ImageData(rgba, w, rows), 0, 0);
    // srcStrip is chosen so strip edges land on (near-)integer dest rows: adjacent strips share
    // the same rounded boundary -> no gaps/overlaps
    const dy0 = Math.round(y0 * scale);
    const dy1 = y1 === h ? sh : Math.max(dy0 + 1, Math.round(y1 * scale));
    g.drawImage(strip, 0, 0, w, rows, 0, dy0, sw, dy1 - dy0);
  }
  return dst;
}

// bake the layer's user mask into the alpha of one strip (preview-quality; the proxy carries
// no masks). Mask rows are decoded on demand for just this strip's document rows.
async function bakeMaskStrip(blob, meta, rec, mch, rgba, w, y0, y1) {
  const md = rec.mask;
  if (!md || md.disabled || !mch) return;
  const mw = md.right - md.left, mh = md.bottom - md.top;
  if (mw <= 0 || mh <= 0) return;
  // mask rect is in canvas coords unless the relative flag is set
  const maskLeft = md.relative ? rec.left + md.left : md.left;
  const maskTop = md.relative ? rec.top + md.top : md.top;
  const m0 = Math.min(mh, Math.max(0, rec.top + y0 - maskTop));
  const m1 = Math.min(mh, Math.max(0, rec.top + y1 - maskTop));
  const mrows = m1 > m0 ? await readChannelRows(blob, meta, mch, mw, mh, m0, m1) : null;
  const bg = md.defaultColor;                 // mask value outside its rect (0 or 255)
  for (let y = y0; y < y1; y++) {
    const my = rec.top + y - maskTop;
    const inRow = mrows && my >= m0 && my < m1;
    for (let x = 0; x < w; x++) {
      const mx = rec.left + x - maskLeft;
      const mv = inRow && mx >= 0 && mx < mw ? mrows[(my - m0) * mw + mx] : bg;
      if (mv === 255) continue;
      const i = ((y - y0) * w + x) * 4 + 3;
      rgba[i] = (rgba[i] * mv) / 255;
    }
  }
}

async function buildProxyPsdLazy(blob, forceScale) {   // forceScale: diagnostics/tests only
  const scale = forceScale || scaleForSize(blob.size);
  if (scale >= 1) return null;                                  // <= 800 MB: open the original as-is
  const meta = await parseLazyPsd(blob);
  console.log('[hybrid] psd', meta.width + 'x' + meta.height, meta.layers.length, 'records,',
              (blob.size / 1e9).toFixed(2) + ' GB -> scale', scale, '(lazy)');
  // records are in file order (bottom-to-top) — exactly ag-psd's children order. A group is
  // bracketed by its sectionType-3 divider (before its children) and its header layer (after).
  const root = { children: [] };
  const stack = [root];
  for (const rec of meta.layers) {
    const common = { name: rec.name, hidden: rec.hidden, opacity: rec.opacity / 255,
                     blendMode: BLEND[rec.blendKey] || 'normal' };
    if (rec.sectionType === 3) { stack.push({ children: [] }); continue; }
    if (rec.sectionType === 1 || rec.sectionType === 2) {
      const grp = stack.length > 1 ? stack.pop() : { children: [] };
      stack[stack.length - 1].children.push(
        { ...common, opened: rec.sectionType === 1, children: grp.children });
      continue;
    }
    const layer = { ...common, clipping: rec.clipping,
                    left: Math.round(rec.left * scale), top: Math.round(rec.top * scale) };
    const canvas = await lazyLayerCanvas(blob, meta, rec, scale);
    if (canvas) layer.canvas = canvas;
    stack[stack.length - 1].children.push(layer);
  }
  const doc = {
    width: Math.max(1, Math.round(meta.width * scale)),
    height: Math.max(1, Math.round(meta.height * scale)),
    children: root.children,
  };
  return writePsd(doc, { generateThumbnail: false, invalidateTextLayers: true });
}

// ---- whole-buffer fallback (@webtoon/psd; needs the full file + one full-res layer in RAM) ---

const props = (node) => {           // reach the raw layer properties (TS-private at runtime)
  try { return node.layerFrame.layerProperties; } catch (e) { return null; }
};
const blendOf = (node) => {
  const p = props(node);
  return (p && BLEND[p.blendMode]) || 'normal';
};

function scaledCanvas(rgba, w, h, scale) {
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  const sw = Math.max(1, Math.round(w * scale)), sh = Math.max(1, Math.round(h * scale));
  if (sw === w && sh === h) return src;
  const dst = document.createElement('canvas');
  dst.width = sw; dst.height = sh;
  const g = dst.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, sw, sh);
  return dst;                        // src is dropped -> GC frees the full-res bitmap
}

// bake the layer's user mask into the alpha channel (preview-quality; the proxy carries no masks)
async function applyUserMask(node, rgba, w, h) {
  const md = node.maskData;
  if (!md || md.right == null || (md.flags && md.flags.layerMaskDisabled)) return;
  const mask = await node.userMask();      // RGBA: 4 bytes per mask pixel, gray value in R
  if (!mask) return;
  const mw = md.right - md.left, mh = md.bottom - md.top;
  if (mw <= 0 || mh <= 0 || mask.length < mw * mh * 4) return;
  // mask rect is in canvas coords unless positionRelativeToLayer is set
  const maskLeft = md.flags && md.flags.positionRelativeToLayer ? node.left + md.left : md.left;
  const maskTop  = md.flags && md.flags.positionRelativeToLayer ? node.top  + md.top  : md.top;
  const bg = md.backgroundColor;              // mask value outside its rect (0 or 255)
  for (let y = 0; y < h; y++) {
    const my = node.top + y - maskTop;
    const inRow = my >= 0 && my < mh;
    for (let x = 0; x < w; x++) {
      const mx = node.left + x - maskLeft;
      const mv = inRow && mx >= 0 && mx < mw ? mask[(my * mw + mx) * 4] : bg;
      if (mv === 255) continue;
      const i = (y * w + x) * 4 + 3;
      rgba[i] = (rgba[i] * mv) / 255;
    }
  }
}

// walk the @webtoon/psd tree, producing an ag-psd layer/group tree with downscaled rasters.
// NOTE: @webtoon/psd lists children TOP-first, ag-psd expects BOTTOM-first -> reverse each level,
// otherwise the proxy's stacking order (and thus the composite) is upside-down.
async function buildProxyChildren(nodes, scale) {
  const out = [];
  for (const node of [...nodes].reverse()) {
    const p = props(node);
    const hidden = !!(p && p.hidden);
    const opacity = p ? (p.opacity / 255) : 1;
    if (node.type === 'Group') {
      out.push({
        name: node.name, opened: true, hidden, opacity, blendMode: blendOf(node),
        children: await buildProxyChildren(node.children || [], scale),
      });
    } else {
      const w = node.width, h = node.height;
      const layer = { name: node.name, hidden, opacity, blendMode: blendOf(node),
                      clipping: !!(p && p.clippingMask), left: Math.round(node.left * scale),
                      top: Math.round(node.top * scale) };
      if (w > 0 && h > 0) {
        try {
          // raw pixels, WITHOUT baking opacity in — layer.opacity above already carries it
          // (composite(true) would multiply opacity into the alpha AND we'd set it again -> double)
          const rgba = await node.composite(false);
          try { await applyUserMask(node, rgba, w, h); }
          catch (e) { console.warn('[hybrid] mask apply failed:', node.name, e); }
          layer.canvas = scaledCanvas(rgba, w, h, scale);
        } catch (e) { /* adjustment/empty layer -> no raster */ }
      }
      out.push(layer);
    }
  }
  return out;
}

async function buildProxyPsd(ab, forceScale) {   // fallback path + diagnostics/tests
  const scale = forceScale || scaleForSize(ab.byteLength);
  if (scale >= 1) return null;                               // <= 800 MB: open the original as-is
  const psd = Psd.parse(ab);
  console.log('[hybrid] psd', psd.width + 'x' + psd.height, countLayers(psd.children),
              'layers,', (ab.byteLength / 1e9).toFixed(2) + ' GB -> scale', scale, '(full)');
  const children = await buildProxyChildren(psd.children || [], scale);
  const doc = {
    width: Math.max(1, Math.round(psd.width * scale)),
    height: Math.max(1, Math.round(psd.height * scale)),
    children,
  };
  return writePsd(doc, { generateThumbnail: false, invalidateTextLayers: true });
}

// ---- FileReader hook -------------------------------------------------------------------------

// deliver a substituted ArrayBuffer to a FileReader's onload (as if it had read that)
function deliver(fr, buf) {
  try { Object.defineProperty(fr, 'result', { value: buf, configurable: true }); } catch (e) {}
  const ev = new ProgressEvent('load');
  try { Object.defineProperty(ev, 'target', { value: fr }); } catch (e) {}
  if (typeof fr.onload === 'function') { try { fr.onload(ev); } catch (e) { console.error(e); } }
}

const origRead = FileReader.prototype.readAsArrayBuffer;
FileReader.prototype.readAsArrayBuffer = function (blob) {
  // size decides everything up front — nothing is read here (blob.size is free)
  if (previewMode && blob && isPsd(blob.name) && scaleForSize(blob.size) < 1) {
    const fr = this;
    (async () => {
      let proxy = null;
      try {
        proxy = await buildProxyPsdLazy(blob);
      } catch (e) {
        console.warn('[hybrid] lazy proxy failed:', e);
        if (blob.size <= FULL_FALLBACK_MAX) {
          try { proxy = await buildProxyPsd(await blob.arrayBuffer()); }
          catch (e2) { console.error('[hybrid] full proxy failed too:', e2); }
        }
      }
      if (!proxy) { origRead.call(fr, blob); return; }         // give up -> open the original
      stashedFile = blob;                                      // keep disk-backed file for escalation
      deliver(fr, proxy.buffer || proxy);                      // Photopea opens the downscaled layer tree
      setTimeout(showBadge, 400);
    })();
    return;
  }
  return origRead.call(this, blob);
};

async function escalate() {
  if (!stashedFile || !previewMode) return;
  previewMode = false;
  const file = stashedFile; stashedFile = null;
  hideBadge();
  const ab = await file.arrayBuffer();                       // re-read original from disk
  window.postMessage(ab, '*', [ab]);                         // opens full-res doc; app is NOT reloaded
}
window.__escalate = escalate;
window.__buildProxyPsd = buildProxyPsd;           // whole-buffer path (diagnostics/testing)
window.__buildProxyPsdLazy = buildProxyPsdLazy;   // lazy path (diagnostics/testing)
window.__countPsdLayers = (ab) => countLayers(Psd.parse(ab).children);

// ---- escalation UI + triggers ----
function showBadge() {
  if (document.getElementById('__hybridbadge')) return;
  const b = document.createElement('div');
  b.id = '__hybridbadge';
  b.textContent = 'Low-res preview (low RAM) - click for full resolution & editing';
  b.style.cssText = 'position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#3482f6;color:#fff;font:12px -apple-system,sans-serif;padding:5px 12px;border-radius:14px;' +
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);user-select:none';
  b.title = 'Loads every layer at full resolution for editing (uses more memory)';
  b.onclick = escalate;
  document.body.appendChild(b);
}
function hideBadge() { const b = document.getElementById('__hybridbadge'); if (b) b.remove(); }

// on-edit-tool: picking a tool from the left toolbar (the ~44px strip below the menu bar) means the
// user wants to edit -> escalate. Browsing/toggling layers (right panel) and zoom/pan do NOT escalate.
document.addEventListener('pointerdown', (e) => {
  if (previewMode && stashedFile && e.clientX < 44 && e.clientY > 38) escalate();
}, true);
// also escalate on any single-letter tool shortcut (brush/eraser/text/...), ignoring view keys & combos
const VIEW_KEYS = new Set(['h', 'z', ' ', 'v']);
document.addEventListener('keydown', (e) => {
  if (!previewMode || !stashedFile || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key) && !VIEW_KEYS.has(e.key.toLowerCase())) escalate();
}, true);
