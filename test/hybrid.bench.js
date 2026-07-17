#!/usr/bin/env node
// Benchmark the hybrid lazy proxy on a real (large) PSD. Feeds a disk-backed File through the
// actual FileReader hook in the single-file build and reports build time, proxy size, and JS
// heap before/peak/after (sampled every 250 ms). Canvas backing stores are not in the JS heap;
// the heap numbers cover the file reads + decode buffers, which is what A1+A2 attack.
//
// Pass --full to benchmark the old whole-buffer path (@webtoon/psd) instead, for comparison.
// Peak RSS of the whole Chrome process tree is sampled from node (ps), since big ArrayBuffers
// and canvas backing stores don't show up in the JS heap counter.
//
//   node test/hybrid.bench.js ~/Downloads/large-file.psd [path-to-html] [--full]

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2).filter(a => a !== '--full');
const FULL = process.argv.includes('--full');
const FILE = args[0];
const HTML = path.resolve(args[1] || path.join(__dirname, '..', 'builds', 'photopea-offline.html'));
if (!FILE || !fs.existsSync(FILE)) { console.error('usage: node test/hybrid.bench.js <file.psd> [html] [--full]'); process.exit(1); }

// total RSS (MB) of a process and all its descendants
function treeRssMB(rootPid) {
  try {
    const rows = execSync('ps -axo pid=,ppid=,rss=', { encoding: 'utf8' }).trim().split('\n')
      .map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let total = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop();
      total += rss.get(pid) || 0;
      for (const k of kids.get(pid) || []) stack.push(k);
    }
    return Math.round(total / 1024);
  } catch (e) { return 0; }
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => { const t = m.text(); if (t.includes('[hybrid]')) console.log('  ' + t); });
    await page.goto('file://' + HTML, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('typeof window.__buildProxyPsdLazy === "function"', { timeout: 30000 });

    await page.evaluate(() => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.id = '__benchinput'; inp.style.display = 'none';
      document.body.appendChild(inp);
    });
    const input = await page.$('#__benchinput');
    await input.uploadFile(FILE);
    console.log('file:', FILE, (fs.statSync(FILE).size / 1e9).toFixed(2), 'GB —',
                FULL ? 'OLD whole-buffer path' : 'lazy path');

    const rootPid = browser.process().pid;
    const rssBefore = treeRssMB(rootPid);
    let rssPeak = rssBefore;
    const rssTimer = setInterval(() => { rssPeak = Math.max(rssPeak, treeRssMB(rootPid)); }, 500);

    const res = await page.evaluate(async (FULL) => {
      const mb = (b) => Math.round(b / 1e6);
      const heap = () => performance.memory ? performance.memory.usedJSHeapSize : 0;
      const before = heap();
      let peak = before;
      const timer = setInterval(() => { peak = Math.max(peak, heap()); }, 250);
      const file = document.getElementById('__benchinput').files[0];
      const t0 = performance.now();
      let proxy;
      if (FULL) {
        proxy = await window.__buildProxyPsd(await file.arrayBuffer(), 0.4);
      } else {
        // exercise the REAL FileReader hook (what Photopea's open path calls)
        proxy = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error);
          fr.readAsArrayBuffer(file);
        });
      }
      const ms = performance.now() - t0;
      clearInterval(timer);
      const after = heap();
      return { ms: Math.round(ms), proxyMB: mb(proxy.byteLength),
               beforeMB: mb(before), peakMB: mb(Math.max(peak, heap())), afterMB: mb(after),
               isProxy: proxy.byteLength !== file.size };
    }, FULL);

    clearInterval(rssTimer);
    const rssEnd = treeRssMB(rootPid);
    console.log('proxy built:', res.isProxy ? 'yes' : 'NO (original passed through!)');
    console.log('time:       ', (res.ms / 1000).toFixed(1) + 's');
    console.log('proxy size: ', res.proxyMB, 'MB');
    console.log('JS heap:    ', res.beforeMB, 'MB before ->', res.peakMB, 'MB peak ->', res.afterMB, 'MB after');
    console.log('chrome RSS: ', rssBefore, 'MB before ->', Math.max(rssPeak, rssEnd), 'MB peak');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
