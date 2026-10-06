// Page entry. One page, two modes sharing the same engine:
//   player (default): the film fills the window and plays by itself, on a loop. t is SONG time: the film starts at
//                     -safety.preroll with the warning page, which is also the loading page (the engine can draw it
//                     before the rest has loaded); after the end, the warning page comes again
//   export (?mode=export&w=..&h=..): no UI; Node drives window.__mv frame by frame
import { createEngine } from './engine/engine.js';

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
// relative to the page, so it works from any folder of a site (GitHub Pages serves it under /<repository>/)
const urlOf = (p) => p.split('/').map(encodeURIComponent).join('/');
// the site build tags every module with its version (src/main.js?v=...): the data is asked for with the same tag, so a
// browser never mixes a new page with old cached data (or the other way round)
const VERSION = new URL(import.meta.url).search;
const getJson = async (p) => {
  const r = await fetch(urlOf(p) + VERSION);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
const isExport = qs.get('mode') === 'export';
const fail = (e) => { if (!isExport) { $('error').textContent = `could not start: ${e.message}`; $('error').hidden = false; } };

// ---- render size (player): never more pixels than the picture has on screen, and fewer when frames are missed ------
// 16:9 steps, largest first. 1920 is the film's own (virtual) size; 4K is for exports only.
const LADDER = [1920, 1600, 1280, 1120, 960, 800, 640];
const sizeOf = (i) => [LADDER[i], (LADDER[i] * 9) / 16];
/** Index of the smallest step that still has a pixel for every device pixel of the picture as it is shown. */
function fitLevel() {
  const px = Math.max(1, $('view').getBoundingClientRect().width) * (devicePixelRatio || 1);
  let i = 0;
  while (i + 1 < LADDER.length && LADDER[i + 1] >= px) i++;
  return i;
}

let cfg, engine, width, height;
const fixedSize = isExport || qs.has('w');       // ?w=..&h=.. pins the render size (no adaptation)
let level = fixedSize ? -1 : fitLevel();
try {
  cfg = await getJson('config.json');
  if (!isExport && cfg.player?.sound) $('audio').src = urlOf(cfg.paths.audio);   // starts buffering while the rest loads
  const [featuresData, lyricsData] = await Promise.all([getJson(cfg.paths.features), getJson(cfg.paths.lyrics)]);
  [width, height] = fixedSize ? [+qs.get('w') || cfg.video.previewWidth, +qs.get('h') || cfg.video.previewHeight] : sizeOf(level);
  // ?lab=<set> renders the check cards of src/scenes/lab.js instead of the film (node export/export.mjs --lab <set> --sheet ...)
  engine = await createEngine({
    canvas: $('view'), width, height, cfg, featuresData, lyricsData, flipY: isExport, lab: qs.get('lab'),
    keepFrame: isExport,                         // only the exporter reads the picture back
  });
  if (isExport) await engine.ready;
} catch (e) { fail(e); throw e; }

if (isExport) setupExport(); else setupPlayer();

// ---------------------------------------------------------------------------------
function setupExport() {
  document.body.classList.add('export');
  const buf = new Uint8Array(width * height * 4);
  // One WebSocket carries all frames; the Node side acks each frame once ffmpeg has consumed it.
  const ws = new WebSocket(`ws://${location.host}/__frames`);
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('frame socket failed')); });
  const send = (data) => new Promise((res, rej) => {
    ws.onmessage = res;
    ws.onclose = () => rej(new Error('frame socket closed'));
    ws.send(data);
  });
  window.__mv = {
    ready: true,
    duration: engine.duration,
    renderer: engine.rendererInfo(),
    /** Render stills at arbitrary times (QA contact sheets). */
    async exportTimes(times) {
      await opened;
      for (const t of times) { engine.renderFrame(t); engine.readPixels(buf); await send(buf); }
      return times.length;
    },
    /** Render frames [from, to) at `fps` and send each one (raw RGBA) to the Node side, in order. */
    async exportRange(from, to, fps) {
      await opened;
      const ms = { render: 0, read: 0, send: 0 };       // profiling only; never affects the frames
      for (let i = from; i < to; i++) {
        const a = performance.now();
        engine.renderFrame(i / fps);
        const b = performance.now();
        engine.readPixels(buf);
        const c = performance.now();
        await send(buf);
        ms.render += b - a; ms.read += c - b; ms.send += performance.now() - c;
      }
      for (const k in ms) ms[k] = +(ms[k] / (to - from)).toFixed(1);
      return ms;
    },
  };
}

