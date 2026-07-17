// lazy-psd.js — minimal lazy PSD/PSB reader (A1 + A2 of performance.md).
//
// Unlike @webtoon/psd (which needs the WHOLE file as one ArrayBuffer), this reads only the
// layer-record metadata up front (a few MB from the start of the file, via blob.slice) and
// exposes per-channel ROW-RANGE decoding, so the proxy builder can decode huge layers in
// horizontal strips: peak RAM per layer becomes W×strip×4 instead of W×H×4, and the 2 GB
// file itself is never held in memory (the File/Blob stays disk-backed).
//
// Scope (falls back to the full in-memory path in hybrid.js when it throws):
//   - RGB (mode 3) and Grayscale (mode 1), 8- and 16-bit (16 converted to 8)
//   - compression: 0 raw, 1 RLE (strip-seekable via the per-row byte-count table),
//     2/3 zip (NOT seekable -> whole channel inflated once and cached on the channel)
//   - PSD (version 1) and PSB (version 2)
// No DOM usage — unit-testable in node (Blob is global since node 18).

const SIG_8BIM = 0x3842494d, SIG_8B64 = 0x38423634, SIG_8BPS = 0x38425053;

// additional-info keys that use an 8-byte length in PSB files
const BIG_KEYS = new Set(['LMsk', 'Lr16', 'Lr32', 'Layr', 'Mt16', 'Mt32', 'Mtrn',
                          'Alph', 'FMsk', 'lnk2', 'FEid', 'FXid', 'PxSD']);

const WINDOW = 1 << 22;              // 4 MB read window over the blob

class Cursor {
  constructor(blob) { this.blob = blob; this.pos = 0; this.wStart = 0; this.wEnd = 0; this.dv = null; }
  async ensure(n) {
    if (this.pos >= this.wStart && this.pos + n <= this.wEnd) return;
    if (this.pos + n > this.blob.size) throw new Error('lazy-psd: unexpected EOF');
    const start = this.pos, end = Math.min(this.blob.size, start + Math.max(n, WINDOW));
    const ab = await this.blob.slice(start, end).arrayBuffer();
    this.dv = new DataView(ab); this.wStart = start; this.wEnd = start + ab.byteLength;
  }
  skip(n) { this.pos += n; }
  async u8()  { await this.ensure(1); const v = this.dv.getUint8(this.pos - this.wStart);  this.pos += 1; return v; }
  async u16() { await this.ensure(2); const v = this.dv.getUint16(this.pos - this.wStart); this.pos += 2; return v; }
  async i16() { await this.ensure(2); const v = this.dv.getInt16(this.pos - this.wStart);  this.pos += 2; return v; }
  async u32() { await this.ensure(4); const v = this.dv.getUint32(this.pos - this.wStart); this.pos += 4; return v; }
  async i32() { await this.ensure(4); const v = this.dv.getInt32(this.pos - this.wStart);  this.pos += 4; return v; }
  async u64() { await this.ensure(8); const v = Number(this.dv.getBigUint64(this.pos - this.wStart)); this.pos += 8; return v; }
  async bytes(n) {
    await this.ensure(n);
    const o = this.pos - this.wStart;
    const v = new Uint8Array(this.dv.buffer, o, n).slice();
    this.pos += n; return v;
  }
  async str(n) { const b = await this.bytes(n); let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]); return s; }
}

const utf16be = (b) => {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  return s.replace(/\0+$/, '');
};

