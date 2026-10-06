// Engine: owns the layer canvases, the post passes and the scene list.
// renderFrame(t) is the single entry point for BOTH preview and export. It is a pure
// function of t: no frame-to-frame state, no wall clock.
//
// Layers: two content layers (A = outgoing shot, B = incoming shot while their time
// ranges overlap) and one transparent overlay layer drawn on top of the transition.
import { rand, setSeed } from './prng.js';
import { Features } from './features.js';
import { Lyrics } from './lyrics.js';
import { Ctx } from './draw.js';
import { Post } from './post.js';
import { loadArt } from './art.js';
import { buildPalettes, mixPal } from './palette.js';
import { resolveTransition } from './transitions.js';
import { clamp } from './util.js';
import { buildScenes } from '../scenes/index.js';
import { prerollShot } from '../scenes/overlay.js';
import { sequence } from '../scenes/shot.js';

/** What the warning page before the song is set in: the mono face and the one CJK role of its Chinese line. */
const LEAD = { latin: ['mono'], cjk: ['tcSans'] };

/**
 * Load fonts before the first frame that uses them, so text never renders in a fallback face.
 * which = { latin: [mono | serif | sans ...], cjk: [role ...] }, or null for all of them.
 */
async function loadFonts(cfg, which = null) {
  const jobs = [], base = cfg.paths.fonts ?? 'node_modules/@fontsource';     // relative to the page (the site build has its own copy)
  for (const key of which?.latin ?? ['mono', 'serif', 'sans']) {
    const { family, pkg, weights, italic = [] } = cfg.fonts[key];
    const add = (w, style) => {
      const face = new FontFace(family, `url("${base}/${pkg}/files/${pkg}-latin-${w}-${style}.woff2")`, { weight: String(w), style });
      jobs.push(face.load().then((f) => { document.fonts.add(f); }));
    };
    weights.forEach((w) => add(w, 'normal'));
    italic.forEach((w) => add(w, 'italic'));
  }
  await Promise.all(jobs);
  // CJK faces ship as ~100 unicode-range slices each. Their stylesheet is read here, and only the slices that hold the
  // characters a role draws are loaded, as FontFace objects like the Latin files. (Linking the stylesheet and asking
  // document.fonts.load() does not work in Safari: it answers that no face was loaded.)
  await Promise.all((cfg.fonts.cjk || []).filter((c) => !which || which.cjk.includes(c.role)).map(async (c) => {
    const href = new URL(`${base}/${c.pkg}/${c.weight}.css`, location.href), r = await fetch(href);
    if (!r.ok) throw new Error(`font css failed: ${c.pkg} ${c.weight} (HTTP ${r.status})`);
    const left = new Set([...(c.text ?? '')].map((ch) => ch.codePointAt(0)).filter((cp) => cp > 32)), faces = [];
    for (const block of (await r.text()).match(/@font-face\s*{[^}]*}/g) ?? []) {
      const file = /url\(\s*['"]?([^'")]+\.woff2)/.exec(block)?.[1], ur = /unicode-range:\s*([^;}]+)/.exec(block)?.[1].trim();
      if (!file) continue;
      const spans = ur ? ur.split(',').map((s) => s.trim().replace(/^U\+/i, '').split('-').map((h) => parseInt(h, 16))).map(([a, b = a]) => [a, b]) : null;
      const holds = [...left].filter((cp) => !spans || spans.some(([a, b]) => cp >= a && cp <= b));
      if (!holds.length) continue;
      holds.forEach((cp) => left.delete(cp));
      faces.push(new FontFace(c.family, `url("${new URL(file, href).href}")`, { weight: String(c.weight), style: 'normal', ...(ur ? { unicodeRange: ur } : {}) }));
    }
    // no slice at all: the role would be set in a system font without any sign of it
    if (!faces.length) throw new Error(`no font face for ${c.role}: ${c.family} ${c.weight} does not cover its configured text`);
    if (left.size) console.warn(`[fonts] ${c.role}: no slice of ${c.family} ${c.weight} holds ${[...left].map((cp) => String.fromCodePoint(cp)).join('')}`);
    await Promise.all(faces.map((f) => f.load().then(() => document.fonts.add(f))));
  }));
}

// with the version tag of the site build, if any (see src/main.js)
const getJson = async (p) => { try { return await (await fetch(p.split('/').map(encodeURIComponent).join('/') + new URL(import.meta.url).search)).json(); } catch { return null; } };

/**
 * Resolves as soon as the warning page before the song can be drawn (its two fonts are in): that page is the
 * loading page. Everything else (the other fonts, the silhouettes, the sections) goes on loading behind it, and
 * `ready` resolves once the whole film can be drawn; until then renderFrame() only knows the warning page.
 * keepFrame: keep the picture after it is shown, for readPixels() later on (the exporter); the player does without.
 */
export async function createEngine({ canvas, width, height, cfg, featuresData, lyricsData, flipY = false, lab = null, keepFrame = true }) {
  setSeed(cfg.seed);
  const palettes = buildPalettes(cfg.palettes);
  const mk = (alpha) => new Ctx(document.createElement('canvas'), cfg, palettes, { alpha });
  const layerA = mk(false), layerB = mk(false), over = mk(true);
  const post = new Post(canvas, cfg, { keepFrame });

  const features = new Features(featuresData, cfg);
  const lyrics = new Lyrics(lyricsData, cfg, features);
  const lead = lab ? null : prerollShot({ cfg, lyrics });

  let content = [], overlays = [];
  /** Takes the shot list: in cut order (not by `start`: a lead-in may begin before the cut of the shot it follows), so
   *  of two live shots the later one is always the incoming one. */
  const use = (all) => {
    content = all.filter((s) => !s.overlay).sort((a, b) => (a.at ?? a.start) - (b.at ?? b.start));
    overlays = all.filter((s) => s.overlay).sort((a, b) => (a.z || 0) - (b.z || 0));
  };
  const rest = (async () => {
    const [, art, script, errors] = await Promise.all([loadFonts(cfg, lead ? { latin: ['serif', 'sans'], cjk: cfg.fonts.cjk.map((c) => c.role).filter((r) => !LEAD.cjk.includes(r)) } : null),
      loadArt(cfg), getJson(cfg.paths.script), getJson(cfg.paths.errors)]);
    // env: what every section file receives. art = character illustrations, script / errors = the written conversation.
    use(await buildScenes({ cfg, features, lyrics, art, script: script ?? {}, errors: errors ?? {} }, { lab }));
  })();
  rest.catch(() => {});                          // (reported through `ready`; this only keeps an early failure quiet)
  if (lead) {
    await loadFonts(cfg, LEAD);
    use(sequence([lead], 0));                    // the warning page alone, up to the song (it ends on a cut)
  } else await rest;

  function resize(w, h) {
    for (const l of [layerA, layerB, over]) { l.canvas.width = w; l.canvas.height = h; }
    post.resize(w, h);
  }
  resize(width, height);

  /** Per-frame post parameters; shots raise / override them (see README -> fx). */
  function defaultFx(f, t) {
    const c = cfg, started = f.t >= features.t0 ? 1 : 0;
    return {
      flash: 0, flashColor: null,                           // full-screen flash (capped by safety.maxFlash)
      glow: c.glow.base + c.glow.lowGain * f.lowEnv,        // bloom strength; only saturated colour blooms
      bloomAll: 0, bloomThreshold: 0.35,                    // v4 light: bright things bloom too (0..1), above this luminance
      rays: 0, raysAt: [960, 540],                          //   rays of whatever blooms, outwards from a point (virtual px)
      streak: 0,                                            //   a horizontal streak through whatever blooms
      zoomBlur: 0, zoomAt: [960, 540],                      //   the picture smeared towards a point, 0..1 (a push)
      zoom: 1 + c.post.zoomOnLow * f.lowEnv * started,      // low band breathes the whole frame, very slightly
      rot: 0, shake: [0, 0],                                // whole-frame camera
      aberration: c.post.aberration, rgbSplit: 0,           // radial / horizontal colour separation (px)
      glitch: 0, mosh: 0,                                   // torn rows / datamosh blocks
      mosaic: 0, mosaicRect: null,                          // cell size in px (0 = off), optional [x, y, w, h]
      invert: 0, desat: 0,                                  // 0..1
      scan: 1, vignette: 1,                                 // multipliers on the finish
      bright: 1 + c.post.flicker * f.high * (rand(7, Math.round(t * 60)) - 0.5) * 2,
      hud: 1,                                               // opacity of the overlay layer (warning toast, credits)
    };
  }

  const broken = new Set();
  function drawScene(layer, sc, tv, f) {
    layer.g.save();
    try {
      sc.render(layer, tv, f);
      layer.g.restore();
    } catch (e) {
      // one broken shot must not take the film (or a neighbour's contact sheet) down: report once, show a note
      if (!broken.has(sc.id)) { broken.add(sc.id); console.error(`[shot ${sc.id}] ${e.message}`); }
      layer.g.reset();
      layer.begin(tv, f, layer.videoTime, layer.fx);
      layer.clear();
      layer.text(`shot "${sc.id}" failed: ${e.message}`, 80, 540, { size: 28, font: 'mono', color: 'err' });
    }
  }

  /**
   * fx of a frame in which two shots overlap. Each shot wrote its own set (`a` = what the outgoing shot left,
   * `fx` = what the incoming one wrote, starting again from the defaults), and the frame gets their blend by
   * the progress k of the overlap: what the incoming shot asks for must not hit the whole frame while the
   * picture is still almost entirely the outgoing one. The flash is not blended: it stays the maximum over
   * both shots, as ctx.flash() left it.
   */
  function blendFx(fx, a, k) {
    // the mosaic rectangle cannot be blended: it is the one of the shot that has a mosaic (of the nearer one if both do);
    // likewise the points the rays and the zoom blur are centred on
    const of = (amt, at) => (!(fx[amt] > 0) ? a[at] : !(a[amt] > 0) || k >= 0.5 ? fx[at] : a[at]);
    const rect = of('mosaic', 'mosaicRect'), raysAt = of('rays', 'raysAt'), zoomAt = of('zoomBlur', 'zoomAt');
    for (const key in fx) {
      if (key !== 'flash' && typeof fx[key] === 'number' && typeof a[key] === 'number') fx[key] = a[key] + (fx[key] - a[key]) * k;
    }
    fx.shake = [0, 1].map((i) => { const va = a.shake?.[i] ?? 0; return va + ((fx.shake?.[i] ?? 0) - va) * k; });
    fx.mosaicRect = rect; fx.raysAt = raysAt; fx.zoomAt = zoomAt;
  }

  /** Render the frame for video time t (seconds). */
  function renderFrame(t) {
    const tv = t - cfg.timing.offset;            // global sync offset (see config.json)
    const f = features.sample(tv);
    const fx = defaultFx(f, t);

    // at most two content shots are live: A (outgoing) and B (incoming)
    const live = content.filter((s) => tv >= s.start && tv < s.end);
    const A = live.length > 1 ? live[live.length - 2] : live[0], B = live.length > 1 ? live[live.length - 1] : null;
    // a layer is set up (and cleared) only when something is drawn on it this frame: layer B only during an overlap,
    // the overlay layer only while an overlay scene shows anything (its visible(t), if it has one)
    const hud = overlays.filter((sc) => tv >= sc.start && tv < sc.end && (!sc.visible || sc.visible(tv)));
    for (const l of [layerA, B && layerB, hud.length && over]) if (l) { l.begin(tv, f, t, fx); l.statePal = null; }
    if (A) drawScene(layerA, A, tv, f); else { layerA.setPal('dead'); layerA.clear(); }
    // the palette a shot is IN (statePal, set by sequence()), not whatever a ctx.setPal() inside it left behind
    const palA = layerA.statePal ?? layerA.pal;
    let k = 0, pal = palA, palB = null, glowA = fx.glow, glowB = fx.glow;
    if (B) {
      const fxA = { ...fx };
      Object.assign(fx, defaultFx(f, t), { flash: fxA.flash, flashColor: fxA.flashColor });   // same object: the layers hold it
      drawScene(layerB, B, tv, f);
      k = clamp((tv - B.start) / Math.max(1e-6, A.end - B.start));
      palB = layerB.statePal ?? layerB.pal;
      pal = mixPal(palA, palB, k);
      glowA = fxA.glow; glowB = fx.glow;
      blendFx(fx, fxA, k);                       // (the overlay opacity `hud` follows the transition with the rest)
    }
    const tr = resolveTransition(B ? B.enter : null, k, pal);

    if (hud.length) {
      over.pal = pal; over.clear();
      for (const sc of hud) drawScene(over, sc, tv, f);
    }

    const n = (c) => c.map((v) => v / 255);
    // What the bloom has to know about each shot, because during an overlap every pixel still belongs to one of
    // them: its background (only what is brighter than it glows), its bloom tint, and how strongly it glows
    // (the palette's multiplier and the shot's own fx.glow).
    const feed = (p, fxGlow) => ({ bg: n(p.bg).map((v) => v * 1.03), tint: n(p.bloom), glow: p.glow, fxGlow });
    const look = {
      tint: n(pal.bloom), flashCol: n(fx.flashColor ?? pal.bloom), moshCol: n(pal.err), bg: n(pal.bg).map((v) => v * 1.03), glow: pal.glow,
      a: feed(palA, glowA), b: B ? feed(palB, glowB) : null,
    };
    post.render({ a: layerA.canvas, b: B ? layerB.canvas : null, hud: hud.length ? over.canvas : null }, tr, fx, look, Math.round(t * 60), flipY);
  }

  return {
    renderFrame, resize, features, lyrics, palettes, post,
    /** Resolves once the whole film can be drawn (rejects if it cannot). */
    ready: rest,
    get scenes() { return [...content, ...overlays]; },
    duration: features.duration,
    /** The film starts this many seconds BEFORE the song (the warning page); t in renderFrame(t) is song time. */
    preroll: lab ? 0 : cfg.safety.preroll ?? 0,
    readPixels: (buf) => post.readPixels(buf),
    rendererInfo: () => post.rendererInfo(),
    activeScenes: (t) => content.filter((s) => t >= s.start && t < s.end).map((s) => s.id),
    shotAt: (t) => content.filter((s) => t >= s.start && t < s.end).pop() ?? null,
  };
}
