// Agent voice audition across providers: the same two lines in each candidate voice, then an audio-capable model
// listens to every clip and scores it (naturalness, age, accent, robotic or not). Output: ../skylinecalls-frontend/
// audio/audition2/<id>.mp3 + scores.json. Keys from Desktop/*.txt and .env; nothing printed.
// Usage: node scripts/voice-audition.js
import '../src/env.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const key = (f) => readFileSync(join(homedir(), 'Desktop', f), 'utf8').trim().split(/\s+/)[0];
const EL = key('11labsapi.txt'), SARVAM = key('sarvamnewapi.txt'), CARTESIA = key('cartesiaapi.txt'), OPENAI = process.env.OPENAI_API_KEY;
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const OUT = '../skylinecalls-frontend/audio/audition2';
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
// what the agent says on two very different calls: refusing a scammer, and directing a rider
const DEV = 'नमस्ते जी, मैं कोई OTP या detail शेयर नहीं करता। मैं Sam को बता देता हूँ। हाँ भाई, gate से अंदर आओ, left में blue building है, lift से second floor।';
const ROMAN = 'Namaste ji, main koi OTP ya detail share nahi karta. Main Sam ko bata deta hoon. Haan bhai, gate se andar aao, left mein blue building hai, lift se second floor.';

const el = (voice, model = 'eleven_multilingual_v2') => async () => {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`, {
    method: 'POST', headers: { 'xi-api-key': EL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: DEV, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
  });
  if (!r.ok) throw new Error(`elevenlabs ${r.status} ${(await r.text()).slice(0, 120)}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: 'mp3' };
};
const sarvam = (speaker) => async () => {
  const r = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST', headers: { 'api-subscription-key': SARVAM, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: DEV, target_language_code: 'hi-IN', model: 'bulbul:v3', speaker, pace: 1.05 }),
  });
  if (!r.ok) throw new Error(`sarvam ${r.status} ${(await r.text()).slice(0, 120)}`);
  const j = await r.json();
  return { buf: Buffer.from(j.audios[0], 'base64'), ext: 'wav' };
};
const openai = (voice) => async () => {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: DEV, response_format: 'wav', instructions: 'A sharp, friendly young Indian man in his late twenties answering someone else\'s phone. Natural Hinglish, relaxed, warm, clear. Not formal, not theatrical.' }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: 'wav' };
};
const cartesia = (id, text = DEV) => async () => {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST', headers: { 'X-API-Key': CARTESIA, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-3', transcript: text, voice: { mode: 'id', id }, language: 'hi', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  });
  if (!r.ok) throw new Error(`cartesia ${r.status}`);
  return { buf: Buffer.from(await r.arrayBuffer()), ext: 'wav' };
};
const CANDIDATES = {
  'el-viraj': el('iWNf11sz1GrUE4ppxTOL'),
  'el-abhishek': el('0oZaNvOUQnpeHSZr7Nzi'),
  'el-neeraj': el('H9oourY5nVeVuzarh4D5'),
  'el-keshav': el('pUPXMTdMR5Gxduol1I9M'),
  'sarvam-varun': sarvam('varun'), 'sarvam-aditya': sarvam('aditya'), 'sarvam-rahul': sarvam('rahul'),
  'sarvam-advait': sarvam('advait'), 'sarvam-anand': sarvam('anand'), 'sarvam-kabir': sarvam('kabir'), 'sarvam-shubh': sarvam('shubh'),
  'openai-ash': openai('ash'), 'openai-verse': openai('verse'),
  'cartesia-varun': cartesia('4cd9f881-58f7-4969-876a-00983214c362'),
};
const made = [];
for (const [id, fn] of Object.entries(CANDIDATES)) {
  try {
    const { buf, ext } = await fn();
    const raw = join(OUT, `_${id}.${ext}`); writeFileSync(raw, buf);
    execFileSync(FF, ['-y', '-loglevel', 'error', '-i', raw, '-af', 'loudnorm=I=-17:TP=-2', '-ac', '1', '-ar', '24000', '-b:a', '64k', join(OUT, `${id}.mp3`)]);
    rmSync(raw); made.push(id); console.log('made', id);
  } catch (e) { console.log('skip', id, '-', e.message.slice(0, 120)); }
}

// an audio model listens to each clip and scores it
async function judge(id) {
  const b64 = readFileSync(join(OUT, `${id}.mp3`)).toString('base64');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-audio-preview', modalities: ['text'], temperature: 0, messages: [
      { role: 'system', content: 'You judge text-to-speech voices for a phone assistant in India. The ideal voice is a natural-sounding young Indian man (25-35) speaking casual Hinglish, warm and clear, indistinguishable from a real person. Listen carefully.' },
      { role: 'user', content: [
        { type: 'text', text: `The clip says: "${ROMAN}". Score it. Reply JSON only: {"naturalness":1-10,"sounds_like_age":number,"indian_accent":1-10,"hinglish_pronunciation":1-10,"robotic":true|false,"note":"short"}` },
        { type: 'input_audio', input_audio: { data: b64, format: 'mp3' } }] }] }),
  });
  const j = await r.json();
  if (!r.ok) return { error: j.error?.message?.slice(0, 120) };
  try { return JSON.parse(j.choices[0].message.content.replace(/^```json|```$/g, '').trim()); } catch { return { raw: j.choices[0].message.content.slice(0, 200) }; }
}
const scores = {};
for (const id of made) { scores[id] = await judge(id); const s = scores[id]; console.log(id.padEnd(16), s.error || s.raw || `natural ${s.naturalness} | age ${s.sounds_like_age} | accent ${s.indian_accent} | hinglish ${s.hinglish_pronunciation} | robotic ${s.robotic} | ${s.note}`); }
writeFileSync(join(OUT, 'scores.json'), JSON.stringify(scores, null, 1));
