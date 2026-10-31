// Voices the example calls on the landing page (skylinecalls-frontend/calls.json), one clip per spoken line.
// Agent: Varun, the same Cartesia voice the live Bolna agent uses. Callers: Sagar, Dev, and Meera (Mom).
// Output: ../skylinecalls-frontend/audio/<call>-<n>.mp3 plus audio/manifest.json (clip -> seconds).
// Needs Desktop/cartesiaapi.txt and ffmpeg (FFMPEG env or the path below). Usage: node scripts/render-landing-audio.js [call]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const FRONT = process.env.FRONT || '../skylinecalls-frontend';
const OUT = join(FRONT, 'audio');
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const KEY = readFileSync(join(homedir(), 'Desktop', 'cartesiaapi.txt'), 'utf8').trim();
const VOICES = {
  agent: '4cd9f881-58f7-4969-876a-00983214c362', // Varun
  rider: '6303e5fb-a0a7-48f9-bb1a-dd42c216dc5d', // Sagar
  caller2: '910fb75e-1d20-4840-ac63-ac6b26a71bdc', // Dev
  mom: 'a81fccdc-5595-4dfc-ae76-4de6a515b8a2', // Meera
};
const ONLY = process.argv[2] || '';
const calls = JSON.parse(readFileSync(join(FRONT, 'calls.json'), 'utf8'));
mkdirSync(OUT, { recursive: true });
const manifestFile = join(OUT, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};

async function tts(voice, transcript, language) {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-3', transcript, voice: { mode: 'id', id: voice }, language, output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  });
  if (!r.ok) throw new Error(`cartesia ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
const seconds = (file) => {
  const out = (() => { try { execFileSync(FF, ['-i', file], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr); } })();
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 100) / 100 : 0;
};

for (const [id, call] of Object.entries(calls)) {
  if (ONLY && id !== ONLY) continue;
  let n = 0;
  for (const [who, text, voice, lang] of call.lines) {
    if (who === 'tool') continue;
    const name = `${id}-${n++}`;
    const wav = join(OUT, `_${name}.wav`), mp3 = join(OUT, `${name}.mp3`);
    const v = who === 'varun' ? VOICES.agent : VOICES[voice] || VOICES.rider;
    writeFileSync(wav, await tts(v, text, lang || 'hi'));
    // callers get a light phone-line band-pass so the agent stands out; the agent stays clean
    const filter = who === 'varun' ? 'loudnorm=I=-18:TP=-2' : 'highpass=f=300,lowpass=f=3400,loudnorm=I=-19:TP=-2';
    execFileSync(FF, ['-y', '-loglevel', 'error', '-i', wav, '-af', filter, '-ac', '1', '-ar', '24000', '-b:a', '64k', mp3]);
    rmSync(wav);
    manifest[name] = seconds(mp3);
    console.log(name, who, manifest[name] + 's');
  }
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
console.log('clips:', Object.keys(manifest).length);
