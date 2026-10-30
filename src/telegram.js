// Telegram bot (long polling). Only the customer's own chat is accepted.
//   "I have an order with Zepto", "zepto", "uber 98xxxxxx10"  -> registers an expected visitor
//   "status"  -> active visits      "done" -> closes the latest visit
//   Allow / Block buttons -> live approval for an unknown caller
import { env } from './env.js';
import { emit } from './store.js';
import { createVisit, activeVisits, awaitingVisits, detectService, closeVisit } from './visits.js';
import { confirmDelivery } from './guide.js';
import { setMode, savePerson, KIND_LABEL, ownerMessage } from './assistant.js';
import { resolveApproval } from './notify.js';
import { setPosition, getRider } from './rider.js';

const api = (m, body) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${m}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
const say = (text) => (text ? api('sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text }) : null);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function handleText(text) {
  const t = String(text || '').trim();
  const low = t.toLowerCase();
  if (/^\/start|^hi$|^hello$|^help/.test(low)) {
    return 'Hi! Tell me when someone is coming, e.g. "I have an order with Zepto" or "booked an Uber". I\'ll guide only them to your door. Send "status" to see who\'s expected.';
  }
  // reminders: "remind me to call Rahul at 6pm"
  const rem = ownerMessage(t);
  if (rem) return rem.say || 'Saved.';
  // modes: available / screened / unavailable (and friendly words)
  const mode = low.match(/^(available|free|screen|screened|filter|unavailable|busy|dnd|do not disturb)\b/);
  if (mode) {
    const m = { available: 'available', free: 'available', screen: 'screened', screened: 'screened', filter: 'screened', unavailable: 'unavailable', busy: 'unavailable', dnd: 'unavailable', 'do not disturb': 'unavailable' }[mode[1]];
    setMode(m);
    return { available: 'Available: calls ring you directly. I only pick up a missed one.', screened: 'Screened: I answer first, filter spam, and put real people through.', unavailable: 'Unavailable: I handle everything; only your code reaches you.' }[m];
  }
  const sv = t.match(/^(save|block)\s+(\+?[\d\s-]{10,16})(?:\s+as\s+([^,]+?)(?:,\s*(.+))?)?$/i);
  if (sv) {
    const block = sv[1].toLowerCase() === 'block';
    const rel = (sv[4] || '').trim().toLowerCase();
    const kind = block ? 'blocked' : /mom|dad|mother|father|wife|husband|brother|sister|cousin|friend|family/.test(rel) ? 'close' : /boss|manager|client|doctor/.test(rel) ? 'vip' : 'known';
    const p = savePerson(sv[2], { name: (sv[3] || '').trim() || undefined, relation: rel || undefined, kind });
    return p ? (block ? "Blocked. I'll cut them off." : `Saved ${p.name || 'them'} as ${KIND_LABEL[kind].toLowerCase()}.`) : 'That number looks wrong.';
  }
  if (/^status/.test(low)) {
    const a = activeVisits();
    return a.length ? 'Expecting:\n' + a.map((v) => `• ${cap(v.service)} (code ${v.code}), until ${new Date(v.expires).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`).join('\n') : 'Nobody is expected right now.';
  }
  // answering 'did it arrive?'
  if (awaitingVisits().length && /^(not received|not delivered|nahi mila|didn.?t (get|receive)|no\b)/.test(low)) return confirmDelivery(null, false, 'Telegram') ? '' : 'Nothing waiting for an answer.';
  if (awaitingVisits().length && /^(received|got it|mil gaya|yes|done)/.test(low)) return confirmDelivery(null, true, 'Telegram') ? '' : 'Nothing waiting for an answer.';
  if (/^(done|cancel|received)/.test(low)) {
    const a = activeVisits().pop();
    if (!a) return 'Nothing to close.';
    closeVisit(a.id, low.startsWith('cancel') ? 'cancelled' : 'delivered', 'closed from Telegram');
    return `Closed the ${cap(a.service)} visit.`;
  }
  const service = detectService(low);
  const ordered = /order|deliver|coming|booked|book|cab|ride|parcel|package|aa raha|aayega/.test(low);
  if (service || ordered) {
    const phone = (t.match(/(?:\+?91)?[6-9]\d{9}/) || [])[0] || null;
    const v = createVisit({ service: service || 'delivery', rider_phone: phone, source: 'telegram' });
    return `Got it, expecting ${cap(v.service)} for the next 3 hours.\nDelivery code: ${v.code} (share it on the app's delivery note if you like).\nI'll guide only them and message you as they get close.`;
  }
  return 'Tell me who is coming, e.g. "order with Swiggy" or "booked a Rapido". Send "status" to see who\'s expected.';
}

// A location (one pin or Telegram live location) becomes the rider's position for the latest active visit.
// Live location keeps arriving as edited messages every few seconds.
const tracking = new Set();
export function handleLocation(loc, live = false) {
  const v = activeVisits().pop();
  if (!v) return 'Nobody is expected right now. Tell me who is coming first, e.g. "order with Zepto".';
  setPosition(v.id, { lat: loc.latitude, lng: loc.longitude }, live ? 'telegram-live' : 'telegram-pin');
  if (tracking.has(v.id)) return null; // don't reply to every live update
  tracking.add(v.id);
  return live
    ? `📍 Got live location for the ${cap(v.service)} rider. I'll track it until the delivery is done.`
    : `📍 Got the ${cap(v.service)} rider's position. Send a live location to keep it updating.`;
}

let offset = 0, running = false;
export async function startTelegram() {
  if (running || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  running = true;
  // skip anything sent before the server started
  try { const u = await api('getUpdates', { offset: -1 }); offset = u.result?.length ? u.result[0].update_id + 1 : 0; } catch {}
  while (running) {
    try {
      const u = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query'] });
      for (const up of u.result || []) {
        offset = up.update_id + 1;
        const msg = up.message || up.edited_message;
        const chat = String(msg?.chat?.id || up.callback_query?.message?.chat?.id || '');
        if (chat !== String(env.TELEGRAM_CHAT_ID)) continue; // only the customer
        if (msg?.location) {
          const out = handleLocation(msg.location, !!msg.location.live_period || !!up.edited_message);
          if (out) await say(out);
          continue;
        }
        if (up.message?.text) {
          emit('telegram.in', { text: up.message.text });
          await say(handleText(up.message.text));
        }
        if (up.callback_query && /^(got|miss):/.test(up.callback_query.data)) {
          const [act, vid] = String(up.callback_query.data).split(':');
          const ok = confirmDelivery(vid, act === 'got', 'Telegram');
          await api('answerCallbackQuery', { callback_query_id: up.callback_query.id, text: ok ? (act === 'got' ? 'Marked delivered' : 'Marked not received') : 'Already closed' });
          continue;
        }
        if (up.callback_query) {
          const [act, aid] = String(up.callback_query.data).split(':');
          resolveApproval(aid, act === 'allow' ? 'allowed' : 'blocked');
          await api('answerCallbackQuery', { callback_query_id: up.callback_query.id, text: act === 'allow' ? 'Allowed' : 'Blocked' });
          await say(act === 'allow' ? '✅ Allowed. I\'ll guide them to your door.' : '⛔ Blocked. I won\'t share anything with them.');
        }
      }
    } catch (e) { emit('error', { where: 'telegram', message: e.message }); await new Promise((r) => setTimeout(r, 3000)); }
  }
}
export const stopTelegram = () => { running = false; };
