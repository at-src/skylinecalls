// Screenshots the live screen at each stage of a demo delivery, on a private test server
// (DRY_RUN: no Telegram, no calls). Usage: node scripts/shoot-ui.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-ui-'));
const { start } = await import('../src/server.js');
const PORT = 3297;
const server = await start(PORT);

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'C:/hc/tothedoor/.chrome-3d', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'domcontentloaded' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await wait(9000);
await p.screenshot({ path: 'scripts/ui-1-onboard.jpg', type: 'jpeg', quality: 82 });
await p.click('#useDemo');
await wait(30000);
await p.screenshot({ path: 'scripts/ui-2-home.jpg', type: 'jpeg', quality: 82 });

await fetch(`http://localhost:${PORT}/api/demo/replay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pace: 2 }) });
await wait(16000);
await p.screenshot({ path: 'scripts/ui-3-far.jpg', type: 'jpeg', quality: 82 });
await wait(22000);
await p.screenshot({ path: 'scripts/ui-4-near.jpg', type: 'jpeg', quality: 82 });
await wait(26000);
await p.screenshot({ path: 'scripts/ui-5-done.jpg', type: 'jpeg', quality: 82 });

console.log('errors:', errs.length ? errs.join('\n  ') : 'none');
await b.close(); server.close(); process.exit(0);
