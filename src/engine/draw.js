// Drawing context handed to scenes. Scenes draw on a 2D canvas in a fixed virtual
// 1920x1080 coordinate space; the engine scales it to the real output size and the
// WebGL passes (post.js) add transitions, selective bloom and the finish on top.
//
// One Ctx exists per layer: two content layers (outgoing / incoming shot during a
// transition) and one transparent overlay layer. All layers share the same per-frame `fx`.
//
// v3 look: matte surfaces, hairlines, soft shadows; glow only where asked for (ctx.glow,
// or simply by using a saturated colour: the bloom pass ignores cream and grey).
import { mixPal, parseHex } from './palette.js';
import { SAFE, VH, VW, split } from './layout.js';

export { VW, VH };

/** Legacy rect names used by the split composition. */
const SPLIT = split();
export const LAYOUT = { top: 64, bottom: 1016, pad: 56, log: SPLIT.log, stage: SPLIT.stage, full: SAFE };

const literal = new Map();
const measured = new Map();
const flagged = new Set();
/** console.error, once per key (a frame is drawn many times over; one line per mistake is enough). */
function reportOnce(key, msg) {
  if (flagged.has(key)) return;
  flagged.add(key);
  console.error(msg);
}
/**
 * What the Latin subsets of the bundled fonts contain (see ctx.text), read from the cmap of the fifteen woff2
 * files loadFonts() names. In every one of them: ASCII, Latin-1 from the no-break space up (without the soft
 * hyphen), ı Œ œ ʼ ˆ ˚ ˜, seven combining accents, and – — ‘ ’ ‚ “ ” „ • … ′ ″ ‹ › ⁄ € ™ ↑ ↓ −. That is ALL of
 * general punctuation: no other dash, space or mark from U+2000-206F. Tab and line breaks pass because the
 * canvas draws them as spaces.
 */
const LATIN = '\\t\\n\\f\\r -~\\u00a0-\\u00ac\\u00ae-\\u00ff\\u0131\\u0152\\u0153\\u02bc\\u02c6\\u02da\\u02dc\\u0300\\u0301\\u0303\\u0304\\u0308\\u0309\\u0323'
  + '\\u2013\\u2014\\u2018-\\u201a\\u201c-\\u201e\\u2022\\u2026\\u2032\\u2033\\u2039\\u203a\\u2044\\u20ac\\u2122\\u2191\\u2193\\u2212';
/** Per type role: characters NOT in its files (the common set, plus the few code points only that family has). */
const OUTSIDE = {
  mono: new RegExp(`[^${LATIN}\\u00ad\\u0102\\u2215\\ufeff]`),
  serif: new RegExp(`[^${LATIN}\\u00ad\\u02bb\\u0329\\u2002\\u2009\\u200b\\u2215]`),
  sans: new RegExp(`[^${LATIN}\\u02bb\\u2002\\u2009\\u200b\\ufeff]`),
};
const unknownColour = (name) => reportOnce(`col|${name}`, `[palette] unknown colour "${name}" - use a role (text, sub, me, err, ...) or '#rgb' / '#rrggbb'`);
const codePoints = (chars) => [...new Set(chars)].map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

export class Ctx {
  constructor(canvas, cfg, palettes, { alpha = false } = {}) {
    this.canvas = canvas;
    // video.exactRaster = true draws the 2D layers with Chrome's CPU rasteriser instead of the GPU one
    // (slower; only useful for debugging raster differences - both were measured to be repeatable).
    this.g = canvas.getContext('2d', { alpha, willReadFrequently: !!cfg.video.exactRaster });
    // Safari before 18 has no reset(): giving the canvas its width again does the same (state back to defaults, bitmap cleared)
    if (!this.g.reset) this.g.reset = () => { canvas.width = canvas.width; };
    this.transparent = alpha;
    this.cfg = cfg;
    this.palettes = palettes;
    this.W = VW; this.H = VH;
    this.L = LAYOUT;
    // type roles: mono = system / code, serif = the AI's voice, sans = interface and the user
    this.fonts = { mono: cfg.fonts.mono.family, serif: cfg.fonts.serif.family, sans: cfg.fonts.sans.family };
    this.cjk = {};                                           // CJK role -> the only characters preloaded for it
    for (const c of cfg.fonts.cjk || []) { this.fonts[c.role] = c.family; this.cjk[c.role] = c.text ?? ''; }
    this._font = ''; this._canon = '';
    this.pal = palettes.off ?? Object.values(palettes)[0];
  }

