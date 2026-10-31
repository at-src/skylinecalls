// Voices the example calls on the landing page (skylinecalls-frontend/calls.json), one clip per spoken line.
//   Agent: a Cartesia voice (the same family as the live Bolna agent; AGENT_VOICE picks which).
//   Callers: OpenAI gpt-4o-mini-tts, with an acting note per call, so each sounds like a person, not a voice bank.
//   Hindi voices read Devanagari far better than romanised Hinglish, so each line is transliterated once (Hindi words
//   to Devanagari, English words like OTP or Zepto kept in English) and cached in audio/say.json. The page still shows
//   the Hinglish text.
// Output: ../skylinecalls-frontend/audio/<call>-<n>.mp3 + manifest.json. Needs Desktop/cartesiaapi.txt, OPENAI_API_KEY
// (from .env) and ffmpeg. Usage: node scripts/render-landing-audio.js [call]
//        node scripts/render-landing-audio.js --audition   -> audio/audition/*.mp3, one line in several agent voices
import '../src/env.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const FRONT = process.env.FRONT || '../skylinecalls-frontend';
const OUT = join(FRONT, 'audio');
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const CARTESIA = readFileSync(join(homedir(), 'Desktop', 'cartesiaapi.txt'), 'utf8').trim();
const OPENAI = process.env.OPENAI_API_KEY;
// Cartesia Hindi male voices to audition for the agent
const AGENTS = {
  varun: '4cd9f881-58f7-4969-876a-00983214c362', dev: '910fb75e-1d20-4840-ac63-ac6b26a71bdc', rohan: '4877b818-c7fe-4c89-b1cf-eadf8e23da72',
  kabir: 'cb9c954d-bcaa-43ed-82bf-aeb5e88a3cb5', aryan: '9bde82b6-70e6-4df6-b964-e897cc526b2b', samar: 'f5a7e270-a91b-463e-8997-8ed08b6a6a77',
};
const AGENT = AGENTS[process.env.AGENT_VOICE || 'varun'];
// each call's caller: an OpenAI voice and how to play the part
const CALLERS = {
  rider: ['ash', 'A young Indian delivery rider in his twenties, standing at a building gate on a noisy street. Casual Hinglish, quick, a little out of breath, friendly. Natural, not theatrical.'],
  scam: ['onyx', 'A smooth Indian call-centre fraudster pretending to be a bank official. Confident, slightly pushy, fake-polite, speaking Hinglish fast like he has read the script many times.'],
  renewal: ['verse', 'An Indian insurance renewal agent on a phone call. Polite, practised sales tone, Hinglish, reads numbers clearly.'],
  sales: ['echo', 'An Indian telemarketer selling loans. Upbeat, scripted, a bit too eager, Hinglish.'],
  mom: ['coral', 'A warm Indian mother in her fifties calling her son\'s phone. Affectionate, unhurried, Hindi with a little English.'],
  friend: ['ballad', 'A cheerful young Indian guy calling his friend about cricket tomorrow. Relaxed, casual Hinglish.'],
  inject: ['sage', 'A calm, slightly smug man trying to trick a phone assistant. Even tone, a bit manipulative.'],
};
const AGENT_STYLE = 'Varun, a sharp, friendly young Indian assistant answering someone else\'s phone. Natural Hinglish, relaxed and clear.';

mkdirSync(OUT, { recursive: true });
const sayFile = join(OUT, 'say.json');
const SAY = existsSync(sayFile) ? JSON.parse(readFileSync(sayFile, 'utf8')) : {};
async function devanagari(text) {
  if (SAY[text]) return SAY[text];
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1-mini', temperature: 0, messages: [
      { role: 'system', content: 'Rewrite romanised Hinglish for a Hindi text-to-speech voice. Write the Hindi words in Devanagari. Keep English words (OTP, KYC, Zepto, insurance, premium, zero-dep, add-on, cricket, delivery, test mode, etc.) in Latin script exactly as spoken. Write numbers as words the way a person would say them in Hindi. Keep punctuation. Output only the rewritten line.' },
      { role: 'user', content: text }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('openai ' + r.status);
  return (SAY[text] = j.choices[0].message.content.trim());
}
async function cartesia(voice, transcript) {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', headers: { 'X-API-Key': CARTESIA, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-3', transcript, voice: { mode: 'id', id: voice }, language: 'hi', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  });
  if (!r.ok) throw new Error(`cartesia ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
async function openaiTts(voice, input, instructions) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input, instructions, response_format: 'wav' }),
  });
  if (!r.ok) throw new Error(`openai tts ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}
const seconds = (file) => {
  let out = ''; try { execFileSync(FF, ['-i', file], { stdio: 'pipe' }); } catch (e) { out = String(e.stderr); }
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 100) / 100 : 0;
};
// callers sound like a phone line (band-limited); the agent is a touch cleaner. Both loudness-matched.
function encode(wav, mp3, phone) {
  const filter = phone ? 'highpass=f=250,lowpass=f=3600,loudnorm=I=-18:TP=-2' : 'highpass=f=90,loudnorm=I=-17:TP=-2';
  execFileSync(FF, ['-y', '-loglevel', 'error', '-i', wav, '-af', filter, '-ac', '1', '-ar', '24000', '-b:a', '64k', mp3]);
  rmSync(wav);
}

if (process.argv[2] === '--audition') {
  const dir = join(OUT, 'audition'); mkdirSync(dir, { recursive: true });
  const line = await devanagari('Main koi OTP ya detail share nahi karta. Main unko bata deta hoon.');
  const line2 = await devanagari('Haan, gate se andar aao. Left mein blue building, lift se second floor.');
  for (const [name, id] of Object.entries(AGENTS)) {
    for (const [k, t] of [['a', line], ['b', line2]]) {
      const wav = join(dir, `_${name}-${k}.wav`); writeFileSync(wav, await cartesia(id, t)); encode(wav, join(dir, `${name}-${k}.mp3`), false);
    }
    console.log('audition', name);
  }
  // the old way, for comparison: romanised text straight to the Varun voice
  const wav = join(dir, '_varun-old.wav'); writeFileSync(wav, await cartesia(AGENTS.varun, 'Main koi OTP ya detail share nahi karta. Main unko bata deta hoon.')); encode(wav, join(dir, 'varun-old.mp3'), false);
  writeFileSync(sayFile, JSON.stringify(SAY, null, 1));
  process.exit(0);
}

const ONLY = process.argv[2] || '';
const calls = JSON.parse(readFileSync(join(FRONT, 'calls.json'), 'utf8'));
const manifestFile = join(OUT, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};
for (const [id, call] of Object.entries(calls)) {
  if (ONLY && id !== ONLY) continue;
  let n = 0;
  for (const [who, text] of call.lines) {
    if (who === 'tool') continue;
    const name = `${id}-${n++}`;
    const wav = join(OUT, `_${name}.wav`), mp3 = join(OUT, `${name}.mp3`);
    const said = await devanagari(text);
    if (who === 'varun') writeFileSync(wav, await cartesia(AGENT, said));
    else { const [voice, how] = CALLERS[id] || CALLERS.rider; writeFileSync(wav, await openaiTts(voice, said, how)); }
    encode(wav, mp3, who !== 'varun');
    manifest[name] = seconds(mp3);
    console.log(name, who, manifest[name] + 's', '|', said.slice(0, 60));
  }
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
writeFileSync(sayFile, JSON.stringify(SAY, null, 1));
console.log('clips:', Object.keys(manifest).length);
