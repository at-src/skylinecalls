// Screenshots of Sam's line on a private DRY_RUN server: the line between calls, then scripted calls clicked from
// the dock the way a visitor would. Records which audio lines played.
// Usage: node scripts/shoot-line.js [persona:seconds,...]  ->  scripts/line-<n>-<name>.jpg
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-line-'));
const { start } = await import('../src/server.js');
const PORT = 3289;
const server = await start(PORT);
const profile = 'C:/hc/tothedoor/.chrome-line';
rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
p.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await p.evaluateOnNewDocument(() => {
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { const r = play.call(this); const src = this.src.split('/').pop(); r.then(() => window.__played.push(['ok', src]), (e) => window.__played.push(['blocked ' + e.name, src])); return r; };
});
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('ttd-home', JSON.stringify({ lat: 12.91281, lng: 77.63741, label: "Sam's home" })); localStorage.setItem('ttd-role', 'receiver'); });
await p.goto(`http://localhost:${PORT}/?hour=${process.env.HOUR || '13'}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 });
await wait(3000);
let n = 0;
const shot = async (name) => { await p.screenshot({ path: `scripts/line-${++n}-${name}.jpg`, type: 'jpeg', quality: 78 }); console.log('shot', n, name); };
await shot('idle');
if (process.env.MSG) {
  await p.type('#tgInput', 'remind me to call the plumber at 6pm');
  await p.click('#tgCompose .tg-send');
  await wait(1500); await shot('reminder');
}
const idx = { sales: 0, friend: 1, mom: 2, landlord: 3, jio: 4, investor: 5, delivery: 6 };
for (const [persona, secs] of (process.argv[2] || 'sales:16,landlord:30,delivery:50').split(',').map((s) => s.split(':'))) {
  await p.evaluate((i) => document.querySelectorAll('#personas .persona')[i].click(), idx[persona]);
  await wait(Number(secs) * 1000);
  await shot(persona);
  await p.waitForFunction(() => ![...document.querySelectorAll('#personas .persona')].some((x) => x.disabled), { timeout: 180000 }).catch(() => console.log('still on a call'));
  await wait(1500);
}
await wait(10000);
await shot('after');
const played = await p.evaluate(() => window.__played);
console.log('audio:', played.length, 'lines;', played.filter((x) => x[0] !== 'ok').length, 'blocked');
console.log('errors:', errs.length ? [...new Set(errs)].join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
