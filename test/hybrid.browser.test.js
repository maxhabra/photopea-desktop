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

    // ---- live-Photopea tests: script channel, per-layer escalation (B1), history cap (C1) ----
    // Photopea scripts sent via postMessage run in the page's own JS context, so a script can
    // report back through a window global that page.waitForFunction can see.
    const runScript = async (script, resultExpr, timeout = 30000) => {
      await page.evaluate((s) => window.postMessage(s, '*'), script);
      if (!resultExpr) return null;
      await page.waitForFunction(resultExpr, { timeout });
      return page.evaluate(resultExpr);
    };
    // wait until Photopea's script engine answers a ping
    await page.evaluate(() => {
      window.__ping = 0;
      const iv = setInterval(() => window.postMessage('window.__ping=1', '*'), 500);
      window.__stopPing = () => clearInterval(iv);
    });
    await page.waitForFunction('window.__ping === 1', { timeout: 60000 });
    await page.evaluate(() => window.__stopPing());
    ok('Photopea script channel alive', true);

    // open the proxy through the REAL FileReader hook (forced scale), then hand the delivered
    // buffer to Photopea — the same buffer Photopea's open path would have received
    await page.evaluate(async (b64) => {
      window.__hybridForceScale = 0.5;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'live.psd');
      const buf = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(file);
      });
      delete window.__hybridForceScale;
      window.postMessage(buf, '*', [buf]);
    }, psdB64);
    const nDocs = await runScript('window.__docs=app.documents.length', 'window.__docs');
    ok('proxy opened in Photopea', nDocs === 1, 'documents=' + nDocs);

    // B1: select 'semi' (top-first index 2 of [G, masked, semi, bottom]) and escalate it
    await runScript('app.activeDocument.activeLayer=app.activeDocument.layers[2];window.__sel=app.activeDocument.activeLayer.name',
                    'window.__sel');
    await page.evaluate(() => window.__escalateActiveLayer());
    await page.evaluate(() => { window.__docs = 0; });
    let layerDoc = null;
    for (let tries = 0; tries < 60 && !layerDoc; tries++) {
      await new Promise(r => setTimeout(r, 500));
      layerDoc = await runScript(
        'window.__d2=app.documents.length<2?null:JSON.stringify({n:app.documents[1].activeLayer.name,w:parseInt(app.documents[1].width),h:parseInt(app.documents[1].height)})',
        'window.__d2 !== undefined') ? await page.evaluate('window.__d2') : null;
      if (layerDoc === 'null' || layerDoc === null) { layerDoc = null; await page.evaluate('delete window.__d2'); }
    }
    const d2 = layerDoc ? JSON.parse(layerDoc) : null;
    ok('B1: active layer opened as own doc', !!d2, layerDoc || 'no second document');
    if (d2) {
      ok('B1: full layer resolution (20x10, not 10x5)', d2.w === 20 && d2.h === 10, d2.w + 'x' + d2.h);
      ok('B1: layer name + origin carried', /semi @ full res \(5,6\)/.test(d2.n), d2.n);
    }
    const stillPreview = await page.evaluate(() => !!document.getElementById('__hybridbadge'));
    ok('B1: proxy stays in preview mode (badge kept)', stillPreview);

    // C1: size-aware history cap. Control first: with the default ~1 GB budget a small doc keeps
    // stock history (proves the rotations DO record states); then a tiny budget caps it at 2.
    await runScript('app.documents.add(400,400,72);window.__doc3=app.documents.length', 'window.__doc3');
    for (let i = 0; i < 6; i++) {
      await runScript(`app.activeDocument.artLayers.add();window.__rotA${i}=1`, `window.__rotA${i}`);
    }
    const histFree = await runScript('window.__histA=app.activeDocument.historyStates.length', 'window.__histA');
    ok('C1 control: history grows uncapped', histFree >= 6, 'historyStates=' + histFree);

    await runScript('window.__ppHistBudget=1e6;app.documents.add(400,400,72);window.__doc4=app.documents.length',
                    'window.__doc4');
    for (let i = 0; i < 6; i++) {
      await runScript(`app.activeDocument.artLayers.add();window.__rotB${i}=1`, `window.__rotB${i}`);
    }
    const hist = await runScript('window.__histB=app.activeDocument.historyStates.length', 'window.__histB');
    ok('C1: history capped by RAM budget', hist > 0 && hist <= 4, 'historyStates=' + hist);
    ok('C1: capped well below control', hist < histFree, hist + ' < ' + histFree);
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
