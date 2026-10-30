// Sam's line: the agent that answers every call for him. It knows who's who (people it has met, and what Sam told
// it), follows his rules for each kind of caller with a time limit, uses his briefings for calls he expects, lets
// close ones reach him with a passcode, guides deliveries to the door, and tells him what it did after every call.
import { load, save, emit, id } from './store.js';
import { notify } from './notify.js';
import { detectService } from './visits.js';
import { verify } from './guide.js';
import { env } from './env.js';

// ---------- what Sam told it ----------
export const KINDS = ['close', 'vip', 'known', 'service', 'sales', 'delivery', 'unknown'];
export const KIND_LABEL = { close: 'Close one', vip: 'VIP', known: 'Known', service: 'Service', sales: 'Sales / spam', delivery: 'Delivery / cab', unknown: 'Unknown', blocked: 'Blocked' };
// Three modes. Note: in a real deploy, "available" means the call rings the owner directly and Varun never picks up;
// Varun only answers in screened/unavailable. In this demo every call reaches Varun so it can be shown, but the mode
// still changes how he behaves on the line.
export const MODES = {
  available: '{owner} takes calls himself. You only pick up if he misses it. Keep it short: greet, say you will let him know, and alert him for anyone he knows.',
  screened: '{owner} is reachable but wants calls screened. Answer every call, work out who it is, handle spam and services yourself, and put real people through by alerting {owner} (close ones and VIPs, or a correct passcode).',
  unavailable: '{owner} is not taking calls. Handle everything yourself: decline spam, deal with services, take messages. Only a correct passcode reaches him.',
};
const DEFAULT_PROFILE = {
  owner: 'Sam', mode: 'screened', passcode: '55434', busy_until: '',
  rules: {
    close: { say: 'Greet them by name. Say Sam is busy and take the message. If it is urgent, alert him.', budget: 120 },
    vip: { say: 'Be respectful. Take the message and alert Sam right away.', budget: 60 },
    known: { say: 'Greet them by name. Use the briefing if there is one, else take a message.', budget: 90 },
    service: { say: 'Handle it for Sam: what it is about, any amount, the due date and what he has to do. Never share an OTP, card or account details, never agree to pay, buy or change anything.', budget: 60 },
    sales: { say: 'Sam is not interested. Ask them to remove his number. Do not listen to the pitch. End fast.', budget: 20 },
    delivery: { say: 'Guide them to the door with the door path.', budget: 300 },
    unknown: { say: 'Ask who they are and why they are calling, then treat them by what they say. If they will not say, take a message.', budget: 45 },
  },
};
// people the demo line already knows (fictional numbers)
const DEFAULT_PEOPLE = {
  '+919876500001': { name: 'Mom', relation: 'mother', kind: 'close' },
  '+919900112233': { name: 'Rohit', relation: 'close friend', kind: 'close' },
  '+919811122233': { name: 'Priya Menon', relation: 'manager at work', kind: 'vip' },
  '+919845566778': { name: 'Mr Sharma', relation: 'landlord', kind: 'known' },
  '+919820033344': { name: 'Rahul Verma', relation: 'investor, XYZ Capital', org: 'XYZ Capital', kind: 'known' },
};
const DEFAULT_BRIEFINGS = [
  {
    id: 'b_rent', who: 'Mr Sharma (landlord)', names: ['sharma'], orgs: [], numbers: ['+919845566778'],
    about: 'This month\'s rent (₹28,000), due on the 3rd.',
    goal: 'Get time to pay. Sam is short this month.',
    can_agree: ['Pay by the 10th', 'Any date up to the 15th, if he pushes'],
    must_not: ['Agree to a date after the 15th', 'Agree to a late fee'],
    private: ['Why Sam is short of money'],
    until: '', source: 'Told by Sam',
  },
  {
    id: 'b_xyz', who: 'Rahul Verma, XYZ Capital (investor)', names: ['rahul'], orgs: ['xyz', 'xyz capital'], numbers: ['+919820033344'],
    about: 'Seed round: ₹1 Cr for the company.',
    goal: 'Only move ahead at ₹8 Cr pre-money or more.',
    can_agree: ['₹8 Cr pre-money or higher: say Sam will send the paperwork'],
    must_not: ['Agree to anything below ₹8 Cr', 'Agree to a board seat'],
    private: ['That another fund (Peak Ventures) offered ₹7.5 Cr'],
    until: '', source: 'Imported from a ChatGPT chat',
  },
];
export const profile = () => load('profile', DEFAULT_PROFILE);
export const people = () => load('people', DEFAULT_PEOPLE);
export const briefings = () => load('briefings', DEFAULT_BRIEFINGS);
export const calls = () => load('calls', []);
const saveProfile = (p) => { save('profile', p); emit('line.updated', { what: 'profile' }); return p; };
const savePeople = (p) => { save('people', p); emit('line.updated', { what: 'people' }); return p; };
const saveBriefings = (b) => { save('briefings', b); emit('line.updated', { what: 'briefings' }); return b; };

