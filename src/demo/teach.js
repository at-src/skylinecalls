// Scripted calibration call: Sam teaches the way from BDA Complex to the door, through the REAL calibration tools, so
// the live screen shows the path being learned stop by stop. No phone call and no Telegram message: on screen only.
// The points come from the demo door file, so the taught path matches the one the guidance demo uses.
import { readFileSync } from 'node:fs';
import { emit } from '../store.js';
import { flags } from '../notify.js';

const DEMO = JSON.parse(readFileSync(new URL('./door-hsr.json', import.meta.url), 'utf8'));
const S = DEMO.steps;
const step = (i) => ({ instruction: S[i].instruction, see: S[i].see, pass: S[i].pass, side: S[i].side, distance_m: S[i].distance_m, check: S[i].check, lat: S[i].lat, lng: S[i].lng, landmark: S[i].see[0], map_matches: S[i].map_matches });

// [role, line, tool, args(session id)]
const SCRIPT = [
  ['agent', 'Hi Sam! Chaliye aapke ghar ka raasta set karte hain, taaki koi bhi rider seedha darwaze tak aa sake. Aapke ghar ke paas sabse bada landmark kaunsa hai, jo sab jaante hain?'],
  ['customer', 'BDA Complex, 14th Main Road pe. Gate ke bilkul paas Punjab National Bank hai.', 'save_anchor', () => ({ name: 'BDA Complex', also_called: DEMO.anchor.also_called, description: DEMO.anchor.description, lat: DEMO.anchor.lat, lng: DEMO.anchor.lng })],
  ['agent', 'Mil gaya, BDA Complex, Sector 6. Gate pe road ki taraf face karke khade ho, toh pehle kidhar jaana hai?'],
  ['customer', 'Left, seedha 14th Main pe, McDonald\'s tak. Sau-sava sau metre. Beech mein Travel Buddy aur ek footwear shop aati hai.', 'save_step', () => step(0)],
  ['agent', 'Theek, McDonald\'s left mein aayega. Uske baad?'],
  ['customer', 'McDonald\'s ke just baad left mein ek patli gali hai, blue iron gate wali.', 'save_step', () => step(1)],
  ['agent', 'Blue gate ke andar kya hai?'],
  ['customer', 'Andar passage mein bikes khadi hoti hain. Unke peeche seedhi hai.', 'save_step', () => step(2)],
  ['agent', 'Aur seedhi se upar?'],
  ['customer', 'Second floor, right wala darwaza, green nameplate. Bell kharab hai, knock karna.', 'save_step', () => step(3)],
  ['agent', 'Got it.', 'save_door', () => DEMO.door],
  ['agent', 'Aur agar ghar pe koi na ho toh rider kya kare?'],
  ['customer', 'Bahar shoe rack pe rakh de, aur photo bhej de.', 'save_fallback', () => DEMO.fallback],
  ['agent', 'Bas ek second, check kar raha hoon.', 'finish_calibration', () => ({})],
  ['agent', 'Ho gaya Sam. BDA Complex gate se left, McDonald\'s tak seedha, phir blue gate, bikes ke peeche seedhi, second floor right, green nameplate. Ab koi bhi rider phone karega toh main usse yahi raasta bataunga.'],
  ['customer', 'Perfect, thank you!']
];

let running = false;
export async function teach(TOOLS, { pace = 1 } = {}) {
  if (running) return { ok: false, error: 'already running' };
  running = true; flags.noCalls = true; flags.quiet = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / pace));
  try {
    const start = await TOOLS.start_calibration({ customer: 'Sam', door_id: DEMO.id });
    const cid = start.calibration_id;
    emit('call.started', { demo: true, caller: 'Sam · teaching the door', kind: 'calibration' });
    await sleep(1500);
    for (const [role, text, tool, args] of SCRIPT) {
      if (text && text !== 'Got it.') emit('call.line', { role, text, kind: 'calibration' });
      if (text && text !== 'Got it.') await sleep(role === 'customer' ? 900 : 600);
      if (tool) {
        const a = { calibration_id: cid, ...args() };
        emit('tool.call', { tool, args: a });
        const out = await TOOLS[tool](a);
        emit('tool.result', { tool, out, args: a });
      }
      if (text && text !== 'Got it.') await sleep(Math.min(4200, 1400 + text.length * 34));
    }
    emit('call.ended', { demo: true, kind: 'calibration' });
    return { ok: true };
  } finally { running = false; flags.noCalls = false; flags.quiet = false; }
}
