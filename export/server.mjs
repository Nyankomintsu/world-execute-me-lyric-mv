// Tiny static file server (no dependencies) used by both preview and export.
//   node export/server.mjs --player      -> the film in its own full-screen browser window, sound allowed (npm run dev)
//   node export/server.mjs --open        -> the page in the default browser, at http://127.0.0.1:5280/ (npm run preview)
// The address is 127.0.0.1, not localhost: another dev server listening on the IPv6 side of the same port (Vite does,
// on 5173) would otherwise answer a browser that tries ::1 first.
// Supports HTTP Range (audio seeking) and a WebSocket upgrade hook the exporter uses to receive frames.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.png': 'image/png', '.mp4': 'video/mp4', '.lrc': 'text/plain; charset=utf-8',
};

function serveFile(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel === '/') rel = '/index.html';
  if (rel === '/favicon.ico') { res.writeHead(204).end(); return; }
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }   // stay inside the project
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const head = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end(); return; }
      res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...head, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

/** Start the server. `onUpgrade(req, socket)` handles the exporter's frame WebSocket. Tries following ports if busy. */
export function startServer({ port = 5280, onUpgrade = null } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveFile);
    server.on('upgrade', (req, socket) => (onUpgrade ? onUpgrade(req, socket) : socket.destroy()));
    let tries = 0;
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries++ < 20) server.listen(++port, '127.0.0.1');
      else reject(e);
    });
    server.on('listening', () => resolve({ server, port, url: `http://127.0.0.1:${port}` }));
    server.listen(port, '127.0.0.1');
  });
}

/**
 * The film in a window of its own: Chrome (or Edge) in full screen, allowed to start the sound without a click (a page
 * cannot ask for that itself). Its own profile, so the switches apply even while the browser is open already.
 * Returns false when neither browser is found.
 */
function playerWindow(url) {
  const pf = process.env.PROGRAMFILES ?? 'C:\\Program Files', pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA ?? '';
  const exe = (process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe'),
        path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']).find((p) => fs.existsSync(p));
  if (!exe) return false;
  spawn(exe, [
    `--user-data-dir=${path.join(os.tmpdir(), 'world-execute-me-player')}`, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--start-fullscreen', `--app=${url}/`,
  ], { stdio: 'ignore', detached: true }).unref();
  return true;
}

// ---- run directly: preview server -------------------------------------------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // the repository has neither the song nor its lyrics: the lines are made from your own lyric file, the audio is yours too
  const { ensureLyrics } = await import('../tools/fill_lyrics.mjs');
  try { ensureLyrics(); } catch (e) { console.error(e.message); process.exit(1); }
  const audio = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).paths.audio;
  if (!fs.existsSync(path.join(ROOT, audio))) console.warn(`[audio] "${audio}" not found (config.json -> paths.audio): the preview can be scrubbed but will not play; an export needs the file.`);
  const { url } = await startServer({ port: +process.env.PORT || 5280 });   // PORT lets a launcher pick a free port
  console.log(`preview: ${url}/   (Ctrl+C to stop)`);
  if (process.argv.includes('--player') && playerWindow(url)) {
    console.log(`opened in its own full-screen window (${process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4'} closes it)`);
  } else if (process.argv.includes('--open') || process.argv.includes('--player')) {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  }
}
