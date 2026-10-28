// Screenshots of the city at several hours of the day, for checking the day/night cycle.
// Usage: node scripts/shoot-hours.js   ->  scripts/ui-hour-<h>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-hours-'));
const { start } = await import('../src/server.js');
const PORT = 3295;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-hours';
rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 860 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 300)));
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 400)); });
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => localStorage.clear());
await p.reload({ waitUntil: 'domcontentloaded' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(6000);
await p.click('#useDemo');
await wait(9000);
const hours = (process.argv[2] || '3,7,9.5,13,17.5,18.5,20,23').split(',').map(Number);
for (const h of hours) {
  await p.evaluate((hh) => { const c = window.__city; c.controls.autoRotate = false; c.setHour(hh); c.look(c.home.clone(), 260, 1.05, 4.0, 0.05); }, h);
  await wait(1500);
  const cars = await p.evaluate(() => { const c = window.__city; return { dens: +c.dens.toFixed(2), active: c.cars.filter((v) => v.q <= c.dens).length, total: c.cars.length }; });
  console.log(`hour ${h}: traffic ${cars.active}/${cars.total} (density ${cars.dens})`);
  await p.screenshot({ path: `scripts/ui-hour-${String(h).replace('.', '_')}.jpg`, type: 'jpeg', quality: 80 });
}
console.log('errors:', errs.length ? errs.join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
