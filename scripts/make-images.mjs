// Rasterizes the PWA icons (public/icons/*) and the Open Graph share image (public/share.png) for Palisade
// without any npm dependency: shapes are filled at a supersampled resolution with a scanline polygon filler,
// box-filtered down for anti-aliasing and written as 8-bit RGBA PNG (deflate from node:zlib, CRC32 by hand).
// The artwork mirrors index.html: the three-stake favicon, and the #logo palisade with its shield and crown.
// Run: node scripts/make-images.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------- colours and paints
// A paint is either a straight-alpha [r,g,b,a] (0..1) or a function of output-pixel (x, y) returning one.
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(h.length === 9 ? parseInt(h.slice(7, 9), 16) / 255 : 1);
const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
/** Colour ramp from [[t, '#hex' | rgba], ...] to a function of t (clamped at both ends). */
function ramp(stops) {
  const st = stops.map(([t, c]) => [t, typeof c === 'string' ? rgb(c) : c]);
  return (t) => {
    if (!(t > st[0][0])) return st[0][1];
    for (let i = 1; i < st.length; i++) if (t <= st[i][0]) return mix(st[i - 1][1], st[i][1], (t - st[i - 1][0]) / (st[i][0] - st[i - 1][0]));
    return st[st.length - 1][1];
  };
}
const linear = (x0, y0, x1, y1, stops) => { const f = ramp(stops), dx = x1 - x0, dy = y1 - y0, d = dx * dx + dy * dy; return (x, y) => f(((x - x0) * dx + (y - y0) * dy) / d); };
const radial = (cx, cy, r0, r1, stops) => { const f = ramp(stops); return (x, y) => f((Math.hypot(x - cx, y - cy) - r0) / (r1 - r0)); };
/** Vertical gradient down a stake plus a lit left side and a shaded right side, so it reads as a round log. */
function logPaint(x0, x1, y0, y1, stops, shade = 0.16) {
  const f = ramp(stops);
  return (x, y) => { const c = f((y - y0) / (y1 - y0)), k = 1 + shade * (1 - 2 * (x - x0) / (x1 - x0)); return [c[0] * k, c[1] * k, c[2] * k, c[3]]; };
}
const INK = rgb('#2b1a10');

// ---------------------------------------------------------------------------- geometry (output-pixel units)
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const circle = (cx, cy, r, n) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
function roundRect(x0, y0, x1, y1, r, n = 32) {
  const pts = [], corners = [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]];
  for (const [cx, cy, a0] of corners) for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI / 2; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
/** Quadratic Bezier from p0 via control c to p1 as line segments (p0 itself excluded). */
const quad = (p0, c, p1, n = 16) => Array.from({ length: n }, (_, i) => {
  const t = (i + 1) / n, u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
});
/** Cuts every corner of a polygon by `c` (one number, or one per vertex) along both adjacent edges. */
function chamfer(poly, c) {
  const n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const ci = Array.isArray(c) ? c[i] : c, [px, py] = poly[(i + n - 1) % n], [x, y] = poly[i], [nx, ny] = poly[(i + 1) % n];
    if (!ci) { out.push([x, y]); continue; }
    const d0 = Math.hypot(px - x, py - y), d1 = Math.hypot(nx - x, ny - y);
    out.push([x + ((px - x) / d0) * ci, y + ((py - y) / d0) * ci], [x + ((nx - x) / d1) * ci, y + ((ny - y) / d1) * ci]);
  }
  return out;
}
const map = (poly, fn) => poly.map(([x, y]) => fn(x, y));

// ---------------------------------------------------------------------------- rasterizer
/** A premultiplied float RGBA buffer at S x S the output resolution (or a one-channel coverage mask). */
class Canvas {
  constructor(w, h, S = 4, channels = 4) {
    Object.assign(this, { w, h, S, ch: channels, W: w * S, H: h * S });
    this.data = new Float32Array(this.W * this.H * channels);
  }

