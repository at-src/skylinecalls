// Close-up screenshots of the 3D city at street level (no call), for checking building detail.
// Usage: node scripts/shoot-close.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-close-'));
const { start } = await import('../src/server.js');
const PORT = 3296;
const server = await start(PORT);
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'C:/hc/tothedoor/.chrome-close', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
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
// grab the city object through the module scope: expose it for the test
const shots = [[120, 1.25, 0.6, 'close-a'], [70, 1.35, 2.4, 'close-b'], [260, 1.05, 4.0, 'close-c']];
for (const [dist, polar, az, name] of shots) {
  await p.evaluate(([d, ph, th]) => { const c = window.__city; c.controls.autoRotate = false; c.look(c.home.clone(), d, ph, th, 0.05); }, [dist, polar, az]);
  await wait(1800);
  await p.screenshot({ path: `scripts/ui-${name}.jpg`, type: 'jpeg', quality: 84 });
}
console.log('errors:', errs.length ? errs.join('\n  ') : 'none');
await b.close(); server.close(); process.exit(0);
