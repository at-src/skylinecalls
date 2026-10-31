// Records the live 3D map during the scripted demo delivery, as a looping timelapse for the landing page and the
// demo video. Private DRY_RUN server (no Telegram, no calls). Frames of the map area -> ffmpeg -> MP4 (H.264).
// Usage: PUPPETEER_PKG=<path to a package.json with puppeteer-core> node scripts/record-map.js [out.mp4] [seconds]
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const OUT = process.argv[2] || '../skylinecalls-frontend/media/rider-map.mp4';
const SECS = Number(process.argv[3] || 105);
process.env.DRY_RUN = '1';
process.env.OWNER_NAME = process.env.OWNER_NAME || 'Sam';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-rec-'));
const { start } = await import('../src/server.js');
const PORT = 3290;
const server = await start(PORT);
const profile = mkdtempSync(join(tmpdir(), 'ttd-rec-chrome-'));
const frames = mkdtempSync(join(tmpdir(), 'ttd-rec-frames-'));
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: profile,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage();
await p.setViewport({ width: 1600, height: 900 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await p.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => { localStorage.setItem('ttd-home', JSON.stringify({ lat: 12.91281, lng: 77.63741, label: 'Home' })); localStorage.setItem('ttd-role', 'receiver'); });
await p.goto(`http://localhost:${PORT}/?hour=${process.env.HOUR || '17'}`, { waitUntil: 'domcontentloaded' });
await p.waitForFunction(() => document.getElementById('veil')?.classList.contains('off'), { timeout: 120000 }).catch(() => {});
await wait(4000);
// the scripted delivery through the real tools (what the dashboard's demo used to start); the screen follows the events
await p.evaluate(async () => {
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  await post('/api/home', { lat: 12.91281, lng: 77.63741, label: 'Home' });
  await new Promise((r) => setTimeout(r, 3000));
  await post('/api/demo/replay', {});
});
// Chrome's screencast stream: frames as they're painted (far faster than screenshots with WebGPU). We keep only the
// frames where the map is up, with their timestamps, and let ffmpeg lay them out on a steady clock.
const cdp = await p.createCDPSession();
const t0 = Date.now(); let n = 0, box = null, firstTs = null;
const list = [];
const { writeFileSync } = await import('node:fs');
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  if (!box) return;
  const f = join(frames, `f${String(n++).padStart(5, '0')}.jpg`);
  writeFileSync(f, Buffer.from(data, 'base64'));
  firstTs ??= metadata.timestamp;
  list.push([f, metadata.timestamp - firstTs]);
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, everyNthFrame: 1 });
while (Date.now() - t0 < SECS * 1000) {
  box = await p.evaluate(() => { const m = document.getElementById('mapCol'); if (!m || m.hidden) return null; const r = m.getBoundingClientRect(); return r.width > 100 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null; });
  await wait(500);
}
await cdp.send('Page.stopScreencast');
console.log('frames:', n, 'in', Math.round((Date.now() - t0) / 1000) + 's');
const crop = await p.evaluate(() => { const m = document.getElementById('mapCol').getBoundingClientRect(); return { x: Math.round(m.x), y: Math.round(m.y), w: Math.round(m.width), h: Math.round(m.height), vw: innerWidth }; });
await b.close(); server.close();
if (n < 20) { console.error('map never showed; nothing recorded'); process.exit(1); }
// ffconcat with each frame's real duration, sped up 3x; crop to the map (screencast frames are the full viewport)
const SPEED = Number(process.env.SPEED || 3);
const lines = ['ffconcat version 1.0'];
list.forEach(([f, t], i) => { const next = list[i + 1]?.[1] ?? t + 0.1; lines.push(`file '${f.replace(/\\/g, '/')}'`, `duration ${Math.max(0.01, (next - t) / SPEED).toFixed(3)}`); });
const concat = join(frames, 'list.txt'); writeFileSync(concat, lines.join('\n'));
const shotW = await (async () => { try { const out = execFileSync(FF, ['-i', list[0][0]], { stdio: 'pipe' }); return out; } catch (e) { const m = String(e.stderr).match(/, (\d+)x(\d+)/); return m ? Number(m[1]) : crop.vw; } })();
const k = shotW / crop.vw; // screencast frames may be scaled from CSS pixels
const c = [crop.w, crop.h, crop.x, crop.y].map((v) => Math.round(v * k) & ~1).join(':');
execFileSync(FF, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
  '-vf', `crop=${c},fps=24,scale=1280:-2:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(process.env.CRF || 30), '-movflags', '+faststart', '-an', OUT]);
console.log('wrote', OUT, readdirSync(frames).length, 'frames');
rmSync(frames, { recursive: true, force: true }); rmSync(profile, { recursive: true, force: true });
process.exit(0);
