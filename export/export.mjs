// Offline exporter: headless Chrome (GPU) renders frame by frame, raw RGBA frames are
// streamed straight into ffmpeg's stdin (no image files on disk), audio is muxed from the wav.
//
//   video:  node export/export.mjs [--start s] [--end s] [--width w] [--height h] [--fps n]
//                                  [--out file.mp4] [--codec auto|h264_nvenc|libx264] [--cq n] [--headed]
//           Times are SONG time (audio start = 0). The film itself starts at -safety.preroll (config.json) with a
//           silent warning page, and that is where an export starts unless --start says otherwise; the audio is
//           then delayed by the same amount. The file records the song time of its first frame (mv_start=... in the
//           `comment` tag) so that tools/check_sync.py and tools/check_flash.py can report song times.
//   QA contact sheet (one PNG of stills, for checking shots without exporting a video):
//           node export/export.mjs --sheet out/qa.png --times 12.5,13,13.5 [--cols 4] [--width 960 --height 540]
//           node export/export.mjs --sheet out/qa.png --from 29.4 --to 44.6 --step 0.923
//   check cards (src/scenes/lab.js) instead of the film: add --lab <set>, e.g. --lab inks --times 0,1,2
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { ROOT, startServer } from './server.mjs';
import { frameSocketHandler } from './wsframes.mjs';
import { ensureLyrics } from '../tools/fill_lyrics.mjs';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const features = JSON.parse(fs.readFileSync(path.join(ROOT, cfg.paths.features), 'utf8'));
// the lyric lines come from your own lyric file (the repository has none); stop here, before any output is touched, if they cannot be had
try { ensureLyrics({ quiet: true }); } catch (e) { console.error(e.message); process.exit(1); }

// ---- arguments -------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const SHEET = arg('sheet', null);
const LAB = arg('lab', null);                         // --lab <set>: the check cards of src/scenes/lab.js, one per second from t = 0
const W = +arg('width', SHEET ? 960 : cfg.video.width), H = +arg('height', SHEET ? 540 : cfg.video.height), FPS = +arg('fps', cfg.video.fps);
const PRE = cfg.safety?.preroll ?? 0;                 // seconds of film before the song
const START = Math.max(-PRE, +arg('start', LAB ? 0 : -PRE)), END = Math.min(+arg('end', features.meta.duration), features.meta.duration);
const OUT = path.resolve(ROOT, SHEET || arg('out', `out/export_${W}x${H}_${FPS}.mp4`));
const firstFrame = Math.round(START * FPS), lastFrame = Math.round(END * FPS);   // [first, last)
if (W % 2 || H % 2) throw new Error('width/height must be even for yuv420p');

let times = null;                                    // sheet mode: explicit list of timestamps
if (SHEET) {
  if (arg('times')) times = arg('times').split(',').map(Number);
  else { times = []; for (let t = +arg('from', 0); t <= +arg('to', 10) + 1e-6; t += +arg('step', 1)) times.push(+t.toFixed(4)); }
}
const total = SHEET ? times.length : lastFrame - firstFrame;

// ---- ffmpeg ----------------------------------------------------------------------
function findFfmpeg() {
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';          // system ffmpeg wins
  const p = createRequire(import.meta.url)('ffmpeg-static');
  if (p && fs.existsSync(p)) return p;
  throw new Error('ffmpeg not found. Install it, or run: node node_modules/ffmpeg-static/install.js');
}
const FFMPEG = findFfmpeg();

function pickCodec() {
  const want = arg('codec', cfg.export.codec);
  if (want !== 'auto' && want !== 'h264_nvenc') return want;
  // Real probe: encode a few frames at the target size. Fails if driver/GPU/resolution is unsupported.
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=${FPS}`,
    '-frames:v', '5', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
  if (r.status === 0) return 'h264_nvenc';
  console.warn('[export] h264_nvenc unavailable -> falling back to libx264');
  return 'libx264';
}

/** --cq N overrides the quality value of the configured encoder args (smaller files for previews). */
function quality(list, flag) {
  const q = arg('cq', null), out = [...list], i = out.indexOf(flag);
  if (q != null && i >= 0) out[i + 1] = String(q);
  return out;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const rawIn = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`];
