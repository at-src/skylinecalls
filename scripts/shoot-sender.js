// Screenshots of the sender view (Zepto): a delivery shift with live riders, one guided in by ToTheDoor.
// Usage: node scripts/shoot-sender.js  ->  scripts/sender-<n>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-sender-'));
const { start } = await import('../src/server.js');
const PORT = 3289;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-sender';
rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(`http://localhost:${PORT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const hour = process.env.HOUR || '18.6';
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.setItem('ttd-role', 'sender:zepto'));
await p.goto(`http://localhost:${PORT}/?hour=${hour}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 });
await wait(6000);
let n = 0;
const shot = async (name) => { await p.screenshot({ path: `scripts/sender-${++n}-${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('shot', n, name); };
await shot('idle');
await p.click('#runShift');
await wait(12000); await shot('riders-out');
await wait(20000); await shot('stuck');
await wait(14000); await shot('guiding');
await wait(22000); await shot('near-door');
await wait(30000); await shot('delivered');
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
