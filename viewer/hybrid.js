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

// ---- "Enable Low RAM Mode" setting (toggle lives in Photopea's More menu) --------------------
// When ON (default), big PSDs open as the downscaled proxy below. When OFF, they load at full
// resolution from the start (the FileReader hook passes the original file through untouched).
// Default is OFF on machines with >= 23 GB of RAM — browsers can't read the real RAM size
// (navigator.deviceMemory is capped at 8), so the mac/electron shells inject window.__ppRAMGB.
const RAM_DEFAULT_OFF_GB = 23;
function lowRamEnabled() {
  try {
    const v = localStorage.getItem('__ppLowRAM');
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (e) { /* ignore */ }
  return !(window.__ppRAMGB >= RAM_DEFAULT_OFF_GB);
}

let previewMode = true;      // true until the user escalates for the current doc
let stashedFile = null;      // the original File/Blob (disk-backed -> cheap; re-read on escalate)
let stashedMeta = null;      // lazy-psd metadata of the stashed file (per-layer escalation, B1)
let stashedTree = null;      // proxy layer tree mirroring Photopea's panel, leaves carry records
let stashedScale = 0;        // proxy scale (needed to decode skipped layers on toggle, A4)
let stashedSkipped = null;   // hidden layers whose pixels were skipped: [{rec, domPath}]

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

const hasPixels = (rec, meta) => {
  if (rec.right - rec.left <= 0 || rec.bottom - rec.top <= 0) return false;
  const ids = new Set(rec.channels.map(c => c.id));
  return meta.mode === 3 ? ids.has(0) && ids.has(1) && ids.has(2) : ids.has(0);
};

async function buildProxyLazy(blob, forceScale) {
  const scale = forceScale || scaleForSize(blob.size);
  if (scale >= 1) return null;                                  // <= 800 MB: open the original as-is
  const meta = await parseLazyPsd(blob);
  console.log('[hybrid] psd', meta.width + 'x' + meta.height, meta.layers.length, 'records,',
              (blob.size / 1e9).toFixed(2) + ' GB -> scale', scale, '(lazy)');
  // Pass 1 — structure only. Records are in file order (bottom-to-top) — exactly ag-psd's
  // children order. A group is bracketed by its sectionType-3 divider (before its children)
  // and its header layer (after) — so a group's own hidden flag is unknown until its header,
  // which is why pixels are decoded in a second pass.
  const navRoot = { children: [] };
  const navStack = [navRoot];
  for (const rec of meta.layers) {
    if (rec.sectionType === 3) { navStack.push({ children: [] }); continue; }
    if (rec.sectionType === 1 || rec.sectionType === 2) {
      const nav = navStack.length > 1 ? navStack.pop() : { children: [] };
      navStack[navStack.length - 1].children.push({ rec, children: nav.children });
      continue;
    }
    navStack[navStack.length - 1].children.push({ rec });
  }
  // Pass 2 — build the ag-psd tree; decode pixels ONLY for effectively-visible layers (A4:
  // a layer hidden itself or inside a hidden group is written as an empty placeholder and
  // decoded later, on the user's visibility toggle — see the visibility watcher).
  const skipped = [];
  const toAg = async (nodes, parentHidden) => {
    const out = [];
    for (const n of nodes) {
      const rec = n.rec;
      const common = { name: rec.name, hidden: rec.hidden, opacity: rec.opacity / 255,
                       blendMode: BLEND[rec.blendKey] || 'normal' };
      if (n.children) {
        out.push({ ...common, opened: rec.sectionType === 1,
                   children: await toAg(n.children, parentHidden || rec.hidden) });
        continue;
      }
      const layer = { ...common, clipping: rec.clipping,
                      left: Math.round(rec.left * scale), top: Math.round(rec.top * scale) };
      if (parentHidden || rec.hidden) {
        if (hasPixels(rec, meta)) skipped.push({ rec, node: n });
      } else {
        const canvas = await lazyLayerCanvas(blob, meta, rec, scale);
        if (canvas) layer.canvas = canvas;
      }
      out.push(layer);
    }
    return out;
  };
  const children = await toAg(navRoot.children, false);
  if (skipped.length) console.log('[hybrid]', skipped.length, 'hidden layer(s) skipped (decoded on toggle)');
  const doc = {
    width: Math.max(1, Math.round(meta.width * scale)),
    height: Math.max(1, Math.round(meta.height * scale)),
    children,
  };
  const buf = writePsd(doc, { generateThumbnail: false, invalidateTextLayers: true });
  // DOM path (top-first, Photopea panel order) for each skipped layer, for the watcher
  const domPathOf = (target, nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i], dom = nodes.length - 1 - i;
      if (n === target) return [dom];
      if (n.children) { const p = domPathOf(target, n.children); if (p) return [dom, ...p]; }
    }
    return null;
  };
  return { buf, meta, scale, tree: navRoot.children,
           skipped: skipped.map(s => ({ rec: s.rec, domPath: domPathOf(s.node, navRoot.children) })) };
}

