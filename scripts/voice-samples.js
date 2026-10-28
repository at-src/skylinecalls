// Renders the agent's opening lines in candidate male Cartesia Hindi voices (sonic-3, on Bolna's flat-rate list),
// filtered to 8 kHz phone-line audio so they sound like the real call.
// The flow mirrors a real delivery call: agent picks up with "Hello?", rider says who he is, agent answers in one short line.
// Output: Desktop/voice-samples/tothedoor/*.mp3
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const desk = join(homedir(), 'Desktop');
const KEY = readFileSync(join(desk, 'cartesiaapi.txt'), 'utf8').trim();
const OUT = join(desk, 'voice-samples', 'tothedoor');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// line 1: pick-up. line 2: reply after the rider says "Sir, Zepto delivery".
const LINES = ['Hello?', 'Haan ji, bataiye, abhi kahan pahunche ho?'];

const VOICES = {
  Dev: '910fb75e-1d20-4840-ac63-ac6b26a71bdc',
  Sagar: '6303e5fb-a0a7-48f9-bb1a-dd42c216dc5d',
  Anuj: '7e8cb11d-37af-476b-ab8f-25da99b18644',
  Varun: '4cd9f881-58f7-4969-876a-00983214c362',
  Rohan: '4877b818-c7fe-4c89-b1cf-eadf8e23da72',
  Kabir: 'cb9c954d-bcaa-43ed-82bf-aeb5e88a3cb5',
};

const tts = async (id, transcript) => {
  const r = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: { 'X-API-Key': KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model_id: 'sonic-3', transcript, voice: { mode: 'id', id }, language: 'hi', output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 } }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
};

for (const [name, id] of Object.entries(VOICES)) {
  try {
    const parts = [];
    for (const [i, line] of LINES.entries()) {
      const f = join(OUT, `_${i}.wav`);
      writeFileSync(f, await tts(id, line));
      parts.push(f);
    }
    // pick-up, 1.6 s gap (where the rider speaks), reply; then phone-line filter
    execSync(`ffmpeg -v error -y -i "${parts[0]}" -i "${parts[1]}" -filter_complex "[0]apad=pad_dur=1.6[a];[a][1]concat=n=2:v=0:a=1,highpass=f=300,lowpass=f=3400,aresample=8000" -ac 1 -b:a 64k "${join(OUT, name + '.mp3')}"`);
    parts.forEach((p) => rmSync(p));
    console.log('ok  ', name);
  } catch (e) { console.log('FAIL', name, e.message.slice(0, 160)); }
}
