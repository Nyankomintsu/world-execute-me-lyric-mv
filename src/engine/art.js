// Character art and the treatments that put it on screen. The art is never redrawn or warped: every
// treatment only crops, tints, masks, screens or re-samples it.
//
// v4: the character is the set of flat THREE-INK SILHOUETTES (orange / cream / near-black cut-paper busts,
// INK_NAMES below). Each is separated ONCE, at load, into three ink plates:
//
//   art.inks()        the figure as plates: every plate takes a palette role, an offset (misregistration)
//                     and a reveal of its own; lower plates run under the upper ones, so nothing seams
//   art.inkClip()     run a drawing clipped to one plate (masks are taken from the art, never hand-drawn)
//   art.inkPath()     a plate as a Path2D in source pixels (close-ups are drawn as paths, not enlarged bitmaps)
//   art.inkAt()       which ink lies at a point of the picture (glyph plates and dot screens sample this)
//   art.fit()         where to draw a bust so that it registers with f_bust (match cuts)
//
// Also on the silhouettes:
//   art.silhouette() halftone() ascii()     the flat matte in one colour; a dot screen; a glyph screen
//   art.cover()       the source crop that fills a rectangle
// And the room behind the interface:
//   art.backdrop()    a code-drawn warm ground (soft pools of light and grain) in palette colours. Its `name` only
//                     seeds where the pools lie: 'tea', 'rain', 'library' are the names of ROOMS now (v3 showed a
//                     blurred illustration of that name there; those six illustrations are gone from the film)
//
// Nothing here reads pixels while the film renders: classification, masks and outlines are built in
// _prepareInk() and never again.
import { rand } from './prng.js';
import { outline, smoothPath } from './trace.js';
import { clamp } from './util.js';

/** The silhouettes (assets/character/<key>.png; sources and what each shows: docs/v4/PLAN.md §4). All the art there is. */
export const INK_NAMES = ['f_bust', 'f_profile', 'f_reach', 'f_eye', 'boy_bust', 'man_bust', 'cat_bust', 'cat_paws'];
export const ART_NAMES = INK_NAMES;

const LUM_H = 240;                              // working resolution of the luminance maps: the longer side
const MAX_UNTREATED = 1.75;                     // max source magnification at 4K for plate bitmaps (above it: paths)
const warned = new Set();
const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); console.warn(msg); } };

/** The three inks as the files have them (set medians; refined per image at load). Print order: cream, orange, black. */
const INK_RGB = [[244, 224, 198], [220, 114, 63], [36, 26, 21]];
const INK_KEY = { cream: 0, orange: 1, black: 2 };
/**
 * Registration onto f_bust: p' = s * p + [tx, ty] in source px (measured, docs/v4/maps/map_assets.json):
 * the chin, the flower and the collar then coincide.
 */