async function buildProxyPsdLazy(blob, forceScale) {   // diagnostics/tests: proxy bytes only
  const r = await buildProxyLazy(blob, forceScale);
  return r && r.buf;
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
  // size decides everything up front — nothing is read here (blob.size is free).
  // window.__hybridForceScale (tests/diagnostics) forces the proxy on for small files.
  const forced = window.__hybridForceScale;
  if (lowRamEnabled() && previewMode && blob && isPsd(blob.name) && (forced || scaleForSize(blob.size) < 1)) {
    const fr = this;
    (async () => {
      let proxy = null;
      try {
        const r = await buildProxyLazy(blob, forced);
        if (r) { proxy = r.buf; stashedMeta = r.meta; stashedTree = r.tree;
                 stashedScale = r.scale; stashedSkipped = r.skipped; }
      } catch (e) {
        console.warn('[hybrid] lazy proxy failed:', e);
        if (blob.size <= FULL_FALLBACK_MAX) {
          try { proxy = await buildProxyPsd(await blob.arrayBuffer(), forced); }
          catch (e2) { console.error('[hybrid] full proxy failed too:', e2); }
        }
      }
      if (!proxy) { origRead.call(fr, blob); return; }         // give up -> open the original
      stashedFile = blob;                                      // keep disk-backed file for escalation
      deliver(fr, proxy.buffer || proxy);                      // Photopea opens the downscaled layer tree
      setTimeout(() => { showBadge(); startVisibilityWatch(); captureProxyName(); }, 400);
    })();
    return;
  }
  return origRead.call(this, blob);
};

// the proxy doc's name is needed to close it on escalation — capture it once it finishes opening
async function captureProxyName() {
  for (let t = 0; t < 20 && !proxyDocName; t++) {
    proxyDocName = (await peaEval('app.documents.length?app.activeDocument.name:null')) || null;
    if (!proxyDocName) await new Promise(r => setTimeout(r, 500));
  }
}

async function escalate() {
  if (!stashedFile || !previewMode) return;
  previewMode = false;
  const proxyName = proxyDocName ||
    (await peaEval('app.documents.length?app.activeDocument.name:null'));
  const proxyW = await peaEval('app.documents.length?app.activeDocument.width:0');
  const fullW = stashedMeta ? stashedMeta.width : null;      // full-res width (lazy path only)
  stopVisibilityWatch();
  const file = stashedFile;
  stashedFile = stashedMeta = stashedTree = stashedSkipped = null;
  hideBadge();
  const newName = String(file.name || '').replace(/\.[^.]+$/, '');
  const ab = await file.arrayBuffer();                       // re-read original from disk
  // a synthetic drop (__openU8) is IGNORED by Photopea while any document is open, so the full
  // file must go through postMessage — which opens it under a generic name ("file"). The loop
  // below renames it back to the original filename once it appears, then closes the proxy.
  // Docs are identified by (name, width) — object identity is useless, every script eval hands
  // out fresh Document wrappers.
  window.postMessage(ab, '*', [ab]);
  if (!proxyName) return;
  const PN = JSON.stringify(proxyName), NEW = JSON.stringify(newName);
  for (let tries = 0; tries < 600; tries++) {                // full-res load can take minutes
    const r = await peaEval(
      '(function(){var A=app.documents,px=null,fx=null;' +
      'for(var i=0;i<A.length;i++){var D=A[i];' +
      'if(D.name==' + PN + '&&D.width==' + JSON.stringify(proxyW) + '){px=D;continue}' +
      (fullW != null
        ? 'if(fx==null&&D.width==' + JSON.stringify(fullW) + '&&D.name!=' + NEW + ')fx=D;'
        : 'if(fx==null&&D.name=="file")fx=D;') +
      '}' +
      'if(!fx)return "wait";' +                              // full doc not open yet
      'if(' + NEW + ')fx.name=' + NEW + ';' +
      'if(px)px.close(SaveOptions.DONOTSAVECHANGES);' +
      'return "ok"})()');
    if (r === 'ok') { console.log('[hybrid] full-res doc renamed, low-res proxy closed'); break; }
    if (r !== 'wait' && r !== undefined) { console.warn('[hybrid] proxy swap failed:', r); break; }
    await new Promise(res => setTimeout(res, 500));
  }
}