let ffArgs, CODEC = 'png';
if (SHEET) {
  const cols = +arg('cols', 4), rows = Math.ceil(total / cols);
  ffArgs = [...rawIn, '-framerate', '1', '-i', 'pipe:0', '-vf', `tile=${cols}x${rows}:padding=6:color=0x303030`, '-frames:v', '1', OUT];
} else {
  CODEC = pickCodec();
  // audio: the file from where the first frame falls in it (timing.audioStart = song time of its first sample); if the
  // export starts before the file, it is delayed by that lead (in samples: exact)
  const at = firstFrame / FPS - (cfg.timing.audioStart ?? 0), lead = Math.max(0, -at), aStart = Math.max(0, at);
  ffArgs = [
    ...rawIn, '-framerate', String(FPS), '-thread_queue_size', '64', '-i', 'pipe:0',
    '-ss', String(aStart), '-t', String(total / FPS - lead), '-i', path.join(ROOT, cfg.paths.audio),
    '-map', '0:v', '-map', '1:a',
    ...(lead > 0 ? ['-af', `adelay=${Math.round(lead * features.meta.sampleRate)}S:all=1`] : []),
    '-metadata', `comment=mv_start=${(firstFrame / FPS).toFixed(6)}`,
    '-vf', 'scale=out_color_matrix=bt709:out_range=limited,format=yuv420p',
    '-c:v', CODEC, ...(CODEC === 'h264_nvenc' ? quality(cfg.export.nvenc, '-cq') : quality(cfg.export.x264, '-crf')),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    ...cfg.export.audio, '-shortest', '-movflags', '+faststart', OUT,
  ];
}
const ff = spawn(FFMPEG, ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise((res, rej) => ff.on('exit', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
ff.stdin.on('error', (e) => { console.error('[ffmpeg stdin]', e.message); });

// ---- frame sink: page -> WebSocket -> ffmpeg stdin (frames never touch the disk) ---
let received = 0, failed = null;
const onUpgrade = frameSocketHandler({
  frameBytes: W * H * 4,
  // resolve only once ffmpeg has taken the frame; the page waits for that before sending the next
  onFrame: (frame) => new Promise((res, rej) => ff.stdin.write(frame, (e) => (e ? rej(e) : (received++, res())))),
  onError: (e) => { failed = e; },
});

// ---- browser ---------------------------------------------------------------------
const { server, url } = await startServer({ port: 5180, onUpgrade });
const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--force_high_performance_gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
let browser;
for (const channel of [cfg.export.browserChannel, 'chrome', 'msedge', undefined]) {
  try { browser = await chromium.launch({ channel, headless: !argv.includes('--headed'), args: gpuArgs }); break; } catch { /* try next */ }
}
if (!browser) throw new Error('No Chrome/Edge found for Playwright (set export.browserChannel in config.json)');

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => { failed = e; console.error('[page error]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  await page.goto(`${url}/?mode=export&w=${W}&h=${H}${LAB ? `&lab=${encodeURIComponent(LAB)}` : ''}`);
  await page.waitForFunction(() => window.__mv && window.__mv.ready, null, { timeout: 60000 });
  const renderer = await page.evaluate(() => window.__mv.renderer);
  if (/swiftshader|llvmpipe|basic render/i.test(renderer)) console.warn('[export] WARNING: software WebGL - GPU not in use');

  if (SHEET) {
    await page.evaluate((ts) => window.__mv.exportTimes(ts), times);
    if (failed) throw failed;
  } else {
    console.log(`[export] ${W}x${H} @ ${FPS}fps  frames ${firstFrame}..${lastFrame - 1} (${total})  song time ${(firstFrame / FPS).toFixed(3)}..${(lastFrame / FPS).toFixed(3)} s  codec=${CODEC}`);
    console.log(`[export] renderer: ${renderer}`);
    const t0 = Date.now(), chunk = cfg.export.chunkFrames;   // (wall clock is used for the progress display only)
    for (let a = firstFrame; a < lastFrame; a += chunk) {
      const b = Math.min(lastFrame, a + chunk);
      const ms = await page.evaluate(([x, y, fps]) => window.__mv.exportRange(x, y, fps), [a, b, FPS]);
      if (failed) throw failed;
      const done = b - firstFrame, rate = done / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r[export] ${done}/${total} frames  ${rate.toFixed(1)} fps  eta ${Math.ceil((total - done) / rate)}s  ` +
        `(ms/frame: render ${ms.render} read ${ms.read} send ${ms.send})   `);
    }
    process.stdout.write('\n');
  }
} finally {
  ff.stdin.end();
  await browser.close();
  server.close();
}
await ffDone;
console.log(`[export] wrote ${path.relative(ROOT, OUT)}  (${received} frames, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);