export function setMode(mode) { if (!MODES[mode]) return { error: 'unknown mode' }; const p = profile(); p.mode = mode; return saveProfile(p); }
export function setRule(kind, { say, budget }) {
  const p = profile(); if (!p.rules[kind]) return { error: 'unknown kind' };
  if (say != null) p.rules[kind].say = String(say).slice(0, 400);
  if (budget != null && Number(budget) > 0) p.rules[kind].budget = Math.min(600, Math.round(Number(budget)));
  return saveProfile(p);
}
export function setPasscode(code) { const p = profile(); p.passcode = String(code).replace(/\D/g, '').slice(0, 8) || p.passcode; return saveProfile(p); }

// ---------- numbers ----------
export function normNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  return '+' + d;
}
export const showNumber = (n) => { const m = String(n).match(/^\+91(\d{5})(\d{5})$/); return m ? `+91 ${m[1]} ${m[2]}` : n || 'Unknown number'; };
export function savePerson(number, patch) {
  const n = normNumber(number); if (!n) return null;
  const all = people(); all[n] = { ...(all[n] || {}), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null && v !== '')) };
  savePeople(all); return { number: n, ...all[n] };
}
export function forgetPerson(number) { const all = people(); delete all[normNumber(number)]; savePeople(all); return { ok: true }; }

// ---------- briefings ----------
export function addBriefing(b) {
  const list = briefings();
  const clean = {
    id: id('b'), who: String(b.who || 'Someone').slice(0, 80),
    names: (b.names || []).map((x) => String(x).toLowerCase()).filter(Boolean),
    orgs: (b.orgs || []).map((x) => String(x).toLowerCase()).filter(Boolean),
    numbers: (b.numbers || []).map(normNumber).filter(Boolean),
    about: String(b.about || '').slice(0, 300), goal: String(b.goal || '').slice(0, 300),
    can_agree: (b.can_agree || []).map(String), must_not: (b.must_not || []).map(String), private: (b.private || []).map(String),
    until: String(b.until || ''), source: String(b.source || 'Told by Sam'),
  };
  list.unshift(clean); saveBriefings(list); return clean;
}
export function removeBriefing(bid) { saveBriefings(briefings().filter((b) => b.id !== bid)); return { ok: true }; }
const words = (s) => String(s || '').toLowerCase();
function briefingFor({ number, name, org, purpose }) {
  const n = normNumber(number), text = [name, org, purpose].map(words).join(' ');
  return briefings().find((b) => (n && b.numbers.includes(n)) || b.orgs.some((o) => o && text.includes(o)) || b.names.some((x) => x && new RegExp(`\\b${x}\\b`).test(text))) || null;
}
const briefingText = (b) => [
  `BRIEFING from Sam about ${b.who}: ${b.about}`, b.goal && `Sam wants: ${b.goal}`,
  b.can_agree.length && `You may agree to: ${b.can_agree.join('; ')}.`, b.must_not.length && `Never agree to: ${b.must_not.join('; ')}.`,
  b.private.length && `Keep private, never mention: ${b.private.join('; ')}.`,
  'Anything outside this: say you will take it to Sam. Never sign, pay or commit to more than the briefing allows.',
].filter(Boolean).join(' ');