// run a Photopea script and read back one JS expression's value. In the single-file build,
// Photopea scripts run in OUR window's JS context, so a window global is the return channel.
function peaEval(expr, timeoutMs = 3000) {
  return new Promise((resolve) => {
    delete window.__hybridR;
    window.postMessage('try{window.__hybridR=' + expr + '}catch(e){window.__hybridR="__ERR"}', '*');
    let waited = 0;
    const iv = setInterval(() => {
      if (window.__hybridR !== undefined || (waited += 50) > timeoutMs) {
        clearInterval(iv);
        resolve(window.__hybridR === '__ERR' ? undefined : window.__hybridR);
      }
    }, 50);
  });
}

// ---- A4: visibility watcher — decode a skipped hidden layer when the user toggles it on ------
//
// The proxy writes effectively-hidden layers as empty placeholders (no pixels decoded). This
// watcher polls their effective visibility in the open proxy document; when one turns visible,
// its pixels are decoded from the stashed file AT PROXY SCALE (cheap), opened as a temp doc,
// duplicated into the proxy in the placeholder's exact spot, and the placeholder is removed.
let watchTimer = null;
let proxyDocName = null;
let injecting = false;

function stopVisibilityWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  proxyDocName = null;
}

function startVisibilityWatch() {
  stopVisibilityWatch();
  if (!stashedSkipped || !stashedSkipped.length) return;
  watchTimer = setInterval(watchTick, 1000);
}

async function watchTick() {
  if (injecting || !previewMode || !stashedFile) return;
  if (!stashedSkipped || !stashedSkipped.length) { stopVisibilityWatch(); return; }
  if (!proxyDocName) {
    proxyDocName = await peaEval('app.activeDocument.name');   // proxy is the doc just opened
    if (!proxyDocName) return;
  }
  const paths = JSON.stringify(stashedSkipped.map(s => s.domPath));
  const vis = await peaEval(
    '(function(){var A=app.documents,D=null;' +
    'for(var i=0;i<A.length;i++)if(A[i].name==' + JSON.stringify(proxyDocName) + '){D=A[i];break}' +
    'if(!D)return "null";var P=' + paths + ',V=[];' +
    'for(var j=0;j<P.length;j++){var n=D,v=true;' +
    'for(var k=0;k<P[j].length;k++){n=n.layers[P[j][k]];if(!n){v=false;break}}' +
    'var t=n;while(v&&t&&t!=D){if(!t.visible)v=false;t=t.parent==D?null:t.parent}' +
    'V.push(!!v)}return JSON.stringify(V)})()');
  let flags = null;
  try { flags = JSON.parse(vis || 'null'); } catch (e) { /* ignore */ }
  if (!flags) return;
  const idx = flags.findIndex(v => v);
  if (idx >= 0) await injectSkippedLayer(idx);
}