  /** Even-odd scanline fill of a polygon [[x, y], ...] given in output pixels, composited "over". */
  fill(poly, paint = INK) {
    const { S, W, H, data, ch } = this, edges = [];
    let ymin = Infinity, ymax = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
      const x0 = ax * S, y0 = ay * S, x1 = bx * S, y1 = by * S;
      if (y0 === y1) continue;
      edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
      ymin = Math.min(ymin, y0, y1); ymax = Math.max(ymax, y0, y1);
    }
    const solid = typeof paint === 'function' ? null : paint, xs = [];
    for (let j = Math.max(0, Math.floor(ymin)); j < Math.min(H, Math.ceil(ymax)); j++) {
      const y = j + 0.5;
      xs.length = 0;
      for (const [x0, y0, x1, y1] of edges) if (y >= y0 && y < y1) xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W, Math.ceil(xs[k + 1] - 0.5));
        for (let i = i0; i < i1; i++) {
          const p = (j * W + i) * ch;
          if (ch === 1) { data[p] = 1; continue; }
          const c = solid ?? paint((i + 0.5) / S, (j + 0.5) / S), a = c[3], ia = 1 - a;
          data[p] = c[0] * a + data[p] * ia; data[p + 1] = c[1] * a + data[p + 1] * ia;
          data[p + 2] = c[2] * a + data[p + 2] * ia; data[p + 3] = a + data[p + 3] * ia;
        }
      }
    }
  }

  /** Strokes a closed polygon with round joins: a quad per edge plus a disc per vertex. Use an opaque paint. */
  stroke(poly, width, paint = INK) {
    const r = width / 2, segs = Math.max(12, Math.min(96, Math.round(r * this.S * 1.5)));
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len) { const nx = (-dy / len) * r, ny = (dx / len) * r; this.fill([[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]], paint); }
      this.fill(circle(ax, ay, r, segs), paint);
    }
  }

  /** Fill plus outline. `under` puts the outline beneath the fill (SVG paint-order="stroke"). */
  shape(poly, paint, strokeWidth = 0, strokePaint = INK, under = false) {
    if (under && strokeWidth) this.stroke(poly, strokeWidth, strokePaint);
    this.fill(poly, paint);
    if (!under && strokeWidth) this.stroke(poly, strokeWidth, strokePaint);
  }

  /** Renders `draw(mask)` into a coverage mask, blurs it (sigma ~ `blur` px) and darkens the canvas with it, offset by (dx, dy). */
  shadow(draw, { blur = 8, dx = 0, dy = 6, alpha = 0.5 } = {}) {
    const { S, W, H, data } = this, mask = new Canvas(this.w, this.h, S, 1);
    draw(mask);
    boxBlur(mask, Math.max(1, Math.round(blur * S)));
    const ox = Math.round(dx * S), oy = Math.round(dy * S);
    for (let y = Math.max(0, oy); y < Math.min(H, H + oy); y++) {
      for (let x = Math.max(0, ox); x < Math.min(W, W + ox); x++) {
        const a = mask.data[(y - oy) * W + (x - ox)] * alpha;
        if (a <= 0) continue;
        const p = (y * W + x) * 4, k = 1 - a;
        data[p] *= k; data[p + 1] *= k; data[p + 2] *= k; data[p + 3] = a + data[p + 3] * k;
      }
    }
  }

  /** Box-filters the supersampled buffer down to the output size and encodes it as a PNG. */
  png() {
    const { w, h, S, W, data } = this, out = Buffer.alloc(w * h * 4), inv = 1 / (S * S);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        let p = ((y * S + sy) * W + x * S) * 4;
        for (let sx = 0; sx < S; sx++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; }
      }
      a *= inv;
      const o = (y * w + x) * 4, k = a > 0 ? inv / a : 0; // un-premultiply
      out[o] = byte(r * k); out[o + 1] = byte(g * k); out[o + 2] = byte(b * k); out[o + 3] = byte(a);
    }
    return encodePNG(w, h, out);
  }
}
const byte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** Three in-place box blurs of radius r on a one-channel mask (a close match to a Gaussian of sigma ~ r). */
function boxBlur(mask, r) {
  const { W, H, data } = mask, tmp = new Float32Array(Math.max(W, H)), norm = 1 / (2 * r + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      const row = y * W; let sum = 0;
      for (let i = 0; i <= r && i < W; i++) sum += data[row + i];
      for (let x = 0; x < W; x++) { tmp[x] = sum * norm; const add = x + r + 1, rem = x - r; sum += (add < W ? data[row + add] : 0) - (rem >= 0 ? data[row + rem] : 0); }
      data.set(tmp.subarray(0, W), row);
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let i = 0; i <= r && i < H; i++) sum += data[i * W + x];
      for (let y = 0; y < H; y++) { tmp[y] = sum * norm; const add = y + r + 1, rem = y - r; sum += (add < H ? data[add * W + x] : 0) - (rem >= 0 ? data[rem * W + x] : 0); }
      for (let y = 0; y < H; y++) data[y * W + x] = tmp[y];
    }
  }
}