// Turns a pasted chat (ChatGPT, Claude, WhatsApp, notes) into a briefing draft. Sam confirms it before it's used.
export async function briefingFromChat(text) {
  const chat = String(text || '').trim().slice(0, 24000);
  if (chat.length < 20) return { error: 'Paste a little more of the chat.' };
  if (!env.OPENAI_API_KEY) return { draft: { who: 'Someone', about: chat.slice(0, 280), goal: '', can_agree: [], must_not: [], private: [], names: [], orgs: [], numbers: [], source: 'Pasted text' } };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4.1-mini', temperature: 0, response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `Sam pasted a chat (with ChatGPT, Claude, a person, or his own notes) about someone who will phone him. His phone assistant will take that call for him. Extract a briefing as JSON with keys:
who (name and role, e.g. "Rahul Verma, XYZ Capital (investor)"), names (lowercase first names or surnames the caller may say), orgs (lowercase company names), numbers (phone numbers if any),
about (what the call is about, one sentence), goal (what Sam wants out of it, one sentence), can_agree (what the assistant may agree to, short items, with numbers and dates exactly as in the chat),
must_not (what it must never agree to), private (what it must never reveal), until (when this stops applying, if said; else "").
Only use what the chat says. Keep every amount, rate and date exactly. Short, plain items.` },
        { role: 'user', content: chat },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) return { error: 'Could not read the chat right now.' };
  try { const d = JSON.parse(j.choices[0].message.content); return { draft: { names: [], orgs: [], numbers: [], can_agree: [], must_not: [], private: [], ...d, source: 'Imported from a chat' } }; }
  catch { return { error: 'Could not read the chat right now.' }; }
}

// ---------- sorting a caller by what they say ----------
const SALES = /insurance|policy|lic\b|term plan|loan|credit card|pre.?approved|offer|scheme|investment plan|mutual fund|demat|real estate|plot|flat for sale|promotion|lucky draw|holiday package|survey|telemarket/i;
const SERVICE = /\b(jio|airtel|vodafone|vi|bsnl|bescom|electricity|water board|gas|indane|bharat gas|bank|hdfc|icici|sbi|axis|kotak|customer care|support|service|technician|courier|blue ?dart|dtdc|delhivery|bill|recharge|kyc|hospital|clinic|school)\b/i;
const CAB = /\b(uber|ola|rapido|cab|taxi|auto(?![- ]?pay)|driver)\b/i;
function sortCaller({ name, org, purpose, guess }) {
  const text = [name, org, purpose].filter(Boolean).join(' ');
  if (detectService(text)) return 'delivery';
  if (SALES.test(text)) return 'sales';
  if (SERVICE.test(text)) return 'service';
  if (CAB.test(text) || /deliver|parcel|order|package/i.test(text)) return 'delivery';
  return KINDS.includes(guess) ? guess : 'unknown';
}

// ---------- the call itself ----------
const live = new Map(); // number -> the call in progress
function current(number) {
  const n = normNumber(number) || 'unknown';
  if (!live.has(n)) live.set(n, { id: id('c'), number: n, started: Date.now(), kind: 'unknown', name: '', org: '', actions: [] });
  return live.get(n);
}
const ownerName = () => profile().owner;
function modeLine() {
  const p = profile();
  return `MODE: ${p.mode}. ${(MODES[p.mode] || '').replaceAll('{owner}', p.owner)}`;
}
function ruleLine(kind) { const r = profile().rules[kind] || profile().rules.unknown; return `RULE for ${KIND_LABEL[kind]}: ${r.say} Keep this call under ${r.budget} seconds.`; }

// at the start of every call: who is this?
export function lookupCaller({ caller_number }) {
  const c = current(caller_number);
  const p = people()[c.number];
  emit('line.call', { call: c.id, number: c.number });
  if (p?.kind === 'blocked') {
    c.kind = 'blocked'; c.name = p.name || ''; c.actions.push('cut off: blocked number');
    return { known: true, blocked: true, kind: 'blocked', name: p.name || '', note: p.note || '', call_id: c.id, say: `This number is blocked (${p.note || 'spam'}). Say only "Not interested, please don't call again." Then call end_call with outcome "blocked number, cut off" and hang up.` };
  }
  if (p) {
    c.kind = p.kind; c.name = p.name; c.org = p.org || '';
    const b = briefingFor({ number: c.number, name: p.name, org: p.org });
    const seen = p.calls ? ` They have called ${p.calls} time${p.calls > 1 ? 's' : ''} before${p.last_summary ? `; last time: ${p.last_summary}` : ''}.` : '';
    return {
      known: true, kind: p.kind, name: p.name, relation: p.relation || '', briefing: b, budget: profile().rules[p.kind]?.budget, call_id: c.id, mode: profile().mode,
      say: `This is ${p.name}, ${ownerName()}'s ${p.relation || KIND_LABEL[p.kind].toLowerCase()}.${seen} Greet them by name, naturally, and do NOT ask who they are. ${modeLine()} ${ruleLine(p.kind)}${b ? ' ' + briefingText(b) : ''}`,
    };
  }
  return { known: false, kind: 'unknown', call_id: c.id, mode: profile().mode, budget: profile().rules.unknown.budget, say: `Not in ${ownerName()}'s contacts and never called before. Ask who they are and what it is about, in one short line ("Haan ji, kaun bol rahe hain? Kis baare mein?"). Do not say ${ownerName()} is unavailable yet. When they answer, call classify_caller. ${modeLine()}` };
}

