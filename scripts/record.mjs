/**
 * Record a short deterministic clip of the app (headless Edge/Chrome via DevTools + ffmpeg).
 *
 *   node scripts/record.mjs [--url http://127.0.0.1:5180/] [--out screenshots/demo] [--seconds 10]
 *                           [--fps 20] [--width 1200] [--height 791] [--query "world=virtual"]
 *                           [--setup "<js run after load>"]
 *
 * The simulation is paused and advanced by exactly 1/fps per captured frame, so the clip is
 * smooth regardless of how slowly the software renderer draws. Writes <out>.mp4 and <out>.gif.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const url = new URL(args.url ?? 'http://127.0.0.1:5180/');
if (args.query) for (const [k, v] of new URLSearchParams(args.query)) url.searchParams.set(k, v);
const out = args.out ?? 'screenshots/demo';
const width = Number(args.width ?? 1200);
const height = Number(args.height ?? 791);
const fps = Number(args.fps ?? 20);
const seconds = Number(args.seconds ?? 10);

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found. Set BROWSER_PATH.');
  process.exit(2);
}
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg not found on PATH.');
  process.exit(2);
}

const port = 9222 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-viz-rec-'));
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-viz-frames-'));
const child = spawn(
  executablePath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const deadline = Date.now() + 20000;
let browser;
while (!browser) {
  try {
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: { width, height, deviceScaleFactor: 1 } });
  } catch (e) {
    if (Date.now() > deadline) {
      child.kill();
      throw e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', String(e)));
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 60000 });
  await page.evaluate(async () => {
    while (!window.__viz) await new Promise((r) => setTimeout(r, 100));
  });
  if (args.setup) await page.evaluate(args.setup);
  // freeze the app's own clock: we advance the simulation ourselves
  await page.evaluate(() => {
    window.__viz.sim.paused = true;
  });
  await new Promise((r) => setTimeout(r, 1500));
  const n = Math.round(seconds * fps);
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((dt) => window.__viz.tick(dt), 1 / fps);
    await page.screenshot({ path: path.join(frames, `f${String(i).padStart(4, '0')}.png`), type: 'png', captureBeyondViewport: false });
    if (i % fps === 0) process.stdout.write(`\r${i}/${n} frames (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  process.stdout.write('\n');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const input = ['-y', '-framerate', String(fps), '-i', path.join(frames, 'f%04d.png')];
  let r = spawnSync('ffmpeg', [...input, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', '-movflags', '+faststart', `${out}.mp4`], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) throw new Error('ffmpeg mp4 failed: ' + r.stderr.toString().slice(-500));
  r = spawnSync(
    'ffmpeg',
    [...input, '-vf', `fps=${Math.min(fps, 15)},scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`, '-loop', '0', `${out}.gif`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (r.status !== 0) throw new Error('ffmpeg gif failed: ' + r.stderr.toString().slice(-500));
  for (const f of [`${out}.mp4`, `${out}.gif`]) console.log(`${f}: ${(fs.statSync(f).size / 1024 / 1024).toFixed(1)} MB`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.disconnect();
  child.kill();
  await new Promise((r) => setTimeout(r, 1000)); // let the browser release its profile files
  for (const dir of [frames, profile]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Crashpad may still hold a file; the temp dir is harmless */
    }
  }
}