async function injectSkippedLayer(idx) {
  injecting = true;
  const { rec, domPath } = stashedSkipped[idx];
  stashedSkipped.splice(idx, 1);
  const label = badgeLabel('Loading hidden layer "' + rec.name + '"…');
  try {
    const canvas = await lazyLayerCanvas(stashedFile, stashedMeta, rec, stashedScale);
    if (!canvas) return;
    // temp doc has the PROXY's canvas dims with the layer pre-positioned: duplicating between
    // same-size docs keeps coordinates, so no post-move is needed (layer.translate breaks
    // Photopea's script runner). The layer canvas is still layer-sized — dims are just headers.
    const buf = writePsd({
      width: Math.max(1, Math.round(stashedMeta.width * stashedScale)),
      height: Math.max(1, Math.round(stashedMeta.height * stashedScale)),
      children: [{ name: '__hybridinject',
                   left: Math.round(rec.left * stashedScale),
                   top: Math.round(rec.top * stashedScale), canvas }] },
      { generateThumbnail: false, invalidateTextLayers: true });
    window.postMessage(buf, '*', [buf]);                       // opens the temp single-layer doc
    // Cross-doc layer moves are done via copy -> paste-into-the-selected-empty-placeholder:
    // Photopea pastes in place (same-size docs) and INTO the active empty layer, so the
    // placeholder keeps its name/blend/opacity/panel spot. duplicate()/translate() are avoided —
    // they crash Photopea's script runner — and mutating scripts often die AFTER doing the work,
    // so each step is posted fire-and-forget and success is verified with read-only scripts
    // (those respond reliably).
    const post = (s) => window.postMessage(s, '*');
    const sleep = (ms) => new Promise(res => setTimeout(res, ms));
    const nav = domPath.map(i => 'n=n.layers[' + i + '];').join('');
    const findTemp = 'var A=app.documents,S=null;for(var i=0;i<A.length;i++)' +
      'if(A[i].layers.length==1&&A[i].layers[0].name=="__hybridinject"){S=A[i];break}';
    const findProxy = 'var A=app.documents,D=null;for(var i=0;i<A.length;i++)' +
      'if(A[i].name==' + JSON.stringify(proxyDocName) +
      '&&!(A[i].layers.length==1&&A[i].layers[0].name=="__hybridinject")){D=A[i];break}';
    // wait for the temp doc to open
    let seen = false;
    for (let t = 0; t < 40 && !seen; t++) {
      seen = (await peaEval('(function(){' + findTemp + 'return S?"y":"n"})()')) === 'y';
      if (!seen) await sleep(250);
    }
    if (!seen) { console.warn('[hybrid] inject: temp doc never opened:', rec.name); return; }
    const ex = [Math.round(rec.left * stashedScale), Math.round(rec.top * stashedScale)];
    const exW = canvas.width, exH = canvas.height;
    const boundsOk = (b) => Array.isArray(b) && b[0] === ex[0] && b[1] === ex[1] &&
                            b[2] === ex[0] + exW && b[3] === ex[1] + exH;
    for (let attempt = 0; attempt < 4; attempt++) {
      post('(function(){' + findTemp + 'if(S){app.activeDocument=S;S.selection.selectAll();S.selection.copy()}})()');
      await sleep(400);
      post('(function(){' + findProxy + 'if(D){app.activeDocument=D;var n=D;' + nav + 'D.activeLayer=n}})()');
      await sleep(400);
      post('app.activeDocument.paste()');
      await sleep(400);
      const b = await peaEval('(function(){' + findProxy + 'if(!D)return "x";var n=D;' + nav +
        'var b=n.bounds;return JSON.stringify([b[0].value,b[1].value,b[2].value,b[3].value])})()');
      let bounds = null;
      try { bounds = JSON.parse(b || 'null'); } catch (e) { /* ignore */ }
      if (boundsOk(bounds)) {
        console.log('[hybrid] injected hidden layer:', rec.name);
        post('(function(){' + findTemp + 'if(S)S.close(SaveOptions.DONOTSAVECHANGES)})()');
        await sleep(300);
        post('(function(){' + findProxy + 'if(D)app.activeDocument=D})()');
        return;
      }
    }
    console.warn('[hybrid] inject failed (pixels never landed):', rec.name);
    post('(function(){' + findTemp + 'if(S)S.close(SaveOptions.DONOTSAVECHANGES)})()');
  } catch (e) {
    console.warn('[hybrid] inject failed:', rec.name, e);
  } finally {
    label.restore();
    injecting = false;
  }
}

