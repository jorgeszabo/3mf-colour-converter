/*
 * 3MF fargekonverter: Bambu Studio / OrcaSlicer  <->  PrusaSlicer
 *
 * Begge slicerne lagrer malte farger per trekant med samme bitformat
 * (TriangleSelector-serialisering, hex-streng der siste tegn er første nibble).
 * Forskjellen er attributtnavn, filstruktur (Bambu: én fil per objekt med
 * production-extension, Prusa: alt i 3D/3dmodel.model) og konfigfilene som
 * beskriver deler/volumer. Denne filen leser begge og skriver begge.
 *
 * Kjører både i nettleser (window.Conv3MF) og Node 18+ (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Conv3MF = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder('utf-8');

  // ---------------------------------------------------------------- ZIP

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf, crc) {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function collect(readable) {
    const reader = readable.getReader();
    const chunks = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    return { chunks, length };
  }

  function concat(chunks, length) {
    const out = new Uint8Array(length);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }

  async function inflateRaw(data) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    const result = collect(ds.readable);
    writer.write(data).catch(() => {});
    writer.close().catch(() => {});
    const { chunks, length } = await result;
    return concat(chunks, length);
  }

  async function readZip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('The file is not a valid 3MF/ZIP archive.');
    let count = dv.getUint16(eocd + 10, true);
    let cdOff = dv.getUint32(eocd + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z = Number(dv.getBigUint64(loc + 8, true));
        count = Number(dv.getBigUint64(z + 32, true));
        cdOff = Number(dv.getBigUint64(z + 48, true));
      }
    }
    const entries = new Map();
    let p = cdOff;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      let localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = dv.getUint16(e, true), sz = dv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (localOff === 0xffffffff) { localOff = Number(dv.getBigUint64(q, true)); }
        }
        e += 4 + sz;
      }
      p = eEnd + commentLen;
      const entry = {
        name, method, csize, usize, localOff,
        async bytes() {
          const ln = dv.getUint16(localOff + 26, true), le = dv.getUint16(localOff + 28, true);
          const start = localOff + 30 + ln + le;
          const raw = u8.subarray(start, start + csize);
          if (method === 0) return raw;
          if (method === 8) return inflateRaw(raw);
          throw new Error('Unknown compression in ' + name);
        },
        async text() { return dec.decode(await this.bytes()); },
      };
      entries.set(name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(), entry);
    }
    return {
      entries,
      get(path) { return entries.get(String(path).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()) || null; },
    };
  }

  function dosDateTime(d) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  // files: [{ name, parts: (string|Uint8Array)[], store?: boolean }]
  async function writeZip(files, onProgress) {
    const out = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());
    for (let fi = 0; fi < files.length; fi++) {
      const f = files[fi];
      if (onProgress) onProgress(fi, files.length, f.name);
      const nameBytes = enc.encode(f.name);
      let crc = 0, usize = 0, csize = 0, chunks;
      if (f.store) {
        chunks = f.parts.map((x) => (typeof x === 'string' ? enc.encode(x) : x));
        for (const c of chunks) { crc = crc32(c, crc); usize += c.length; }
        csize = usize;
      } else {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const result = collect(cs.readable);
        for (const part of f.parts) {
          const b = typeof part === 'string' ? enc.encode(part) : part;
          crc = crc32(b, crc);
          usize += b.length;
          await writer.write(b);
        }
        await writer.close();
        const r = await result;
        chunks = r.chunks;
        csize = r.length;
      }
      const method = f.store ? 0 : 8;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, method, true);
      lh.setUint16(10, time, true);
      lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, csize, true);
      lh.setUint32(22, usize, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      out.push(new Uint8Array(lh.buffer), nameBytes, ...chunks);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, method, true);
      ch.setUint16(12, time, true);
      ch.setUint16(14, date, true);
      ch.setUint32(16, crc, true);
      ch.setUint32(20, csize, true);
      ch.setUint32(24, usize, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), nameBytes);
      offset += 30 + nameBytes.length + csize;
    }
    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...out, ...central, new Uint8Array(end.buffer)], { type: 'model/3mf' });
  }

  // ---------------------------------------------------------------- XML helpers

  const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  function parseAttrs(s) {
    const o = {};
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(s))) o[m[1]] = m[2] !== undefined ? m[2] : m[3];
    return o;
  }

  function unesc(s) {
    if (s == null) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (all, e) => {
      const l = e.toLowerCase();
      if (l === 'lt') return '<';
      if (l === 'gt') return '>';
      if (l === 'quot') return '"';
      if (l === 'apos') return "'";
      if (l === 'amp') return '&';
      if (l[1] === 'x') return String.fromCodePoint(parseInt(l.slice(2), 16));
      return String.fromCodePoint(parseInt(l.slice(1), 10));
    });
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function uuid() {
    const b = new Uint8Array(16);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // Buffered string writer, so a 100 MB mesh never becomes one giant string.
  class Out {
    constructor() { this.parts = []; this.buf = []; this.len = 0; }
    w(s) {
      this.buf.push(s);
      this.len += s.length;
      if (this.len > 1 << 20) { this.parts.push(this.buf.join('')); this.buf = []; this.len = 0; }
    }
    done() { if (this.buf.length) this.parts.push(this.buf.join('')); this.buf = []; return this.parts; }
  }

  function fmt(x) {
    if (x === 0) return '0';
    return String(Number(x.toPrecision(9)));
  }

  // ---------------------------------------------------------------- transforms
  // 3MF transform: 12 values, row-vector convention: p' = p * M, last row = translation.
  // Slic3r "matrix": 16 values, row-major 4x4, column-vector convention (translation in last column).

  const IDENTITY12 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

  function parse12(s) {
    if (!s) return IDENTITY12.slice();
    const v = s.trim().split(/\s+/).map(Number);
    return v.length === 12 && v.every(Number.isFinite) ? v : IDENTITY12.slice();
  }

  function isIdentity12(m) {
    for (let i = 0; i < 12; i++) if (Math.abs(m[i] - IDENTITY12[i]) > 1e-12) return false;
    return true;
  }

  function mul12(a, b) { // apply a, then b
    const r = new Array(12);
    for (let i = 0; i < 4; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2], w = i === 3 ? 1 : 0;
      for (let j = 0; j < 3; j++) r[i * 3 + j] = x * b[j] + y * b[3 + j] + z * b[6 + j] + w * b[9 + j];
    }
    return r;
  }

  function m12to16(m) {
    return [m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1];
  }

  // Transforms keep full precision; only mesh vertices are written as float32-ish values.
  function fmtFull(x) { return x === 0 ? '0' : String(x); }
  function fmt12(m) { return m.map(fmtFull).join(' '); }
  function fmt16(m) { return m.map(fmtFull).join(' '); }

  function parse16(s) {
    if (!s) return null;
    const v = s.trim().split(/\s+/).map(Number);
    return v.length === 16 && v.every(Number.isFinite) ? v : null;
  }

  // ---------------------------------------------------------------- paint encoding

  const HEX = '0123456789ABCDEF';
  function nib(c) {
    if (c >= 48 && c <= 57) return c - 48;
    if (c >= 65 && c <= 70) return c - 55;
    if (c >= 97 && c <= 102) return c - 87;
    return -1;
  }

  function pushLeaf(out, s) {
    if (s < 3) { out.push(s << 2); return; }
    out.push(12);
    let n = s - 3;
    while (n >= 15) { out.push(15); n -= 15; }
    out.push(n);
  }

  // Walks the serialized triangle tree (pre-order, first nibble = last char).
  // Calls visit(state) for every leaf. If map is given, returns the re-encoded string.
  // Throws on anything that is not exactly one complete tree (slicers can crash on those).
  function walkPaint(str, map, visit) {
    let i = str.length - 1;
    const out = map ? [] : null;
    let pending = 1; // nodes still expected in the tree
    while (pending > 0) {
      if (i < 0) throw new Error('Truncated paint data: ' + str);
      const code = nib(str.charCodeAt(i--));
      if (code < 0) throw new Error('Invalid paint data: ' + str);
      pending--;
      if (code & 3) { pending += (code & 3) + 1; if (out) out.push(code); continue; }
      let state;
      if ((code & 12) === 12) {
        let k = 0, c = i >= 0 ? nib(str.charCodeAt(i--)) : -1;
        while (c === 15) { k++; c = i >= 0 ? nib(str.charCodeAt(i--)) : -1; }
        if (c < 0) throw new Error('Truncated paint data: ' + str);
        state = c + 15 * k + 3;
      } else state = code >> 2;
      if (visit) visit(state);
      if (out) pushLeaf(out, map(state));
    }
    if (i >= 0) throw new Error('Invalid paint data (extra data): ' + str);
    if (!out) return str;
    let s = '';
    for (let j = out.length - 1; j >= 0; j--) s += HEX[out[j]];
    return s;
  }

  function remapPaint(str, mapArr) {
    return walkPaint(str, (s) => (s < mapArr.length && mapArr[s] != null ? mapArr[s] : s));
  }

  // ---------------------------------------------------------------- 3MF model parsing

  const PAINT_KEYS = {
    paint_color: 'color', 'slic3rpe:mmu_segmentation': 'color',
    paint_supports: 'supports', 'slic3rpe:custom_supports': 'supports',
    paint_seam: 'seam', 'slic3rpe:custom_seam': 'seam',
    paint_fuzzy_skin: 'fuzzy', 'slic3rpe:fuzzy_skin': 'fuzzy',
  };

  const TRI_FAST = /^\s*v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"(?:\s+([\w:]+)="([^"]*)")?\s*\/?\s*$/;
  const VX = /\bx\s*=\s*["']([^"']*)["']/, VY = /\by\s*=\s*["']([^"']*)["']/, VZ = /\bz\s*=\s*["']([^"']*)["']/;

  function parseMesh(body) {
    const verts = [];
    const vre = /<vertex\b([^>]*)>/g;
    let m;
    const vEnd = body.indexOf('</vertices>');
    vre.lastIndex = body.indexOf('<vertices');
    while ((m = vre.exec(body))) {
      if (vEnd >= 0 && m.index > vEnd) break;
      const a = m[1];
      verts.push(+VX.exec(a)[1], +VY.exec(a)[1], +VZ.exec(a)[1]);
    }
    const tris = [];
    const paint = {};
    const tre = /<triangle\b([^>]*)>/g;
    tre.lastIndex = Math.max(0, body.indexOf('<triangles'));
    let t = 0;
    while ((m = tre.exec(body))) {
      const f = TRI_FAST.exec(m[1]);
      if (f) {
        tris.push(+f[1], +f[2], +f[3]);
        if (f[4] && PAINT_KEYS[f[4]] && f[5]) (paint[PAINT_KEYS[f[4]]] || (paint[PAINT_KEYS[f[4]]] = []))[t] = f[5];
      } else {
        const a = parseAttrs(m[1]);
        tris.push(+a.v1, +a.v2, +a.v3);
        for (const k in a) if (PAINT_KEYS[k] && a[k]) (paint[PAINT_KEYS[k]] || (paint[PAINT_KEYS[k]] = []))[t] = a[k];
      }
      t++;
    }
    return { vertices: Float64Array.from(verts), triangles: Uint32Array.from(tris), paint };
  }

  function parseModel(text) {
    const unit = parseAttrs((/<model\b([^>]*)>/.exec(text) || [null, ''])[1]).unit || 'millimeter';
    const scale = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 }[unit];
    if (!scale) throw new Error('Unsupported 3MF unit: ' + unit);
    const res = { unit, meta: {}, objects: new Map(), build: [] };
    const resStart = text.indexOf('<resources');
    const resEnd = text.lastIndexOf('</resources>');
    const outside = resStart >= 0 ? text.slice(0, resStart) + (resEnd >= 0 ? text.slice(resEnd) : '') : text;
    const metaRe = /<metadata\b([^>]*?)(?:\/>|>([\s\S]*?)<\/metadata>)/g;
    let m;
    while ((m = metaRe.exec(outside))) {
      const a = parseAttrs(m[1]);
      if (a.name) res.meta[a.name] = unesc(m[2] || '');
    }
    let i = resStart >= 0 ? resStart : 0;
    for (;;) {
      const s = text.indexOf('<object', i);
      if (s < 0 || (resEnd >= 0 && s > resEnd)) break;
      const c = text.charCodeAt(s + 7);
      if (!(c === 32 || c === 9 || c === 10 || c === 13 || c === 62)) { i = s + 7; continue; }
      const tagEnd = text.indexOf('>', s);
      const attrs = parseAttrs(text.slice(s + 7, tagEnd));
      const selfClose = text.charCodeAt(tagEnd - 1) === 47;
      const e = selfClose ? tagEnd + 1 : text.indexOf('</object>', tagEnd);
      const body = selfClose ? '' : text.slice(tagEnd + 1, e);
      const obj = { id: attrs.id, attrs, mesh: null, components: null };
      if (body.indexOf('<mesh') >= 0) obj.mesh = parseMesh(body);
      else if (body.indexOf('<components') >= 0) {
        obj.components = [];
        const cre = /<component\b([^>]*)>/g;
        let cm;
        while ((cm = cre.exec(body))) {
          const a = parseAttrs(cm[1]);
          obj.components.push({ objectid: a.objectid, path: a['p:path'] || null, transform: parse12(a.transform) });
        }
      }
      res.objects.set(String(attrs.id), obj);
      i = selfClose ? e : e + 9;
    }
    const b = text.indexOf('<build', resEnd >= 0 ? resEnd : 0);
    if (b >= 0) {
      const ire = /<item\b([^>]*)>/g;
      ire.lastIndex = b;
      while ((m = ire.exec(text))) {
        const a = parseAttrs(m[1]);
        res.build.push({ objectid: a.objectid, transform: parse12(a.transform), printable: a.printable !== '0' });
      }
    }
    // Normalize coordinates and translations once, including production-extension submodels.
    if (scale !== 1) {
      for (const o of res.objects.values()) {
        if (o.mesh) for (let n = 0; n < o.mesh.vertices.length; n++) o.mesh.vertices[n] *= scale;
        for (const c of o.components || []) for (let n = 9; n < 12; n++) c.transform[n] *= scale;
      }
      for (const it of res.build) for (let n = 9; n < 12; n++) it.transform[n] *= scale;
    }
    return res;
  }

  // Model files can be larger than the longest string JavaScript allows (~512 MB; browsers may return an empty
  // string instead of failing). Large ones are decoded in pieces that each end after a "</object>" and parsed
  // one by one; every piece after the first gets a "<resources>" so its objects are found the same way.
  const MODEL_PIECE = 64 * 1024 * 1024;
  const END_OBJECT = new TextEncoder().encode('</object>');
  function indexOfBytes(u8, pat, from) {
    for (let i = u8.indexOf(pat[0], from); i >= 0 && i <= u8.length - pat.length; i = u8.indexOf(pat[0], i + 1)) {
      let k = 1;
      while (k < pat.length && u8[i + k] === pat[k]) k++;
      if (k === pat.length) return i;
    }
    return -1;
  }
  function parseModelBytes(u8) {
    if (u8.length <= MODEL_PIECE) return parseModel(dec.decode(u8));
    const res = { meta: {}, objects: new Map(), build: [] };
    for (let start = 0, first = true; start < u8.length; first = false) {
      const hit = start + MODEL_PIECE < u8.length ? indexOfBytes(u8, END_OBJECT, start + MODEL_PIECE) : -1;
      const end = hit < 0 ? u8.length : hit + END_OBJECT.length;
      const part = parseModel((first ? '' : `<model unit="${res.unit}"><resources>`) + dec.decode(u8.subarray(start, end)));
      if (first) res.unit = part.unit;
      Object.assign(res.meta, part.meta);
      for (const [id, o] of part.objects) res.objects.set(id, o);
      res.build.push(...part.build);
      start = end;
    }
    return res;
  }

  function transformVertices(v, m) {
    if (isIdentity12(m)) return v;
    const out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      out[i] = x * m[0] + y * m[3] + z * m[6] + m[9];
      out[i + 1] = x * m[1] + y * m[4] + z * m[7] + m[10];
      out[i + 2] = x * m[2] + y * m[5] + z * m[8] + m[11];
    }
    return out;
  }

  // Attribute list of a tag; quoted values may contain '>' (PrusaSlicer writes names like "a <b>" unescaped).
  const TAG_ATTRS = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*?`;

  // Collects <metadata key=.. value=..> pairs (any attribute order or quoting), optionally only of one type.
  function readMeta(text, type) {
    const meta = {};
    const re = new RegExp(String.raw`<metadata\b(${TAG_ATTRS})/?>`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const a = parseAttrs(m[1]);
      if (a.key == null || (type && a.type !== type)) continue;
      meta[a.key] = unesc(a.value || '');
    }
    return meta;
  }

  function eachBlock(text, tag, fn) {
    const re = new RegExp(String.raw`<${tag}\b(${TAG_ATTRS})(?:/>|>([\s\S]*?)</${tag}>)`, 'g');
    let m;
    while ((m = re.exec(text))) fn(parseAttrs(m[1]), m[2] || '');
  }

  // Bambu model_settings.config
  function parseBambuSettings(text) {
    const objects = new Map();
    eachBlock(text, 'object', (oa, body) => {
      const firstPart = body.search(/<part\b/);
      const meta = readMeta(firstPart >= 0 ? body.slice(0, firstPart) : body);
      const parts = new Map();
      eachBlock(body, 'part', (a, pbody) => {
        parts.set(String(a.id), { subtype: a.subtype || 'normal_part', meta: readMeta(pbody) });
      });
      objects.set(String(oa.id), { meta, parts });
    });
    return objects;
  }

  // Prusa Slic3r_PE_model.config
  function parsePrusaSettings(text) {
    const objects = new Map();
    eachBlock(text, 'object', (oa, body) => {
      const volumes = [];
      eachBlock(body, 'volume', (a, vbody) => {
        volumes.push({ first: +a.firstid, last: +a.lastid, meta: readMeta(vbody, 'volume') });
      });
      objects.set(String(oa.id), { meta: readMeta(body, 'object'), volumes });
    });
    return objects;
  }

  const BAMBU_TO_TYPE = {
    normal_part: 'part', negative_part: 'negative', modifier_part: 'modifier',
    support_enforcer: 'enforcer', support_blocker: 'blocker',
  };
  const TYPE_TO_BAMBU = Object.fromEntries(Object.entries(BAMBU_TO_TYPE).map(([k, v]) => [v, k]));
  const PRUSA_TO_TYPE = {
    ModelPart: 'part', NegativeVolume: 'negative', ParameterModifier: 'modifier',
    SupportEnforcer: 'enforcer', SupportBlocker: 'blocker',
  };
  const TYPE_TO_PRUSA = Object.fromEntries(Object.entries(PRUSA_TO_TYPE).map(([k, v]) => [v, k]));

  function splitList(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.map(String);
    return String(v).split(';').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
  }

  function parseIni(text) {
    const o = {};
    for (const line of text.split(/\r?\n/)) {
      const mm = /^\s*;?\s*([\w-]+)\s*=\s*(.*)$/.exec(line);
      if (mm) o[mm[1]] = mm[2].trim();
    }
    return o;
  }

  function sliceVolume(mesh, first, last) {
    const tris = mesh.triangles.subarray(first * 3, (last + 1) * 3);
    const remap = new Map();
    const vout = [];
    const tout = new Uint32Array(tris.length);
    for (let i = 0; i < tris.length; i++) {
      const v = tris[i];
      let n = remap.get(v);
      if (n === undefined) {
        n = vout.length / 3;
        remap.set(v, n);
        vout.push(mesh.vertices[v * 3], mesh.vertices[v * 3 + 1], mesh.vertices[v * 3 + 2]);
      }
      tout[i] = n;
    }
    const paint = {};
    for (const k in mesh.paint) {
      const src = mesh.paint[k];
      const arr = [];
      for (let t = first; t <= last; t++) if (src[t]) arr[t - first] = src[t];
      paint[k] = arr;
    }
    return { vertices: Float64Array.from(vout), triangles: tout, paint };
  }

  /**
   * Loads a 3MF (Uint8Array / ArrayBuffer) into a slicer-neutral model:
   * { format, meta, filaments[], objects[{ name, extruder, volumes[], instances[] }], thumbnail }
   */
  async function load3mf(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    const zip = await readZip(u8);
    let rootPath = '3D/3dmodel.model';
    const rels = zip.get('_rels/.rels');
    if (rels) {
      const t = await rels.text();
      const rm = /<Relationship\b[^>]*Target="([^"]+)"[^>]*Type="[^"]*\/3dmodel"/.exec(t)
        || /<Relationship\b[^>]*Type="[^"]*\/3dmodel"[^>]*Target="([^"]+)"/.exec(t);
      if (rm) rootPath = rm[1];
    }
    const rootEntry = zip.get(rootPath);
    if (!rootEntry) throw new Error('3D/3dmodel.model not found in the file.');
    const root = parseModelBytes(await rootEntry.bytes());
    const app = root.meta.Application || '';

    let format = 'generic';
    const bambuCfg = zip.get('Metadata/model_settings.config');
    const prusaCfg = zip.get('Metadata/Slic3r_PE_model.config');
    const prusa3Cfg = zip.get('Metadata/PrusaSlicer3_project.json');
    if (bambuCfg || /^(BambuStudio|OrcaSlicer)/i.test(app) || root.meta['BambuStudio:3mfVersion']) format = 'bambu';
    else if (prusaCfg || prusa3Cfg || root.meta['slic3rpe:Version3mf'] || /^PrusaSlicer/i.test(app)) format = 'prusa';

    const modelCache = new Map([[rootPath.replace(/^\/+/, '').toLowerCase(), root]]);
    async function getModel(path) {
      const key = path.replace(/^\/+/, '').toLowerCase();
      if (!modelCache.has(key)) {
        const e = zip.get(key);
        if (!e) throw new Error('Missing part file ' + path);
        modelCache.set(key, parseModelBytes(await e.bytes()));
      }
      return modelCache.get(key);
    }

    // Flattens components into a list of { mesh, transform, partId }
    async function flatten(model, id, transform, out, depth) {
      const obj = model.objects.get(String(id));
      if (!obj || depth > 8) return;
      if (obj.mesh) { out.push({ mesh: obj.mesh, transform, partId: String(id), name: obj.attrs.name }); return; }
      for (const c of obj.components || []) {
        const sub = c.path ? await getModel(c.path) : model;
        await flatten(sub, c.objectid, mul12(c.transform, transform), out, depth + 1);
      }
    }

    const bambuSettings = bambuCfg ? parseBambuSettings(await bambuCfg.text()) : new Map();
    const prusaSettings = prusaCfg ? parsePrusaSettings(await prusaCfg.text()) : new Map();

    // PrusaSlicer 3.0 keeps names in the model but extruders, volume types and colours in its project JSON,
    // keyed by the ids of the model objects and of the per-volume wrapper objects.
    let prusa3 = null;
    if (prusa3Cfg) { try { prusa3 = JSON.parse(await prusa3Cfg.text()); } catch (_) { prusa3 = null; } }
    const p3Objects = new Map(), p3Volumes = new Map();
    if (prusa3) for (const o of prusa3.objects || []) {
      p3Objects.set(String(o.id), o);
      for (const v of o.volumes || []) p3Volumes.set(String(v.id), v);
      // alpha13 stores printability here, indexed by global build-item order,
      // and ignores the standard XML printable attribute on native projects.
      for (const it of o.instances || []) {
        if (Number.isInteger(it.ord) && root.build[it.ord] && it.printable === false) root.build[it.ord].printable = false;
      }
    }
    // Painting normally sits on the triangles too; Slic3r_facets_annotation.json is only read for volumes without it.
    let p3Facets = null;
    async function prusa3Facets() {
      if (!p3Facets) {
        p3Facets = new Map();
        const e = zip.get('Metadata/Slic3r_facets_annotation.json');
        if (e) {
          try { for (const f of JSON.parse(await e.text())) p3Facets.set(String(f.id), f); } catch (_) { /* ignore broken facets */ }
        }
      }
      return p3Facets;
    }

    // PrusaSlicer writes extra instances as <object id=N><components><component objectid=M/></components>
    // with its own build item; fold those back into instances of object M.
    function instanceOf(it) {
      const o = root.objects.get(String(it.objectid));
      if (format !== 'prusa' || !o || !o.components || o.components.length !== 1 || prusaSettings.has(String(it.objectid))) return it;
      const c = o.components[0];
      const target = root.objects.get(String(c.objectid));
      if (c.path || !target || !target.mesh || !prusaSettings.has(String(c.objectid))) return it;
      return { ...it, objectid: c.objectid, transform: mul12(c.transform, it.transform) };
    }

    const order = [];
    const instances = new Map();
    const printables = new Map();
    for (const raw of root.build) {
      const it = instanceOf(raw);
      if (!instances.has(it.objectid)) { instances.set(it.objectid, []); printables.set(it.objectid, []); order.push(it.objectid); }
      instances.get(it.objectid).push(it.transform);
      printables.get(it.objectid).push(it.printable !== false);
    }

    const objects = [];
    for (const oid of order) {
      const robj = root.objects.get(String(oid));
      if (!robj) continue;
      const pieces = [];
      if (robj.mesh) pieces.push({ mesh: robj.mesh, transform: IDENTITY12, partId: String(oid), name: robj.attrs.name });
      else for (const c of robj.components || []) {
        const sub = c.path ? await getModel(c.path) : root;
        const from = pieces.length;
        await flatten(sub, c.objectid, c.transform, pieces, 0);
        const wrapper = prusa3 && !c.path && p3Volumes.has(String(c.objectid)) && root.objects.get(String(c.objectid));
        if (wrapper) for (let k = from; k < pieces.length; k++) {
          pieces[k].volId = String(c.objectid);
          if (wrapper.attrs.name) pieces[k].name = wrapper.attrs.name;
        }
      }
      const bs = bambuSettings.get(String(oid));
      const ps = prusaSettings.get(String(oid));
      const p3o = p3Objects.get(String(oid));
      const object = {
        sourceId: String(oid),
        name: (bs && bs.meta.name) || (ps && ps.meta.name) || robj.attrs.name || `Object ${objects.length + 1}`,
        extruder: +((bs && bs.meta.extruder) || (ps && ps.meta.extruder) || (p3o && p3o.object_settings && p3o.object_settings.extruder) || 1) || 1,
        volumes: [],
        instances: instances.get(oid),
        instancePrintable: printables.get(oid),
      };
      for (const pc of pieces) {
        const vertices = transformVertices(pc.mesh.vertices, pc.transform);
        if (ps && ps.volumes.length && pc.mesh === robj.mesh) {
          for (const pv of ps.volumes) {
            const sv = sliceVolume({ vertices, triangles: pc.mesh.triangles, paint: pc.mesh.paint }, pv.first, pv.last);
            const vt = pv.meta.volume_type ? PRUSA_TO_TYPE[pv.meta.volume_type] : (pv.meta.modifier === '1' ? 'modifier' : 'part');
            object.volumes.push({
              ...sv,
              name: pv.meta.name || object.name,
              type: vt || 'part',
              extruder: +pv.meta.extruder || 0,
              matrix: parse16(pv.meta.matrix),
            });
          }
          continue;
        }
        const part = bs && bs.parts.get(pc.partId);
        const pv3 = pc.volId && p3Volumes.get(pc.volId);
        let matrix = part ? parse16(part.meta.matrix) : null;
        if (!matrix && !isIdentity12(pc.transform)) matrix = m12to16(pc.transform);
        let paint = pc.mesh.paint;
        if (pv3) {
          const f = (await prusa3Facets()).get(pc.volId);
          for (const k in PRUSA3_FACETS) {
            if (!f || !Array.isArray(f[PRUSA3_FACETS[k]]) || (paint[k] && paint[k].length)) continue;
            const arr = [];
            for (const e of f[PRUSA3_FACETS[k]]) if (e && e.dividing && e.triangle >= 0) arr[e.triangle] = e.dividing;
            paint = { ...paint, [k]: arr };
          }
        }
        object.volumes.push({
          vertices,
          triangles: pc.mesh.triangles,
          paint,
          name: (part && part.meta.name) || pc.name || object.name,
          type: (part && BAMBU_TO_TYPE[part.subtype]) || (pv3 && PRUSA_TO_TYPE[pv3.type]) || 'part',
          extruder: part ? +part.meta.extruder || 0 : (pv3 && pv3.volume_settings && +pv3.volume_settings.extruder) || 0,
          matrix,
        });
      }
      if (object.volumes.length) objects.push(object);
    }

    // Drop paint strings that are not a valid tree instead of copying something a slicer may crash on.
    let badPaint = 0;
    for (const o of objects) for (const v of o.volumes) for (const k in v.paint) {
      const arr = v.paint[k];
      for (let t = 0; t < arr.length; t++) {
        if (!arr[t]) continue;
        try { walkPaint(arr[t]); } catch (_) { arr[t] = undefined; badPaint++; }
      }
    }

    // Filaments / extruder colours
    let filaments = [];
    if (format === 'bambu') {
      const ps = zip.get('Metadata/project_settings.config');
      if (ps) {
        try {
          const j = JSON.parse(await ps.text());
          const colors = splitList(j.filament_colour);
          const types = splitList(j.filament_type);
          const names = splitList(j.filament_settings_id);
          filaments = colors.map((c, i) => ({ color: c, type: types[i] || '', name: names[i] || '' }));
        } catch (_) { /* ignore broken settings */ }
      }
    } else {
      const pc = zip.get('Metadata/Slic3r_PE.config');
      if (pc) {
        const ini = parseIni(await pc.text());
        const ext = splitList(ini.extruder_colour);
        const fil = splitList(ini.filament_colour);
        const types = splitList(ini.filament_type);
        const names = splitList(ini.filament_settings_id);
        const n = Math.max(ext.length, fil.length);
        for (let i = 0; i < n; i++) {
          filaments.push({ color: ext[i] || fil[i] || '', type: types[i] || '', name: names[i] || '' });
        }
      } else if (prusa3) {
        const group = (prusa3.config_containers || [])[0] || {};
        const conf = group.configuration || {};
        const list = (v) => (Array.isArray(v) ? v : splitList(v));
        const ext = list((conf.project_settings || {}).extruder_colour);
        const types = list((conf.filament_settings || {}).filament_type);
        const mats = (group.preset && group.preset.materials) || [];
        filaments = ext.map((c, i) => ({ color: c || '', type: types[i] || '', name: (mats[i] && (mats[i].root_id || mats[i].name)) || '' }));
      }
    }
    filaments = filaments.map((f) => ({ ...f, color: /^#[0-9a-f]{6}/i.test(f.color) ? f.color.slice(0, 7) : '' }));

    let thumbnail = null;
    for (const p of ['Metadata/plate_1.png', 'Metadata/thumbnail.png', 'Auxiliaries/.thumbnails/thumbnail_middle.png']) {
      const e = zip.get(p);
      if (e) { thumbnail = await e.bytes(); break; }
    }

    const sourceSettings = [];
    if (prusa3) for (const [i, g] of (prusa3.config_containers || []).entries()) {
      for (const section of ['print_settings', 'toolprint_settings']) {
        sourceSettings.push({ scope: `group ${i + 1}/${section}`, values: (g.configuration || {})[section] || {} });
      }
    }
    if (format === 'bambu' && zip.get('Metadata/project_settings.config')) {
      sourceSettings.push({ scope: 'Bambu project', values: JSON.parse(await zip.get('Metadata/project_settings.config').text()) });
    }
    if (!prusa3 && format === 'prusa' && zip.get('Metadata/Slic3r_PE.config')) {
      sourceSettings.push({ scope: 'Prusa 2 project', values: parseIni(await zip.get('Metadata/Slic3r_PE.config').text()) });
    }
    // Retain every override in the audit, including settings with no equivalent in the target slicer.
    const overrides = (scope, values, handled) => {
      const rest = Object.fromEntries(Object.entries(values || {}).filter(([k]) => !handled.includes(k)));
      if (Object.keys(rest).length) sourceSettings.push({ scope, values: rest });
    };
    for (const [id, o] of bambuSettings) {
      overrides(`object ${id}`, o.meta, ['name', 'extruder']);
      for (const [pid, v] of o.parts) overrides(`object ${id}/part ${pid}`, v.meta, ['name', 'extruder', 'matrix']);
    }
    for (const [id, o] of prusaSettings) {
      overrides(`object ${id}`, o.meta, ['name', 'extruder']);
      for (const [i, v] of o.volumes.entries()) overrides(`object ${id}/volume ${i}`, v.meta, ['name', 'extruder', 'matrix', 'modifier', 'volume_type']);
    }
    for (const [id, o] of p3Objects) {
      overrides(`object ${id}`, o.object_settings, ['extruder', 'wipe_into_objects']);
      overrides(`object ${id}/features`, o, ['id', 'volumes', 'instances', 'object_settings']);
      for (const v of o.volumes || []) overrides(`object ${id}/volume ${v.id}`, v.volume_settings, ['extruder', 'wipe_into_infill']);
    }
    const beds = [];
    if (prusa3) for (const [groupIndex, g] of (prusa3.config_containers || []).entries()) {
      for (const b of g.beds || []) beds.push({ groupIndex, x: b.position_x, y: b.position_y, shape: g.configuration.printer_settings.bed_shape });
    }
    if (bambuCfg) eachBlock(await bambuCfg.text(), 'plate', (_a, body) => {
      const members = [];
      eachBlock(body, 'model_instance', (_b, mb) => {
        const meta = readMeta(mb);
        members.push({ objectId: String(meta.object_id), instance: Number(meta.instance_id || 0) });
      });
      beds.push({ members });
    });
    return {
      format,
      application: app,
      meta: { title: root.meta.Title || '', designer: root.meta.Designer || '' },
      filaments,
      objects,
      thumbnail,
      badPaint,
      beds,
      sourceSettings,
    };
  }

  // Multi-bed migration is deliberately explicit. Convert one source bed at a time;
  // never flatten a project into a single potentially overlapping/out-of-bounds bed.
  function selectBed(model, number) {
    if (!Number.isInteger(number) || number < 1 || number > Math.max(1, model.beds.length)) throw new Error('Invalid source bed: ' + number);
    if (!model.beds.length) return model;
    const bed = model.beds[number - 1];
    const objects = model.objects.map((o) => {
      const keep = o.instances.map((t, i) => {
        if (bed.members) return bed.members.some((m) => m.objectId === o.sourceId && m.instance === i);
        const bounds = instanceBounds(o, t);
        const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
        const hits = model.beds.filter((b) => !b.members && cx >= b.x + Math.min(...b.shape.map((p) => p[0])) && cx <= b.x + Math.max(...b.shape.map((p) => p[0])) && cy >= b.y + Math.min(...b.shape.map((p) => p[1])) && cy <= b.y + Math.max(...b.shape.map((p) => p[1])));
        if (hits.length !== 1) throw new Error(`Cannot unambiguously assign ${o.name} to a source bed. Arrange it in the source slicer first.`);
        return hits[0] === bed;
      });
      return { ...o, instances: o.instances.filter((_t, i) => keep[i]).map((t) => { const m = t.slice(); m[9] -= bed.x || 0; m[10] -= bed.y || 0; return m; }), instancePrintable: o.instances.map((_t, i) => o.instancePrintable[i]).filter((_p, i) => keep[i]) };
    }).filter((o) => o.instances.length);
    if (!objects.length) throw new Error('The selected source bed is empty.');
    const selectedIds = new Set(objects.map((o) => o.sourceId));
    return { ...model, objects, beds: [], selectedBed: number, sourceSettings: model.sourceSettings.filter((s) => {
      if (s.scope.startsWith('group ')) return s.scope.startsWith(`group ${bed.groupIndex + 1}/`);
      const objectScope = /^object ([^/]+)/.exec(s.scope);
      return !objectScope || selectedIds.has(objectScope[1]);
    }) };
  }

  function instanceBounds(o, t) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const v of o.volumes.filter((v) => v.type === 'part')) {
      const a = v.vertices;
      for (let i = 0; i < a.length; i += 3) {
        const x = a[i] * t[0] + a[i + 1] * t[3] + a[i + 2] * t[6] + t[9];
        const y = a[i] * t[1] + a[i + 1] * t[4] + a[i + 2] * t[7] + t[10];
        b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y);
      }
    }
    return b;
  }

  function settingsChanges(model, printer, mapArr = []) {
    const changes = (model.sourceSettings || []).flatMap((s) => Object.entries(s.values).flatMap(([key, before]) => {
      const section = s.scope.split('/')[1];
      const after = printer && printer.project3 && printer.project3.configuration[section] && printer.project3.configuration[section][key];
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ scope: s.scope, key, before, after: after === undefined ? null : after, action: after === undefined ? 'not transferred' : 'replaced' }];
    }));
    if (printer && printer.project3) for (const i of usage(model).filaments.keys()) {
      const tool = mapIndex(mapArr, i) - 1;
      const source = model.filaments[i - 1];
      const selected = printer.profiles && printer.profiles[tool];
      const after = selected ? selected.material : printer.project3.preset.materials[tool];
      if (source && after && source.name !== after.name) changes.push({ scope: `source colour ${i}`, key: 'material preset', before: source, after: after.name, action: 'mapped to target preset' });
    }
    return changes;
  }

  // ---------------------------------------------------------------- statistics

  // Returns { filaments: Map<index, { triangles, objects, parts }>, paintedTriangles, triangles, has: {supports,seam,fuzzy} }
  function usage(model) {
    const filaments = new Map();
    const bump = (i, key, n) => {
      if (!filaments.has(i)) filaments.set(i, { triangles: 0, objects: 0, parts: 0 });
      filaments.get(i)[key] += n;
    };
    let painted = 0, triangles = 0;
    const has = { supports: false, seam: false, fuzzy: false };
    for (const o of model.objects) {
      bump(o.extruder, 'objects', 1);
      for (const v of o.volumes) {
        triangles += v.triangles.length / 3;
        if (v.extruder > 0) bump(v.extruder, 'parts', 1);
        for (const k of ['supports', 'seam', 'fuzzy']) if (v.paint[k] && v.paint[k].length) has[k] = true;
        const pc = v.paint.color;
        if (!pc) continue;
        const seen = new Set();
        for (const s of pc) {
          if (!s) continue;
          painted++;
          seen.clear();
          walkPaint(s, null, (st) => { if (st > 0) seen.add(st); });
          for (const st of seen) bump(st, 'triangles', 1);
        }
      }
    }
    return { filaments, paintedTriangles: painted, triangles, has };
  }

  // ---------------------------------------------------------------- writers

  function mapIndex(mapArr, i) {
    return i > 0 && i < mapArr.length && mapArr[i] != null ? mapArr[i] : i;
  }

  function isIdentityMap(mapArr) {
    for (let i = 0; i < mapArr.length; i++) if (mapArr[i] != null && mapArr[i] !== i) return false;
    return true;
  }

  function writeMesh(out, volumes, attrNames, mapArr, indent) {
    const ident = isIdentityMap(mapArr);
    out.w(`${indent}<mesh>\n${indent} <vertices>\n`);
    const vi = indent + '  ';
    for (const v of volumes) {
      const a = v.vertices;
      for (let i = 0; i < a.length; i += 3) out.w(`${vi}<vertex x="${fmt(a[i])}" y="${fmt(a[i + 1])}" z="${fmt(a[i + 2])}"/>\n`);
    }
    out.w(`${indent} </vertices>\n${indent} <triangles>\n`);
    let base = 0;
    for (const v of volumes) {
      const t = v.triangles;
      const keys = Object.keys(v.paint).filter((k) => attrNames[k] && v.paint[k].length);
      for (let i = 0, n = 0; i < t.length; i += 3, n++) {
        let s = `${vi}<triangle v1="${t[i] + base}" v2="${t[i + 1] + base}" v3="${t[i + 2] + base}"`;
        for (const k of keys) {
          let p = v.paint[k][n];
          if (!p) continue;
          if (k === 'color' && !ident) p = remapPaint(p, mapArr);
          s += ` ${attrNames[k]}="${p}"`;
        }
        out.w(s + '/>\n');
      }
      base += v.vertices.length / 3;
    }
    out.w(`${indent} </triangles>\n${indent}</mesh>\n`);
  }

  function paintUsed(model) {
    const used = { color: false, supports: false, seam: false, fuzzy: false };
    for (const o of model.objects) for (const v of o.volumes) for (const k in used) if (v.paint[k] && v.paint[k].length) used[k] = true;
    return used;
  }

  const PRUSA_ATTRS = {
    color: 'slic3rpe:mmu_segmentation', supports: 'slic3rpe:custom_supports',
    seam: 'slic3rpe:custom_seam', fuzzy: 'slic3rpe:fuzzy_skin',
  };
  const BAMBU_ATTRS = { color: 'paint_color', supports: 'paint_supports', seam: 'paint_seam', fuzzy: 'paint_fuzzy_skin' };

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="config" ContentType="text/xml"/>
</Types>`;

  function configValue(config, key) {
    const m = new RegExp(`^${key} = (.*)$`, 'm').exec(config);
    return m ? m[1] : '';
  }

  // Colour of every extruder in the target printer: the saved slot colour, else the first source colour
  // mapped there, else the profile default.
  function extruderColors(model, mapArr, count, saved, defaults) {
    const colors = [];
    for (let e = 1; e <= count; e++) {
      let c = saved && saved[e - 1];
      for (let i = 1; !c && i <= model.filaments.length; i++) {
        if (mapIndex(mapArr, i) === e) c = model.filaments[i - 1].color;
      }
      colors.push((c || defaults[e - 1] || '#FFFFFF').slice(0, 7).toUpperCase());
    }
    return colors;
  }

  // Splits a PrusaSlicer config list on ';' outside double quotes (string lists), keeping the quotes.
  function splitConfigList(v) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (c === '"' && v[i - 1] !== '\\') q = !q;
      if (c === ';' && !q) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  }

  // Filament settings for extruder/tool i: the chosen filament profile (printer.profiles[i]), else the settings for
  // its filament type (printer.types[i] in table), else none (the template's PLA stays).
  function filamentFor(printer, table, i) {
    return (printer.profiles && printer.profiles[i]) || (table && printer.types && table[printer.types[i]]) || null;
  }

  // Puts each extruder's filament values into a config value that holds one entry per extruder. Lists of strings
  // use ';', lists of numbers ','.
  function withMaterials(key, value, printer) {
    const n = printer.extruders;
    const vals = Array.from({ length: n }, (_, i) => filamentFor(printer, printer.materials, i));
    if (!vals.some((v) => v && key in v)) return value;
    let sep = ';', items = splitConfigList(value);
    if (items.length !== n) { sep = ','; items = value.split(','); }
    if (items.length !== n) return value;
    vals.forEach((v, i) => { if (v && key in v) items[i] = v[key]; });
    return items.join(sep);
  }

  // Metadata/Slic3r_PE.config. PrusaSlicer reads it bottom-up until the first line that is not "; key = value",
  // so the header line must stay first.
  function prusaProjectConfig(printer, colors) {
    const lines = ['; generated by 3MF-Fargekonverter from PrusaSlicer system presets', ''];
    for (const line of printer.config.split('\n')) {
      const m = /^([a-z0-9_]+) = (.*)$/.exec(line);
      if (!m || m[1] === 'compatible_printers') continue;
      const v = m[1] === 'extruder_colour' || m[1] === 'filament_colour' ? colors.join(';') : withMaterials(m[1], m[2], printer);
      lines.push(`; ${m[1]} = ${v}`);
    }
    return lines.join('\n') + '\n';
  }

  // PrusaSlicer 3.0: the filament of each tool – its filament settings (only those that differ from the template's
  // PLA are given), the material preset and the material the tool reports.
  function applyMaterials3(group, printer, tools) {
    const fs = group.configuration.filament_settings;
    for (let i = 0; i < tools; i++) {
      const m = filamentFor(printer, printer.materials3, i);
      if (!m) continue;
      for (const k of Object.keys(fs)) if (Array.isArray(fs[k]) && k in m.filament) fs[k][i] = m.filament[k];
      if (group.preset.materials) group.preset.materials[i] = JSON.parse(JSON.stringify(m.material));
      const tool = group.preset.hw_config.tools && group.preset.hw_config.tools[i];
      if (tool && m.slicerMaterial) {
        tool.slicer_material = Object.assign({}, m.slicerMaterial);
        const pkg = tool.material_package_instance && tool.material_package_instance.package;
        if (pkg && pkg.material) pkg.material.type = m.slicerMaterial.type;
      }
    }
  }

  // Moves all instances so the model is centred on the printer bed (Bambu beds are larger and centred
  // elsewhere), and puts the wipe tower beside the model when there is room. Returns the tower position or null.
  function placeOnBed(model, instances, bed, tw) {
    if (bed.length < 3 || bed.some((p) => p.length !== 2 || p.some((x) => !isFinite(x)))) return null;
    const bx = bed.map((p) => p[0]), by = bed.map((p) => p[1]);
    const bed0 = [Math.min(...bx), Math.min(...by)], bed1 = [Math.max(...bx), Math.max(...by)];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    model.objects.forEach((o, k) => {
      for (const [ii, m] of instances[k].entries()) {
        if (o.instancePrintable && o.instancePrintable[ii] === false) continue;
        for (const v of o.volumes) {
          const a = v.vertices;
          for (let i = 0; i < a.length; i += 3) {
            const x = a[i] * m[0] + a[i + 1] * m[3] + a[i + 2] * m[6] + m[9];
            const y = a[i] * m[1] + a[i + 1] * m[4] + a[i + 2] * m[7] + m[10];
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
    });
    if (!isFinite(x0)) return null;
    const dx = (bed0[0] + bed1[0]) / 2 - (x0 + x1) / 2, dy = (bed0[1] + bed1[1]) / 2 - (y0 + y1) / 2;
    for (const list of instances) for (const m of list) { m[9] += dx; m[10] += dy; }
    x0 += dx; x1 += dx; y0 += dy; y1 += dy;
    const gap = 10, ty = Math.max(bed0[1] + 10, (y0 + y1) / 2 - 30);
    if (x1 + gap + tw <= bed1[0] - 5) return [x1 + gap, ty];
    if (x0 - gap - tw >= bed0[0] + 5) return [x0 - gap - tw, ty];
    return null;
  }

  // PrusaSlicer 3.0 keys for painted facets in Metadata/Slic3r_facets_annotation.json.
  const PRUSA3_FACETS = { color: 'mmSegmentationFacets', supports: 'supportedFacets', seam: 'seamFacets', fuzzy: 'fuzzySkinFacets' };

  // PrusaSlicer 3.0 project, laid out like PrusaSlicer 3.0.0-alpha11 saves it: one mesh object per volume, a named
  // wrapper object per volume, one object per model object made of the wrappers, the printer group in
  // Metadata/PrusaSlicer3_project.json and the painting both on the triangles and in Slic3r_facets_annotation.json.
  // PrusaSlicer 3.0 loads older PrusaSlicer 3MF files as geometry only (single extruder, no colours), hence this format.
  function buildPrusa3(model, mapArr, printer) {
    const used = paintUsed(model);
    const group = JSON.parse(JSON.stringify(printer.project3));
    const ps = group.configuration.printer_settings;
    const tools = group.preset.hw_config.tool_count;
    const instances = model.objects.map((o) => o.instances.map((t) => t.slice()));
    placeOnBed(model, instances, ps.bed_shape || [], 0);
    const ident = isIdentityMap(mapArr);

    const out = new Out();
    out.w('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n');
    if (used.color) out.w(' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n');
    if (used.supports) out.w(' <metadata name="slic3rpe:FdmSupportsPaintingVersion">1</metadata>\n');
    if (used.seam) out.w(' <metadata name="slic3rpe:SeamPaintingVersion">1</metadata>\n');
    if (used.fuzzy) out.w(' <metadata name="slic3rpe:FuzzySkinPaintingVersion">1</metadata>\n');
    out.w(` <metadata name="Title">${esc(model.meta.title)}</metadata>\n`);
    out.w(` <metadata name="Designer">${esc(model.meta.designer)}</metadata>\n`);
    out.w(' <metadata name="Application">3MF-Fargekonverter</metadata>\n <resources>\n');
    const facets = new Out();
    let facetCount = 0;
    const objects = [];
    const objectIds = [];
    let next = 1;
    model.objects.forEach((o) => {
      const volIds = [];
      const volumes = [];
      for (const v of o.volumes) {
        const meshId = next++, volId = next++;
        out.w(`  <object id="${meshId}" >\n`);
        writeMesh(out, [v], PRUSA_ATTRS, mapArr, '   ');
        out.w(`  </object>\n  <object id="${volId}" name="${esc(v.name)}" >\n   <components>\n    <component objectid="${meshId}" />\n   </components>\n  </object>\n`);
        volIds.push(volId);
        const settings = { wipe_into_infill: false };
        if (v.extruder > 0) settings.extruder = Math.min(mapIndex(mapArr, v.extruder), tools);
        volumes.push({ id: volId, type: TYPE_TO_PRUSA[v.type] || 'ModelPart', source: { objectIdx: -1, volumeIdx: -1 }, volume_settings: settings });
        const keys = Object.keys(PRUSA3_FACETS).filter((k) => v.paint[k] && v.paint[k].length);
        if (!keys.length) continue;
        facets.w(facetCount++ ? ',\n  {' : '[\n  {');
        keys.forEach((k, ki) => {
          facets.w(`${ki ? ',' : ''}\n    "${PRUSA3_FACETS[k]}": [`);
          let first = true;
          v.paint[k].forEach((p, n) => {
            if (!p) return;
            if (k === 'color' && !ident) p = remapPaint(p, mapArr);
            facets.w(`${first ? '' : ', '}{"triangle": ${n}, "dividing": "${p}"}`);
            first = false;
          });
          facets.w(`],\n    "${PRUSA3_FACETS[k]}Version": 1`);
        });
        facets.w(`,\n    "id": ${volId}\n  }`);
      }
      const objId = next++;
      out.w(`  <object id="${objId}" name="${esc(o.name)}" >\n   <components>\n`);
      for (const id of volIds) out.w(`    <component objectid="${id}" />\n`);
      out.w('   </components>\n  </object>\n');
      objectIds.push(objId);
      objects.push({ id: objId, volumes, object_settings: { extruder: Math.min(mapIndex(mapArr, o.extruder) || 1, tools), wipe_into_objects: false } });
    });
    out.w(' </resources>\n <build>\n');
    let buildOrdinal = 0;
    instances.forEach((list, k) => {
      list.forEach((t, i) => {
        const printable = !model.objects[k].instancePrintable || model.objects[k].instancePrintable[i] !== false;
        if (!printable) (objects[k].instances || (objects[k].instances = [])).push({ ord: buildOrdinal, printable: false });
        out.w(`  <item objectid="${objectIds[k]}" transform="${fmt12(t)}" printable="${printable ? 1 : 0}" />\n`);
        buildOrdinal++;
      });
    });
    out.w(' </build>\n</model>\n');

    const colors = extruderColors(model, mapArr, tools, printer.colors, group.configuration.project_settings.extruder_colour || []);
    group.configuration.project_settings.extruder_colour = colors;
    applyMaterials3(group, printer, tools);
    const project ={ objects, project: { id: uuid(), version: 1 }, config_containers: [group] };

    const files = [
      { name: '[Content_Types].xml', parts: [CONTENT_TYPES] },
      {
        name: '_rels/.rels', parts: [`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${model.thumbnail ? '\n <Relationship Target="/Metadata/thumbnail.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' : ''}
 <Relationship Target="/Metadata/PrusaSlicer3_project.json" Id="rel-3" Type="http://schemas.prusa3d.cz/package/2024/relationships/metadata/projectfile"/>
