#!/usr/bin/env node
'use strict';
// photopea / cli.js — batch-drive the offline Photopea from the command line (headless Chrome).
// Opens each input in Photopea (in an iframe, using its postMessage API), optionally transforms
// it, and exports to a chosen format. No server, no internet. Processes files in parallel.
//
//   photopea <inputs...> --to <format> [options]
//
// Examples:
//   photopea photo.psd --to png
//   photopea *.psd --to jpg --quality 90 --out exported --concurrency 8
//   photopea a.png b.webp --to jpg --resize 1024x1024 --out out
//   photopea poster.psd --to pdf
//
// Options:
//   --to <fmt>        output format: png jpg webp gif bmp tiff svg pdf psd ai ... (required)
//   --out <dir>       output directory (default: ./out)
//   --resize <WxH>    resize before export, e.g. 1920x1080 (512x or x512 keeps aspect)
//   --quality <0-100> quality for lossy formats (jpg/webp), default 90
//   --concurrency <N> number of parallel Photopea workers (default: CPU cores, capped at inputs)
//   --script "<js>"   run an extra Photopea script per file before export (advanced)
//   --html <path>     path to the single-file build (default: <repo>/builds/photopea-offline.html)
//   --chrome <path>   Chrome/Chromium executable (auto-detected on macOS/Linux, or $CHROME)
//   --timeout <ms>    per-step timeout (default: 60000)
//   -h, --help

const fs = require('fs');
const path = require('path');
const os = require('os');

let puppeteer;
for (const base of [__dirname, path.join(__dirname, 'test')]) {
  try { puppeteer = require(require.resolve('puppeteer-core', { paths: [base] })); break; } catch (e) {}
}
if (!puppeteer) {
  console.error('puppeteer-core not found. Install it once:\n  ( cd "' + __dirname + '" && npm install )');
  process.exit(1);
}

function findChrome(pref) {
  const cands = [pref, process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return pref;
}

function parseArgs(argv) {
  const opt = { inputs: [], out: 'out', quality: 90, timeout: 60000,
    html: path.join(__dirname, 'builds', 'photopea-offline.html') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opt.help = true;
    else if (a === '--to') opt.to = argv[++i];
    else if (a === '--out') opt.out = argv[++i];
    else if (a === '--resize') opt.resize = argv[++i];
    else if (a === '--quality') opt.quality = parseInt(argv[++i], 10);
    else if (a === '--concurrency') opt.concurrency = parseInt(argv[++i], 10);
    else if (a === '--script') opt.script = argv[++i];
    else if (a === '--html') opt.html = argv[++i];
    else if (a === '--chrome') opt.chrome = argv[++i];
    else if (a === '--timeout') opt.timeout = parseInt(argv[++i], 10);
    else if (a.startsWith('--')) { console.error('Unknown option: ' + a); process.exit(2); }
    else opt.inputs.push(a);
  }
  return opt;
}

const HELP = fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).slice(1, 27).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
const EXT = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif', bmp: 'bmp', tiff: 'tif', svg: 'svg', pdf: 'pdf', psd: 'psd', ai: 'ai', ico: 'ico', dds: 'dds' };