// ---- per-layer escalation (B1): open the ACTIVE layer as its own full-res document -----------
//
// A PSD can't mix resolutions, so the full-res pixels can't be swapped into the downscaled proxy
// doc. Instead the selected layer is decoded from the stashed file (strip decoding again — RAM is
// one layer, not the document) and opened as a separate document sized to the LAYER's bounds
// (sizing it to the full canvas would make Photopea allocate the full-res composite buffer).

// In the single-file build, Photopea scripts run in OUR window's JS context, so a script sent via
// postMessage can hand results back through a global — no echoToOE round-trip needed.
function queryActiveLayerPath() {
  return new Promise((resolve) => {
    delete window.__hybridALPath;
    const script =
      'try{var d=app.activeDocument,n=d.activeLayer,p=[];' +
      'while(n&&n!=d){var q=n.parent||d,ls=q.layers,i=-1;' +
      'for(var k=0;k<ls.length;k++)if(ls[k]==n){i=k;break}' +
      'p.unshift(i);if(q==d)break;n=q}' +
      'window.__hybridALPath=JSON.stringify(p)}catch(e){window.__hybridALPath="null"}';
    window.postMessage(script, '*');
    let waited = 0;
    const iv = setInterval(() => {
      if (window.__hybridALPath !== undefined || (waited += 50) > 3000) {
        clearInterval(iv);
        try { resolve(JSON.parse(window.__hybridALPath || 'null')); } catch (e) { resolve(null); }
      }
    }, 50);
  });
}

async function escalateActiveLayer() {
  if (!stashedFile || !stashedMeta || !stashedTree || !previewMode) return;
  const path = await queryActiveLayerPath();
  if (!path || !path.length) { console.warn('[hybrid] could not resolve active layer'); return; }
  // Photopea's DOM lists layers TOP-first; our tree is bottom-first -> mirror each index
  let node = { children: stashedTree };
  for (const i of path) {
    const C = node.children;
    if (!C || i < 0 || i >= C.length) { console.warn('[hybrid] layer path mismatch', path); return; }
    node = C[C.length - 1 - i];
  }
  if (node.children) { console.warn('[hybrid] active item is a group — select a pixel layer'); return; }
  const rec = node.rec;
  if (!rec) { console.warn('[hybrid] active item is a group — select a pixel layer'); return; }
  const label = badgeLabel('Extracting "' + rec.name + '" at full resolution…');
  try {
    const canvas = await lazyLayerCanvas(stashedFile, stashedMeta, rec, 1);
    if (!canvas) { console.warn('[hybrid] layer has no pixels:', rec.name); return; }
    const doc = {
      width: rec.right - rec.left, height: rec.bottom - rec.top,
      children: [{ name: rec.name + ' @ full res (' + rec.left + ',' + rec.top + ')',
                   left: 0, top: 0, canvas }],
    };
    const buf = writePsd(doc, { generateThumbnail: false, invalidateTextLayers: true });
    window.postMessage(buf, '*', [buf]);        // opens as a NEW document; proxy stays open
  } finally { label.restore(); }
}

window.__escalate = escalate;
window.__escalateActiveLayer = escalateActiveLayer;
window.__buildProxyPsd = buildProxyPsd;           // whole-buffer path (diagnostics/testing)
window.__buildProxyPsdLazy = buildProxyPsdLazy;   // lazy path (diagnostics/testing)
window.__countPsdLayers = (ab) => countLayers(Psd.parse(ab).children);