const REGISTER = { cat_bust: [1.0, -28, -49], boy_bust: [0.89, 60, -18], man_bust: [0.873, 81, -4] };

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** `step(label)` is told of each silhouette once it is separated (the preview's progress bar; it may ask for a pause). */
export async function loadArt(cfg, step = () => {}) {
  const dir = cfg.paths.art, art = new Art();
  await Promise.all(ART_NAMES.map(async (name) => {
    const img = new Image();
    img.src = `${dir}/${name}.png`;
    await img.decode();
    art._prepareInk(name, img);
    await step(`silhouette  ${name}`);
  }));
  try { art.regions = await (await fetch(`${dir}/regions.json`)).json(); } catch { art.regions = {}; }
  return art;
}

export class Art {
  constructor() {
    this.sil = {}; this.lum = {}; this.regions = {};
    this.ink = {}; this.dim = {}; this.walls = {};
    this.tmpA = mk(8, 8); this.tmpB = mk(8, 8); this.tmpC = mk(8, 8);
  }

  /**
   * One-off separation of a three-ink silhouette into its plates.
   *
   *  - matte: alpha under 16 is dust (and carries stray red / yellow RGB): dropped. The solid body is alpha 253 / 254
   *    in the files, never 255: made solid.
   *  - every pixel is split between the two inks it lies between in RGB (anti-aliased ink-to-ink edges stay soft; the
   *    fourth, rust tone of f_reach lies between orange and black and folds into black). Pixels of the soft outer edge
   *    take the split of their most opaque neighbour: their own RGB is too coarse to trust.
   *  - plates are CUMULATIVE, in print order: mask 0 = the whole figure, 1 = orange + black, 2 = black. A lower plate
   *    runs under the upper ones, so registered plates never show a seam and a shifted plate shows the ink below it.
   *  - each mask is also traced to a smooth outline (trace.js) for close-ups, keylines and clipping.
   */
  _prepareInk(name, img) {
    const W = img.naturalWidth, H = img.naturalHeight, N = W * H;
    const src = mk(W, H), sg = src.getContext('2d', { willReadFrequently: true });
    sg.drawImage(img, 0, 0);
    const px = sg.getImageData(0, 0, W, H).data;                     // the only read-back, once, at load
    const A = new Uint8Array(N), C1 = new Uint8Array(N), C2 = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const a = px[i * 4 + 3]; A[i] = a < 16 ? 0 : a >= 250 ? 255 : a; }

    // the three inks of THIS image: mean of the solid pixels nearest to each seed
    const ink = INK_RGB.map((c) => [...c]), sum = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (let i = 0; i < N; i += 3) {
      if (A[i] !== 255) continue;
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      let best = -1, bd = 40 * 40;
      for (let k = 0; k < 3; k++) { const d = (r - ink[k][0]) ** 2 + (g - ink[k][1]) ** 2 + (b - ink[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
      if (best >= 0) { const s = sum[best]; s[0] += r; s[1] += g; s[2] += b; s[3]++; }
    }
    for (let k = 0; k < 3; k++) if (sum[k][3] > 200) for (let c = 0; c < 3; c++) ink[k][c] = sum[k][c] / sum[k][3];

    // split of one colour between the two inks whose mixing line it is nearest to: returns [orange-or-black, black], 0..255
    const PAIR = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => { const d = [0, 1, 2].map((c) => ink[b][c] - ink[a][c]); return { a, b, d, len2: d[0] * d[0] + d[1] * d[1] + d[2] * d[2] }; });
    const ramp = (t) => clamp((t - 0.15) / 0.55);                    // a crisper edge; anything 70 % of the way to an ink IS that ink
    const split = (r, g, b) => {
      let bestD = Infinity, bt = 0, bp = PAIR[0];
      for (const p of PAIR) {
        const x = r - ink[p.a][0], y = g - ink[p.a][1], z = b - ink[p.a][2];
        const t = clamp((x * p.d[0] + y * p.d[1] + z * p.d[2]) / p.len2), ex = x - t * p.d[0], ey = y - t * p.d[1], ez = z - t * p.d[2], d = ex * ex + ey * ey + ez * ez;
        if (d < bestD) { bestD = d; bt = t; bp = p; }
      }
      const t = Math.round(255 * ramp(bt));
      return bp.a === 0 && bp.b === 1 ? [t, 0] : bp.a === 0 ? [t, t] : [255, t];
    };
    for (let i = 0; i < N; i++) {
      if (A[i] < 128) continue;
      const s = split(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
      C1[i] = s[0]; C2[i] = s[1];
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {       // the soft outer edge: take the split of the most opaque neighbour
      const i = y * W + x;
      if (A[i] === 0 || A[i] >= 128) continue;
      let best = -1, ba = 127;
      for (let r = 1; r <= 2 && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (A[j] > ba) { ba = A[j]; best = j; }
      }
      if (best >= 0) { C1[i] = C1[best]; C2[i] = C2[best]; }
      else { const s = split(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]); C1[i] = s[0]; C2[i] = s[1]; }
    }

    // the three cumulative masks (white, alpha = coverage), their coverage maps, their outlines
    const cover = [A, new Uint8Array(N), new Uint8Array(N)];
    for (let i = 0; i < N; i++) { cover[1][i] = (A[i] * C1[i] + 127) / 255; cover[2][i] = (A[i] * C2[i] + 127) / 255; }
    const mask = cover.map((cv) => {
      const c = mk(W, H), g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
      for (let i = 0; i < N; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = cv[i]; }
      g.putImageData(im, 0, 0);
      return c;
    });
    const path = cover.map((cv) => smoothPath(outline(cv, W, H, { eps: 0.25, minArea: 10 }), new Path2D()));
    // a plate WITHOUT what is printed over it (even-odd: inside plate k, outside plate k + 1)
    const exact = [0, 1].map((k) => { const p = new Path2D(); p.addPath(path[k]); p.addPath(path[k + 1]); return p; });
    exact.push(path[2]);

    // which ink lies where, at half resolution: 0 = none, 1 = cream, 2 = orange, 3 = black
    const lw = Math.ceil(W / 2), lh = Math.ceil(H / 2), label = new Uint8Array(lw * lh);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const i = Math.min(H - 1, 2 * y) * W + Math.min(W - 1, 2 * x);
      label[y * lw + x] = A[i] < 128 ? 0 : C2[i] > 127 ? 3 : C1[i] > 127 ? 2 : 1;
    }
    // luminance / alpha map for the dot and glyph screens, in the picture's own aspect
    const mw = W >= H ? LUM_H : Math.round((LUM_H * W) / H), mh = W >= H ? Math.round((LUM_H * H) / W) : LUM_H;
    const L = new Float32Array(mw * mh), LA = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const i = Math.min(H - 1, Math.floor(((y + 0.5) * H) / mh)) * W + Math.min(W - 1, Math.floor(((x + 0.5) * W) / mw));
      L[y * mw + x] = (0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2]) / 255; LA[y * mw + x] = A[i] / 255;
    }
    this.lum[name] = { L, A: LA, hasAlpha: true, w: mw, h: mh };
    this.dim[name] = { w: W, h: H };
    this.sil[name] = mask[0];                                       // art.silhouette(): the whole figure as one flat shape
    this.ink[name] = { w: W, h: H, mask, path, exact, label, lw, lh, rgb: ink };
  }

  size(name) { const d = this.dim[name]; return { w: d.w, h: d.h }; }
  /** Region from regions.json: art.region('f_reach', 'hand') -> {x, y, w, h}; 'crops.avatar', 'crops.wide.0' also work. */
  region(name, key) {
    let v = this.regions[name];
    for (const k of key.split('.')) v = v?.[k];
    if (!Array.isArray(v) || typeof v[0] !== 'number') return null;
    return v.length === 3 ? { x: v[0] - v[2], y: v[1] - v[2], w: 2 * v[2], h: 2 * v[2] } : v.length === 2 ? { x: v[0], y: v[1], w: 0, h: 0 } : { x: v[0], y: v[1], w: v[2], h: v[3] };
  }

  /**
   * Source crop that makes the picture cover `dst` (aspect of dst), centred on `focus`
   * (source px [x, y], or a region key like 'face') and magnified by `zoom` (1 = widest crop that covers).
   */
  cover(name, dst, { focus = null, zoom = 1 } = {}) {
    const { w: W, h: H } = this.size(name), ar = dst.w / dst.h;
    let cw = Math.min(W, H * ar) / zoom, ch = cw / ar;
    let fx = W / 2, fy = H / 2;
    if (typeof focus === 'string') { const r = this.region(name, focus); if (r) { fx = r.x + r.w / 2; fy = r.y + r.h / 2; } }
    else if (focus) [fx, fy] = focus;
    return { x: clamp(fx - cw / 2, 0, W - cw), y: clamp(fy - ch / 2, 0, H - ch), w: cw, h: ch };
  }

  /** Flat silhouette from the alpha matte, in a palette colour. */
  silhouette(ctx, name, dst, { crop = null, color = 'mute', alpha = 1 } = {}) {
    if (alpha <= 0.003) return;
    const c = crop ?? { x: 0, y: 0, ...this.size(name) }, t = this._tmp(this.tmpA, c.w, c.h), tg = t.getContext('2d');
    tg.globalCompositeOperation = 'copy'; tg.drawImage(this.sil[name], c.x, c.y, c.w, c.h, 0, 0, t.width, t.height);
    tg.globalCompositeOperation = 'source-in'; tg.fillStyle = ctx.col(color, 1); tg.fillRect(0, 0, t.width, t.height);
    const g = ctx.g, a0 = g.globalAlpha;
    g.globalAlpha = a0 * alpha; g.drawImage(t, dst.x, dst.y, dst.w, dst.h); g.globalAlpha = a0;
  }

  /** Sample luminance / alpha of the picture at normalised crop coordinates (u, v in 0..1). */
  _sample(name, c, u, v) {
    const { w: W, h: H } = this.size(name), m = this.lum[name];
    const x = clamp(Math.floor(((c.x + u * c.w) / W) * m.w), 0, m.w - 1), y = clamp(Math.floor(((c.y + v * c.h) / H) * m.h), 0, m.h - 1);
    return [m.L[y * m.w + x], m.A[y * m.w + x]];
  }

  /**
   * Dot screen: dot area follows the picture's brightness (light dots on the dark page; set
   * invert for dark dots on a light field). cell = dot pitch in virtual px.
   * ink (silhouettes only): 'cream' | 'orange' | 'black' = dots only where that ink is printed, at full size,
   * so one call per ink screens the figure in its own separations.
   */
  halftone(ctx, name, dst, { crop = null, cell = 10, color = 'me', alpha = 1, invert = false, gain = 1, angle = 0, ink = null, flip = false } = {}) {
    if (alpha <= 0.003) return;
    const c = crop ?? { x: 0, y: 0, ...this.size(name) }, g = ctx.g, want = ink ? INK_KEY[ink] + 1 : 0;
    const cols = Math.ceil(dst.w / cell), rows = Math.ceil(dst.h / cell), { w: W, h: H } = this.size(name);
    g.save(); g.beginPath(); g.rect(dst.x, dst.y, dst.w, dst.h); g.clip();
    g.fillStyle = ctx.col(color, alpha);
    g.beginPath();
    for (let j = 0; j < rows; j++) {
      const off = angle ? (j % 2) * 0.5 : 0;                        // staggered rows read as a 45 degree screen
      for (let i = 0; i < cols + 1; i++) {
        const u = (i + 0.5 - off) / cols, v = (j + 0.5) / rows, us = flip ? 1 - u : u;
        if (u < 0 || u > 1) continue;
        let r;
        if (want) {
          if (this.inkAt(name, (c.x + us * c.w) / W, (c.y + v * c.h) / H) !== want) continue;
          r = cell * 0.62 * Math.sqrt(clamp(gain));
        } else {
          const [l, a] = this._sample(name, c, us, v);
          if (a < 0.5) continue;
          r = cell * 0.62 * Math.sqrt(clamp((invert ? 1 - l : l) * gain));
        }
        if (r < 0.6) continue;
        const x = dst.x + u * dst.w, y = dst.y + v * dst.h;
        g.moveTo(x + r, y); g.arc(x, y, r, 0, 6.2832);
      }
    }
    g.fill(); g.restore(); ctx._font = '';
  }

  /** Glyph screen: one character per cell, denser glyph = brighter. colors = roles for dark / mid / light. */
  ascii(ctx, name, dst, { crop = null, size = 16, colors = ['meDim', 'me', 'meHot'], alpha = 1, ramp = ' .:-=+*#%@', gain = 1 } = {}) {
    if (alpha <= 0.003) return;
    const c = crop ?? { x: 0, y: 0, ...this.size(name) }, g = ctx.g, cw = ctx.cw(size), ch = size;
    const cols = Math.floor(dst.w / cw), rows = Math.floor(dst.h / ch);
    g.save(); g.beginPath(); g.rect(dst.x, dst.y, dst.w, dst.h); g.clip();
    ctx.font(size, 400, 'mono'); g.textAlign = 'left';
    for (let j = 0; j < rows; j++) {
      const strs = ['', '', ''];
      for (let i = 0; i < cols; i++) {
        const [l, a] = this._sample(name, c, (i + 0.5) / cols, (j + 0.5) / rows);
        const k = clamp(l * gain), idx = a < 0.5 ? 0 : Math.min(ramp.length - 1, Math.floor(k * ramp.length));
        const tier = k > 0.66 ? 2 : k > 0.33 ? 1 : 0;
        for (let q = 0; q < 3; q++) strs[q] += q === tier ? ramp[idx] : ' ';
      }
      for (let q = 0; q < 3; q++) {
        if (!strs[q].trim()) continue;
        g.fillStyle = ctx.col(colors[q], alpha);
        g.fillText(strs[q], dst.x, dst.y + (j + 0.8) * ch);
      }
    }
    g.restore(); ctx._font = '';
  }

  // ------------------------------------------------------------------------------------------------ the room

  /** The wall's light: a small map of soft pools (white, alpha = light), built once per name and only ever shown enlarged. */
  _wall(name) {
    if (this.walls[name]) return this.walls[name];
    let seed = 0;
    for (const ch of String(name)) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
    const W = 320, H = 180, c = mk(W, H), g = c.getContext('2d');
    const pool = (x, y, r, a) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.42})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); };
    for (let i = 0; i < 5; i++) pool(W * (0.08 + 0.84 * rand(seed, i, 1)), H * (0.1 + 0.8 * rand(seed, i, 2)), H * (0.55 + 0.5 * rand(seed, i, 3)), 0.34 + 0.3 * rand(seed, i, 4));       // broad pools
    for (let i = 0; i < 9; i++) pool(W * rand(seed, i, 5), H * rand(seed, i, 6), H * (0.16 + 0.2 * rand(seed, i, 7)), 0.16 + 0.2 * rand(seed, i, 8));                                    // smaller, softer spots
    g.globalCompositeOperation = 'destination-out';                                                                                                                                    // and a few places the light does not reach
    for (let i = 0; i < 4; i++) pool(W * rand(seed, i, 9), H * rand(seed, i, 10), H * (0.3 + 0.3 * rand(seed, i, 11)), 0.5);
    return (this.walls[name] = c);
  }
  /** Fine grain of the wall: a tile of light and dark specks (alpha only), built once. */
  _grain() {
    if (this.grain) return this.grain;
    const S = 256, c = mk(S, S), g = c.getContext('2d'), im = g.createImageData(S, S), d = im.data;
    for (let i = 0; i < S * S; i++) { const v = rand(977, i); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v > 0.5 ? 255 : 0; d[i * 4 + 3] = Math.round(255 * Math.abs(v - 0.5) * 2 * (0.4 + 0.6 * rand(978, i >> 2))); }
    g.putImageData(im, 0, 0);
    return (this.grain = c);
  }

  /**
   * The room behind the interface: a warm, mottled wall drawn in code: soft pools of the AI's own light (role meDim; a
   * neutral grey as `sat` falls, so the room greys with the conversation state) and a fine grain. `name` only seeds
   * where the pools lie, so each room keeps a look of its own (the names are those of v3's rooms; no picture is behind them).
   */
  backdrop(ctx, name, dst = { x: 0, y: 0, w: 1920, h: 1080 }, { alpha = 0.5, sat = ctx.pal.sat, focus = [0.5, 0.4], zoom = 1 } = {}) {
    if (alpha <= 0.003) return;
    const g = ctx.g, b = this._wall(name), ar = dst.w / dst.h;
    const cw = Math.min(b.width, b.height * ar) / zoom, ch = cw / ar;
    const sx = clamp(focus[0] * b.width - cw / 2, 0, b.width - cw), sy = clamp(focus[1] * b.height - ch / 2, 0, b.height - ch);
    const s = clamp(sat), warm = ctx.pal.meDim, grey = ctx.pal.mute, col = [0, 1, 2].map((i) => Math.round(grey[i] + (warm[i] - grey[i]) * s));
    const t = this._tmp(this.tmpA, b.width, b.height), tg = t.getContext('2d');
    tg.globalCompositeOperation = 'copy'; tg.drawImage(b, 0, 0);
    tg.globalCompositeOperation = 'source-in'; tg.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`; tg.fillRect(0, 0, t.width, t.height);
    const a0 = g.globalAlpha;
    g.imageSmoothingQuality = 'high';
    g.globalAlpha = a0 * Math.min(1, alpha * 1.5); g.drawImage(t, sx, sy, cw, ch, dst.x, dst.y, dst.w, dst.h);
    // grain: one speck = one px of a 4K frame, laid in the wall's own space (it moves with the camera, like the wall)
    g.save(); g.beginPath(); g.rect(dst.x, dst.y, dst.w, dst.h); g.clip();
    const pat = g.createPattern(this._grain(), 'repeat');
    pat.setTransform(new DOMMatrix().scale(0.5));
    g.globalAlpha = a0 * Math.min(1, alpha * 0.16); g.fillStyle = pat; g.fillRect(dst.x, dst.y, dst.w, dst.h);
    g.restore();
    g.globalAlpha = a0;
  }

  // ------------------------------------------------------------------------------------------------ ink plates

  _ink(name) {
    const K = this.ink[name];
    if (!K) warnOnce(`ink|${name}`, `[art] "${name}" has no ink plates - the three-ink silhouettes are: ${INK_NAMES.join(', ')}`);
    return K;
  }
  /** Where to draw bust `name` so that it registers with f_bust drawn into `base` (chin, flower and collar coincide). */
  fit(name, base) {
    const r = REGISTER[name];
    if (!r) return { ...base };
    const k = base.w / 1086;
    return { x: base.x + k * r[1], y: base.y + k * r[2], w: base.w * r[0], h: base.h * r[0] };
  }
  /** A plate as a Path2D in source px: 'all' (the whole figure), 'orange' (orange + black) or 'black'; exact = that ink alone. */
  inkPath(name, ink = 'all', exact = false) {
    const K = this._ink(name), k = ink === 'all' ? 0 : INK_KEY[ink] ?? 0;
    return K ? (exact ? K.exact : K.path)[k] : null;
  }
  /** Which ink is printed at (u, v) of the picture (0..1): 0 = none, 1 = cream, 2 = orange, 3 = black. */
  inkAt(name, u, v) {
    const K = this.ink[name];
    if (!K || u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
    return K.label[Math.floor(v * K.lh) * K.lw + Math.floor(u * K.lw)];
  }
  /**
   * ONE CONNECTED PATCH of one ink, as a Path2D in source px: everything that is printed in `ink` and hangs together
   * with the point `seed` ([x, y] in source px, or a region key such as 'palm'). A part of the figure (her open hand)
   * is cut out of the art this way and never with a hand-drawn polygon. grow = source px by which the patch is
   * widened (to take the soft edge with it). Built on first use from the label map (no pixels are read) and kept.
   */
  part(name, seed, { ink = 'cream', grow = 2 } = {}) {
    const K = this._ink(name);
    if (!K) return null;
    const key = `${typeof seed === 'string' ? seed : seed.join(',')}|${ink}|${grow}`;
    K.parts ??= {};
    if (K.parts[key]) return K.parts[key];
    const r = typeof seed === 'string' ? this.region(name, seed) : { x: seed[0], y: seed[1], w: 0, h: 0 };
    const { label, lw, lh } = K, want = (INK_KEY[ink] ?? 0) + 1, cover = new Uint8Array(lw * lh);
    const sx = clamp(Math.round((r.x + r.w / 2) / 2), 0, lw - 1), sy = clamp(Math.round((r.y + r.h / 2) / 2), 0, lh - 1);
    // the seed may sit on a line of another ink (a crease in the palm): start from the nearest cell of the wanted ink
    let start = -1;
    for (let rad = 0; rad < 24 && start < 0; rad++) for (let dy = -rad; dy <= rad && start < 0; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x >= 0 && y >= 0 && x < lw && y < lh && label[y * lw + x] === want) { start = y * lw + x; break; }
    }
    if (start >= 0) {
      const stack = [start];
      cover[start] = 255;
      while (stack.length) {
        const i = stack.pop(), x = i % lw;
        for (const j of [i - lw, i + lw, x > 0 ? i - 1 : -1, x < lw - 1 ? i + 1 : -1]) {
          if (j >= 0 && j < cover.length && !cover[j] && label[j] === want) { cover[j] = 255; stack.push(j); }
        }
      }
    }
    for (let n = Math.round(grow / 2); n > 0; n--) {                 // widen by one cell (2 source px) per pass
      const src = cover.slice();
      for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
        const i = y * lw + x;
        if (!src[i] && ((x > 0 && src[i - 1]) || (x < lw - 1 && src[i + 1]) || (y > 0 && src[i - lw]) || (y < lh - 1 && src[i + lw]))) cover[i] = 255;
      }
    }
    const half = smoothPath(outline(cover, lw, lh, { eps: 0.3, minArea: 6 }), new Path2D()), path = new Path2D();
    path.addPath(half, new DOMMatrix().scale(2));                    // the label map is at half the source resolution
    return (K.parts[key] = path);
  }
  /** Run fn with drawing clipped to such a patch of the figure as it would be drawn into dst (see part()). */
  partClip(ctx, name, dst, seed, fn, { ink = 'cream', grow = 2, crop = null, flip = false } = {}) {
    const K = this._ink(name), g = ctx.g, path = this.part(name, seed, { ink, grow });
    if (!K || !path) return;
    const c = crop ?? { x: 0, y: 0, w: K.w, h: K.h }, m = g.getTransform();
    g.save();
    this._onto(g, c, dst, flip);
    g.clip(path, 'evenodd');
    g.setTransform(m);
    fn();
    g.restore(); ctx._font = '';
  }

  /** The canvas transform that carries source px of `c` (a crop) onto `dst`. */
  _onto(g, c, dst, flip, dx = 0, dy = 0) {
    g.translate(dst.x + dx, dst.y + dy);
    if (flip) { g.translate(dst.w, 0); g.scale(-1, 1); }
    g.scale(dst.w / c.w, dst.h / c.h); g.translate(-c.x, -c.y);
  }
  /** Run fn with drawing clipped to one plate of the figure as it would be drawn into dst. */
  inkClip(ctx, name, dst, fn, { ink = 'all', exact = false, crop = null, flip = false } = {}) {
    const K = this._ink(name), g = ctx.g;
    if (!K) return;
    const c = crop ?? { x: 0, y: 0, w: K.w, h: K.h }, m = g.getTransform();
    g.save();
    this._onto(g, c, dst, flip);
    g.beginPath(); g.rect(c.x, c.y, c.w, c.h); g.clip();
    g.clip(this.inkPath(name, ink, exact), 'evenodd');
    g.setTransform(m);
    fn();
    g.restore(); ctx._font = '';
  }

  /**
   * The figure, printed from its ink plates.
   *
   *   roles    { cream, orange, black }: palette role (or '#rrggbb') each plate is printed in; null = that plate is not
   *            printed. Default text / me / panel. With the user's cream interface in the same frame give her cream
   *            plate 'sub' (cream is YOU). In `off` and `dead` the figure greys by itself; in `error` and `ash` `me`
   *            is still orange: name a grey or red role yourself.
   *   offset   { cream: [dx, dy], ... } misregistration per plate, virtual px
   *   reveal   { cream: k, ... } or one k for all: 0..1 of the plate printed, wiped top to bottom; or { k, dir } with
   *            dir 'down' | 'up' | 'right' | 'left'
   *   exact    true = every plate prints only its own ink (separations laid side by side). Default false: a plate runs
   *            under the plates printed above it, so registered plates never seam and a shifted plate shows the ink below.
   *   plates   instead of the three standard plates, a list in print order:
   *            [{ ink: 'all' | 'cream' | 'orange' | 'black', role, exact, offset: [dx, dy], alpha, reveal }]
   *            ('all' = the whole figure as one flat shape)
   *   keyline  { color, width, alpha }: a thin line round the whole figure, under the plates (the black ink is almost
   *            the page colour: every use needs paper, light or a line behind it)
   *   crop     source rect; flip = mirrored left to right; alpha = the whole figure
   *   vector   draw the plates as paths instead of bitmaps. Default: automatically above 1.75 x source size at 4K,
   *            where a bitmap would go soft (f_eye and f_reach close-ups).
   */
  inks(ctx, name, dst, { roles = {}, offset = {}, reveal = null, exact = false, plates = null, keyline = null, crop = null, flip = false, alpha = 1, vector = null } = {}) {
    const K = this._ink(name), g = ctx.g;
    if (!K || !(alpha > 0.003)) return;
    const c = crop ?? { x: 0, y: 0, w: K.w, h: K.h };
    const role = (k, d) => (roles[k] === undefined ? d : roles[k]), rv = (k) => (reveal != null && typeof reveal === 'object' && !('k' in reveal) ? reveal[k] : reveal);
    let list = plates;
    if (!list) {
      const rc = role('cream', 'text'), ro = role('orange', 'me'), rb = role('black', 'panel');
      list = [
        { ink: 'cream', role: rc, exact: exact || !ro || !rb, offset: offset.cream, reveal: rv('cream') },
        { ink: 'orange', role: ro, exact: exact || !rb, offset: offset.orange, reveal: rv('orange') },
        { ink: 'black', role: rb, exact: true, offset: offset.black, reveal: rv('black') },
      ];
    }
    list = list.filter((p) => p.role && (p.alpha ?? 1) > 0.003 && !(p.reveal != null && (p.reveal.k ?? p.reveal) <= 0));
    if (!list.length) return;
    const m = g.getTransform(), mag = (dst.w / c.w) * (Math.hypot(m.a, m.b) / ctx.scale) * 2;       // source magnification in a 4K frame
    const asPath = vector ?? mag > MAX_UNTREATED;
    const wipe = (p, r) => {                                         // the part of rect r a plate's reveal has reached
      const k = p.reveal == null ? 1 : clamp(p.reveal.k ?? p.reveal), dir = p.reveal?.dir ?? 'down';
      return k >= 1 ? r : dir === 'down' ? { ...r, h: r.h * k } : dir === 'up' ? { ...r, y: r.y + r.h * (1 - k), h: r.h * k } : dir === 'right' ? { ...r, w: r.w * k } : { ...r, x: r.x + r.w * (1 - k), w: r.w * k };
    };
    const a0 = g.globalAlpha;

    if (keyline) {
      g.save();
      this._onto(g, c, dst, flip);
      g.beginPath(); g.rect(c.x, c.y, c.w, c.h); g.clip();
      g.strokeStyle = ctx.col(keyline.color ?? 'line', 1); g.globalAlpha = a0 * alpha * (keyline.alpha ?? 1);
      g.lineWidth = (2 * (keyline.width ?? 2) * c.w) / dst.w; g.lineJoin = 'round';
      g.stroke(K.path[0]);
      g.restore();
    }

    if (asPath) {                                                    // paths: crisp at any size (a figure alpha < 1 is applied per plate)
      for (const p of list) {
        const k = p.ink === 'all' ? 0 : INK_KEY[p.ink], o = p.offset ?? [0, 0], w = wipe(p, dst);
        g.save();
        if (w !== dst) { g.beginPath(); g.rect(w.x + o[0], w.y + o[1], w.w, w.h); g.clip(); }
        this._onto(g, c, dst, flip, o[0], o[1]);
        if (crop) { g.beginPath(); g.rect(c.x, c.y, c.w, c.h); g.clip(); }
        g.fillStyle = ctx.col(p.role, 1); g.globalAlpha = a0 * alpha * (p.alpha ?? 1);
        g.fill((p.exact && p.ink !== 'all' ? K.exact : K.path)[k], 'evenodd');
        g.restore();
      }
      g.globalAlpha = a0; ctx._font = '';
      return;
    }

    // bitmaps: each plate is tinted in a scratch canvas at source size. A translucent figure is first assembled whole
    // (plates overlap: translucent plates laid one on another would not add up to the figure at that opacity).
    const sx = c.w / dst.w, sy = c.h / dst.h;
    const group = alpha < 0.999 && list.length > 1;
    let pad = 0, G = null, gg = null;
    if (group) {
      pad = Math.ceil(Math.max(0, ...list.map((p) => Math.max(Math.abs(p.offset?.[0] ?? 0) * sx, Math.abs(p.offset?.[1] ?? 0) * sy)))) + 1;
      G = this._tmp(this.tmpC, c.w + 2 * pad, c.h + 2 * pad); gg = G.getContext('2d');
      gg.setTransform(1, 0, 0, 1, 0, 0); gg.globalAlpha = 1; gg.globalCompositeOperation = 'source-over'; gg.clearRect(0, 0, G.width, G.height);
    }
    for (const p of list) {
      const k = p.ink === 'all' ? 0 : INK_KEY[p.ink], minus = p.exact && p.ink !== 'all' && k < 2 ? k + 1 : -1, o = p.offset ?? [0, 0];
      const t = this._tmp(this.tmpA, c.w, c.h), tg = t.getContext('2d');
      tg.globalCompositeOperation = 'copy'; tg.drawImage(K.mask[k], c.x, c.y, c.w, c.h, 0, 0, t.width, t.height);
      if (minus >= 0) { tg.globalCompositeOperation = 'destination-out'; tg.drawImage(K.mask[minus], c.x, c.y, c.w, c.h, 0, 0, t.width, t.height); }
      tg.globalCompositeOperation = 'source-in'; tg.fillStyle = ctx.col(p.role, 1); tg.fillRect(0, 0, t.width, t.height);
      const full = { x: 0, y: 0, w: t.width, h: t.height }, w = wipe(p, full);                     // the reveal, in the scratch canvas
      if (group) {
        gg.globalAlpha = p.alpha ?? 1;
        gg.drawImage(t, w.x, w.y, w.w, w.h, pad + o[0] * sx + w.x, pad + o[1] * sy + w.y, w.w, w.h);
      } else {
        g.save();
        g.translate(dst.x + o[0], dst.y + o[1]);
        if (flip) { g.translate(dst.w, 0); g.scale(-1, 1); }
        g.globalAlpha = a0 * alpha * (p.alpha ?? 1);
        g.drawImage(t, w.x, w.y, w.w, w.h, (w.x / t.width) * dst.w, (w.y / t.height) * dst.h, (w.w / t.width) * dst.w, (w.h / t.height) * dst.h);
        g.restore();
      }
    }
    if (group) {
      g.save();
      g.translate(dst.x, dst.y);
      if (flip) { g.translate(dst.w, 0); g.scale(-1, 1); }
      g.globalAlpha = a0 * alpha;
      g.drawImage(G, 0, 0, G.width, G.height, -pad / sx, -pad / sy, G.width / sx, G.height / sy);
      g.restore();
    }
    g.globalAlpha = a0; ctx._font = '';
  }

  _tmp(c, w, h) { const W = Math.max(2, Math.round(w)), H = Math.max(2, Math.round(h)); if (c.width !== W || c.height !== H) { c.width = W; c.height = H; } return c; }
}
