#!/usr/bin/env node
'use strict';
// convert-smart — one command for every input. Routes each file to the fastest tool:
//   * ordinary raster (png/jpg/webp/gif/tiff/bmp/avif) -> sharp (libvips, native, very fast)
//   * layered / vector / special (psd/ai/xd/sketch/fig/pdf/svg/raw/...) -> the Photopea CLI
//
//   convert-smart <inputs...> --to <format> [options]
//
// Examples:
//   convert-smart mix/*.{png,psd,ai} --to webp --quality 85 --out web
//   convert-smart photo.jpg --to png --resize 800x600
//
// Options: same as `photopea` (--to --out --resize --quality --concurrency --html --chrome).
// Add --verbose to see which engine handled each file.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let sharp = null;
try { sharp = require(require.resolve('sharp', { paths: [__dirname] })); } catch (e) {}

const SHARP_IN = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'tif', 'bmp', 'avif', 'heic', 'heif']);
const SHARP_OUT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tiff', 'tif', 'avif']);
const EXT = { jpeg: 'jpg', tiff: 'tif' };

function parseArgs(argv) {
  const o = { inputs: [], out: 'out', quality: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--resize') o.resize = argv[++i];
    else if (a === '--quality') o.quality = parseInt(argv[++i], 10);
    else if (a === '--concurrency') o.concurrency = parseInt(argv[++i], 10);
    else if (a === '--html') o.html = argv[++i];
    else if (a === '--chrome') o.chrome = argv[++i];
    else if (a.startsWith('--')) { console.error('Unknown option: ' + a); process.exit(2); }
    else o.inputs.push(a);
  }
  return o;
}

const ext = (f) => path.extname(f).slice(1).toLowerCase();

async function sharpOne(input, opt, outFile) {
  let img = sharp(input, { failOn: 'none' });
  if (opt.resize) {
    const [w, h] = opt.resize.toLowerCase().split('x').map(n => n ? parseInt(n, 10) : null);
    img = img.resize(w || null, h || null, (w && h) ? { fit: 'fill' } : {});
  }
  const fmt = opt.to.toLowerCase();
  if (fmt === 'jpg' || fmt === 'jpeg') img = img.jpeg({ quality: opt.quality });
  else if (fmt === 'webp') img = img.webp({ quality: opt.quality });
  else if (fmt === 'avif') img = img.avif({ quality: opt.quality });
  else img = img.toFormat(fmt === 'tif' ? 'tiff' : fmt);
  await img.toFile(outFile);
  return fs.statSync(outFile).size;
}

function runPhotopea(files, opt) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'cli.js'), ...files, '--to', opt.to, '--out', opt.out, '--quality', String(opt.quality)];
    if (opt.resize) args.push('--resize', opt.resize);
    if (opt.concurrency) args.push('--concurrency', String(opt.concurrency));
    if (opt.html) args.push('--html', opt.html);
    if (opt.chrome) args.push('--chrome', opt.chrome);
    const ch = spawn(process.execPath, args, { stdio: 'inherit' });
    ch.on('close', (code) => resolve(code || 0));
  });
}

async function pool(items, n, fn) {
  const q = items.slice(); const runners = [];
  for (let i = 0; i < Math.max(1, n); i++) runners.push((async () => { while (q.length) await fn(q.shift()); })());
  await Promise.all(runners);
}

async function main() {
  const HELP = fs.readFileSync(__filename, 'utf8').split('\n').filter(l => l.startsWith('//')).slice(1, 18).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help || !opt.inputs.length || !opt.to) { console.log(HELP); process.exit(opt.help ? 0 : 2); }
  fs.mkdirSync(opt.out, { recursive: true });
  const to = opt.to.toLowerCase();
  const outExt = EXT[to] || to;

  const useSharp = (f) => sharp && SHARP_IN.has(ext(f)) && SHARP_OUT.has(to);
  const sharpFiles = opt.inputs.filter(useSharp);
  const peaFiles = opt.inputs.filter(f => !useSharp(f));

  console.log(`Routing: ${sharpFiles.length} via sharp (fast), ${peaFiles.length} via Photopea` + (sharp ? '' : '  (sharp not installed -> all Photopea)'));
  let ok = 0, fail = 0;
  const t0 = Date.now();

  // sharp group (parallel)
  await pool(sharpFiles, opt.concurrency || os.cpus().length, async (input) => {
    const outFile = path.join(opt.out, path.basename(input).replace(/\.[^.]+$/, '') + '.' + outExt);
    try { const sz = await sharpOne(input, opt, outFile); ok++; if (opt.verbose) console.log(`  sharp    ${input} -> ${outFile} (${sz} b)`); }
    catch (e) { fail++; console.log(`  FAIL(sharp) ${input}  (${e.message})`); }
  });

  // photopea group (its own parallel workers)
  if (peaFiles.length) {
    const code = await runPhotopea(peaFiles, opt);
    // cli.js prints its own per-file results; tally by checking outputs
    for (const f of peaFiles) {
      const out = path.join(opt.out, path.basename(f).replace(/\.[^.]+$/, '') + '.' + outExt);
      if (fs.existsSync(out)) ok++; else fail++;
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${ok} ok, ${fail} failed in ${secs}s  ->  ${path.resolve(opt.out)}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
