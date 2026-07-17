#!/usr/bin/env node
// Smoke tests for the offline Photopea single-file build (builds/photopea-offline.html).
// Drives it in headless Chrome and checks the behaviors we've fixed. Run via ../test.sh.
//
//   node run.js [path-to-html]     default: ../builds/photopea-offline.html
//   CHROME=/path/to/chrome node run.js
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HTML = path.resolve(process.argv[2] || path.join(__dirname, '..', 'builds', 'photopea-offline.html'));
const URL = 'file://' + HTML;

const results = [];
const ok = (n, cond, extra) => { results.push({ n, pass: !!cond, extra: extra || '' }); };

async function newPage(browser, { lang, mode } = {}) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 860 });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  if (lang) await p.evaluateOnNewDocument((l) => {
    Object.defineProperty(navigator, 'languages', { get: () => [l, l.split('-')[0]] });
    Object.defineProperty(navigator, 'language', { get: () => l });
  }, lang);
  if (mode != null) await p.evaluateOnNewDocument((m) => { try { localStorage.setItem('__ppmode', String(m)); } catch (e) {} }, mode);
  p.__errs = errs;
  return p;
}

const menuText = (p) => p.evaluate(() =>
  [...document.querySelectorAll('button')].map(x => x.textContent.trim()).filter(t => t && t.length < 16));
const visibleText = (p, t) => p.evaluate((t) =>
  [...document.querySelectorAll('*')].some(e => e.offsetParent !== null && e.querySelectorAll('*').length < 3 && e.textContent.trim() === t), t);

async function openMenuOpens(p) {
  await p.evaluate(() => { window.__mo = false; new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && String(n.className).includes('contextpanel')) window.__mo = true; }).observe(document.body, { childList: true, subtree: true }); });
  const pos = await p.evaluate(() => { const e = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'File' || x.textContent.trim() === 'Tệp'); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await p.mouse.click(pos.x, pos.y);
  await new Promise(r => setTimeout(r, 600));
  const opened = await p.evaluate(() => window.__mo);
  await p.keyboard.press('Escape');
  return opened;
}

(async () => {
  console.log('Testing:', URL);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--allow-file-access-from-files'] });

  // ---- 1) Photopea (default): loads clean, full-width, UI trimmed, menu + doc + file dialog work ----
  {
    const p = await newPage(browser);
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 6000));
    const st = await p.evaluate(() => {
      const cap = document.getElementById('cap');
      const app = document.querySelector('.app');
      const sset = document.querySelector('.storageset');
      return {
        appLoaded: !!app,
        landingHidden: !cap || getComputedStyle(cap).display === 'none',
        mainW: app ? Math.round(app.children[0].getBoundingClientRect().width) : 0,
        vw: window.innerWidth,
        sidebarHidden: sset ? getComputedStyle(sset.children[0]).display === 'none' : true,
        switcher: !!document.getElementById('__modesw'),
      };
    });
    ok('app loads', st.appLoaded);
    ok('goes straight to app (no landing)', st.landingHidden);
    ok('full-width layout (no ad gap)', st.mainW === st.vw, `main=${st.mainW} vw=${st.vw}`);
    ok('home sidebar hidden', st.sidebarHidden);
    ok('mode switcher present', st.switcher);
    ok('Account button hidden', !(await visibleText(p, 'Account')));
    ok('Generate with AI hidden', !(await visibleText(p, 'Generate with AI')));
    ok('top-right links hidden (Report a bug)', !(await p.evaluate(() => [...document.querySelectorAll('*')].some(e => e.offsetParent !== null && e.querySelectorAll('*').length < 2 && /Report a bug/.test(e.textContent)))));
    ok('File menu opens', await openMenuOpens(p));
    // Open From Computer -> file dialog (while still on the home screen, before opening a doc)
    let dialog = false;
    try {
      const b = await p.evaluate(() => { const e = [...document.querySelectorAll('button,div,span')].find(x => x.textContent.trim() === 'Open From Computer' && x.querySelectorAll('*').length <= 2); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      if (b) { const [fc] = await Promise.all([p.waitForFileChooser({ timeout: 4000 }), p.mouse.click(b.x, b.y)]); dialog = !!fc; await fc.cancel(); }
    } catch (e) {}
    ok('Open From Computer opens file dialog', dialog);
    // New Project -> canvas (do this last — it leaves the home screen)
    const np = await p.evaluate(() => { const e = [...document.querySelectorAll('button,div,span')].find(x => x.textContent.trim() === 'New Project' && x.querySelectorAll('*').length <= 2); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (np) { await p.mouse.click(np.x, np.y); await new Promise(r => setTimeout(r, 1000)); await p.keyboard.press('Enter'); await new Promise(r => setTimeout(r, 2500)); }
    ok('New Project creates a canvas', await p.evaluate(() => !!document.querySelector('canvas')));
    ok('no console errors (Photopea)', p.__errs.length === 0, p.__errs.slice(0, 2).join(' | '));
    await p.close();
  }

  // ---- 2) Vectorpea via switcher ----
  {
    const p = await newPage(browser, { mode: 1 });
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 11000));
    // Vectorpea's editor menus differ from Photopea (Object/Type vs Image/Layer) — a robust mode check
    const vmenus = await menuText(p);
    ok('switcher -> Vectorpea (Object/Type menus)', vmenus.includes('Object') && vmenus.includes('Type'), vmenus.slice(0, 9).join(' '));
    ok('no stuck Loading toast (Vectorpea)', !(await p.evaluate(() => [...document.querySelectorAll('.alertcont .alertpanel')].some(a => a.offsetParent !== null && /^Loading/i.test(a.textContent.trim())))));
    await p.close();
  }

  // ---- 3) Jampea via switcher ----
  {
    const p = await newPage(browser, { mode: 2 });
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 11000));
    // Jampea is a music editor — it has an "Input" menu that neither Photopea nor Vectorpea have
    const jmenus = await menuText(p);
    ok('switcher -> Jampea (Input menu)', jmenus.includes('Input'), jmenus.slice(0, 9).join(' '));
    ok('no stuck Loading toast (Jampea)', !(await p.evaluate(() => [...document.querySelectorAll('.alertcont .alertpanel')].some(a => a.offsetParent !== null && /^Loading/i.test(a.textContent.trim())))));
    await p.close();
  }

  // ---- 4) Vietnamese UI (embedded translations) ----
  {
    const p = await newPage(browser, { lang: 'vi-VN' });
    await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await new Promise(r => setTimeout(r, 9000));
    const m = await menuText(p);
    ok('Vietnamese translation (Tệp/Chỉnh sửa)', m.includes('Tệp') && m.includes('Chỉnh sửa'), m.slice(0, 6).join(' '));
    await p.close();
  }

  await browser.close();

  const pass = results.filter(r => r.pass).length;
  console.log('\n' + '-'.repeat(60));
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.extra ? '   (' + r.extra + ')' : ''}`);
  console.log('-'.repeat(60));
  console.log(`${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
