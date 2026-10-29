// Plays the receiver's demo delivery the way a visitor would (clicks "Play a demo delivery") on a private DRY_RUN
// server, records which audio lines actually played, and takes screenshots along the way.
// Usage: node scripts/shoot-demo.js  ->  scripts/demo-<n>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-demo-'));
const { start } = await import('../src/server.js');
const PORT = 3291;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-demo';
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
// note every line the page tries to play, and whether the browser let it
await p.evaluateOnNewDocument(() => {
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { const r = play.call(this); const src = this.src.split('/').pop(); r.then(() => window.__played.push(['ok', src]), (e) => window.__played.push(['blocked ' + e.name, src])); return r; };
});
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('ttd-home', JSON.stringify({ lat: 12.91281, lng: 77.63741, label: "Sam's home" })); localStorage.setItem('ttd-role', 'receiver'); });
await p.goto(`http://localhost:${PORT}/?hour=${process.env.HOUR || '13'}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 });
await wait(5000);
let n = 0;
const shot = async (name) => { await p.screenshot({ path: `scripts/demo-${++n}-${name}.jpg`, type: 'jpeg', quality: 82 }); console.log('shot', n, name, Math.round((Date.now() - t0) / 1000) + 's'); };
const t0 = Date.now();
await p.click('#playDemo');
for (const [at, name] of (process.env.SHOTS || '44:mcd,58:gate,70:stairs,100:done').split(',').map((s) => s.split(':'))) {
  await wait(Math.max(0, Number(at) * 1000 - (Date.now() - t0)));
  await shot(name);
}
const played = await p.evaluate(() => window.__played);
console.log('audio:', played.length, 'lines;', played.filter((x) => x[0] !== 'ok').length, 'blocked');
console.log(played.map((x) => x.join(' ')).join('\n'));
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
