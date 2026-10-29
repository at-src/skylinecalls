// Screenshots of the dashboard with the demo home at given hours (DRY_RUN server, no calls).
// Usage: node scripts/shoot-dash.js 23,19,9  ->  scripts/dash-<hour>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-dash-'));
const { start } = await import('../src/server.js');
const PORT = 3292;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-dash';
rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
p.on('console', (m) => { if (['error'].includes(m.type())) errs.push(m.text().slice(0, 300)); });
p.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// frame errors (the 3D map in its iframe)
b.on('targetcreated', () => {});
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.setItem('ttd-home', JSON.stringify({ lat: 12.91281, lng: 77.63741, label: "Sam's home" })) || localStorage.setItem('ttd-role', 'receiver'));
for (const h of (process.argv[2] || '23,19,9').split(',')) {
  await p.goto(`http://localhost:${PORT}/?hour=${h}${process.env.Q || ""}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 }).catch(() => console.log('veil still up'));
  console.log('map up after', Math.round((Date.now() - t0) / 1000), 's');
  await wait(7000);
  for (const f of p.frames()) if (f !== p.mainFrame()) f.evaluate(() => 0).catch((e) => errs.push('frame: ' + e.message));
  await p.screenshot({ path: `scripts/dash-${h.replace('.', '_')}.jpg`, type: 'jpeg', quality: 82 });
  console.log('shot', h);
}
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