// ---------------------------------------------------------------------------- PNG encoder
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = Buffer.alloc(8), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1'); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, crc]);
}
/** Picks, per scanline, the PNG filter with the smallest absolute residual sum, then zlib-compresses. */
function filterRows(w, h, rgba) {
  const bpp = 4, stride = w * bpp, out = Buffer.alloc((stride + 1) * h), cand = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[i] - pred) & 0xff;
        cand[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; out[y * (stride + 1)] = f; cand.copy(out, y * (stride + 1) + 1); }
    }
    prev = row;
  }
  return out;
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits per sample, colour type 6 = RGBA; compression, filter and interlace stay 0
  const idat = zlib.deflateSync(filterRows(w, h, rgba), { level: 9 });
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------- the favicon motif -> app icons
// From the inline SVG favicon in index.html (32-unit grid): three pointed stakes and a crimson band.
const FAV_STAKES = [[[5, 27], [5, 11], [8, 6], [11, 11], [11, 27]], [[13, 27], [13, 8], [16, 3], [19, 8], [19, 27]], [[21, 27], [21, 11], [24, 6], [27, 11], [27, 27]]];
const FAV_BAND = [3, 16, 29, 20];
const FAV_CENTER = [16, 15];

function drawIcon(size, { rounded = true, maskable = false } = {}) {
  const c = new Canvas(size, size, 4);
  const bg = rounded ? roundRect(0, 0, size, size, (size * 6) / 32) : rect(0, 0, size, size);
  c.fill(bg, radial(size / 2, size * 0.4, 0, size * 0.8, [[0, '#32200f'], [1, '#24150c']]));
  // Placement: the favicon's own layout, or shrunk so the motif stays inside the maskable safe circle (radius 40% of the side).
  let k = size / 32, ox = 0, oy = 0;
  if (maskable) {
    const far = Math.max(...FAV_STAKES.flat().map(([x, y]) => Math.hypot(x - FAV_CENTER[0], y - FAV_CENTER[1])));
    k = (size * 0.4 - size * 0.02) / far; ox = size / 2 - FAV_CENTER[0] * k; oy = size / 2 - FAV_CENTER[1] * k;
  }
  const T = (x, y) => [x * k + ox, y * k + oy];
  for (const s of FAV_STAKES) {
    const [[x0, bottom], , [, tip], , [x1]] = s;
    c.fill(map(s, T), logPaint(T(x0, 0)[0], T(x1, 0)[0], T(0, tip)[1], T(0, bottom)[1], [[0, '#f7dc8f'], [0.45, '#e6b84a'], [1, '#a87a2a']]));
  }
  const [bx0, by0, bx1, by1] = FAV_BAND, band = map(rect(bx0, by0, bx1, by1), T);
  c.shadow((m) => m.fill(band), { blur: k * 0.45, dy: k * 0.55, alpha: 0.55 });
  c.shape(band, linear(0, T(0, by0)[1], 0, T(0, by1)[1], [[0, '#c9333e'], [1, '#931b25']]), k * 0.4, INK);
  return c;
}