// Parse header + layer records only (no pixel data). Returns
//   { version, width, height, depth, mode, layers }
// where layers is in FILE ORDER (bottom-to-top; ag-psd's children order). Each layer:
//   { name, top, left, bottom, right, blendKey, opacity, clipping, hidden,
//     sectionType (0 layer | 1 open group | 2 closed group | 3 group-start divider),
//     mask: {top,left,bottom,right,defaultColor,relative,disabled} | null,
//     channels: [{ id, length, offset }] }        // offset = absolute position in the blob
export async function parseLazyPsd(blob) {
  const c = new Cursor(blob);
  if (await c.u32() !== SIG_8BPS) throw new Error('lazy-psd: not a PSD');
  const version = await c.u16();
  if (version !== 1 && version !== 2) throw new Error('lazy-psd: bad version ' + version);
  c.skip(6);
  const nchannels = await c.u16();
  const height = await c.u32(), width = await c.u32();
  const depth = await c.u16(), mode = await c.u16();
  if (depth !== 8 && depth !== 16) throw new Error('lazy-psd: unsupported depth ' + depth);
  if (mode !== 3 && mode !== 1) throw new Error('lazy-psd: unsupported color mode ' + mode);
  c.skip(await c.u32());                                        // color mode data
  c.skip(await c.u32());                                        // image resources
  const secLen = version === 2 ? await c.u64() : await c.u32(); // layer & mask section length
  const secEnd = c.pos + secLen;
  const layerInfoLen = version === 2 ? await c.u64() : await c.u32();
  let layers;
  if (layerInfoLen > 0) {
    layers = await readLayerInfo(c, version);
  } else {
    // 16/32-bit files keep the layer info in a global 'Lr16'/'Lr32' tagged block instead
    c.skip(await c.u32());                                      // global layer mask info
    layers = null;
    while (c.pos + 12 <= secEnd) {
      const sig = await c.u32();
      if (sig !== SIG_8BIM && sig !== SIG_8B64) break;
      const key = await c.str(4);
      const len = (version === 2 && BIG_KEYS.has(key)) ? await c.u64() : await c.u32();
      const dataEnd = c.pos + len + ((4 - (len % 4)) % 4);      // global blocks pad to 4
      if (key === 'Lr16') { layers = await readLayerInfo(c, version); break; }
      if (key === 'Lr32') throw new Error('lazy-psd: 32-bit layers unsupported');
      c.pos = dataEnd;
    }
    if (!layers) throw new Error('lazy-psd: no layer info (flattened file)');
  }
  return { version, nchannels, width, height, depth, mode, layers };
}

async function readLayerInfo(c, version) {
  const count = Math.abs(await c.i16());
  const layers = [];
  for (let i = 0; i < count; i++) layers.push(await readRecord(c, version));
  // channel image data follows the records sequentially, in layer order, channel order
  let off = c.pos;
  for (const rec of layers) for (const ch of rec.channels) { ch.offset = off; off += ch.length; }
  return layers;
}

async function readRecord(c, version) {
  const top = await c.i32(), left = await c.i32(), bottom = await c.i32(), right = await c.i32();
  const nch = await c.u16();
  const channels = [];
  for (let j = 0; j < nch; j++) {
    const id = await c.i16();
    const length = version === 2 ? await c.u64() : await c.u32();
    channels.push({ id, length, offset: 0 });
  }
  if (await c.u32() !== SIG_8BIM) throw new Error('lazy-psd: bad blend signature');
  const blendKey = await c.str(4);
  const opacity = await c.u8(), clipping = await c.u8(), flags = await c.u8();
  await c.u8();                                                 // filler
  const extraLen = await c.u32();
  const extraEnd = c.pos + extraLen;

  const maskLen = await c.u32();
  const maskEnd = c.pos + maskLen;
  let mask = null;
  if (maskLen >= 20) {
    const mt = await c.i32(), ml = await c.i32(), mb = await c.i32(), mr = await c.i32();
    const defaultColor = await c.u8(), mflags = await c.u8();
    mask = { top: mt, left: ml, bottom: mb, right: mr, defaultColor,
             relative: !!(mflags & 1), disabled: !!(mflags & 2) };
  }
  c.pos = maskEnd;
  c.skip(await c.u32());                                        // blending ranges
  const nameLen = await c.u8();
  let name = await c.str(nameLen);
  c.skip((4 - ((nameLen + 1) % 4)) % 4);                        // pascal string padded to 4

  // additional info blocks: we only need 'lsct'/'lsdk' (group structure) and 'luni' (name)
  let sectionType = 0;
  while (c.pos + 12 <= extraEnd) {
    let sig = await c.u32();
    if (sig !== SIG_8BIM && sig !== SIG_8B64) {                 // some writers pad oddly: resync <=3 bytes
      const base = c.pos - 4;
      let ok = false;
      for (let k = 1; k <= 3 && base + k + 12 <= extraEnd; k++) {
        c.pos = base + k; sig = await c.u32();
        if (sig === SIG_8BIM || sig === SIG_8B64) { ok = true; break; }
      }
      if (!ok) break;
    }
    const key = await c.str(4);
    const len = (version === 2 && BIG_KEYS.has(key)) ? await c.u64() : await c.u32();
    const dataEnd = c.pos + len;
    if ((key === 'lsct' || key === 'lsdk') && len >= 4) sectionType = await c.u32();
    else if (key === 'luni' && len >= 4) {
      const n = await c.u32();
      const s = utf16be(await c.bytes(Math.min(n * 2, dataEnd - c.pos)));
      if (s) name = s;
    }
    c.pos = dataEnd;
  }
  c.pos = extraEnd;
  return { name, top, left, bottom, right, blendKey, opacity,
           clipping: !!clipping, hidden: !!(flags & 2), sectionType, mask, channels };
}

