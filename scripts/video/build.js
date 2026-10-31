// Builds the demo video: narrated stickman intro -> real calls on the dashboard (from scripts/demo-process.js) ->
// narrated outro. Narration: an ElevenLabs premade voice. The intro/outro are rendered frame by frame from
// story.html, timed to the narration, so picture and voice line up exactly.
// Usage: node scripts/video/build.js [call ids...]   -> C:/Users/at261/ttd-tools/skyline-demo.mp4
import '../../src/env.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || 'C:/Users/at261/parkwise-backup/package.json')('puppeteer-core');
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const WORK = 'C:/Users/at261/ttd-tools/video'; mkdirSync(WORK, { recursive: true });
const CALLS = 'C:/Users/at261/ttd-tools/calls';
const EL = readFileSync(join(homedir(), 'Desktop', '11labsapi.txt'), 'utf8').trim().split(/\s+/)[0];
const VOICE = process.env.NARRATOR || 'JBFqnCBsd6RMkjVDRZzb'; // George: warm storyteller (premade)
const run = (args) => execFileSync(FF, ['-y', '-loglevel', 'error', ...args]);
const dur = (f) => { const m = String(spawnSync(FF, ['-i', f], { encoding: 'utf8' }).stderr).match(/Duration: (\d+):(\d+):([\d.]+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

async function say(name, text) {
  const out = join(WORK, `n-${name}.mp3`);
  if (existsSync(out)) return out;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': EL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status} ${(await r.text()).slice(0, 160)}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer())); return out;
}

// the narration, line by line; each line names the scene it starts
const INTRO = [
  ['sam', 'This is Sam. Sam is a busy founder in Bengaluru.'],
  ['rings', 'And Sam\'s phone never stops. Twenty sales calls a day. A delivery rider who can\'t find the building. A bank that isn\'t really a bank.'],
  ['hours', 'That\'s nearly two hours a day on calls. And most of them didn\'t need Sam at all.'],
  ['meet', 'So Sam got himself an agent. This is Skyline Calls. Meet Varun. He picks up Sam\'s calls, and here are real calls he took.'],
];
const OUTRO = [
  ['outro', 'Now Varun takes the calls. Sam gets one line on Telegram for each, and only the calls that matter reach him.'],
  ['end', 'Skyline Calls. Your own voice agent. Try it live at skylinecalls dot vercel dot app. Powered by Bolna.'],
];

async function narrated(lines, gap = 0.35, lead = 0.6, tail = 1.2) {
  const parts = []; const T = {}; let t = lead;
  for (const [scene, text] of lines) { const f = await say(scene, text); T[scene] = t; parts.push([f, t]); t += dur(f) + gap; }
  return { parts, T, total: t + tail };
}
// render story.html frame by frame between t0 and t1 at 30 fps, with the narration mixed at its times
async function renderStory(name, T, t0, t1, parts) {
  const frames = join(WORK, `frames-${name}`); rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
  const p = await b.newPage(); await p.setViewport({ width: 1600, height: 900 });
  await p.goto(pathToFileURL(join(import.meta.dirname, 'story.html')).href + '?T=' + encodeURIComponent(JSON.stringify(T)), { waitUntil: 'networkidle0' });
  await p.evaluate(() => document.fonts.ready);
  const FPS = 30, n = Math.ceil((t1 - t0) * FPS);
  for (let i = 0; i < n; i++) {
    await p.evaluate((t) => window.render(t), t0 + i / FPS);
    await p.screenshot({ path: join(frames, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 88 });
  }
  await b.close();
  const ins = ['-framerate', String(FPS), '-i', join(frames, 'f%05d.jpg')];
  const mix = [];
  parts.forEach(([f, t], i) => { ins.push('-i', f); mix.push(`[${i + 1}:a]adelay=${Math.round((t - t0) * 1000)},apad[a${i}]`); });
  const fc = `${mix.join(';')};${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:dropout_transition=0,volume=${parts.length},atrim=0:${(t1 - t0).toFixed(2)},loudnorm=I=-16:TP=-1.5,aresample=48000,aformat=channel_layouts=mono[out]`;
  const out = join(WORK, `${name}.mp4`);
  run([...ins, '-filter_complex', fc, '-map', '0:v', '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest', out]);
  rmSync(frames, { recursive: true, force: true });
  console.log(name, (t1 - t0).toFixed(1) + 's');
  return out;
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['sales', 'scam', 'rider', 'friend'];
const intro = await narrated(INTRO);
const outro = await narrated(OUTRO, 0.5, 0.4, 1.8);
// one timeline object for story.html: outro scenes shifted after the intro
const T = { ...intro.T, outro: 1000 + outro.T.outro, card: 1000 + outro.T.end - 0.3, end: 1000 + outro.total };
const introMp4 = await renderStory('intro', T, 0, intro.total, intro.parts);
const outroMp4 = await renderStory('outro', T, 1000, 1000 + outro.total, outro.parts.map(([f, t]) => [f, t + 1000]));
// the call segments, normalised to the same format
const segs = ids.map((id) => join(CALLS, id, 'segment.mp4')).filter(existsSync);
const norm = segs.map((f, i) => { const o = join(WORK, `seg-${i}.mp4`); run(['-i', f, '-vf', 'scale=1600:900,fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '1', o]); return o; });
const list = join(WORK, 'list.txt');
writeFileSync(list, [introMp4, ...norm, outroMp4].map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
const out = 'C:/Users/at261/ttd-tools/skyline-demo.mp4';
run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
console.log('video:', out, dur(out).toFixed(1) + 's', '| calls:', segs.length);
