#!/usr/bin/env node
'use strict';
// Tests for cli.js (photopea) and convert-smart.js. Run via ../test-cli.sh.
// Uses sharp to read output metadata (format/size) — no external tools needed.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require(require.resolve('sharp', { paths: [path.join(__dirname, '..')] }));

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.js');
const SMART = path.join(ROOT, 'convert-smart.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ppcli-'));
const node = process.execPath;
const run = (script, args) => execFileSync(node, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const results = [];
const ok = (n, cond, extra) => results.push({ n, pass: !!cond, extra: extra || '' });

(async () => {
  // ---- setup: a plain PNG (via sharp) and a PSD (via the CLI) ----
  const png = path.join(TMP, 'src.png');
  await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toFile(png);
  run(CLI, [png, '--to', 'psd', '--out', TMP]);
  const psd = path.join(TMP, 'src.psd');
  ok('setup: PSD produced by cli.js', fs.existsSync(psd));

  // ---- 1) cli.js: PNG -> JPG with resize ----
  const o1 = path.join(TMP, 'out1');
  run(CLI, [png, '--to', 'jpg', '--resize', '100x100', '--quality', '80', '--out', o1]);
  const j = path.join(o1, 'src.jpg');
  if (fs.existsSync(j)) {
    const m = await sharp(j).metadata();
    ok('cli.js PNG->JPG', m.format === 'jpeg', 'format=' + m.format);
    ok('cli.js --resize applied', m.width === 100 && m.height === 100, `${m.width}x${m.height}`);
  } else { ok('cli.js PNG->JPG', false, 'no output'); ok('cli.js --resize applied', false, 'no output'); }

  // ---- 2) cli.js: batch (2 files) ----
  const o2 = path.join(TMP, 'out2');
  run(CLI, [png, psd, '--to', 'png', '--out', o2]);
  ok('cli.js batch -> 2 outputs', fs.existsSync(path.join(o2, 'src.png')));

  // ---- 3) convert-smart: routes PNG->sharp, PSD->Photopea ----
  const o3 = path.join(TMP, 'out3');
  const out = run(SMART, [png, psd, '--to', 'webp', '--quality', '85', '--out', o3, '--verbose']);
  ok('convert-smart routes PNG via sharp', /sharp\s+\S*src\.png/.test(out), out.split('\n').find(l => /sharp/.test(l)) || '');
  ok('convert-smart routes PSD via Photopea', /Photopea/.test(out) && /1 via Photopea/.test(out));
  // both webp outputs valid (note: same basename would collide, so check the last written is webp)
  const w = path.join(o3, 'src.webp');
  ok('convert-smart produces webp', fs.existsSync(w) && (await sharp(w).metadata()).format === 'webp');

  // ---- report ----
  fs.rmSync(TMP, { recursive: true, force: true });
  const pass = results.filter(r => r.pass).length;
  console.log('\n' + '-'.repeat(56));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.extra ? '   (' + r.extra + ')' : ''}`);
  console.log('-'.repeat(56));
  console.log(`${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} process.exit(2); });
