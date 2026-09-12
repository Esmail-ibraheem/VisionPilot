/**
 * Headless screenshot of the running app using the locally installed Edge/Chrome via puppeteer-core.
 *
 *   node scripts/screenshot.mjs [--url http://127.0.0.1:5180/] [--out screenshots/reference.png]
 *                               [--width 1200] [--height 791] [--query "mode=live"] [--wait 1500]
 *
 * Also prints console errors and any non-same-origin network requests, so it doubles as a check
 * that the app is fully self-contained.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);

const url = new URL(args.url ?? 'http://127.0.0.1:5180/');
if (args.query) for (const [k, v] of new URLSearchParams(args.query)) url.searchParams.set(k, v);
const out = args.out ?? 'screenshots/reference.png';
const width = Number(args.width ?? 1200);
const height = Number(args.height ?? 791);
const wait = Number(args.wait ?? 1500);

const candidates = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Edge found. Set BROWSER_PATH to a Chromium-based browser executable.');
  process.exit(2);
}

// Spawn the browser ourselves (puppeteer's launcher is picky about some Edge builds) and connect
// over the DevTools port.
const { spawn } = await import('node:child_process');
const os = await import('node:os');
const port = 9222 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tesla-viz-shot-'));
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
  const errors = [];
  const external = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== url.origin && !u.protocol.startsWith('data')) external.push(r.url());
  });
  await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, wait));
  const info = await page.evaluate(() => {
    const c = document.getElementById('scene');
    const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
    return {
      canvas: c ? `${c.width}x${c.height}` : 'missing',
      webgl: gl ? gl.getParameter(gl.VERSION) : 'none',
      errorVisible: !document.getElementById('error')?.hidden,
    };
  });
  if (args.eval) {
    // Evaluate an expression in the page after the wait and print the JSON result (debug aid).
    const result = await page.evaluate(args.eval);
    console.log('eval: ' + JSON.stringify(result));
  }
  if (args.sample) {
    // Sample rendered canvas pixels: --sample "x,y;x,y" (CSS pixels). Prints hex colours.
    const pts = args.sample.split(';').map((p) => p.split(',').map(Number));
    const colors = await page.evaluate((pts) => {
      const c = document.getElementById('scene');
      const tmp = document.createElement('canvas');
      tmp.width = c.width;
      tmp.height = c.height;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const sx = c.width / c.clientWidth;
      return pts.map(([x, y]) => {
        const d = ctx.getImageData(Math.round(x * sx), Math.round(y * sx), 1, 1).data;
        return `${x},${y}: #${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      });
    }, pts);
    for (const c of colors) console.log('  sample ' + c);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`saved ${out} (${width}x${height}) via ${path.basename(executablePath)}`);
  console.log(`canvas ${info.canvas}, ${info.webgl}, error overlay: ${info.errorVisible}`);
  console.log(`console errors: ${errors.length}${errors.length ? '\n  ' + errors.join('\n  ') : ''}`);
  console.log(`external requests: ${external.length}${external.length ? '\n  ' + external.join('\n  ') : ''}`);
  if (info.errorVisible || errors.length) process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  child.kill();
  // The browser releases its profile files a moment after exit; best-effort cleanup.
  setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }), 800).unref();
}