</Relationships>`],
      },
      { name: '3D/3dmodel.model', parts: out.done() },
      { name: 'Metadata/PrusaSlicer3_project.json', parts: [JSON.stringify(project, null, 2)] },
    ];
    if (facetCount) {
      facets.w('\n]\n');
      files.push({ name: 'Metadata/Slic3r_facets_annotation.json', parts: facets.done() });
    }
    if (model.thumbnail) files.push({ name: 'Metadata/thumbnail.png', parts: [model.thumbnail], store: true });
    return files;
  }

  function buildPrusa(model, mapArr, printer) {
    if (printer && printer.project3 && printer.format === 3) return buildPrusa3(model, mapArr, printer);
    const used = paintUsed(model);
    const instances = model.objects.map((o) => o.instances.map((t) => t.slice()));
    let tower = null;
    if (printer) {
      const bed = configValue(printer.config, 'bed_shape').split(',').map((p) => p.split('x').map(Number));
      const tw = (Number(configValue(printer.config, 'wipe_tower_width')) || 60) + 2 * (Number(configValue(printer.config, 'wipe_tower_brim_width')) || 0);
      tower = placeOnBed(model, instances, bed, tw);
      if (configValue(printer.config, 'wipe_tower') === '0') tower = null; // tool changers (INDX) have no tower
    }
    const out = new Out();
    out.w('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n');
    out.w(' <metadata name="slic3rpe:Version3mf">1</metadata>\n');
    if (used.color) out.w(' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n');
    if (used.supports) out.w(' <metadata name="slic3rpe:FdmSupportsPaintingVersion">1</metadata>\n');
    if (used.seam) out.w(' <metadata name="slic3rpe:SeamPaintingVersion">1</metadata>\n');
    if (used.fuzzy) out.w(' <metadata name="slic3rpe:FuzzySkinPaintingVersion">1</metadata>\n');
    out.w(` <metadata name="Title">${esc(model.meta.title)}</metadata>\n`);
    out.w(` <metadata name="Designer">${esc(model.meta.designer)}</metadata>\n`);
    out.w(' <metadata name="Application">3MF-Fargekonverter</metadata>\n <resources>\n');
    const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
    model.objects.forEach((o, k) => {
      const id = k + 1;
      out.w(`  <object id="${id}" type="model">\n`);
      writeMesh(out, o.volumes, PRUSA_ATTRS, mapArr, '   ');
      out.w('  </object>\n');
      cfg.push(` <object id="${id}" instances_count="${o.instances.length}">\n`);
      cfg.push(`  <metadata type="object" key="name" value="${esc(o.name)}"/>\n`);
      cfg.push(`  <metadata type="object" key="extruder" value="${mapIndex(mapArr, o.extruder)}"/>\n`);
      let first = 0;
      for (const v of o.volumes) {
        const n = v.triangles.length / 3;
        cfg.push(`  <volume firstid="${first}" lastid="${first + n - 1}">\n`);
        cfg.push(`   <metadata type="volume" key="name" value="${esc(v.name)}"/>\n`);
        if (v.type === 'modifier') cfg.push('   <metadata type="volume" key="modifier" value="1"/>\n');
        cfg.push(`   <metadata type="volume" key="volume_type" value="${TYPE_TO_PRUSA[v.type] || 'ModelPart'}"/>\n`);
        cfg.push(`   <metadata type="volume" key="matrix" value="${fmt16(v.matrix || m12to16(IDENTITY12))}"/>\n`);
        if (v.extruder > 0) cfg.push(`   <metadata type="volume" key="extruder" value="${mapIndex(mapArr, v.extruder)}"/>\n`);
        cfg.push('   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n');
        cfg.push('  </volume>\n');
        first += n;
      }
      cfg.push(' </object>\n');
    });
    out.w(' </resources>\n <build>\n');
    instances.forEach((list, k) => {
      list.forEach((t, i) => out.w(`  <item objectid="${k + 1}" transform="${fmt12(t)}" printable="${model.objects[k].instancePrintable && model.objects[k].instancePrintable[i] === false ? 0 : 1}"/>\n`));
    });
    out.w(' </build>\n</model>\n');
    cfg.push('</config>\n');

    const files = [
      { name: '[Content_Types].xml', parts: [CONTENT_TYPES] },
      {
        name: '_rels/.rels', parts: [`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${model.thumbnail ? '\n <Relationship Target="/Metadata/thumbnail.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' : ''}
