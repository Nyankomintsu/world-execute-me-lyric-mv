// Publish the site on GitHub Pages:
//   node tools/deploy_pages.mjs         (npm run deploy)
// builds dist/ (tools/build_site.mjs) and force-pushes it as the only commit of the gh-pages branch of `origin`.
// Once, on GitHub: Settings -> Pages -> Build and deployment -> Source "Deploy from a branch", branch gh-pages, / (root).
// It is built here and not by a GitHub Action because the song and the lyrics are not in the repository (and stay out
// of main); the gh-pages branch does carry them, and the site makes them public.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSite, DIST } from './build_site.mjs';

const ROOT = path.resolve(DIST, '..');
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const tryGit = (args) => { try { return git(args); } catch { return ''; } };

try { buildSite(); } catch (e) { console.error(e.message); process.exit(1); }
const remote = git(['remote', 'get-url', 'origin']), sha = tryGit(['rev-parse', '--short', 'HEAD']) || 'local';
const who = [['user.name', tryGit(['config', 'user.name'])], ['user.email', tryGit(['config', 'user.email'])]].filter(([, v]) => v).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
const repo = path.join(DIST, '.git');
fs.rmSync(repo, { recursive: true, force: true });
try {
  git(['init', '-q', '-b', 'gh-pages'], DIST);
  git(['add', '-A'], DIST);
  git([...who, 'commit', '-q', '-m', `Deploy ${sha}`], DIST);
  execFileSync('git', ['push', '-f', remote, 'gh-pages'], { cwd: DIST, stdio: 'inherit' });
} finally { fs.rmSync(repo, { recursive: true, force: true }); }
const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
console.log(`published${m ? `: https://${m[1].toLowerCase()}.github.io/${m[2]}/  (live a minute or two after the push)` : ''}`);