const WRAPPER = (htmlAbs) => `<!doctype html><body style="margin:0"><iframe id=pp style="width:100vw;height:100vh;border:0" src="file://${htmlAbs}"></iframe>
<script>
window.__q=[];
addEventListener('message',function(e){ if(e.source!==document.getElementById('pp').contentWindow) return;
  var d=e.data;
  if(d instanceof ArrayBuffer){ var u=new Uint8Array(d),s='',C=0x8000; for(var i=0;i<u.length;i+=C) s+=String.fromCharCode.apply(null,u.subarray(i,i+C)); window.__q.push({t:'buf',b:btoa(s)}); }
  else window.__q.push({t:'msg',d:(typeof d==='string')?d:JSON.stringify(d)});
});
window.__send=function(x){ document.getElementById('pp').contentWindow.postMessage(x,'*'); };
window.__sendBuf=function(b64){ var bin=atob(b64),u=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i); document.getElementById('pp').contentWindow.postMessage(u.buffer,'*'); };
window.__drain=function(){ return window.__q.splice(0); };
</script>`;

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.inputs.length || !opt.to) { console.log(HELP); process.exit(opt.help ? 0 : 2); }
  if (!fs.existsSync(opt.html)) { console.error('Build not found: ' + opt.html + '\nRun: python3 pack.py'); process.exit(1); }
  const chrome = findChrome(opt.chrome);
  const outExt = EXT[opt.to.toLowerCase()] || opt.to.toLowerCase();
  fs.mkdirSync(opt.out, { recursive: true });
  const lossy = /^(jpg|jpeg|webp)$/i.test(opt.to);
  const fmt = lossy ? `${opt.to.toLowerCase() === 'jpeg' ? 'jpg' : opt.to.toLowerCase()}:${opt.quality}` : opt.to.toLowerCase();
  const workers = Math.max(1, Math.min(opt.concurrency || os.cpus().length, opt.inputs.length));

  const wrapper = path.join(os.tmpdir(), 'pp_cli_' + process.pid + '.html');
  fs.writeFileSync(wrapper, WRAPPER(path.resolve(opt.html)));

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new',
    args: ['--allow-file-access-from-files', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });

  const queue = opt.inputs.slice();
  let ok = 0, fail = 0;
  const t0 = Date.now();

  async function makeWorker() {
    const page = await browser.newPage();
    await page.goto('file://' + wrapper, { waitUntil: 'load', timeout: opt.timeout });
    await new Promise(r => setTimeout(r, 7000)); // boot Photopea inside the iframe
    const send = (x) => page.evaluate((s) => window.__send(s), x);
    const sendBuf = (b) => page.evaluate((s) => window.__sendBuf(s), b);
    const drain = () => page.evaluate(() => window.__drain());
    async function waitFor(pred) {
      const t = Date.now(); const acc = [];
      while (Date.now() - t < opt.timeout) {
        const b = await drain(); acc.push(...b);
        if (b.some(pred)) return acc;
        await new Promise(r => setTimeout(r, 120));
      }
      throw new Error('timeout waiting for Photopea');
    }
    const done = (m) => m.t === 'msg' && /done/i.test(m.d);
    return async function processOne(input) {
      const name = path.basename(input).replace(/\.[^.]+$/, '');
      const outFile = path.join(opt.out, name + '.' + outExt);
      if (!fs.existsSync(input)) throw new Error('no such file');
      await drain();
      await sendBuf(fs.readFileSync(input).toString('base64'));
      await waitFor(done);
      if (opt.resize) {
        const [w, h] = opt.resize.toLowerCase().split('x').map(n => n ? parseInt(n, 10) : null);
        await send(`app.activeDocument.resizeImage(${w || 'null'}, ${h || 'null'});`);
        await waitFor(done);
      }
      if (opt.script) { await send(opt.script.endsWith(';') ? opt.script : opt.script + ';'); await waitFor(done); }
      await send(`app.activeDocument.saveToOE("${fmt}");`);
      const acc = await waitFor(m => m.t === 'buf');
      const buf = acc.reverse().find(m => m.t === 'buf');
      fs.writeFileSync(outFile, Buffer.from(buf.b, 'base64'));
      await send('if(app.documents.length) app.activeDocument.close();');
      await new Promise(r => setTimeout(r, 200));
      return { outFile, size: fs.statSync(outFile).size };
    };
  }

  async function runWorker() {
    let processOne;
    try { processOne = await makeWorker(); }
    catch (e) { console.error('worker failed to start:', e.message); return; }
    while (queue.length) {
      const input = queue.shift();
      try { const r = await processOne(input); ok++; console.log(`  ok   ${input}  ->  ${r.outFile}  (${r.size} bytes)`); }
      catch (e) { fail++; console.log(`  FAIL ${input}  (${e.message})`); }
    }
  }

  console.log(`Converting ${opt.inputs.length} file(s) to ${opt.to} with ${workers} worker(s)...`);
  try { await Promise.all(Array.from({ length: workers }, runWorker)); }
  finally { await browser.close(); try { fs.unlinkSync(wrapper); } catch (e) {} }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${ok} ok, ${fail} failed in ${secs}s  ->  ${path.resolve(opt.out)}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
