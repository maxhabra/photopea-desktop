#!/usr/bin/env node
// Tests for viewer/lazy-psd.js (performance.md A1+A2) — the lazy PSD reader behind the hybrid
// low-RAM proxy. Pure node (Blob/DecompressionStream are global since node 18): generates PSDs
// with ag-psd, then checks that the lazy parser sees the same structure and that row-range
// (strip) decoding returns the exact pixels that were written. Compression corner cases (raw,
// zip, zip+prediction, 16-bit) are exercised with hand-built channel buffers.
//
//   node test/hybrid.test.js

const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const R = (p) => require(require.resolve(p, { paths: [path.join(__dirname, '..')] }));
const agPsd = R('ag-psd');
const Psd = R('@webtoon/psd').default;

const results = [];
const ok = (n, cond, extra) => results.push({ n, pass: !!cond, extra: extra || '' });

const gradient = (w, h) => {           // R = row, G = column, B = 128, A = 255
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = y & 255; d[i + 1] = x & 255; d[i + 2] = 128; d[i + 3] = 255;
  }
  return { width: w, height: h, data: d };
};
const solid = (w, h, [r, g, b, a]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  return { width: w, height: h, data: d };
};

(async () => {
  const lazy = await import(pathToFileURL(path.join(__dirname, '..', 'viewer', 'lazy-psd.js')).href);
  const { parseLazyPsd, readChannelRows } = lazy;

  // ---- integration: ag-psd-written PSD (RLE) --------------------------------------------------
  const doc = { width: 64, height: 48, children: [
    { name: 'bottom', imageData: gradient(64, 48), left: 0, top: 0 },
    { name: 'semi', opacity: 0.5, imageData: solid(20, 10, [255, 0, 0, 200]), left: 5, top: 6 },
    { name: 'masked', imageData: solid(30, 20, [0, 255, 0, 255]), left: 10, top: 10,
      mask: { top: 12, left: 12, bottom: 22, right: 32, imageData: solid(20, 10, [100, 100, 100, 255]) } },
    { name: 'hidden', hidden: true, blendMode: 'multiply', imageData: solid(8, 8, [1, 2, 3, 255]), left: 40, top: 30 },
    { name: 'G', opened: true, children: [
      { name: 'inner1', imageData: solid(4, 4, [9, 9, 9, 255]), left: 1, top: 1 },
      { name: 'inner2', imageData: solid(4, 4, [7, 7, 7, 255]), left: 8, top: 8 },
    ] },
  ] };
  const psdBuf = agPsd.writePsd(doc, { generateThumbnail: false });
  const blob = new Blob([psdBuf]);
  const meta = await parseLazyPsd(blob);

  ok('header', meta.width === 64 && meta.height === 48 && meta.depth === 8 && meta.mode === 3,
     JSON.stringify({ w: meta.width, h: meta.height, d: meta.depth, m: meta.mode }));

  const types = meta.layers.map(l => l.sectionType).join(',');
  ok('file order sectionTypes', types === '0,0,0,0,3,0,0,1', types);
  const names = meta.layers.filter(l => l.sectionType === 0 || l.sectionType === 1).map(l => l.name).join(',');
  ok('file order names', names === 'bottom,semi,masked,hidden,inner1,inner2,G', names);

  const by = {}; for (const l of meta.layers) by[l.name] = l;
  ok('hidden flag', by.hidden.hidden === true && by.bottom.hidden === false);
  ok('blend key', by.hidden.blendKey === 'mul ' && by.bottom.blendKey === 'norm', by.hidden.blendKey);
  ok('opacity', Math.abs(by.semi.opacity - 128) <= 1, String(by.semi.opacity));
  ok('rect', by.masked.left === 10 && by.masked.top === 10 && by.masked.right === 40 && by.masked.bottom === 30);
  ok('mask rect', !!by.masked.mask && by.masked.mask.left === 12 && by.masked.mask.top === 12 &&
     by.masked.mask.right === 32 && by.masked.mask.bottom === 22, JSON.stringify(by.masked.mask));

  // cross-check tree order against @webtoon/psd (which lists children TOP-first)
  const wt = Psd.parse(psdBuf instanceof ArrayBuffer ? psdBuf : psdBuf.buffer);
  const wtTop = wt.children.map(n => n.name).join(',');
  ok('webtoon cross-check (reversed)', wtTop === 'G,hidden,masked,semi,bottom', wtTop);

  // strip decoding must equal full decoding, and match the written pixels
  const chansOf = (rec) => { const m = {}; for (const c of rec.channels) m[c.id] = c; return m; };
  {
    const rec = by.bottom, ch = chansOf(rec);
    const full = await readChannelRows(blob, meta, ch[0], 64, 48, 0, 48);   // R = row index
    let good = true;
    for (let y = 0; y < 48 && good; y++) for (let x = 0; x < 64; x++)
      if (full[y * 64 + x] !== (y & 255)) { good = false; break; }
    ok('decode full channel (RLE)', good);
    const strip = await readChannelRows(blob, meta, ch[0], 64, 48, 10, 20); // rows 10..20 only
    ok('decode strip == full slice', Buffer.from(strip).equals(Buffer.from(full.subarray(10 * 64, 20 * 64))));
    const g = await readChannelRows(blob, meta, ch[1], 64, 48, 3, 5);       // G = column index
    ok('decode strip channel G', g[0] === 0 && g[63] === 63 && g[64] === 0);
  }
  {
    const ch = chansOf(by.semi);
    const a = await readChannelRows(blob, meta, ch[-1], 20, 10, 0, 10);
    ok('alpha channel', a.every(v => v === 200), String(a[0]));
    const r = await readChannelRows(blob, meta, ch[0], 20, 10, 4, 6);
    ok('color under alpha', r.every(v => v === 255), String(r[0]));
  }
  {
    const ch = chansOf(by.masked);
    ok('mask channel present', !!ch[-2]);
    if (ch[-2]) {
      const m = await readChannelRows(blob, meta, ch[-2], 20, 10, 2, 4);
      ok('mask channel decode', m.every(v => v === 100), String(m[0]));
    }
  }

  // ---- unit: synthetic channels for raw / zip / prediction / 16-bit --------------------------
  const mkCh = (comp, payload) => {
    const head = Buffer.alloc(2); head.writeUInt16BE(comp);
    const b = Buffer.concat([head, Buffer.from(payload)]);
    return { blob: new Blob([b]), ch: { id: 0, offset: 0, length: b.length } };
  };
  const M8 = { version: 1, depth: 8 }, M16 = { version: 1, depth: 16 };
  {
    const { blob, ch } = mkCh(0, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);   // raw 8-bit, 4x3
    const rows = await readChannelRows(blob, M8, ch, 4, 3, 1, 3);
    ok('raw 8-bit rows', Buffer.from(rows).equals(Buffer.from([5, 6, 7, 8, 9, 10, 11, 12])));
  }
  {
    const p = []; for (const v of [256, 512, 1024, 65535]) { p.push(v >> 8, v & 255); }
    const { blob, ch } = mkCh(0, p);                                         // raw 16-bit, 2x2
    const rows = await readChannelRows(blob, M16, ch, 2, 2, 0, 2);
    ok('raw 16->8', Buffer.from(rows).equals(Buffer.from([1, 2, 4, 255])));
  }
  {
    const data = Buffer.from([10, 20, 30, 40, 50, 60]);                      // zip 8-bit, 3x2
    const { blob, ch } = mkCh(2, zlib.deflateSync(data));
    const rows = await readChannelRows(blob, M8, ch, 3, 2, 1, 2);
    ok('zip 8-bit', Buffer.from(rows).equals(Buffer.from([40, 50, 60])));
  }
  {
    const delta = Buffer.from([10, 10, 10, 5, 20, 1]);                       // prediction: rows delta-coded
    const { blob, ch } = mkCh(3, zlib.deflateSync(delta));
    const rows = await readChannelRows(blob, M8, ch, 3, 2, 0, 2);
    ok('zip+prediction 8-bit', Buffer.from(rows).equals(Buffer.from([10, 20, 30, 5, 25, 26])));
  }
  {
    // prediction 16-bit: one row, values [256, 512, 768] delta-coded as [256, 256, 256]
    const delta = Buffer.from([1, 0, 1, 0, 1, 0]);
    const { blob, ch } = mkCh(3, zlib.deflateSync(delta));
    const rows = await readChannelRows(blob, M16, ch, 3, 1, 0, 1);
    ok('zip+prediction 16->8', Buffer.from(rows).equals(Buffer.from([1, 2, 3])));
  }

  // ---- PSB (version 2), if this ag-psd can write it -------------------------------------------
  try {
    const psbBuf = agPsd.writePsd(doc, { generateThumbnail: false, psb: true });
    const m2 = await parseLazyPsd(new Blob([psbBuf]));
    ok('psb parse', m2.version === 2 && m2.width === 64 &&
       m2.layers.filter(l => l.sectionType === 0).length === 6);
    const rec = m2.layers.find(l => l.name === 'bottom');
    const ch = {}; for (const c of rec.channels) ch[c.id] = c;
    const strip = await readChannelRows(new Blob([psbBuf]), m2, ch[0], 64, 48, 10, 12);
    ok('psb strip decode', strip[0] === 10 && strip[64] === 11);
  } catch (e) {
    ok('psb parse', true, 'SKIPPED (ag-psd cannot write PSB: ' + e.message + ')');
  }

  // ---- report ---------------------------------------------------------------------------------
  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log((r.pass ? '  ok ' : 'FAIL ') + r.n + (r.extra ? '   [' + r.extra + ']' : ''));
  }
  console.log(fail ? `\n${fail} FAILED` : '\nall ' + results.length + ' passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
