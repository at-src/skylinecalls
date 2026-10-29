// Scripted demo call. Plays a full delivery through the REAL tools (verification, map lookups, door path,
// customer alert, outcome) so the live screen can be shown without a phone call. The agent's lines are scripted;
// everything the screen shows about where the rider is comes from the real tool results.
// No real phone calls are placed and nothing is sent to Telegram during a replay: the Telegram side shows on screen.
import { emit } from '../store.js';
import { createVisit, getVisit } from '../visits.js';
import { flags, notify } from '../notify.js';
import { confirmDelivery } from '../guide.js';
import { clipFor } from './audio.js';

// the rider's phone (app calls usually come from the delivery app's masked number)
const RIDER = '+918047300112';
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const SCRIPT = [
  ['agent', 'Hello?', 'lookup_caller', () => ({ caller_number: RIDER })],
  ['rider', 'Haan sir, Zepto se. Aapka order hai.', 'classify_caller', (v) => ({ caller_number: RIDER, visit_id: v.id, org: cap(v.service), purpose: 'aapka order hai', guess: 'delivery' })],
  ['agent', 'Haan ji, bolo. Location pe ho abhi?'],
  ['rider', 'Nahi sir, Agara lake ke paas aa gaya, galat mud gaya.', 'next_instruction', (v) => ({ visit_id: v.id, seen: 'Agara lake ke paas' })],
  ['agent', 'Achha. Ring Road pakdo, Silk Board ki taraf. Flyover ke baad 9th Main pe left.'],
  ['rider', 'Haan, 9th Main pe hoon. BDA Complex dikh raha hai.', 'next_instruction', (v) => ({ visit_id: v.id, seen: 'BDA Complex dikh raha hai' })],
  ['agent', 'Haan wahi. Gate se left lo, McDonald\'s tak seedha aao.'],
  ['rider', 'Travel Buddy ke saamne se jaa raha hoon.', 'next_instruction', (v) => ({ visit_id: v.id, seen: 'Travel Buddy ke saamne se' })],
  ['agent', 'Haan sahi ja rahe ho. McDonald\'s left mein aayega.'],
  ['rider', 'McDonald\'s dikh gaya.', 'next_instruction', (v) => ({ visit_id: v.id, seen: "McDonald's dikh gaya" })],
  ['agent', 'Uske just baad left mein ek blue gate hai. Dikha?'],
  ['rider', 'Haan, blue gate pe hoon.', 'next_instruction', (v) => ({ visit_id: v.id, seen: 'blue gate pe hoon' })],
  ['agent', 'Andar aao. Bikes ke peeche seedhi hai.'],
  ['rider', 'Seedhi pe hoon.', 'next_instruction', (v) => ({ visit_id: v.id, seen: 'stairs pe hoon' })],
  ['agent', 'Upar aa jao. Second floor, right wala darwaza, green nameplate. Knock karna, bell kharab hai.'],
  ['rider', 'Knock kiya, koi khol nahi raha.', 'call_customer', (v) => ({ visit_id: v.id, reason: 'is at the door and nobody is opening' })],
  ['agent', 'Ruko, bulata hoon. Bhaiya shoe rack pe rakh do, photo bhej dena.'],
  ['rider', 'Theek hai, rakh diya.', 'log_outcome', (v) => ({ visit_id: v.id, result: 'left on the shoe rack', note: 'photo sent' })],
  ['agent', 'Haan theek hai, thanks.', 'end_call', (v) => ({ caller_number: RIDER, org: cap(v.service), kind: 'delivery', summary: 'guided to the door, left on the shoe rack', outcome: 'delivered' })],
];

let running = false;
export const isReplaying = () => running;

export async function replay(TOOLS, { pace = 1, visit_id = null, caller = '+91 80473 00112', service = 'zepto' } = {}) {
  if (running) return { ok: false, error: 'already running' };
  running = true; flags.noCalls = true; flags.quiet = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / pace));
  try {
    let v = visit_id ? getVisit(visit_id) : null;
    if (!v) {
      // Sam tells the bot an order is on its way: only this rider will be guided
      emit('telegram.in', { text: 'I have an order with Zepto' });
      await sleep(900);
      v = createVisit({ service, source: 'demo' });
      notify("Got it, expecting Zepto for the next 3 hours. I'll guide only them and message you as they get close.");
      await sleep(2200);
    }
    emit('call.started', { visit: v.id, demo: true, caller, kind: 'line', number: RIDER });
    await sleep(1500);
    for (const [i, [role, text, tool, args]] of SCRIPT.entries()) {
      const said = text.replace(/Zepto/g, v.service.charAt(0).toUpperCase() + v.service.slice(1));
      const clip = clipFor('guide', i, v.service);
      emit('call.line', { visit: v.id, role, text: said, audio: clip?.src || null });
      // with audio: the line plays out, then the agent looks it up; without: the old reading-speed pause
      if (clip) await sleep(clip.seconds * 1000 + 250); else await sleep(role === 'rider' ? 900 : 600);
      if (tool) {
        const a = args(v);
        emit('tool.call', { tool, args: a });
        const out = await TOOLS[tool](a);
        emit('tool.result', { tool, out });
      }
      await sleep(clip ? (role === 'rider' ? 700 : 450) : Math.min(4200, 1400 + text.length * 38));
    }
    emit('call.ended', { visit: v.id, demo: true });
    // Sam sees the rider's word on Telegram and confirms it
    await sleep(4200);
    emit('telegram.in', { text: '✅ Received' });
    await sleep(600);
    confirmDelivery(v.id, true, 'Telegram');
    return { ok: true };
  } finally { running = false; flags.noCalls = false; flags.quiet = false; }
}