// ---- escalation UI + triggers ----
function badgeLabel(text) {                        // temporarily swap the badge text
  const el = document.getElementById('__hybridmain');
  const old = el ? el.textContent : '';
  if (el) el.textContent = text;
  return { restore() { const e = document.getElementById('__hybridmain'); if (e) e.textContent = old; } };
}
function showBadge() {
  if (document.getElementById('__hybridbadge')) return;
  const b = document.createElement('div');
  b.id = '__hybridbadge';
  b.style.cssText = 'position:fixed;top:96px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
    'background:#3482f6;color:#fff;font:12px -apple-system,sans-serif;padding:5px 12px;border-radius:14px;' +
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);user-select:none';
  const main = document.createElement('span');
  main.id = '__hybridmain';
  const nSkip = stashedSkipped ? stashedSkipped.length : 0;
  main.textContent = 'Low-res preview (low RAM' +
    (nSkip ? ', ' + nSkip + ' hidden layer' + (nSkip > 1 ? 's' : '') + ' skipped' : '') +
    ') - click for full resolution & editing';
  main.title = 'Loads every layer at full resolution for editing (uses more memory)';
  main.onclick = escalate;
  b.appendChild(main);
  if (stashedTree) {                               // per-layer needs the lazy metadata
    const sep = document.createElement('span');
    sep.textContent = '  |  ';
    sep.style.opacity = '0.6';
    const one = document.createElement('span');
    one.textContent = 'active layer only';
    one.title = 'Opens just the selected layer at full resolution as its own document (low RAM)';
    one.style.textDecoration = 'underline';
    one.onclick = (e) => { e.stopPropagation(); escalateActiveLayer(); };
    b.appendChild(sep); b.appendChild(one);
  }
  document.body.appendChild(b);
}
function hideBadge() { const b = document.getElementById('__hybridbadge'); if (b) b.remove(); }

// ---- "Enable Low RAM Mode" row in the More menu -----------------------------------------------
//
// Photopea's dropdowns are div.contextpanel elements with div.enab rows:
//   <div class="enab"><span class="check">[svg tick]</span><span class="label">text</span></div>
// The More menu can't be extended from the outside (items/handlers live in the minified bundle),
// so the row is injected into its panel DOM when it appears. The panel is identified by its
// WebGL row — "WebGL" survives translation in ~every UI language.
const CHECK_SVG = "<svg height='10px' width='10px' fill='none' stroke-width='1.35' " +
                  "stroke='currentColor'><path d='M 1 5 L 4 8 L 9 2'/></svg>";

function injectLowRamMenuItem(panel) {
  if (panel.querySelector('.__lowramrow')) {         // reopened panel: just refresh the tick
    const c = panel.querySelector('.__lowramrow .check');
    if (c) c.innerHTML = lowRamEnabled() ? CHECK_SVG : '';
    return;
  }
  let anchor = null;
  for (const l of panel.querySelectorAll('span.label')) {
    if (/WebGL/i.test(l.textContent)) { anchor = l.parentNode; break; }
  }
  if (!anchor || anchor.parentNode !== panel) return;
  const row = document.createElement('div');
  row.className = 'enab __lowramrow';
  row.title = 'Open big PSDs (over 800 MB) as a downscaled low-RAM preview first. ' +
              'When off, big PSDs load at full resolution from the start.';
  const check = document.createElement('span');
  check.className = 'check';
  check.innerHTML = lowRamEnabled() ? CHECK_SVG : '';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Enable Low RAM Mode';
  row.appendChild(check);
  row.appendChild(label);
  // The panel may act (or dismiss) on pointerdown/mousedown/mouseup/click depending on platform,
  // so toggle on the FIRST event of the press and swallow the rest of the sequence.
  let lastToggle = 0;
  const onPress = (e) => {
    e.stopPropagation();                             // keep the panel's own row handler out of it
    const now = Date.now();
    if (now - lastToggle < 400) return;              // later events of the same press
    lastToggle = now;
    const on = !lowRamEnabled();
    try { localStorage.setItem('__ppLowRAM', on ? '1' : '0'); } catch (e2) { /* ignore */ }
    check.innerHTML = on ? CHECK_SVG : '';
  };
  ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((ev) =>
    row.addEventListener(ev, onPress, true));
  panel.insertBefore(row, anchor.nextSibling);
}

new MutationObserver((muts) => {
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.classList && n.classList.contains('contextpanel')) injectLowRamMenuItem(n);
      else if (n.querySelectorAll) n.querySelectorAll('.contextpanel').forEach(injectLowRamMenuItem);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

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