  /**
   * Called by the engine at the start of every frame for every layer, before anything is drawn on it.
   * g.reset() puts every piece of canvas state back to its default, including what no assignment can undo:
   * a clip or an unbalanced save() left behind by the previous frame. It CLEARS THE BITMAP as well, so begin()
   * must never run on a layer that already holds part of the current frame (the overlay layer is shared by
   * all overlay scenes: once per frame, not once per scene).
   */
  begin(t, f, videoTime, fx) {
    const g = this.g, s = this.canvas.width / VW;
    this.t = t; this.f = f; this.videoTime = videoTime; this.scale = s; this.fx = fx;
    g.reset();
    g.setTransform(s, 0, 0, s, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.imageSmoothingQuality = 'high';                        // one setting for the whole frame, whoever draws first
    this._font = '';
  }

  // ---- palette ---------------------------------------------------------------------
  /** spec: 'name' | palette object | ['a', 'b', k] (blend). An unknown name is reported once and gives 'on'. */
  resolvePal(spec) {
    if (typeof spec === 'string') {
      const p = this.palettes[spec];
      // never the layer's current palette: that is whatever the previous frame left, so a typo would look
      // different when scrubbing and when exporting
      if (!p) reportOnce(`pal|${spec}`, `[palette] unknown palette "${spec}" - using 'on' (there are: ${Object.keys(this.palettes).join(', ')})`);
      return p ?? this.palettes.on ?? this.pal;
    }
    if (Array.isArray(spec)) return mixPal(this.resolvePal(spec[0]), this.resolvePal(spec[1]), spec[2] >= 0 ? Math.min(1, spec[2]) : 0);   // NaN -> 0
    return spec ?? this.pal;
  }
  setPal(spec) { this.pal = this.resolvePal(spec); return this.pal; }
  /** Draw something in another palette, then restore. */
  withPal(spec, fn) { const keep = this.pal; this.setPal(spec); fn(); this.pal = keep; }

  /**
   * rgba() string for a palette role ('text', 'me', 'err', ...) or a '#rgb' / '#rrggbb' literal.
   * null / undefined = no colour (transparent). Anything else is reported once and drawn in cream.
   */
  col(name, a = 1) {
    a = a >= 0 ? +a : 0;                                   // NaN (a 0 / 0 progress) or negative: draw nothing. The canvas would
    let c = this.pal[name];                                // reject the string and keep the previous colour at full strength
    if (!Array.isArray(c)) {
      if (name == null) return 'rgba(0,0,0,0)';
      c = literal.get(name);
      if (!c) { c = name[0] === '#' ? parseHex(name) : null; if (c) literal.set(name, c); }
      if (!c) { unknownColour(name); c = this.pal.text; }  // unknown role: never cache, fall back to cream
    }
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  }

  /** Fill the layer with the palette background (content) or clear it (overlay). */
  clear() {
    const g = this.g, s = this.scale;
    g.setTransform(s, 0, 0, s, 0, 0);
    if (this.transparent) g.clearRect(0, 0, VW, VH);
    else { g.fillStyle = this.col('bg'); g.fillRect(0, 0, VW, VH); }
  }

  // ---- virtual camera (acts on everything drawn afterwards on this layer) ------------
  /** x/y = pan in virtual px (camera moves right/down), zoom about screen centre, rot in radians. */
  camera({ x = 0, y = 0, zoom = 1, rot = 0 } = {}) {
    const g = this.g, s = this.scale;
    g.setTransform(s, 0, 0, s, 0, 0);
    g.translate(VW / 2, VH / 2);
    if (rot) g.rotate(rot);
    g.scale(zoom, zoom);
    g.translate(-VW / 2 - x, -VH / 2 - y);
  }
  /** Frame a rectangle of the scene: returns camera params that make `r` fill the screen (plus margin). */
  frame(r, margin = 0) {
    const zoom = Math.min(VW / (r.w + 2 * margin), VH / (r.h + 2 * margin));
    return { x: r.x + r.w / 2 - VW / 2, y: r.y + r.h / 2 - VH / 2, zoom };
  }

  /** Raise the flash for this frame (optionally coloured by a palette role / literal; otherwise the palette's bloom colour). */
  flash(v, color = null) {
    if (v > this.fx.flash) {
      this.fx.flash = v;
      this.fx.flashColor = color ? (Array.isArray(this.pal[color]) ? this.pal[color] : parseHex(color)) : null;
      if (color && !this.fx.flashColor) unknownColour(color);
    }
  }

  // ---- text ------------------------------------------------------------------------
  /** family: 'mono' | 'serif' | 'sans' | 'krSerif' | 'krSans' | 'tcSerif' | 'tcSans' */
  font(size, weight = 400, family = 'sans', italic = false) {
    const s = `${italic ? 'italic ' : ''}${weight} ${size}px "${this.fonts[family] ?? this.fonts.sans}"`;
    // The cache is checked against the canvas itself (_canon = what it reported right after the assignment), so a
    // raw g.restore() or g.reset() anywhere cannot leave it stale: nobody has to clear ctx._font by hand.
    if (s !== this._font || this.g.font !== this._canon) { this.g.font = s; this._font = s; this._canon = this.g.font; }
  }
  /** Monospace advance width for a font size (JetBrains Mono = 0.6 em). */
  cw(size) { return size * 0.6; }
  /** Rendered width of a string. */
  measure(str, { size = 24, weight = 400, font = 'sans', spacing = 0, italic = false } = {}) {
    if (font === 'mono') return str.length * (size * 0.6 + spacing);
    const key = `${font}|${weight}|${italic ? 1 : 0}|${str}`;
    let w100 = measured.get(key);
    if (w100 === undefined) {
      this.font(100, weight, font, italic);
      this.g.letterSpacing = '0px';
      w100 = this.g.measureText(str).width;
      measured.set(key, w100);
    }
    return (w100 * size) / 100 + str.length * spacing;
  }
  /**
   * Largest size at which `str` fits into maxW (capped at maxSize).
   * NOTE the defaults: serif 700 (a headline), NOT the sans 400 of text() and measure(). Pass the same
   * font / weight / italic you will draw with, and spacingEm = letter spacing as a share of the size.
   */
  fit(str, maxW, { font = 'serif', weight = 700, spacingEm = 0, maxSize = 2000, italic = false } = {}) {
    const w100 = this.measure(str, { size: 100, weight, font, spacing: spacingEm * 100, italic });
    return Math.min(maxSize, (maxW / w100) * 100);
  }
  /** Greedy word wrap. Returns the lines for `str` at the given style and width. */
  wrap(str, maxW, opts = {}) {
    const out = [];
    for (const para of String(str).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && this.measure(next, opts) > maxW) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  text(str, x, y, { size = 24, weight = 400, color = 'text', alpha = 1, align = 'left', spacing = 0, font = 'sans', stroke = 0, italic = false } = {}) {
    if (!(alpha > 0.003) || !str) return;
    // The bundled Latin faces only contain Latin-1 and a handful of punctuation marks and signs (LATIN above); a CJK
    // role has only the slices for its own configured string preloaded. Anything else would silently fall back to a
    // system font (different on every machine) or pop in a few frames late, so it is reported instead.
    const own = this.cjk[font];
    if (own !== undefined) {
      const bad = [...String(str)].filter((ch) => !own.includes(ch));
      if (bad.length) reportOnce(`${font}|${str}`, `[text] glyph outside the preloaded text of '${font}' in "${str}" - only "${own}" is loaded for it (config.json fonts.cjk); use a Latin role for the rest (${codePoints(bad)})`);
    } else {
      const out = OUTSIDE[font] ?? OUTSIDE.sans;
      if (out.test(str)) reportOnce(`${font}|${str}`, `[text] glyph outside the bundled fonts in "${str}" - draw it as a shape or use plain characters (${codePoints([...String(str)].filter((ch) => out.test(ch)))} in ${font})`);
    }
    const g = this.g;
    this.font(size, weight, font, italic);
    g.letterSpacing = `${spacing}px`;
    g.textAlign = align;
    if (stroke > 0) { g.strokeStyle = this.col(color, Math.min(1, alpha)); g.lineWidth = stroke; g.strokeText(str, x, y); }
    else { g.fillStyle = this.col(color, Math.min(1, alpha)); g.fillText(str, x, y); }
    g.letterSpacing = '0px';
  }

  // ---- primitives ------------------------------------------------------------------
  line(x1, y1, x2, y2, { color = 'text', alpha = 1, width = 2 } = {}) {
    if (!(alpha > 0.003)) return;
    const g = this.g;
    g.strokeStyle = this.col(color, Math.min(1, alpha)); g.lineWidth = width;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }

  poly(pts, { color = 'text', alpha = 1, width = 2, close = false, fill = false } = {}) {
    if (!(alpha > 0.003) || pts.length < 2) return;
    const g = this.g;
    g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    if (close) g.closePath();
    if (fill) { g.fillStyle = this.col(color, Math.min(1, alpha)); g.fill(); }
    else { g.strokeStyle = this.col(color, Math.min(1, alpha)); g.lineWidth = width; g.stroke(); }
  }

  rect(x, y, w, h, { color = 'text', alpha = 1, width = 2, fill = false } = {}) {
    if (!(alpha > 0.003)) return;
    const g = this.g;
    if (fill) { g.fillStyle = this.col(color, Math.min(1, alpha)); g.fillRect(x, y, w, h); }
    else { g.strokeStyle = this.col(color, Math.min(1, alpha)); g.lineWidth = width; g.strokeRect(x, y, w, h); }
  }

  /**
   * Rounded rectangle: the basic surface of the interface.
   * fill / stroke are palette roles (or null); shadow = soft drop shadow strength 0..1 (elevation).
   * Inside ctx.glow() one rrect casts one halo: the fill casts it (or its own drop shadow, if `shadow` is set)
   * and the outline is then drawn without; an outline with no fill casts it itself. The halo is put back
   * afterwards, so whatever is drawn next inside the same glow still gets it.
   */
  rrect(x, y, w, h, r, { fill = 'raised', stroke = null, alpha = 1, width = 1.5, fillAlpha = 1, strokeAlpha = 1, shadow = 0 } = {}) {
    if (!(alpha > 0.003) || w <= 0 || h <= 0) return;
    const g = this.g, rr = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath(); g.roundRect(x, y, w, h, rr);
    if (!fill) {
      if (stroke) { g.strokeStyle = this.col(stroke, Math.min(1, alpha * strokeAlpha)); g.lineWidth = width; g.stroke(); }
      return;
    }
    const sc = g.shadowColor, sb = g.shadowBlur, sy = g.shadowOffsetY;      // a surrounding ctx.glow(), or none
    if (shadow > 0) { g.shadowColor = `rgba(0,0,0,${0.5 * shadow * alpha})`; g.shadowBlur = 44 * shadow * this.scale; g.shadowOffsetY = 14 * shadow * this.scale; }
    g.fillStyle = this.col(fill, Math.min(1, alpha * fillAlpha)); g.fill();
    if (stroke) {
      g.shadowColor = 'rgba(0,0,0,0)';
      g.strokeStyle = this.col(stroke, Math.min(1, alpha * strokeAlpha)); g.lineWidth = width; g.stroke();
    }
    g.shadowColor = sc; g.shadowBlur = sb; g.shadowOffsetY = sy;
  }

  circle(x, y, r, { color = 'text', alpha = 1, width = 2, fill = false, a0 = 0, a1 = Math.PI * 2 } = {}) {
    if (!(alpha > 0.003) || r <= 0) return;
    const g = this.g;
    g.beginPath(); g.arc(x, y, r, a0, a1);
    if (fill) { g.fillStyle = this.col(color, Math.min(1, alpha)); g.fill(); }
    else { g.strokeStyle = this.col(color, Math.min(1, alpha)); g.lineWidth = width; g.stroke(); }
  }

  /** Linear gradient fill of a rect. stops: [[position 0..1, role, alpha], ...]; dir 'v' or 'h'. */
  gradRect(x, y, w, h, stops, dir = 'v') {
    const g = this.g, gr = dir === 'v' ? g.createLinearGradient(0, y, 0, y + h) : g.createLinearGradient(x, 0, x + w, 0);
    for (const [p, role, a] of stops) gr.addColorStop(p, this.col(role, a));
    g.fillStyle = gr; g.fillRect(x, y, w, h);
  }
  /** Soft radial light (or shade) centred on (x, y): a cheap way to give a flat surface depth. */
  radial(x, y, r, role, alpha) {
    const g = this.g, gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, this.col(role, alpha)); gr.addColorStop(1, this.col(role, 0));
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  /**
   * LOCAL glow: whatever fn draws gets a soft halo in `color`: every shape, every text, every helper it calls
   * (an rrect casts it once, see there). This is the only glow matte UI elements get (the global bloom only
   * reacts to saturated colour). radius in virtual px of the 1920 frame: it does not grow with ctx.camera()
   * zoom or ctx.at() scale. Calls nest: when an inner glow ends the outer one is back.
   */
  glow(color, radius, fn, alpha = 1) {
    const g = this.g, sc = g.shadowColor, sb = g.shadowBlur;
    g.shadowColor = this.col(color, alpha); g.shadowBlur = radius * this.scale;
    fn();
    g.shadowColor = sc; g.shadowBlur = sb;
  }

  /** Corner brackets around a rect. k = 0..1 draw-in progress. */
  brackets(r, { len = 22, color = 'mute', alpha = 1, width = 2, k = 1 } = {}) {
    const l = len * k, { x, y, w, h } = r, o = { color, alpha, width };
    this.poly([[x, y + l], [x, y], [x + l, y]], o);
    this.poly([[x + w - l, y], [x + w, y], [x + w, y + l]], o);
    this.poly([[x + w, y + h - l], [x + w, y + h], [x + w - l, y + h]], o);
    this.poly([[x + l, y + h], [x, y + h], [x, y + h - l]], o);
  }

  /** Run fn with drawing clipped to a rect (optionally rounded). */
  clip(r, fn, radius = 0) {
    const g = this.g;
    g.save(); g.beginPath();
    if (radius > 0) g.roundRect(r.x, r.y, r.w, r.h, radius); else g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    fn();
    g.restore(); this._font = '';
  }
  /**
   * Run fn clipped to an arbitrary closed outline (list of [x, y]). rule = canvas fill rule, 'nonzero' or
   * 'evenodd': it only matters where the outline crosses itself (pass 'evenodd' to agree with shapes.js inPoly).
   */
  clipPath(pts, fn, rule = 'nonzero') {
    const g = this.g;
    g.save(); g.beginPath();
    if (pts.length) g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath(); g.clip(rule);
    fn();
    g.restore(); this._font = '';
  }

  /**
   * v4: draw `content` only where `mask` paints: type, or any shapes, as WINDOWS onto a picture.
   * Both callbacks draw with the ordinary ctx calls, in the transform that is current here; of what the mask draws
   * only the coverage matters (several shapes = their union). Two scratch canvases of the layer's size are kept for
   * this; nothing is read back.
   */
  masked(content, mask) {
    const main = this.g, W = this.canvas.width, H = this.canvas.height, m = main.getTransform();
    this._scr ??= [0, 1].map(() => { const c = document.createElement('canvas'); return { c, g: c.getContext('2d') }; });
    const [A, B] = this._scr;
    for (const s of [A, B]) {
      if (s.c.width !== W || s.c.height !== H) { s.c.width = W; s.c.height = H; }
      s.g.setTransform(1, 0, 0, 1, 0, 0); s.g.globalCompositeOperation = 'source-over'; s.g.globalAlpha = 1; s.g.clearRect(0, 0, W, H);
      s.g.setTransform(m); s.g.lineCap = 'round'; s.g.lineJoin = 'round'; s.g.imageSmoothingQuality = 'high';
    }
    try {
      this.g = A.g; this._font = ''; content();
      this.g = B.g; this._font = ''; mask();
    } finally { this.g = main; this._font = ''; }
    A.g.setTransform(1, 0, 0, 1, 0, 0); A.g.globalCompositeOperation = 'destination-in'; A.g.globalAlpha = 1; A.g.drawImage(B.c, 0, 0);
    main.save(); main.setTransform(1, 0, 0, 1, 0, 0); main.drawImage(A.c, 0, 0); main.restore();
  }

  /** Run fn inside a local transform: move origin to (x, y), rotate, scale. */
  at(x, y, fn, { rot = 0, scale = 1, sx = scale, sy = scale, alpha = 1 } = {}) {
    const g = this.g;
    g.save(); g.translate(x, y);
    if (rot) g.rotate(rot);
    if (sx !== 1 || sy !== 1) g.scale(sx, sy);
    if (alpha !== 1) g.globalAlpha *= alpha >= 0 ? alpha : 0;   // NaN / negative: the canvas would ignore it = full strength
    fn();
    g.restore(); this._font = '';
  }

  /**
   * Motion blur by ghost samples: calls fn(tau, weight) for n past instants (tau seconds ago),
   * oldest first, with globalAlpha set so the newest is strongest. Use for anything that moves fast:
   *   ctx.trail(5, 0.012, (tau) => drawThing(posAt(t - tau)))
   */
  trail(n, dt, fn, strength = 0.5) {
    const g = this.g;
    for (let i = n; i >= 0; i--) {
      const w = i === 0 ? 1 : strength * (1 - i / (n + 1));
      g.save(); g.globalAlpha *= w;
      fn(i * dt, w);
      g.restore(); this._font = '';
    }
  }
}