// once the caller says who they are and why
export function classifyCaller({ caller_number, name, org, purpose, guess, visit_id }) {
  const c = current(caller_number);
  const known = people()[c.number];
  const kind = known && known.kind !== 'unknown' ? known.kind : sortCaller({ name, org, purpose, guess });
  Object.assign(c, { kind, name: name || c.name, org: org || c.org, purpose: purpose || c.purpose });
  const r = profile().rules[kind];
  const out = { kind, label: KIND_LABEL[kind], name: c.name, org: c.org, budget: r.budget, rule: r.say, call_id: c.id };
  if (kind === 'delivery') {
    // the delivery skill: is this someone Sam is expecting?
    const v = verify({ visit_id, service: detectService([org, name, purpose].join(' ')) || '', code: '', caller_number: c.number });
    c.actions.push('delivery: ' + (v.verified ? 'expected, guiding' : 'not expected'));
    return { ...out, ...v, say: `Delivery or cab. ${v.say} Guide him with next_instruction like a person at home: short Hinglish, one direction at a time.` };
  }
  const b = briefingFor({ number: c.number, name, org, purpose });
  if (b) { out.briefing = b; c.actions.push('used briefing: ' + b.who); }
  return { ...out, say: `${KIND_LABEL[kind]}. ${modeLine()} ${ruleLine(kind)}${b ? ' ' + briefingText(b) : ''}` };
}

// close ones can always get through with the passcode
export function checkPasscode({ caller_number, code, name }) {
  const c = current(caller_number);
  const ok = String(code || '').replace(/\D/g, '') === profile().passcode;
  if (!ok) { c.actions.push('wrong passcode'); return { ok: false, say: 'That is not the code. Do not alert Sam. Offer to take a message.' }; }
  c.kind = 'close'; c.name = name || c.name; c.passcode = true; c.actions.push('passcode correct: alerted Sam');
  notify(`🔴 ${c.name || 'Someone'} is calling with your code from ${showNumber(c.number)}. Call them back now.`);
  emit('line.alert', { call: c.id, number: c.number, name: c.name, reason: 'passcode' });
  return { ok: true, say: `The code is right. ${ownerName()} has been alerted right now and will call back on this number in a minute or two. Tell them that warmly, ask if there is anything to pass on, then end the call.` };
}

export function takeMessage({ caller_number, name, message, urgent }) {
  const c = current(caller_number); const who = name || c.name || showNumber(c.number);
  const u = urgent === true || urgent === 'true';
  c.message = String(message || '').trim(); c.actions.push(u ? 'urgent message' : 'took a message');
  notify(`${u ? '🔴' : '💬'} Message from ${who}: ${c.message}`);
  return { ok: true, say: `Message saved and sent to ${ownerName()}${u ? ' as urgent' : ''}. Read it back in one line to confirm, then wrap up.` };
}
export function alertOwner({ caller_number, name, reason }) {
  const c = current(caller_number); const who = name || c.name || showNumber(c.number);
  c.actions.push('alerted Sam');
  notify(`🔴 ${who} needs you: ${reason || 'urgent'}. Call back ${showNumber(c.number)}.`);
  emit('line.alert', { call: c.id, number: c.number, name: who, reason });
  return { ok: true, say: `${ownerName()} has been alerted. Say he will call back shortly.` };
}

