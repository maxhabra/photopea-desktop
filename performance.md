# performance.md — minimizing RAM on large PSDs

Research notes + implementation plan for the hybrid low-RAM viewer (`viewer/hybrid.js`).
Test file: a ~2 GB PSD (e.g. `~/Downloads/large-file.psd`).

## Where the RAM goes

A 2 GB PSD is compressed (RLE/zip); decoded it is roughly 6–10 GB of raw RGBA. Photopea keeps
every layer decoded in memory, and every edit adds a history state that is never released until
the tab reloads. The ceiling is not machine RAM — it's what a single Chrome renderer process can
allocate. The hybrid proxy (downscaled proxy PSD → real Photopea UI) removes the biggest term;
the items below attack the rest, ordered by impact-to-effort.

References: [photopea#2453](https://github.com/photopea/photopea/issues/2453),
[photopea#7168](https://github.com/photopea/photopea/issues/7168) (history growth),
[photopea#454](https://github.com/photopea/photopea/issues/454),
["Not enough RAM" fixes](https://www.superchargebrowser.com/library/fix-photopea-not-enough-ram-chrome/).

---

## A. Reduce the proxy build's own peak  — ✅ A1+A2 DONE

The proxy build had two transient spikes that dwarfed the proxy itself. Both are fixed by
`viewer/lazy-psd.js` (a minimal lazy PSD/PSB reader) + the reworked `viewer/hybrid.js`.

**Measured on a 2.14 GB PSD (2000×2000, 109 layers), scale 0.4** via `test/hybrid.bench.js`:

|                    | old whole-buffer path | lazy path (A1+A2) |
|--------------------|----------------------|-------------------|
| peak Chrome RSS    | 4435 MB              | 1856 MB           |
| RSS above baseline | ~3.4 GB              | ~0.85 GB (mostly the 207 MB proxy + its canvases) |
| build time         | 2.8 s                | 2.7 s             |

Tests: `test/hybrid.test.js` (node unit: parser, RLE/raw/zip/prediction/16-bit, PSB, strips) and
`test/hybrid.browser.test.js` (end-to-end in the real build: structure, pixels, masks, opacity).
Both run as part of `test.sh`. Bench: `node test/hybrid.bench.js <file.psd> [--full]`.

The old @webtoon/psd path is kept as a fallback for files the lazy reader rejects (CMYK, 32-bit,
…) that are small enough to load whole (< 1.5 GB); its layer-stacking order bug (top-first vs
ag-psd's bottom-first) was fixed along the way.

### A1. Lazy slicing — stop loading the whole file up front  ✅
`hybrid.js` calls `blob.arrayBuffer()` (all 2 GB into memory) because `@webtoon/psd` requires
a full ArrayBuffer.

- Parse only the PSD header + layer-records section (a few MB) to get per-layer channel-data
  offsets/lengths.
- Fetch each layer's channel data on demand with `blob.slice(offset, len).arrayBuffer()` —
  the File is disk-backed, so peak RAM becomes "one layer at a time".
- Needs a small custom layer-record parser (or a fork of @webtoon/psd's offset logic). The PSD
  layer-info section makes this tractable.
- Bonus: unlocks files > 4 GB, which today can't even be `arrayBuffer()`'d reliably — the top
  `SIZE_TIERS` entry (scale 0.3 for > 4 GB) is currently untestable.

### A2. Strip decoding — never hold a full-res layer  ✅
`buildProxyChildren` calls `node.composite(false)`, decoding the whole layer as RGBA before
downscaling (a 20000×15000 layer = 1.2 GB).

- PSD RLE (PackBits) stores a per-row byte-count table at the start of each channel, so rows
  are independently seekable.
- Decode in horizontal strips (~512 rows), downscale each strip into the destination canvas
  (`drawImage` with source rect), free the strip.
- Peak per-layer RAM drops from `W×H×4` to `W×512×4`, independent of layer size.

### A3. OPFS proxy cache (cheap, independent)
Cache the built proxy PSD in OPFS keyed by `name + size + mtime`. Reopening a big file becomes
instant, with no 2 GB re-read spike.

## B. Smarter escalation — avoid ever loading the full doc

Escalation currently re-opens the entire original (`escalate()` posts the full ArrayBuffer),
reintroducing the exact problem.

### B1. Per-layer escalation
On edit-tool pick, swap only the *active layer* to full resolution: decode that one layer from
the stashed file, replace it via a postMessage script, keep the rest proxied. Most edits touch
one layer.

### B2. Edit-on-proxy, replay-on-original
Let the user edit the proxy freely; record the operations via Photopea's scripting API; replay
them headlessly against the original with coordinates scaled by `1/scale`, using the existing
`cli.js` worker. The interactive session never holds the full file — only a disposable batch
process does, at export time. Fits this repo unusually well: both halves already exist.

### B3. Viewport/region escalation
Open a full-res *crop* of the visible region for pixel-peeping, without full escalation.

## C. Patch Photopea itself (via the existing refresh.sh/pack.py patch pipeline)

### C1. Cap / purge undo history
History states are the main cause of "RAM grows until crash" in long sessions; users have
requested a cap for years and Photopea never shipped one. Find the history-stack array in the
minified code and cap its length (drop oldest states). A differentiating offline-build feature.

### C2. Auto-convert 16/32-bit documents to 8-bit on open
Scripted `Image > Mode` call (or patch) — halves/quarters raster memory for deep-color files.
Should be opt-in or badge-announced (it's lossy).

## D. Process-level hygiene

- **D1.** Escalate into a fresh renderer: reload the tab/webview first, then post the file, so
  the proxy session's allocations don't share address space with the ~6 GB decode. ("Reload and
  reopen" is Photopea's own recommended fix for long sessions.)
- **D2.** `cli.js`: recycle the page/worker between large files instead of reusing one
  long-lived Photopea instance.

---

## Suggested order

1. **A1 + A2** ✅ — cut proxy-build peak RSS 4.4 GB → 1.9 GB on the 2 GB test file; makes the >4 GB tier real.
2. **C1** — history cap; fixes long editing sessions.
3. **B1** (then B2) — makes *editing* large files genuinely low-RAM.
4. A3, C2, D1, D2 — cheap, independent, do opportunistically.
