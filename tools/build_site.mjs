// The site: everything the page needs, as static files in dist/, for GitHub Pages or any static host (any folder: every
// path in the page is relative).
//   node tools/build_site.mjs           -> dist/            (npm run build; npm run deploy publishes it)
// dist/ holds: the page and its code; config.json pointing at the copies below; the analysis data; YOUR lyric lines
// (data/lyrics.json, made from your lyric file as for the preview); the silhouettes; the written conversation; only the
// font files the film uses (each CJK face cut down to the slices that hold its configured characters); and the song
// (paths.audio) compressed to AAC, unless player.sound is off or the file is missing (then the site plays silently).
// NOTE: dist/ carries the song and its lyrics. Publishing it publishes them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ensureLyrics } from './fill_lyrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIST = path.join(ROOT, 'dist');
const FONTS = path.join(ROOT, 'node_modules/@fontsource');
const CACHE = path.join(ROOT, 'node_modules/.cache/world-execute-me');          // the encoded song, kept between builds

/** "U+4e00-9fff,U+3000" -> [[0x4e00, 0x9fff], [0x3000, 0x3000]] */
const ranges = (s) => s.split(',').map((r) => r.trim().replace(/^U\+/i, '').split('-').map((h) => parseInt(h, 16))).map(([a, b = a]) => [a, b]);

export function buildSite() {
  ensureLyrics({ quiet: true });                      // throws, with what to do, when there is no lyric file
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const out = { ...cfg, paths: { ...cfg.paths, fonts: 'fonts' }, player: { ...cfg.player } };
  fs.rmSync(DIST, { recursive: true, force: true });
  const put = (to) => { const d = path.join(DIST, to); fs.mkdirSync(path.dirname(d), { recursive: true }); return d; };
  const copy = (from, to = from) => fs.cpSync(path.join(ROOT, from), put(to), { recursive: true });

  copy('index.html'); copy('src'); copy(cfg.paths.art);
  for (const p of [cfg.paths.features, cfg.paths.lyrics, cfg.paths.script, cfg.paths.errors]) copy(p);

  // ---- fonts: the Latin files by weight, the CJK stylesheets cut down to the slices the configured text needs ----
  const font = (pkg, file) => fs.copyFileSync(path.join(FONTS, pkg, file), put(`fonts/${pkg}/${file}`));
  for (const key of ['mono', 'serif', 'sans']) {
    const { pkg, weights, italic = [] } = cfg.fonts[key];
    for (const [w, style] of [...weights.map((w) => [w, 'normal']), ...italic.map((w) => [w, 'italic'])]) font(pkg, `files/${pkg}-latin-${w}-${style}.woff2`);
  }
  const groups = new Map();                           // "pkg/weight" -> every character any role of it draws
  for (const c of cfg.fonts.cjk || []) groups.set(`${c.pkg}/${c.weight}`, (groups.get(`${c.pkg}/${c.weight}`) ?? '') + (c.text ?? ''));
  for (const [key, text] of groups) {
    const [pkg, weight] = key.split('/'), cps = [...new Set(text)].map((ch) => ch.codePointAt(0));
    const kept = [];
    for (const face of fs.readFileSync(path.join(FONTS, pkg, `${weight}.css`), 'utf8').match(/@font-face\s*{[^}]*}/g) ?? []) {
      const ur = /unicode-range:\s*([^;]+);/.exec(face), file = /url\((\.\/files\/[^)]+\.woff2)\)/.exec(face)?.[1];
      if (!file || (ur && !cps.some((cp) => ranges(ur[1]).some(([a, b]) => cp >= a && cp <= b)))) continue;
      font(pkg, file.slice(2));
      kept.push(face.replace(/src:[^;]+;/, `src: url(${file}) format('woff2');`));
    }
    if (!kept.length) throw new Error(`[site] ${pkg} ${weight}: no slice holds the configured characters`);
    fs.writeFileSync(put(`fonts/${pkg}/${weight}.css`), kept.join('\n') + '\n');
  }

  // ---- the song: AAC in an .m4a (the wav is ~10 times larger); encoded once, then taken from the cache ----------
  const src = path.join(ROOT, cfg.paths.audio);
  if (!cfg.player?.sound) console.warn('[site] player.sound is off: the site plays without the song');
  else if (!fs.existsSync(src)) { console.warn(`[site] "${cfg.paths.audio}" not found: the site plays without the song`); out.player.sound = false; }
  else if (!/\.wav$/i.test(src)) { copy(cfg.paths.audio, `audio/${path.basename(src)}`); out.paths.audio = `audio/${path.basename(src)}`; }
  else {
    const st = fs.statSync(src), stamp = `${st.size} ${st.mtimeMs} 192k`, cached = path.join(CACHE, 'song.m4a');
    if (!fs.existsSync(cached) || fs.readFileSync(`${cached}.stamp`, 'utf8') !== stamp) {
      fs.mkdirSync(CACHE, { recursive: true });
      const ff = createRequire(import.meta.url)('ffmpeg-static');
      const r = spawnSync(ff, ['-y', '-v', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', cached], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('[site] ffmpeg could not encode the song');
      fs.writeFileSync(`${cached}.stamp`, stamp);
    }
    fs.copyFileSync(cached, put('audio/song.m4a'));
    out.paths.audio = 'audio/song.m4a';
  }

  fs.writeFileSync(put('config.json'), JSON.stringify(out, null, 2) + '\n');
  fs.writeFileSync(put('.nojekyll'), '');              // served as it is (GitHub Pages would otherwise run Jekyll over it)

  // ---- a version tag on the code: GitHub Pages lets browsers keep every file for 10 minutes, so after a deploy a page
  // could run new modules next to old cached ones. Every module path in the code (and the page's link to src/main.js)
  // gets ?v=<hash of the code and the data>; the page asks for its JSON with the same tag (src/main.js: VERSION).
  const code = [], walkJs = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walkJs(p); else if (p.endsWith('.js')) code.push(p); } };
  walkJs(path.join(DIST, 'src'));
  const h = crypto.createHash('sha256');
  for (const p of [...code, ...['config.json', cfg.paths.features, cfg.paths.lyrics, cfg.paths.script, cfg.paths.errors].map((f) => path.join(DIST, f))]) h.update(path.relative(DIST, p)).update(fs.readFileSync(p));
  const v = h.digest('hex').slice(0, 10);
  for (const p of code) fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/(['"])(\.{1,2}\/[^'"\s]+?\.js)\1/g, `$1$2?v=${v}$1`));
  const page = path.join(DIST, 'index.html'), html = fs.readFileSync(page, 'utf8');
  if (!html.includes('src="src/main.js"')) throw new Error('[site] index.html: no <script src="src/main.js"> to tag');
  fs.writeFileSync(page, html.replace('src="src/main.js"', `src="src/main.js?v=${v}"`));

  let n = 0, bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; } } };
  walk(DIST);
  console.log(`[site] dist/: ${n} files, ${(bytes / 1048576).toFixed(1)} MB, version ${v}${out.player.sound ? '' : ' (no song)'}`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildSite(); } catch (e) { console.error(e.message); process.exit(1); }
}