</Relationships>`],
      },
      { name: '3D/3dmodel.model', parts: out.done() },
      { name: 'Metadata/Slic3r_PE_model.config', parts: [cfg.join('')] },
    ];
    if (printer) {
      const colors = extruderColors(model, mapArr, printer.extruders, printer.colors, configValue(printer.config, 'extruder_colour').split(';'));
      files.push({ name: 'Metadata/Slic3r_PE.config', parts: [prusaProjectConfig(printer, colors)] });
      if (tower) {
        files.push({
          name: 'Metadata/Prusa_Slicer_wipe_tower_information.xml',
          parts: [`<?xml version="1.0" encoding="utf-8"?>\n<wipe_tower_information bed_idx="0" position_x="${tower[0].toFixed(3)}" position_y="${tower[1].toFixed(3)}" rotation_deg="0"/>\n`],
        });
      }
    }
    if (model.thumbnail) files.push({ name: 'Metadata/thumbnail.png', parts: [model.thumbnail], store: true });
    return files;
  }

  const BAMBU_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">\n';

  // Distinct stand-ins for colours the source file does not name (e.g. a PrusaSlicer file saved without settings).
  const PLACEHOLDER_COLORS = ['#00AE42', '#FFFFFF', '#000000', '#C12E1F', '#0086D6', '#F4EE2A', '#9D432C', '#FF6A13',
    '#8E47B3', '#A6A9AA', '#F7ADA6', '#164B35', '#E4BD68', '#5E43B7', '#00B1B7', '#D3B7A7'];

  // Metadata/project_settings.config from a one-filament template (bambu-profiles.js), grown to one entry per colour.
  function bambuProjectSettings(printer, colors, tower) {
    const n = colors.length;
    const s = JSON.parse(JSON.stringify(printer.settings));
    const grow = (a) => Array.from({ length: n }, (_, i) => a[Math.min(i, a.length - 1)]);
    for (const k of printer.filamentKeys) if (Array.isArray(s[k]) && s[k].length) s[k] = grow(s[k]);
    // Filament type per colour: the system preset's name, id and type, and its values where they differ from PLA.
    (printer.types || []).slice(0, n).forEach((t, i) => {
      const m = printer.materials && printer.materials[t];
      if (!m) return;
      const set = (k, v) => { if (Array.isArray(s[k]) && s[k].length === n) s[k][i] = v; };
      set('filament_settings_id', m.name);
      set('filament_ids', m.id);
      set('filament_type', m.type);
      for (const [k, v] of Object.entries(m.values)) if (v.length === 1) set(k, v[0]);
    });
    s.filament_colour = colors.slice();
    s.filament_multi_colour = colors.slice();
    s.filament_self_index = colors.map((_, i) => String(i + 1));
    // Empty = "same as the system preset": Bambu Studio then takes every value from its own presets.
    s.different_settings_to_system = Array(n + 2).fill('');
    s.inherits_group = Array(n + 2).fill('');
    const flush = [];
    for (let z = 0; z < (s.nozzle_diameter || [0]).length; z++) {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) flush.push(i === j ? '0' : '280');
    }
    s.flush_volumes_matrix = flush;
    s.flush_volumes_vector = Array(2 * n).fill('140');
    if (tower) { s.wipe_tower_x = [tower[0].toFixed(3)]; s.wipe_tower_y = [tower[1].toFixed(3)]; }
    return JSON.stringify(s, null, 4) + '\n';
  }

  function buildBambu(model, mapArr, printer) {
    const files = [];
    const instances = model.objects.map((o) => o.instances.map((t) => t.slice()));
    let colors = null, tower = null;
    if (printer) {
      let count = printer.colors ? printer.colors.length : 0;
      for (const i of usage(model).filaments.keys()) if (i > 0) count = Math.max(count, mapIndex(mapArr, i));
      colors = extruderColors(model, mapArr, Math.max(1, count), printer.colors, PLACEHOLDER_COLORS);
      const [w, h] = printer.bed;
      tower = placeOnBed(model, instances, [[0, 0], [w, 0], [w, h], [0, h]], (Number(printer.settings.prime_tower_width) || 35) + 5);
    }
    const rootOut = new Out();
    rootOut.w(BAMBU_HEAD);
    // Only a file that names Bambu Studio as its application gets its project settings loaded.
    if (printer) rootOut.w(` <metadata name="Application">BambuStudio-${printer.version}</metadata>\n`);
    rootOut.w(' <metadata name="BambuStudio:3mfVersion">1</metadata>\n');
    rootOut.w(` <metadata name="Title">${esc(model.meta.title)}</metadata>\n`);
    rootOut.w(` <metadata name="Designer">${esc(model.meta.designer)}</metadata>\n`);
    rootOut.w(' <resources>\n');
    const rels = [];
    const cfg = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'];
    const plate = [];
    const items = [];
    let nextId = 1;
    // Bambu does not read several build items of one object as instances, so every instance
    // becomes its own object (as Bambu does for copies); the copies share one mesh file.
    model.objects.forEach((o, k) => {
      let path = null, partIds = null;
      const writeParts = (suffix) => {
        path = `3D/Objects/object_${k + 1}${suffix}.model`;
        partIds = o.volumes.map(() => nextId++);
        const sub = new Out();
        sub.w(BAMBU_HEAD);
        sub.w(' <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n');
        o.volumes.forEach((v, j) => {
          sub.w(`  <object id="${partIds[j]}" p:UUID="${uuid()}" type="model">\n`);
          writeMesh(sub, [v], BAMBU_ATTRS, mapArr, '   ');
          sub.w('  </object>\n');
        });
        sub.w(' </resources>\n <build/>\n</model>\n');
        files.push({ name: path, parts: sub.done() });
        rels.push(` <Relationship Target="/${path}" Id="rel-${rels.length + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`);
      };
      let faces = 0;
      for (const v of o.volumes) faces += v.triangles.length / 3;
      instances[k].forEach((t, ii) => {
        if (ii === 0) writeParts('');
        const objId = nextId++;
        items.push({ objId, t, printable: !o.instancePrintable || o.instancePrintable[ii] !== false });
        rootOut.w(`  <object id="${objId}" p:UUID="${uuid()}" type="model">\n   <components>\n`);
        partIds.forEach((pid) => {
          rootOut.w(`    <component p:path="/${path}" objectid="${pid}" p:UUID="${uuid()}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`);
        });
        rootOut.w('   </components>\n  </object>\n');

        cfg.push(`  <object id="${objId}">\n`);
        cfg.push(`    <metadata key="name" value="${esc(o.name)}"/>\n`);
        cfg.push(`    <metadata key="extruder" value="${mapIndex(mapArr, o.extruder)}"/>\n`);
        cfg.push(`    <metadata face_count="${faces}"/>\n`);
        o.volumes.forEach((v, j) => {
          const n = v.triangles.length / 3;
          cfg.push(`    <part id="${partIds[j]}" subtype="${TYPE_TO_BAMBU[v.type] || 'normal_part'}">\n`);
          cfg.push(`      <metadata key="name" value="${esc(v.name)}"/>\n`);
          cfg.push(`      <metadata key="matrix" value="${fmt16(v.matrix || m12to16(IDENTITY12))}"/>\n`);
          if (v.extruder > 0) cfg.push(`      <metadata key="extruder" value="${mapIndex(mapArr, v.extruder)}"/>\n`);
          cfg.push(`      <mesh_stat face_count="${n}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n`);
          cfg.push('    </part>\n');
        });
        cfg.push('  </object>\n');
        plate.push(`    <model_instance>\n      <metadata key="object_id" value="${objId}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + plate.length}"/>\n    </model_instance>\n`);
      });
    });
    rootOut.w(` </resources>\n <build p:UUID="${uuid()}">\n`);
    for (const { objId, t, printable } of items) rootOut.w(`  <item objectid="${objId}" p:UUID="${uuid()}" transform="${fmt12(t)}" printable="${printable ? 1 : 0}"/>\n`);
    rootOut.w(' </build>\n</model>\n');

    cfg.push('  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n');
    if (model.thumbnail) cfg.push('    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>\n');
    cfg.push(plate.join(''));
    cfg.push('  </plate>\n</config>\n');

    files.unshift(
      { name: '[Content_Types].xml', parts: [CONTENT_TYPES] },
      {
        name: '_rels/.rels', parts: [`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>${model.thumbnail ? '\n <Relationship Target="/Metadata/plate_1.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>' : ''}
</Relationships>`],
      },
      { name: '3D/3dmodel.model', parts: rootOut.done() },
      {
        name: '3D/_rels/3dmodel.model.rels', parts: [`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels.join('\n')}
</Relationships>`],
      },
      { name: 'Metadata/model_settings.config', parts: [cfg.join('')] },
    );
    if (printer) files.push({ name: 'Metadata/project_settings.config', parts: [bambuProjectSettings(printer, colors, tower)] });
    if (model.thumbnail) files.push({ name: 'Metadata/plate_1.png', parts: [model.thumbnail], store: true });
    return files;
  }

  /**
   * target: 'prusa' | 'bambu'. mapArr[sourceFilament] = targetExtruder (1-based, index 0 unused).
   * opts.printer: the printer the file opens with, filament colours set. PrusaSlicer: { config, extruders, colors?,
   * project3?, format?, types?, materials?, materials3? } from prusa-profiles.js. Bambu: { settings, filamentKeys, version,
   * bed, colors?, types?, materials? } from bambu-profiles.js; one filament per used colour, at least colors.length.
   * types[i] is the filament type ('PLA', 'PETG', …) of extruder/filament i + 1; profiles[i] (PrusaSlicer) a whole filament
   * profile for it from filaments.js, which wins over the type. Without a printer only the model is written.
   * Returns a Blob with the finished 3MF.
   */
  async function convert(model, target, mapArr, onProgress, opts) {
    const map = mapArr || [];
    const printer = opts && opts.printer;
    if ((model.beds || []).length > 1) throw new Error('This file has multiple beds. Select a source bed with the chat CLI (--bed N); beds cannot be combined implicitly.');
    if (model.badPaint) throw new Error('The source contains invalid paint data. Repair the source before converting.');
    const destinations = new Set();
    for (const i of usage(model).filaments.keys()) {
      const dest = mapIndex(map, i);
      if (!Number.isInteger(dest) || dest < 1 || (printer && printer.extruders && dest > printer.extruders)) throw new Error('Invalid target tool for source colour ' + i);
      if (destinations.has(dest) && !(opts && opts.allowColorMerge)) throw new Error('Multiple source colours map to one tool. Review the mapping and explicitly allow colour merging.');
      destinations.add(dest);
    }
    const files = target === 'prusa' ? buildPrusa(model, map, printer) : buildBambu(model, map, printer);
    return writeZip(files, onProgress);
  }

  return { load3mf, convert, usage, remapPaint, walkPaint, readZip, writeZip, parseModel, selectBed, settingsChanges, instanceBounds };
});