// ---------------------------------------------------------------------------------
function setupPlayer() {
  const audio = $('audio');
  const PRE = engine.preroll, D = engine.duration, PASS = D + PRE;
  // song time of the first sample of the audio file (config.json -> timing.audioStart): 0 for the song itself, -PRE for
  // the sound track of an exported film, which also covers the warning page
  const A0 = cfg.timing.audioStart ?? 0;
  // The warning page is the loading page: its countdown (from 3 s before the song) waits until the film has loaded.
  const HOLD = Math.max(-PRE, -3);
  /** Song time folded into one pass of the film (-PRE … D). */
  const fold = (v) => -PRE + ((((v + PRE) % PASS) + PASS) % PASS);

  // ---- clock -------------------------------------------------------------------
  // Before the song (the warning page), and whenever there is no sound, the film runs on the wall clock, silently;
  // while the song sounds (config.json -> player.sound), the <audio> element is the clock.
  // The sound starts only once the film has loaded (the warning page may still wait for it).
  //   wall   { t0, at }   on the wall clock: song time t0 at performance.now() === at;  null = on the audio clock
  //   sound  'ok'        the song is played whenever the film is inside it
  //          'muted'     the browser lets it sound only after a tap, click or key: until then it plays muted (that is
  //                      allowed everywhere) and is the clock all the same; the first tap, click or key unmutes it
  //          'locked'    not even muted: the picture goes on alone until the first tap, click or key
  //          'stalled'   it did not advance: the film went on without it; tried again on the next pass
  //          'none'      off in config.json, no file, or one this browser cannot play
  //   want   song time the sound was started at: the picture holds there until the sound has got there
  //   heard  { t, at }   the last time the audio clock was seen to move
  //   smooth { t, at, seen, moving }   the audio clock between its own (coarse) steps
  let wall = { t0: -PRE, at: performance.now() };
  let sound = cfg.player?.sound ? 'ok' : 'none', want = null, heard = { t: -1, at: 0 }, smooth = null, last = wall.t0, loaded = false;
  engine.ready.then(() => {
    loaded = true;
    if (qs.has('t')) wall = { t0: fold(+qs.get('t') || 0), at: performance.now() };   // ?t=12.5: start there (song time)
  }, (e) => { fail(e); console.error(e); });

  // ---- the first pass waits at the end of the countdown --------------------------------------------------------
  // A command line under it, `$ run` and a cursor: Enter (or a click / tap anywhere) runs the film. The press is what
  // lets every browser start the sound, so nothing sounds before it. Later passes go straight on.
  const GATE = PRE >= 1 ? -0.85 : null;                   // the last digit of the countdown is up; the page is not fading yet
  let ran = GATE === null || qs.has('t'), gated = false;
  // Made here, not in index.html, so that a page and a script of two different versions (one of them still in the
  // browser's cache) cannot leave it out. Set like the warning page's lines (src/scenes/overlay.js: x 300, the line
  // under the countdown, 44 px mono, in the greys of the `off` palette), in pixels of the 1920 px picture as shown.
  const style = document.createElement('style');
  style.textContent = `
    #prompt { position: fixed; z-index: 1; white-space: pre; font: 400 44px/1.2 "JetBrains Mono", monospace; color: #aaa89f;
      cursor: pointer; opacity: 0; transition: opacity 0.3s; }
    #prompt.show { opacity: 1; }
    #prompt.done { opacity: 0; transition: opacity 0.35s 0.1s; }
    #prompt .ps, #prompt .note { color: #6f6e67; }
    #prompt .note { opacity: 0; transition: opacity 0.4s; }
    #prompt.typed .note { opacity: 1; }
    #prompt .cur { display: inline-block; width: 0.6em; height: 1.1em; vertical-align: -0.22em; background: #d2d0c8; animation: prompt-blink 1.06s steps(1) infinite; }
    #prompt.done .cur { visibility: hidden; }
    @keyframes prompt-blink { 50% { opacity: 0; } }`;
  const prompt = document.createElement('div');
  prompt.id = 'prompt'; prompt.hidden = true;
  prompt.innerHTML = '<span class="ps">$ </span><span class="cmd"></span><span class="cur"></span><span class="note"></span>';
  document.head.append(style); document.body.append(prompt);
  const place = () => {
    const r = $('view').getBoundingClientRect(), k = r.width / 1920;
    Object.assign(prompt.style, { left: `${r.left + 300 * k}px`, top: `${r.top + 895 * k}px`, fontSize: `${44 * k}px` });
  };
  window.addEventListener('resize', place);
  function showPrompt() {
    gated = true; place(); prompt.hidden = false; document.body.classList.remove('idle');
    prompt.querySelector('.note').textContent = matchMedia('(hover: none)').matches ? '   # tap to run' : '   # press enter';
    requestAnimationFrame(() => prompt.classList.add('show'));
    const cmd = prompt.querySelector('.cmd'), word = 'run';
    let i = 0;
    const id = setInterval(() => { cmd.textContent = word.slice(0, ++i); if (i >= word.length) { clearInterval(id); prompt.classList.add('typed'); } }, 110);
  }
  function run() {
    if (ran) return;
    ran = true; prompt.classList.add('done'); setTimeout(() => { prompt.hidden = true; }, 600);
    wake();                                                  // inside the press: full screen, and the sound starts
  }

  /** Go on with the picture alone from song time t. */
  function fallBack(why, t) {
    sound = why; wall = { t0: t, at: performance.now() }; smooth = null; want = null;
    if (!audio.paused) audio.pause();
    audio.muted = false;
  }
  /** Start the sound at song time t (>= A0). Until it is there and moves, the picture holds; if it will not start, the picture goes on without it. */
  function start(t) {
    wall = null; smooth = null; heard = { t: -1, at: performance.now() }; want = t;
    // a seek before the browser knows the file is lost (iOS loads nothing until playback is asked for): audioTime()
    // seeks again once it can
    if (audio.readyState >= 1 && Math.abs(audio.currentTime - (t - A0)) > 0.02) audio.currentTime = t - A0;
    play();
  }
  function play() {
    audio.play().catch((e) => {
      if (wall || e.name === 'AbortError' || !audio.paused) return;          // overtaken by a pause or a seek of ours
      if (e.name === 'NotAllowedError' && !audio.muted) { audio.muted = true; sound = 'muted'; play(); return; }   // muted, then
      fallBack(e.name === 'NotAllowedError' ? 'locked' : 'none', want ?? audio.currentTime + A0);
    });
  }
  /** currentTime moves in steps of up to a few frames in some browsers: in between, time runs on, gently pulled back to it. */
  function audioTime(now) {
    const c = audio.currentTime;
    if (want !== null) {                                     // not where it was started yet: seek there as soon as it can
      if (Math.abs(c + A0 - want) < 0.5) want = null;
      else { if (audio.readyState >= 1 && !audio.seeking) audio.currentTime = want - A0; return want; }
    }
    if (audio.paused || audio.seeking || audio.readyState < 3) { smooth = null; return c + A0; }
    if (!smooth) smooth = { t: c, at: now, seen: c, moving: false };
    if (c !== smooth.seen) {
      const p = smooth.t + (now - smooth.at) / 1000, err = c - p;
      smooth = { t: !smooth.moving || Math.abs(err) > 0.05 ? c : p + err * 0.25, at: now, seen: c, moving: true };
    }
    return (smooth.moving ? smooth.t + (now - smooth.at) / 1000 : c) + A0;
  }
  /** Song time now; also every change of clock: the page waits for the load, the song starts, stalls, ends, the film starts over. */
  function advance(now) {
    let t;
    if (wall) {
      t = wall.t0 + (now - wall.at) / 1000;
      if (!loaded && t > HOLD) { t = HOLD; wall = { t0: t, at: now }; }
      if (!ran && loaded && t > GATE) { t = GATE; wall = { t0: t, at: now }; if (!gated) showPrompt(); }
      if (t >= D) {                                          // once more, from the warning page
        t = fold(t); wall = { t0: t, at: now };
        if (sound === 'stalled') sound = 'ok';
      }
      if (loaded && ran && t >= A0 && t < D - 0.25 && (sound === 'ok' || sound === 'muted')) {   // inside the audio: let it sound (from its start, if it was just reached)
        t = last < A0 ? A0 : t;
        start(t);
      }
    } else {
      t = audioTime(now);
      if (audio.ended || t >= D) {
        audio.pause(); audio.currentTime = Math.max(0, -PRE - A0); smooth = null;
        t = -PRE; wall = { t0: t, at: now };
      } else if (!audio.paused) {                            // the audio clock has to be seen to move
        const c = audio.currentTime, waiting = audio.seeking || audio.readyState < 3;
        if (c !== heard.t) heard = { t: c, at: now };
        else if (now - heard.at > (waiting ? 4000 : 2500)) { t = c + A0; fallBack('stalled', t); }
      }
    }
    return (last = t);
  }
  audio.onerror = () => { if (!wall) fallBack('none', audio.currentTime + A0); else sound = 'none'; };

  // ---- the viewer: the first tap, click or key starts what only they may start (full screen, the sound) ---------
  const root = document.documentElement;
  const isFull = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const toggleFull = () => {
    const p = isFull() ? (document.exitFullscreen ?? document.webkitExitFullscreen)?.call(document)
      : (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root, { navigationUI: 'hide' });
    p?.catch?.(() => {});                                   // refused (an iframe, a phone): the window is filled anyway
  };
  let woken = false;
  function wake() {
    if (!woken) { woken = true; if (!isFull()) toggleFull(); }
    keepAwake();
    if (sound === 'muted') { audio.muted = false; sound = 'ok'; if (!wall && audio.paused) play(); return; }
    if (sound === 'locked' || sound === 'stalled') sound = 'ok';
    if (sound !== 'ok' || !wall) return;
    const t = advance(performance.now());
    if (!wall) return;                                       // (advance just started it)
    // not yet (still loading, or before the audio): start the element once and stop it at once (no sound), so a
    // browser that lets only the user start sound will let it start by itself later
    if (!loaded || !ran || t < A0) { audio.play().catch(() => {}); audio.pause(); } else if (t < D - 0.25) start(t);
  }
  const press = () => (gated && !ran ? run() : wake());
  window.addEventListener('click', press);
  window.addEventListener('touchend', press, { passive: true });   // iOS sends no click to the window for a tap on the picture
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' && gated && !ran) { e.preventDefault(); run(); return; }
    if ((e.key === 'f' || e.key === 'F') && woken) toggleFull();
    wake();
  });
  window.addEventListener('dblclick', toggleFull);

  // the pointer hides when it rests; the screen does not sleep while the film plays
  let idle = 0;
  window.addEventListener('pointermove', () => {
    document.body.classList.remove('idle');
    clearTimeout(idle); idle = setTimeout(() => document.body.classList.add('idle'), 2000);
  });
  let lock = null;
  function keepAwake() {
    if (lock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    lock = 'asking';
    navigator.wakeLock.request('screen').then((l) => { lock = l; l.onrelease = () => { lock = null; }; }).catch(() => { lock = null; });
  }
  keepAwake();

  // ---- drawing -----------------------------------------------------------------
  // requestAnimationFrame is only a repaint trigger; the frame content depends on t alone. At most 60 frames a second,
  // the film's own rate: a 120 Hz screen would otherwise draw everything twice. A 2 s window of drawn frames decides
  // the render size: when more than a fifth of them came a refresh late, one step down, and never back up to a step
  // that was too slow (only a larger picture on screen raises it, as far as the step above the slowest one).
  const vs = { min: Infinity, n: 0, cur: 1000 / 60 };       // the screen's refresh interval: min over 60 callbacks
  const win = { frames: 0, late: 0, ms: 0, time: 0, skip: 2 };   // skip = windows not counted (warm-up, just resized)
  let prevRaf = 0, prevDraw = 0, lastT = NaN, slowest = -1;
  const perf = { level: () => (fixedSize ? null : sizeOf(level).join('x')), ms: 0, late: 0, fps: 0 };

  function setLevel(i) {
    if (fixedSize || i === level) return;
    level = i; [width, height] = sizeOf(i);
    engine.resize(width, height);
    lastT = NaN; win.frames = win.late = win.ms = win.time = 0; win.skip = 1;
  }
  let resizing = 0;
  window.addEventListener('resize', () => { clearTimeout(resizing); resizing = setTimeout(() => setLevel(Math.max(fitLevel(), slowest + 1)), 250); });
  document.addEventListener('visibilitychange', () => {
    win.frames = win.late = win.ms = win.time = 0; win.skip = 1; prevDraw = 0;
    if (document.visibilityState === 'visible') keepAwake();
  });
  // rAF stops in a background tab; the sound (and the loop) goes on
  setInterval(() => { if (document.hidden) advance(performance.now()); }, 500);

  function tick(now) {
    requestAnimationFrame(tick);
    if (prevRaf) { const iv = now - prevRaf; if (iv > 2) vs.min = Math.min(vs.min, iv); if (++vs.n >= 60) { vs.cur = vs.min; vs.min = Infinity; vs.n = 0; } }
    prevRaf = now;
    const t = advance(now);
    if (t === lastT || (prevDraw && now - prevDraw < 1000 / 60 - vs.cur / 2)) return;
    const gap = prevDraw ? now - prevDraw : 0, a = performance.now();
    engine.renderFrame(t);
    const ms = performance.now() - a;
    if (!prevDraw) $('view').classList.add('on');
    prevDraw = now; lastT = t;
    if (!gap || !loaded) return;
    win.frames++; win.ms += ms; win.time += gap;
    if (gap > 1000 / 60 * 1.45 && gap > vs.cur * 1.6) win.late++;
    if (win.frames < 120) return;
    perf.ms = +(win.ms / win.frames).toFixed(2); perf.late = +(win.late / win.frames).toFixed(3); perf.fps = +(1000 * win.frames / win.time).toFixed(1);
    if (win.skip > 0) win.skip--;
    else if (!fixedSize && perf.late > 0.2 && level < LADDER.length - 1) { slowest = Math.max(slowest, level); setLevel(level + 1); }
    win.frames = win.late = win.ms = win.time = 0;
  }
  requestAnimationFrame(tick);
  window.__player = { engine, perf, setLevel, state: () => ({ t: last, sound, clock: wall ? 'wall' : 'audio', loaded }), seek: (v) => { audio.pause(); wall = { t0: fold(v), at: performance.now() }; } };   // for the console
}
