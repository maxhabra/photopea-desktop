#!/usr/bin/env node
// Debug: why is Jampea playback silent? Loads the build in Jampea mode, injects a tiny MIDI,
// presses play, and reports soundfont XHR + AudioContext state.
//   CHROME=/path node test/jampea-sound.debug.js
const puppeteer = require(require('path').join(__dirname, 'node_modules', 'puppeteer-core'));
const path = require('path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + path.resolve(__dirname, '..', 'builds', 'photopea-offline.html');

// minimal format-0 MIDI: program 0, one C4 quarter note
function tinyMidi() {
  const b = [];
  const push = (...x) => b.push(...x);
  push(0x4d,0x54,0x68,0x64, 0,0,0,6, 0,0, 0,1, 0x01,0xe0);            // MThd, fmt0, 1trk, 480
  const trk = [0,0xc0,0x00, 0,0x90,60,100, 0x83,0x60,0x80,60,0, 0,0xff,0x2f,0];
  push(0x4d,0x54,0x72,0x6b, 0,0,0,trk.length, ...trk);                 // MTrk
  return Buffer.from(b);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const p = await browser.newPage();
  await p.setViewport({ width: 1440, height: 860 });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  await p.evaluateOnNewDocument(() => {
    try { localStorage.setItem('__ppmode', '2'); } catch (e) {}
    // spy XHR (original URLs, before the offline bootstrap rewrites them)
    window.__xhrlog = [];
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__u = String(u);
      if (this.__u.indexOf('sf2') !== -1 || this.__u.indexOf('MagicSF') !== -1) {
        this.addEventListener('load', () => window.__xhrlog.push({
          u: this.__u.slice(0, 80), status: this.status,
          len: this.response && this.response.byteLength || (this.responseText || '').length }));
        this.addEventListener('error', () => window.__xhrlog.push({ u: this.__u.slice(0, 80), error: true }));
      }
      return oo.apply(this, arguments);
    };
    // spy AudioContext
    window.__ACs = [];
    for (const k of ['AudioContext', 'webkitAudioContext']) {
      const O = window[k]; if (!O) continue;
      window[k] = function (...a) { const c = new O(...a); window.__ACs.push(c); return c; };
      window[k].prototype = O.prototype;
    }
  });
  await p.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await p.waitForFunction(() => document.querySelector('div.topbar') && document.querySelector('div.body'), { timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));   // let Jampea init + soundfont load

  // inject the midi
  const b64 = tinyMidi().toString('base64');
  await p.evaluate((b) => window.__openLocalB64('tiny.mid', b), b64);
  await new Promise(r => setTimeout(r, 4000));

  // find candidate play controls near top-center
  const candidates = await p.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('*')) {
      const r = e.getBoundingClientRect();
      if (r.y < 120 && r.y > 40 && r.width > 8 && r.width < 60 && r.height > 8 && r.height < 60 &&
          Math.abs(r.x + r.width / 2 - innerWidth / 2) < 120 && e.children.length <= 1)
        out.push({ tag: e.tagName, cls: String(e.className).slice(0, 40), x: r.x + r.width / 2, y: r.y + r.height / 2 });
    }
    return out;
  });
  console.log('CANDIDATES', JSON.stringify(candidates));
  for (const c of candidates.slice(0, 3)) await p.mouse.click(c.x, c.y);
  await new Promise(r => setTimeout(r, 3000));

  const report = await p.evaluate(() => ({
    xhr: window.__xhrlog,
    acs: (window.__ACs || []).map(c => ({ state: c.state, t: c.currentTime, sr: c.sampleRate })),
    docTabs: [...document.querySelectorAll('*')].filter(e => e.textContent === 'tiny.mid' && e.children.length === 0).length,
  }));
  console.log('REPORT', JSON.stringify(report, null, 1));
  console.log('ERRORS', JSON.stringify(errs.slice(0, 6)));
  await browser.close();
})();
