// Renders the scripted demo calls to audio, one clip per line, so the on-screen demos can be heard.
// Agent: Varun, the same Cartesia voice the real Bolna agents use. Rider: Sagar. Sam (teaching the door): Meera.
// Lines that name the delivery app are rendered once per sender. Clips get a light phone-line filter.
// Output: public/demo-audio/*.mp3 and manifest.json (clip -> seconds). Needs Desktop/cartesiaapi.txt and ffmpeg.
// Usage: node scripts/render-demo-audio.js
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SCRIPT as GUIDE } from '../src/demo/replay.js';
import { SCRIPT as TEACH } from '../src/demo/teach.js';
import { SENDERS } from '../src/sender.js';

const KEY = readFileSync(join(homedir(), 'Desktop', 'cartesiaapi.txt'), 'utf8').trim();
const OUT = 'public/demo-audio';
const VOICE = {
  agent: '4cd9f881-58f7-4969-876a-00983214c362', // Varun
  rider: '6303e5fb-a0a7-48f9-bb1a-dd42c216dc5d', // Sagar
  customer: 'a81fccdc-5595-4dfc-ae76-4de6a515b8a2', // Meera
};
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

async function tts(voice, transcript) {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-3', transcript, voice: { mode: 'id', id: voice }, language: 'hi', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}
const manifest = {};
async function clip(name, role, text) {
  const wav = join(OUT, `_${name}.wav`), mp3 = join(OUT, `${name}.mp3`);
  writeFileSync(wav, await tts(VOICE[role], text));
  execSync(`ffmpeg -v error -y -i "${wav}" -af "highpass=f=220,lowpass=f=3800,aresample=16000" -ac 1 -b:a 48k "${mp3}"`);
  rmSync(wav);
  manifest[name] = Number(Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp3}"`).toString()).toFixed(2));
  console.log(name.padEnd(18), manifest[name] + 's', text.slice(0, 60));
}
const brand = (id) => SENDERS[id]?.name || id.charAt(0).toUpperCase() + id.slice(1);
for (const [i, [role, text]] of GUIDE.entries()) {
  if (/Zepto/.test(text)) for (const id of Object.keys(SENDERS)) await clip(`guide-${i}-${id}`, role, text.replace(/Zepto/g, brand(id)));
  else await clip(`guide-${i}`, role, text);
}
for (const [i, [role, text]] of TEACH.entries()) if (text && text !== 'Got it.') await clip(`teach-${i}`, role, text);
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(Object.keys(manifest).length, 'clips');
