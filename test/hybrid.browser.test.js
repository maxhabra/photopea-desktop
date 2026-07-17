#!/usr/bin/env node
// End-to-end test of the hybrid lazy proxy (performance.md A1+A2) inside the real single-file
// build: generates a PSD, hands it to window.__buildProxyPsdLazy as a File in headless Chrome
// (strip decoding + canvas downscale run in-page), then validates the returned proxy PSD's
// structure AND pixels node-side with ag-psd.
//
//   node test/hybrid.browser.test.js [path-to-html]     default: ../builds/photopea-offline.html

const path = require('path');
const puppeteer = require('puppeteer-core');
const R = (p) => require(require.resolve(p, { paths: [path.join(__dirname, '..')] }));
const agPsd = R('ag-psd');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTML = path.resolve(process.argv[2] || path.join(__dirname, '..', 'builds', 'photopea-offline.html'));

const results = [];
const ok = (n, cond, extra) => results.push({ n, pass: !!cond, extra: extra || '' });

const solid = (w, h, [r, g, b, a]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a; }
  return { width: w, height: h, data: d };
};

// ag-psd needs an ImageData factory to read layers back in node (no canvas here)
agPsd.initializeCanvas(
  () => { throw new Error('canvas not available in node test'); },
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));

(async () => {
  const doc = { width: 64, height: 48, children: [
    { name: 'bottom', imageData: solid(64, 48, [10, 20, 30, 255]), left: 0, top: 0 },
    { name: 'semi', opacity: 0.5, imageData: solid(20, 10, [255, 0, 0, 200]), left: 5, top: 6 },
    { name: 'masked', imageData: solid(30, 20, [0, 255, 0, 255]), left: 10, top: 10,
      mask: { top: 12, left: 12, bottom: 22, right: 32, imageData: solid(20, 10, [100, 100, 100, 255]) } },
    { name: 'G', opened: true, children: [
      { name: 'inner1', imageData: solid(4, 4, [9, 9, 9, 255]), left: 1, top: 1 },
      { name: 'inner2', imageData: solid(4, 4, [7, 7, 7, 255]), left: 8, top: 8 },
    ] },
  ] };
  const psdB64 = Buffer.from(agPsd.writePsd(doc, { generateThumbnail: false })).toString('base64');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof window.__buildProxyPsdLazy === "function"', { timeout: 30000 });

    const proxyB64 = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'test.psd');
      const proxy = await window.__buildProxyPsdLazy(file, 0.5);   // force scale (file is tiny)
      const u8 = new Uint8Array(proxy);
      let out = '';
      for (let i = 0; i < u8.length; i += 0x8000) out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return btoa(out);
    }, psdB64);

    const proxy = agPsd.readPsd(Buffer.from(proxyB64, 'base64'),
      { useImageData: true, skipCompositeImageData: true, skipThumbnail: true });

    ok('proxy dimensions halved', proxy.width === 32 && proxy.height === 24,
       proxy.width + 'x' + proxy.height);
    const names = proxy.children.map(c => c.name).join(',');
    ok('layer order preserved (bottom-first)', names === 'bottom,semi,masked,G', names);
    const grp = proxy.children[3];
    ok('group children preserved', !!grp.children && grp.children.map(c => c.name).join(',') === 'inner1,inner2',
       grp.children && grp.children.map(c => c.name).join(','));

    const semi = proxy.children[1];
    ok('layer offset scaled', semi.left === 3 /* round(5*.5) */ && semi.top === 3, semi.left + ',' + semi.top);
    ok('layer opacity carried', Math.abs(semi.opacity - 0.5) < 0.01, String(semi.opacity));
    const sd = semi.imageData;                       // 10x5 solid red, alpha 200 (opacity NOT baked)
    const mid = ((2 * sd.width) + 5) * 4;
    ok('pixels downscaled correctly', sd.width === 10 && sd.height === 5 &&
       sd.data[mid] === 255 && sd.data[mid + 1] === 0 && sd.data[mid + 2] === 0,
       sd.width + 'x' + sd.height + ' rgb=' + [sd.data[mid], sd.data[mid + 1], sd.data[mid + 2]]);
    ok('alpha NOT double-baked', Math.abs(sd.data[mid + 3] - 200) <= 2, String(sd.data[mid + 3]));

    const md = proxy.children[2].imageData;          // masked: alpha 100 inside mask rect, 0 outside
    const at = (x, y) => md.data[(y * md.width + x) * 4 + 3];
    ok('mask baked into alpha (inside)', Math.abs(at(5, 3) - 100) <= 3, String(at(5, 3)));
    ok('mask baked into alpha (outside)', at(13, 8) <= 3, String(at(13, 8)));
  } finally {
    await browser.close();
  }

  let fail = 0;
  for (const r of results) {
    if (!r.pass) fail++;
    console.log((r.pass ? '  ok ' : 'FAIL ') + r.n + (r.extra ? '   [' + r.extra + ']' : ''));
  }
  console.log(fail ? `\n${fail} FAILED` : '\nall ' + results.length + ' passed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
