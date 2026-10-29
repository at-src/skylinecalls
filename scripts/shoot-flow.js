// Screenshots of the two scripted calls on the live screen, on a private test server (DRY_RUN: no calls, no
// Telegram): Sam teaching the door by voice, then a rider being guided to it.
// Usage: node scripts/shoot-flow.js  ->  scripts/flow-<n>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-flow-'));
const { start } = await import('../src/server.js');
const PORT = 3290;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-flow';
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
await p.evaluate(() => localStorage.setItem('ttd-home', JSON.stringify({ lat: 12.91226, lng: 77.63775, label: "Sam's home" })));
await p.goto(`http://localhost:${PORT}/?hour=${hour}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 });
await wait(6000);
let n = 0;
const shot = async (name) => { await p.screenshot({ path: `scripts/flow-${++n}-${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('shot', n, name); };
// 1) Sam teaches the door
await post('/api/demo/teach', { pace: 1.6 });
await wait(13000); await shot('teach-anchor');
await wait(9000); await shot('teach-mcd');
await wait(18000); await shot('teach-stairs');
await wait(16000); await shot('teach-saved');
// 2) a rider is guided there
await post('/api/demo/replay', { pace: 1.6 });
await wait(16000); await shot('guide-far');
await wait(9000); await shot('guide-bda');
await wait(10000); await shot('guide-mcd');
await wait(14000); await shot('guide-stairs');
await wait(20000); await shot('guide-done');
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