// ---------------------------------------------------------------------------- the #logo palisade -> share image
// From the #logo SVG in index.html (520 x 190 viewBox): nine stakes [x, width, shoulder y, tip y], a beam, a shield and a crown.
const LOGO_STAKES = [[46, 32, 36, 10], [94, 32, 24, 2], [142, 32, 36, 10], [190, 32, 24, 2], [238, 44, 14, 0], [298, 32, 24, 2], [346, 32, 36, 10], [394, 32, 24, 2], [442, 32, 36, 10]]
  .map(([x, w, sh, tip]) => [[x, 112], [x, sh], [x + w / 2, tip], [x + w, sh], [x + w, 112]]);
const LOGO_BEAM = rect(36, 74, 484, 90);
const LOGO_SHIELD = [[240, 34], [280, 34], [280, 64], ...quad([280, 64], [280, 80], [260, 90]), ...quad([260, 90], [240, 80], [240, 64])];
const LOGO_CROWN = [[251, 62], [251, 44], [255.5, 49], [260, 42], [264.5, 49], [269, 44], [269, 62]];

// A chamfered block face for the word mark: each glyph is a union of boxes and quads on a 100-unit cap height.
// Pieces are outlined one by one first and all filled afterwards, so only the union's silhouette keeps its outline.
const CAP = 100, STEM = 22, C1 = 7, C2 = 18; // cap height, stem width, small chamfer (terminals), big chamfer (where a curve would be)
const box = (x0, y0, x1, y1, ch = C1) => chamfer(rect(x0, y0, x1, y1), ch); // per-corner chamfers are [tl, tr, br, bl]
const GLYPHS = {
  P: [66, (w) => [box(0, 0, STEM, CAP), box(0, 0, w, STEM, [C1, C2, C1, C1]), box(w - STEM, 0, w, 58, [C1, C2, C2, C1]), box(0, 58 - STEM, w, 58, [C1, C1, C2, C1])]],
  A: [84, (w) => {
    const ft = 18, th = 22.6, l = w / 2 - ft; // half the flat top, horizontal leg width, horizontal run of a leg
    return [chamfer([[0, CAP], [th, CAP], [l + th, 0], [l, 0]], C1), chamfer([[w - th, CAP], [w, CAP], [w - l, 0], [w - l - th, 0]], C1), box(l, 0, w - l, STEM), box(16, 56, w - 16, 78)];
  }],
  L: [62, (w) => [box(0, 0, STEM, CAP), box(0, CAP - STEM, w, CAP)]],
  I: [STEM, () => [box(0, 0, STEM, CAP)]],
  S: [66, (w) => [box(0, 0, w, STEM, [C2, C1, C1, C1]), box(0, 0, STEM, 61, [C2, C1, C1, C2]), box(0, 39, w, 61, [C1, C2, C1, C2]), box(w - STEM, 39, w, CAP, [C1, C2, C2, C1]), box(0, CAP - STEM, w, CAP, [C1, C1, C2, C1])]],
  D: [70, (w) => [box(0, 0, STEM, CAP), box(0, 0, w, STEM, [C1, C2, C1, C1]), box(w - STEM, 0, w, CAP, [C1, C2, C2, C1]), box(0, CAP - STEM, w, CAP, [C1, C1, C2, C1])]],
  E: [60, (w) => [box(0, 0, STEM, CAP), box(0, 0, w, STEM), box(0, 39, w - 6, 61), box(0, CAP - STEM, w, CAP)]],
};

