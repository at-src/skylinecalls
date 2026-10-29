// Screenshots of onboarding (receiving or sending, the company list) and the receiver view with its sender settings.
// Usage: node scripts/shoot-onboard.js  ->  scripts/onboard-<n>.jpg
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');
process.env.DRY_RUN = '1'; process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-onb-'));
const { start } = await import('../src/server.js'); const server = await start(3287);
const profile = 'C:/hc/tothedoor/.chrome-onboard'; rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile, args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto('http://localhost:3287/?hour=18.6', { waitUntil: 'domcontentloaded' }); await wait(5000);
await p.screenshot({ path: 'scripts/onboard-1-role.jpg', type: 'jpeg', quality: 80 });
await p.click('#pickSender'); await wait(1500);
await p.screenshot({ path: 'scripts/onboard-2-senders.jpg', type: 'jpeg', quality: 80 });
await p.click('#backRole'); await wait(500); await p.click('#pickReceiver'); await wait(800);
await p.click('#useDemo');
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 }); await wait(6000);
await p.screenshot({ path: 'scripts/onboard-3-receiver.jpg', type: 'jpeg', quality: 80 });
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
