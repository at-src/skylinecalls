// Customer notifications and live approvals over Telegram, plus the "ring the customer" call.
// DRY_RUN=1 (used by tests) records everything as events instead of sending.
import { env } from './env.js';
import { emit, id } from './store.js';

const dry = () => env.DRY_RUN === '1';
const tg = async (method, body) => {
  if (dry() || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, dry: true };
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, ...body }),
  });
  return r.json();
};

// set during the scripted demo replay: never place real calls
export const flags = { noCalls: false };

export function notify(text) {
  emit('notify', { text });
  tg('sendMessage', { text }).catch(() => {});
}

// ---------- live approvals ----------
const approvals = new Map(); // id -> { status: pending|allowed|blocked, caller, created, waiters }

export function requestApproval(caller) {
  const a = { id: id('ap'), status: 'pending', caller, created: Date.now(), waiters: [] };
  approvals.set(a.id, a);
  emit('approval.requested', { approval: a.id, caller });
  tg('sendMessage', {
    text: `❓ Someone is calling for directions to your home.\nThey say: "${caller}"\n\nDo you know them?`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Allow', callback_data: `allow:${a.id}` }, { text: '⛔ Block', callback_data: `block:${a.id}` }]] },
  }).catch(() => {});
  return a;
}

export function resolveApproval(aid, status) {
  const a = approvals.get(aid);
  if (!a || a.status !== 'pending') return a || null;
  a.status = status;
  emit('approval.resolved', { approval: aid, status });
  a.waiters.forEach((w) => w(a));
  a.waiters = [];
  return a;
}

export const getApproval = (aid) => approvals.get(aid) || null;

// wait up to `ms` for the customer to answer
export function waitApproval(aid, ms) {
  const a = approvals.get(aid);
  if (!a || a.status !== 'pending') return Promise.resolve(a);
  return new Promise((res) => {
    const t = setTimeout(() => res(a), ms);
    a.waiters.push((x) => { clearTimeout(t); res(x); });
  });
}

// ---------- ring the customer ----------
export async function ringCustomer(message) {
  emit('customer.ring', { message, dry: dry() || env.ALLOW_CALLS !== '1' });
  notify(`📞 ${message}`);
  if (dry() || flags.noCalls || env.ALLOW_CALLS !== '1' || !env.BOLNA_ALERT_AGENT_ID) return { rang: false, reason: 'calls disabled' };
  const r = await fetch('https://api.bolna.ai/call', {
    method: 'POST', headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: env.BOLNA_ALERT_AGENT_ID, recipient_phone_number: env.CUSTOMER_PHONE, user_data: { message } }),
  });
  return { rang: r.ok };
}
