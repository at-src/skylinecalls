// Screenshots of the slop-city renderer (city/) running a city, for checking a port.
// Usage: node scripts/shoot-slop.js [city] [query]  ->  scripts/slop-<n>.jpg
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

const ROOT = 'C:/hc/tothedoor/city';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gz': 'application/octet-stream', '.bin': 'application/octet-stream' };
const server = http.createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p === '.') p = 'index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    if ((await stat(f)).isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(f));
  } catch { res.writeHead(404).end(); }
});
const PORT = 3294;
await new Promise((r) => server.listen(PORT, r));
const city = process.argv[2] || 'bengaluru';
const extra = process.argv[3] || '';
const profile = 'C:/hc/tothedoor/.chrome-slop';
rmSync(profile, { recursive: true, force: true });
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1400, height: 860 });
const errs = [];
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text().slice(0, 300)); });
await p.goto(`http://localhost:${PORT}/?city=${city}${extra}`, { waitUntil: 'domcontentloaded' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 3; i++) {
  await wait(i ? 8000 : 20000);
  await p.screenshot({ path: `scripts/slop-${i}.jpg`, type: 'jpeg', quality: 80 });
}
console.log('webgpu:', await p.evaluate(() => !!navigator.gpu));
console.log('errors:', errs.length ? [...new Set(errs)].slice(0, 25).join('\n  ') : 'none');
await b.close(); server.close(); rmSync(profile, { recursive: true, force: true }); process.exit(0);