// after every call: log it, learn the caller, tell Sam in one line
export function endCall({ caller_number, name, org, kind, summary, outcome, block, relation }) {
  const c = current(caller_number);
  live.delete(c.number);
  const k = KINDS.includes(kind) ? kind : c.kind;
  const seconds = Math.round((Date.now() - c.started) / 1000);
  const who = name || c.name || '';
  const doBlock = block === true || block === 'true' || (k === 'sales' && block !== false && block !== 'false');
  const all = people(); const before = all[c.number];
  if (c.number !== 'unknown') {
    if (doBlock) all[c.number] = { ...(before || {}), name: who || org || 'Spam', org: org || c.org || '', kind: 'blocked', note: [org || c.org, summary].filter(Boolean).join(': ').slice(0, 120) };
    else if (!before) all[c.number] = { name: who || org || '', org: org || c.org || '', relation: relation || '', kind: c.passcode ? 'close' : k };
    const p = all[c.number];
    p.calls = (p.calls || 0) + 1; p.last = new Date().toISOString(); p.last_summary = String(summary || '').slice(0, 140);
    savePeople(all);
  }
  const rec = { id: c.id, number: c.number, name: who, org: org || c.org || '', kind: c.kind === 'blocked' ? 'blocked' : k, summary: String(summary || ''), outcome: String(outcome || ''), actions: c.actions, seconds, budget: profile().rules[k]?.budget || null, learned: doBlock ? 'blocked' : before ? null : 'saved', at: new Date().toISOString() };
  const log = calls(); log.unshift(rec); save('calls', log.slice(0, 200));
  emit('line.ended', rec);
  const icon = { blocked: '🚫', sales: '🚫', service: '📱', close: '💛', vip: '⭐', known: '📞', delivery: '📦', unknown: '📞' }[rec.kind] || '📞';
  const label = who ? `${who}${rec.org && rec.org !== who ? ` (${rec.org})` : ''}` : rec.org || showNumber(c.number);
  const tail = c.kind === 'blocked' ? ' Cut off.' : doBlock ? ` I'll cut them off next time.` : !before && c.number !== 'unknown' ? ` Saved ${showNumber(c.number)} as ${KIND_LABEL[k].toLowerCase()}.` : '';
  // a message already went to Sam on its own; the summary would only repeat it
  if (k !== 'delivery' && !c.message) notify(`${icon} ${label}, ${seconds}s: ${summary || outcome || 'call handled'}.${tail}`);
  return { ok: true, say: 'Logged. Say a short goodbye and hang up.' };
}

// ---------- reminders / tasks ----------
// Skyline only receives calls; it can't place outbound ones (that needs a verified number + KYC). So when a caller
// asks the owner to "call back at 6", or the owner asks Varun to remind him of something, Varun saves a reminder and
// nudges the owner on Telegram at the time. Shown in the middle "Tasks" list.
export const reminders = () => load('reminders', []);
const saveReminders = (r) => { save('reminders', r); emit('line.updated', { what: 'reminders' }); return r; };
// parse a rough time like "6pm", "17:30", "in 20 min", "tomorrow 9am" -> a timestamp (best effort, local)
function whenTs(text, base = Date.now()) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  let m = t.match(/in\s+(\d+)\s*(min|minute|minutes|hour|hours|hr|hrs)/);
  if (m) return base + Number(m[1]) * (/h/.test(m[2]) ? 3600e3 : 60e3);
  const day = /tomorrow/.test(t) ? 1 : 0;
  m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
  const d = new Date(base); d.setDate(d.getDate() + day); d.setHours(h, min, 0, 0);
  if (!day && d.getTime() <= base) d.setDate(d.getDate() + 1); // next occurrence
  return d.getTime();
}
export function addReminder({ text, when, kind = 'callback', number = '', name = '' }) {
  const at = typeof when === 'number' ? when : whenTs(when);
  const r = { id: id('r'), text: String(text || '').slice(0, 200), at, kind, number: normNumber(number) || '', name: String(name || ''), done: false, created: new Date().toISOString() };
  const list = reminders(); list.unshift(r); saveReminders(list);
  const whenStr = at ? new Date(at).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' }) : 'later';
  notify(`⏰ Reminder set: ${r.text}${at ? ` — I'll nudge you at ${new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}.` : '.'}`);
  return { ok: true, id: r.id, when: whenStr, say: `Saved. ${ownerName()} will get a reminder${at ? ' at ' + whenStr : ''}.` };
}
export function doneReminder(rid) { const l = reminders(); const r = l.find((x) => x.id === rid); if (r) r.done = true; saveReminders(l); return { ok: !!r }; }
// fire any reminder whose time has come
export function sweepReminders(now = Date.now()) {
  const l = reminders(); let changed = false;
  for (const r of l) if (!r.done && !r.fired && r.at && r.at <= now) {
    r.fired = true; changed = true;
    notify(`⏰ ${r.text}${r.number ? ` — ${r.name || showNumber(r.number)}` : ''}. (You asked me to remind you.)`);
    emit('reminder.fired', { id: r.id, text: r.text });
  }
  if (changed) saveReminders(l);
}
// the owner types to Varun (Telegram or the UI compose box): handle plain commands, else make it a note/reminder
const REMIND_RE = /^(remind me|reminder|remind)\b/i;
export function ownerMessage(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (REMIND_RE.test(t)) {
    const body = t.replace(REMIND_RE, '').replace(/^\s*(to|about|that)\s+/i, '').trim();
    const timeM = body.match(/\b(at|by|in|tomorrow)\b.*/i);
    return addReminder({ text: body || 'reminder', when: timeM ? timeM[0] : null, kind: 'note' });
  }
  return null; // not a reminder; telegram.js handles the rest (modes, save/block, confirms)
}