// ---- channel row decoding (A2) --------------------------------------------------------------

function unpackBits(src, si, sEnd, dst, di, dEnd) {
  while (si < sEnd && di < dEnd) {
    let n = src[si++];
    if (n > 127) n -= 256;
    if (n >= 0) { n++; while (n-- > 0 && di < dEnd && si < sEnd) dst[di++] = src[si++]; }
    else if (n !== -128) { const cnt = 1 - n, v = src[si++]; for (let k = 0; k < cnt && di < dEnd; k++) dst[di++] = v; }
  }
  return di;
}

async function inflate(ab) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([ab]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// zip-with-prediction (compression 3): per-row delta coding on samples
function undoPrediction(buf, width, height, depth) {
  const bps = depth === 16 ? 2 : 1, rowBytes = width * bps;
  for (let r = 0; r < height; r++) {
    const o = r * rowBytes;
    if (depth === 8) for (let x = 1; x < rowBytes; x++) buf[o + x] = (buf[o + x] + buf[o + x - 1]) & 0xff;
    else for (let x = 1; x < width; x++) {
      const i = o + x * 2, p = i - 2;
      const v = (((buf[p] << 8) | buf[p + 1]) + ((buf[i] << 8) | buf[i + 1])) & 0xffff;
      buf[i] = v >> 8; buf[i + 1] = v & 0xff;
    }
  }
}

// copy `rows` rows of samples into out, converting 16-bit BE -> 8-bit (high byte)
function toSamples(bytes, srcOff, out, outOff, count, bps) {
  if (bps === 1) out.set(bytes.subarray(srcOff, srcOff + count), outOff);
  else for (let i = 0; i < count; i++) out[outOff + i] = bytes[srcOff + i * 2];
}

// Decode rows [r0, r1) of one channel whose raster is width×height (the LAYER rect for color/
// alpha channels, the MASK rect for id -2). Returns Uint8Array of (r1-r0)*width 8-bit samples.
// Seeks within the blob — only the needed byte range is read (except zip, which is cached).
export async function readChannelRows(blob, meta, ch, width, height, r0, r1) {
  const rows = r1 - r0, bps = meta.depth === 16 ? 2 : 1, rowBytes = width * bps;
  const out = new Uint8Array(Math.max(0, rows * width));
  if (width <= 0 || rows <= 0) return out;

  if (ch._comp == null) ch._comp = new DataView(await blob.slice(ch.offset, ch.offset + 2).arrayBuffer()).getUint16(0);
  const dataOff = ch.offset + 2;

  if (ch._comp === 0) {                                         // raw
    const bytes = new Uint8Array(await blob.slice(dataOff + r0 * rowBytes, dataOff + r1 * rowBytes).arrayBuffer());
    toSamples(bytes, 0, out, 0, rows * width, bps);
    return out;
  }

  if (ch._comp === 1) {                                         // RLE: per-row byte counts -> seekable
    const entry = meta.version === 2 ? 4 : 2;
    if (!ch._rle) {
      const t = new DataView(await blob.slice(dataOff, dataOff + height * entry).arrayBuffer());
      const pre = new Float64Array(height + 1);
      for (let r = 0; r < height; r++) pre[r + 1] = pre[r] + (entry === 2 ? t.getUint16(r * 2) : t.getUint32(r * 4));
      ch._rle = pre;
    }
    const pre = ch._rle, rleStart = dataOff + height * entry;
    const src = new Uint8Array(await blob.slice(rleStart + pre[r0], rleStart + pre[r1]).arrayBuffer());
    const row = new Uint8Array(rowBytes);
    for (let r = r0; r < r1; r++) {
      unpackBits(src, pre[r] - pre[r0], pre[r + 1] - pre[r0], row, 0, rowBytes);
      toSamples(row, 0, out, (r - r0) * width, width, bps);
    }
    return out;
  }

  if (ch._comp === 2 || ch._comp === 3) {                       // zip: not seekable -> inflate once, cache
    if (!ch._zip) {
      ch._zip = await inflate(await blob.slice(dataOff, ch.offset + ch.length).arrayBuffer());
      if (ch._comp === 3) undoPrediction(ch._zip, width, height, meta.depth);
    }
    toSamples(ch._zip, r0 * rowBytes, out, 0, rows * width, bps);
    return out;
  }

  throw new Error('lazy-psd: unsupported compression ' + ch._comp);
}