function drawWord(c, word, cx, top, height, gap = 16) {
  const k = height / CAP, glyphs = [...word].map((ch) => GLYPHS[ch]);
  const total = glyphs.reduce((s, [w]) => s + w, 0) + gap * (glyphs.length - 1);
  let x = cx - (total * k) / 2;
  const pieces = [];
  for (const [w, make] of glyphs) { const ox = x; pieces.push(...make(w).map((p) => map(p, (px, py) => [ox + px * k, top + py * k]))); x += (w + gap) * k; }
  c.shadow((m) => { for (const p of pieces) m.fill(p); }, { blur: 5, dy: 6, alpha: 0.5 });
  for (const p of pieces) c.stroke(p, 6, INK);
  const paint = linear(0, top, 0, top + height, [[0, '#fff8e8'], [0.5, '#fbeed3'], [1, '#e4c998']]);
  for (const p of pieces) c.fill(p, paint);
}

function drawShare(w = 1200, h = 630) {
  const c = new Canvas(w, h, 3);
  c.fill(rect(0, 0, w, h), linear(0, 0, 0, h, [[0, '#362b20'], [0.5, '#2a2118'], [1, '#1b1410']]));
  c.fill(rect(0, 0, w, h), radial(w / 2, h * 0.4, 0, w * 0.46, [[0, [0.42, 0.27, 0.16, 0.42]], [1, [0.42, 0.27, 0.16, 0]]])); // warm glow behind the wall

  // Logo units -> pixels: the beam (448 units wide) spans 70% of the width; the wall's top sits at y = 130.
  const k = (w * 0.7) / 448, top = 130, L = (x, y) => [w / 2 + (x - 260) * k, top + y * k], sw = 4 * k;

  // A crimson band runs edge to edge behind the wall, at the height of the shield.
  const band = rect(0, L(0, 44)[1], w, L(0, 60)[1]);
  c.shadow((m) => m.fill(band), { blur: 5, dy: 6, alpha: 0.5 });
  c.shape(band, linear(0, band[0][1], 0, band[2][1], [[0, '#c4303b'], [1, '#8d1a23']]), 3, INK);

  const stakes = LOGO_STAKES.map((s) => map(s, L)), beam = map(LOGO_BEAM, L), shield = map(LOGO_SHIELD, L), crown = map(LOGO_CROWN, L);
  c.shadow((m) => { for (const s of stakes) m.fill(s); m.fill(beam); m.fill(shield); }, { blur: 9, dy: 14, alpha: 0.6 });
  for (const s of stakes) c.shape(s, logPaint(s[0][0], s[4][0], s[2][1], s[0][1], [[0, '#d49a5c'], [1, '#6a4528']], 0.14), sw, INK);
  c.shape(beam, linear(0, beam[0][1], 0, beam[2][1], [[0, '#4b4541'], [1, '#34302c']]), sw, INK);
  c.shape(shield, linear(0, L(0, 34)[1], 0, L(0, 90)[1], [[0, '#c42c38'], [1, '#8f1a23']]), sw, INK);
  c.shape(crown, linear(0, L(0, 42)[1], 0, L(0, 62)[1], [[0, '#f7dc8f'], [1, '#d9a53a']]), sw * 0.35, INK);

  drawWord(c, 'PALISADE', w / 2, L(0, 112)[1] + 46, 90);
  return c;
}

// ---------------------------------------------------------------------------- write everything
function out(rel, canvas) {
  const file = path.join(ROOT, rel), buf = canvas.png();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`${rel}  ${canvas.w}x${canvas.h}  ${(buf.length / 1024).toFixed(1)} kB`);
}
out('public/icons/icon-192.png', drawIcon(192));
out('public/icons/icon-512.png', drawIcon(512));
out('public/icons/icon-maskable-512.png', drawIcon(512, { rounded: false, maskable: true }));
out('public/icons/apple-touch-icon.png', drawIcon(180, { rounded: false })); // iOS masks its own corners and paints transparency black
out('public/share.png', drawShare());
