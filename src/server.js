// Skyline server: Bolna tool endpoints, Telegram bot, rider position/simulator, live event feed.
// Plain node:http, no dependencies.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { env } from './env.js';
import { emit, bus, recentEvents, load, save } from './store.js';
import { createVisit, activeVisits, awaitingVisits, detectService, getVisit, closeVisit } from './visits.js';
import { getDoor, defaultDoorId } from './doors.js';
import { verify, status, next, outcome, visitOf, confirmDelivery, closeUnanswered } from './guide.js';
import { requestApproval, waitApproval, getApproval, resolveApproval, ringCustomer, notify } from './notify.js';
import { setPosition, planRide, startSim, stopSim, getRider, advance } from './rider.js';
import { startTelegram, handleText } from './telegram.js';
import { findPlace } from './maps.js';
import { replay } from './demo/replay.js';
import { teach } from './demo/teach.js';
import { fleet, stopFleet } from './demo/fleet.js';
import { SENDERS, GUIDE_NUMBER, senderKeys, senderFor, registerOrder, orderLocation, orderStatus, getOrder, ordersOf, senderStats, consent, setConsent } from './sender.js';
import { startCalibration, getCalibration, saveAnchor, saveStep, saveDoor, saveFallback, finish } from './calibrate.js';
import { cityAt } from './city.js';
import * as A from './assistant.js';
import * as G from './guard.js';
import { demoCall, personaList } from './demo/calls.js';
import { registry as connectorRegistry, disconnect as connectorDisconnect, authUrl, handleCallback, redirectUri, gmailRecent, calendarBusy } from './connectors.js';
const mints = new Map(); let lastMint = 0;
// web calls this server opened: run id -> { number, at, wrapped (when Varun called end_call) }
const webRuns = new Map();
bus.on('event', (e) => {
  if (e.type !== 'line.ended') return;
  // every web visitor shares one number, so mark only the most recent open run (one call at a time is enforced)
  const open = [...webRuns.values()].filter((w) => w.number === e.number && !w.wrapped).sort((a, b) => b.at - a.at)[0];
  if (open) open.wrapped = Date.now();
  for (const [id, w] of webRuns) if (Date.now() - w.at > 3600e3) webRuns.delete(id);
});

const PORT = Number(env.PORT || 3200);
const TOKEN = env.TOOL_TOKEN || '';

const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    if (!d) return ok({});
    try { ok(JSON.parse(d)); } catch { ok(Object.fromEntries(new URLSearchParams(d))); }
  });
});
// Bolna leaves a placeholder like "%(seen)s" or "{visit_id}" when a value wasn't filled
const val = (x) => (x == null || /^%\(.*\)s$|^\{.*\}$|^(null|none|undefined)$/i.test(String(x).trim()) ? '' : String(x).trim());

// ---------- agent tools ----------
// Every tool answers with { say: "...facts for the agent..." } so the agent can speak naturally.
const TOOLS = {
  async verify_caller(a) {
    return verify({ visit_id: val(a.visit_id), service: val(a.service), code: val(a.code), caller_number: val(a.caller_number) });
  },

  // caller couldn't be verified: ask the customer live on Telegram, wait a little
  async ask_customer(a) {
    const who = val(a.caller_says) || 'a delivery person';
    const ap = requestApproval(who);
    const res = await waitApproval(ap.id, Number(env.APPROVAL_WAIT_MS || 15000));
    if (res.status === 'allowed') {
      const v = createVisit({ service: detectService(who) || 'delivery', source: 'approved live' });
      return { approved: true, visit_id: v.id, say: 'The family approved this caller. You can guide him now. Ask where he is and call next_instruction with visit_id ' + v.id + '.' };
    }
    if (res.status === 'blocked') return { approved: false, say: 'The family does not know this caller. Politely say you can\'t share the address and end the call. Give no directions.' };
    return { approved: false, pending: true, approval_id: ap.id, say: 'No answer from the family yet. Tell him to hold on a few seconds, then call check_approval with approval_id ' + ap.id + '. Give no directions meanwhile.' };
  },

  async check_approval(a) {
    const ap = getApproval(val(a.approval_id));
    if (!ap) return { say: 'Unknown approval. Do not give directions. Ask him to call again later.' };
    const res = ap.status === 'pending' ? await waitApproval(ap.id, 10000) : ap;
    if (res.status === 'allowed') {
      const v = createVisit({ service: detectService(ap.caller) || 'delivery', source: 'approved live' });
      return { approved: true, visit_id: v.id, say: 'Approved. Ask where he is and call next_instruction with visit_id ' + v.id + '.' };
    }
    if (res.status === 'blocked') return { approved: false, say: 'Not approved. Say you can\'t share the address and end the call politely.' };
    return { approved: false, say: 'Still no answer from the family. Tell him the family will call him back, then end the call. Give no directions.' };
  },

  async next_instruction(a) {
    const v = visitOf(val(a.visit_id));
    if (!v || v.status !== 'active') return { say: 'Caller is not verified. Call verify_caller first. Give no directions.' };
    return next(v, val(a.seen));
  },

  async rider_status(a) {
    const v = visitOf(val(a.visit_id));
    if (!v || v.status !== 'active') return { say: 'Caller is not verified. Give no directions.' };
    return status(v);
  },

  async call_customer(a) {
    const v = visitOf(val(a.visit_id));
    if (!v) return { say: 'Caller is not verified.' };
    const reason = val(a.reason) || 'needs you';
    await ringCustomer(`Your ${v.service.charAt(0).toUpperCase() + v.service.slice(1)} rider ${reason}. He's at your place now.`);
    const door = getDoor(v.door_id);
    return { say: `The family has been called and messaged. Ask him to wait two minutes. If nobody comes: ${door.fallback.if_no_answer}` };
  },

  // ----- calibration: the customer teaches the way to the door -----
  async start_calibration(a) { return startCalibration({ customer: val(a.customer) || 'Sam', door_id: val(a.door_id) }); },
  async save_anchor(a) { const c = getCalibration(val(a.calibration_id)); return c ? saveAnchor(c, a) : { say: 'Start the calibration first (start_calibration).' }; },
  async save_step(a) { const c = getCalibration(val(a.calibration_id)); return c ? saveStep(c, a) : { say: 'Start the calibration first (start_calibration).' }; },
  async save_door(a) { const c = getCalibration(val(a.calibration_id)); return c ? saveDoor(c, a) : { say: 'Start the calibration first (start_calibration).' }; },
  async save_fallback(a) { const c = getCalibration(val(a.calibration_id)); return c ? saveFallback(c, a) : { say: 'Start the calibration first (start_calibration).' }; },
  async finish_calibration(a) { const c = getCalibration(val(a.calibration_id)); return c ? finish(c) : { say: 'Start the calibration first (start_calibration).' }; },
  // ----- Sam's line: every call -----
  async lookup_caller(a) { return A.lookupCaller({ caller_number: val(a.caller_number) }); },
  async classify_caller(a) { return A.classifyCaller({ caller_number: val(a.caller_number), name: val(a.name), org: val(a.org), purpose: val(a.purpose), guess: val(a.guess), visit_id: val(a.visit_id) }); },
  async check_passcode(a) { return A.checkPasscode({ caller_number: val(a.caller_number), code: val(a.code), name: val(a.name) }); },
  async take_message(a) { return A.takeMessage({ caller_number: val(a.caller_number), name: val(a.name), message: val(a.message), urgent: val(a.urgent) }); },
  async alert_owner(a) { return A.alertOwner({ caller_number: val(a.caller_number), name: val(a.name), reason: val(a.reason) }); },
  async end_call(a) { return A.endCall({ caller_number: val(a.caller_number), name: val(a.name), org: val(a.org), kind: val(a.kind), summary: val(a.summary), outcome: val(a.outcome), block: a.block === true ? true : val(a.block), relation: val(a.relation) }); },
  // a caller asks the owner to call back, or wants something passed on at a time: Skyline can't dial out, so it saves a
  // reminder and nudges the owner on Telegram at that time
  async set_reminder(a) { return A.addReminder({ text: val(a.text), when: val(a.when), kind: 'callback', number: val(a.caller_number), name: val(a.name) }); },
  async log_outcome(a) {
    const v = visitOf(val(a.visit_id));
    if (!v) return { say: 'OK.' };
    return outcome(v, val(a.result) || 'delivered', val(a.note));
  },

  // ----- connectors Varun can use on a call (only if the owner linked them) -----
  // Is the owner free on a day? Reads Google Calendar (read-only). Needs the gcal connector.
  // What each caller may hear is decided here from the server's records (guard.levelOf), not by the model:
  // trusted (saved close one / VIP, or passcode) gets event titles; known gets busy times only; anyone else nothing.
  async check_calendar(a) {
    const level = A.accessFor(val(a.caller_number));
    const r = level === 'trusted' || level === 'known' ? await calendarBusy(val(a.date)) : null;
    const out = G.calendarReply(level, r, A.profile().owner);
    emit('line.shared', { tool: 'check_calendar', level, shared: out.shared });
    return { ...out, level };
  },
  // Did an expected mail arrive? Only for trusted callers, sender + subject only, instruction-like subjects withheld.
  async check_mail(a) {
    const level = A.accessFor(val(a.caller_number));
    const r = level === 'trusted' ? await gmailRecent({ query: val(a.query), max: 5 }) : null;
    const out = G.mailReply(level, r, A.profile().owner);
    emit('line.shared', { tool: 'check_mail', level, shared: out.shared });
    return { ...out, level };
  },
};
// tools on Varun's line, and which of their arguments carry the caller's own words (these get scanned)
const LINE_TOOLS = new Set(['lookup_caller', 'classify_caller', 'check_passcode', 'take_message', 'alert_owner', 'set_reminder', 'end_call', 'check_calendar', 'check_mail']);
const CALLER_WORDS = ['name', 'org', 'purpose', 'message', 'reason', 'text', 'query', 'seen', 'caller_says', 'service', 'relation'];

// ---------- http ----------
const weatherCache = new Map();
const routes = {
  'GET /health': () => ({ ok: true }),
  'GET /api/state': () => ({ visits: activeVisits(), awaiting: awaitingVisits(), door: getDoor(defaultDoorId()), events: recentEvents().slice(-100) }),
  'GET /api/door': () => getDoor(defaultDoorId()),
  'GET /api/config': () => ({ mapsKey: env.GOOGLE_MAPS_KEY, door: getDoor(defaultDoorId()), home: load('home', null) }),
  // search an area or address (biased to Bengaluru) for the "where's home?" screen
  // Is it raining at the home right now? (Open-Meteo, no key needed; cached 10 minutes.) The live map rains with it.
  'GET /api/weather': async (b, q) => {
    const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { rain: 0 };
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = weatherCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,precipitation,rain,weather_code,cloud_cover&daily=sunrise,sunset&timezone=auto&forecast_days=1`, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      const c = j.current || {};
      // mm in the last hour -> 0..1: a drizzle at 0.2 mm, a downpour from 4 mm; thunderstorm codes are heavy rain
      const mm = c.precipitation ?? c.rain ?? 0;
      const rain = c.weather_code >= 95 ? 1 : mm <= 0 ? 0 : Math.min(1, 0.3 + mm / 5);
      // today's sunrise and sunset at the home, as local hours, and the home's offset from UTC
      const hourOf = (iso) => { const t = String(iso || '').split('T')[1] || ''; const [h, m] = t.split(':').map(Number); return Number.isFinite(h) ? h + (m || 0) / 60 : null; };
      const value = {
        rain, mm, temp: c.temperature_2m ?? null, code: c.weather_code ?? null, clouds: c.cloud_cover ?? null,
        sunrise: hourOf(j.daily?.sunrise?.[0]), sunset: hourOf(j.daily?.sunset?.[0]), utcOffset: j.utc_offset_seconds ?? null
      };
      weatherCache.set(key, { at: Date.now(), value });
      return value;
    } catch { return { rain: 0, error: 'weather unavailable' }; }
  },
  'GET /api/geocode': async (b, q) => {
    const text = (q.get('q') || '').trim();
    if (text.length < 2) return [];
    const near = q.get('lat') ? { lat: Number(q.get('lat')), lng: Number(q.get('lng')) } : { lat: 12.9716, lng: 77.5946 };
    return (await findPlace(text, near, 30000)).slice(0, 5).map((p) => ({ name: p.name, address: p.address, lat: p.lat, lng: p.lng }));
  },
  'POST /api/home': async (b) => {
    const home = { lat: Number(b.lat), lng: Number(b.lng), label: String(b.label || 'Home').slice(0, 80), set: new Date().toISOString() };
    save('home', home);
    emit('home.set', home);
    return home;
  },
  // 3D city around a point (OpenStreetMap, baked and cached). Snaps to the demo city when close to it.
  'GET /api/city': async (b, q) => {
    const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { error: 'lat/lng required' };
    const near = (a, c) => Math.abs(a - c) < 0.004;
    if (near(lat, 12.9128) && near(lng, 77.6374)) return JSON.parse(readFileSync('public/city/hsr.json', 'utf8'));
    return cityAt(lat, lng);
  },
  'POST /api/home/clear': async () => { save('home', null); return { ok: true }; },
  // scripted demo call through the real tools (no phone calls)
  'POST /api/demo/replay': async (b) => { replay(TOOLS, { pace: Number(b.pace || 1) }); return { ok: true }; },
  // scripted calibration call: Sam teaches the way to the door (no phone, nothing sent to Telegram)
  'POST /api/demo/teach': async (b) => { teach(TOOLS, { pace: Number(b.pace || 1) }).catch((e) => emit('error', { where: 'teach', message: e.message })); return { ok: true }; },
  'POST /api/visits': async (b) => createVisit({ service: detectService(b.service) || b.service || 'delivery', rider_phone: b.rider_phone || null, source: 'api' }),
  'POST /api/visits/close': async (b) => closeVisit(b.visit_id, b.status || 'closed', b.note || ''),
  // the receiver answers 'did it arrive?' from the dashboard (same as the Telegram buttons)
  'POST /api/visits/confirm': async (b) => confirmDelivery(b.visit_id, b.received !== false, 'dashboard') || { ok: false, error: 'nothing waiting for an answer' },
  'POST /api/rider/position': async (b) => setPosition(b.visit_id, { lat: Number(b.lat), lng: Number(b.lng) }, 'gps'),
  'POST /api/rider/plan': async (b) => { const r = await planRide(b.visit_id, { from: b.from, via: b.via, door_id: getVisit(b.visit_id)?.door_id }); return { points: r.path.length }; },
  'POST /api/rider/start': async (b) => { startSim(b.visit_id, Number(b.speed || 8)); return { ok: true }; },
  'POST /api/rider/stop': async (b) => { stopSim(b.visit_id); return { ok: true }; },
  'POST /api/rider/advance': async (b) => advance(b.visit_id, Number(b.metres || 50)),
  'GET /api/rider': async (b, q) => getRider(q.get('visit_id')),
  'POST /api/approvals/resolve': async (b) => resolveApproval(b.approval_id, b.status),
  // demo: start a delivery with a simulated rider ~1.8 km away who takes a wrong turn
  'POST /api/demo/start': async (b) => {
    const v = createVisit({ service: detectService(b.service) || 'zepto', source: 'demo' });
    await planRide(v.id, { from: { lat: 12.9231, lng: 77.6510 }, via: b.wrong_turn === false ? null : { lat: 12.9205, lng: 77.6455 }, door_id: v.door_id });
    if (b.ride !== false) startSim(v.id, Number(b.speed || 8));
    return { visit_id: v.id, code: v.code };
  },
  // the rider's "Call customer" button: connects the rider to the guide agent
  'POST /api/call-rider': async (b) => {
    const v = getVisit(b.visit_id);
    if (!v || v.status !== 'active') return { ok: false, error: 'no active visit' };
    if (env.ALLOW_CALLS !== '1') return { ok: false, error: 'calls disabled (set ALLOW_CALLS=1)' };
    const r = await fetch('https://api.bolna.ai/call', {
      method: 'POST', headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: env.BOLNA_GUIDE_AGENT_ID, recipient_phone_number: env.RIDER_PHONE, user_data: { visit_id: v.id, customer_name: getDoor(v.door_id).customer.name } }),
    });
    const j = await r.json();
    emit('call.started', { visit: v.id, execution: j.execution_id, ok: r.ok, caller: getDoor(v.door_id) && (v.service.charAt(0).toUpperCase() + v.service.slice(1)) + ' rider' });
    if (r.ok && j.execution_id) followCall(v.id, j.execution_id);
    return { ok: r.ok, execution_id: j.execution_id };
  },
  // ----- sender side: the company's dashboard (a sender's own key lives in its settings) -----
  'GET /api/senders': () => Object.entries(SENDERS).map(([id, s]) => ({ id, ...s })),
  'GET /api/sender': (b, q) => {
    const id = q.get('id') || 'zepto';
    if (!SENDERS[id]) return { error: 'unknown sender' };
    return { id, ...SENDERS[id], guide_number: GUIDE_NUMBER, api_key: senderKeys()[id], stats: senderStats(id), orders: ordersOf(id).slice(0, 40) };
  },
  'POST /api/demo/fleet': async (b) => { fleet(TOOLS, { sender: SENDERS[b.sender] ? b.sender : 'zepto', pace: Number(b.pace || 1) }).catch((e) => emit('error', { where: 'fleet', message: e.message })); return { ok: true }; },
  'POST /api/demo/fleet/stop': () => { stopFleet(); return { ok: true }; },
  // ----- receiver side: which senders may guide riders with the household's door path -----
  'GET /api/consent': () => consent(),
  'POST /api/consent': (b) => setConsent(String(b.sender || ''), b.allowed !== false && b.allowed !== 'false'),
  // ----- Sam's line: what the agent knows, his rules, briefings, the call log -----
  'GET /api/line': () => ({
    profile: A.profile(), modes: A.MODES, labels: A.KIND_LABEL,
    people: Object.entries(A.people()).map(([number, p]) => ({ number, shown: A.showNumber(number), ...p })),
    briefings: A.briefings(), calls: A.calls().slice(0, 30), reminders: A.reminders().filter((r) => !r.done).slice(0, 20), personas: personaList(),
    sample_chat: readFileSync('src/demo/sample-chat.txt', 'utf8'), web_call: env.ALLOW_CALLS === '1' && !!env.BOLNA_LINE_AGENT_ID,
  }),
  // the owner types to Varun from the UI's Telegram box (same path as a real Telegram message)
  'POST /api/message': (b) => { const text = String(b.text || '').trim(); if (!text) return { ok: false }; emit('telegram.in', { text }); const out = A.ownerMessage(text) || handleText(text); return { ok: true, reply: typeof out === 'string' ? out : out?.say || '' }; },
  'POST /api/reminders/done': (b) => A.doneReminder(String(b.id || '')),
  'POST /api/line/mode': (b) => A.setMode(String(b.mode || '')),
  'POST /api/line/rule': (b) => A.setRule(String(b.kind || ''), { say: b.say, budget: b.budget }),
  'POST /api/line/passcode': (b) => A.setPasscode(b.code),
  'POST /api/people': (b) => A.savePerson(b.number, { name: b.name, relation: b.relation, kind: A.KINDS.includes(b.kind) || b.kind === 'blocked' ? b.kind : undefined }),
  'POST /api/people/forget': (b) => A.forgetPerson(b.number),
  'POST /api/briefings/import': (b) => A.briefingFromChat(b.text),
  'POST /api/briefings': (b) => A.addBriefing(b),
  'POST /api/briefings/delete': (b) => A.removeBriefing(String(b.id || '')),
  'POST /api/demo/call': (b) => { demoCall(TOOLS, { persona: String(b.persona || 'sales'), pace: Number(b.pace || 1) }).catch((e) => emit('error', { where: 'demo call', message: e.message })); return { ok: true }; },
  // talk to the line from the browser (Bolna web call): a one-time session minted here, so the key never reaches the page
  'POST /api/webcall/session': async (b, q, req) => {
    if (env.ALLOW_CALLS !== '1' || !env.BOLNA_LINE_AGENT_ID) return { error: 'web calls are off' };
    const ip = String(req?.headers['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0];
    const now = Date.now(), recent = (mints.get(ip) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= 8 || now - lastMint < 15000) return { error: 'The line is busy. Try again in a minute.' };
    mints.set(ip, [...recent, now]); lastMint = now;
    const u = b.user_data || {};
    // a visitor can't pick whose number they call from; only the owner may test as a saved contact
    const number = (G.isOwner(req) && A.normNumber(u.caller_number)) || G.WEB_VISITOR;
    G.expectCaller(number);
    const r = await fetch('https://api.bolna.ai/web-call/freeswitch-session', {
      method: 'POST', headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: env.BOLNA_LINE_AGENT_ID, user_data: { owner: A.profile().owner, caller_number: number, customer_name: A.profile().owner, visit_id: '' } }),
    });
    const j = await r.json();
    if (!r.ok || !j.run_id) return { error: 'Could not open the line right now.' };
    emit('call.started', { kind: 'line', caller: A.showNumber(number), number, web: true, execution: j.run_id });
    webRuns.set(j.run_id, { number, at: Date.now(), wrapped: 0 });
    followCall(null, j.run_id, 'caller', number);
    return j;
  },
  // the landing page asks whether Varun has wrapped up this web call, then hangs up after his goodbye plays.
  // Answers only for a run id this server minted (unguessable), and only "wrapped or not".
  'GET /api/webcall/status': (b, q) => {
    const w = webRuns.get(String(q.get('run') || ''));
    return w ? { wrapped: !!w.wrapped } : { wrapped: false, unknown: true };
  },
  'POST /bolna/webhook': async (b) => { emit('bolna.event', { status: b.status, execution: b.id || b.execution_id, transcript: (b.transcript || '').slice(-600) }); return { ok: true }; },
  // ----- connectors: the registry with live connected state, and a disconnect -----
  'GET /api/connectors': () => ({ connectors: connectorRegistry(), redirect_uri: redirectUri() }),
  'POST /api/connectors/disconnect': (b) => connectorDisconnect(String(b.id || '')),
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // tools: POST /tools/<name>, protected by the shared token Bolna sends
    const tm = url.pathname.match(/^\/tools\/([a-z_]+)$/);
    if (tm && req.method === 'POST') {
      // with no token configured, tools only answer the owner's own machine
      if (TOKEN ? !G.keyMatchesToken(req.headers.authorization, TOKEN) : !G.isLocal(req)) return json(res, 401, { say: 'unauthorized' });
      const fn = TOOLS[tm[1]];
      if (!fn) return json(res, 404, { say: 'unknown tool' });
      const out = await runTool(tm[1], { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) });
      return json(res, 200, out);
    }
    // owner login: /login?key=... sets an HttpOnly cookie, then the dashboard works through the tunnel too
    if (url.pathname === '/login' && req.method === 'GET') {
      if (!G.keyMatches(url.searchParams.get('key'))) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Wrong key.'); }
      res.writeHead(302, { 'Set-Cookie': G.ownerCookie(G.ownerKey(), !G.isLocal(req)), Location: '/' }); return res.end();
    }
    // everything under /api and /connect is the owner's, except the few public routes (the landing page's call)
    const routeKey = `${req.method} ${url.pathname}`;
    const ownerOnly = (url.pathname.startsWith('/api/') || url.pathname === '/connect/google') && !G.PUBLIC_ROUTES.has(routeKey);
    if (ownerOnly && !G.isOwner(req)) return json(res, 401, { error: 'owner only' });
    // sender API (the SDK in the company's rider app): POST /v1/orders, /v1/orders/<id>/location, /v1/orders/<id>/status,
    // GET /v1/orders/<id>. Authorised by the sender's API key.
    if (url.pathname.startsWith('/v1/')) {
      const sender = senderFor(req.headers.authorization);
      if (!sender) return json(res, 401, { error: 'unknown API key' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (url.pathname === '/v1/orders' && req.method === 'POST') return json(res, 201, registerOrder(sender, body));
      const om = url.pathname.match(/^\/v1\/orders\/([a-z0-9_]+)(\/location|\/status)?$/i);
      const o = om && getOrder(om[1]);
      if (!o || o.sender !== sender) return json(res, 404, { error: 'no such order' });
      if (!om[2] && req.method === 'GET') return json(res, 200, o);
      if (om[2] === '/location' && req.method === 'POST') return json(res, 200, orderLocation(o, body));
      if (om[2] === '/status' && req.method === 'POST') return json(res, 200, orderStatus(o, body));
      return json(res, 405, { error: 'method not allowed' });
    }
    // ----- Google OAuth: start consent -----
    // GET /connect/google?scope=gmail|calendar -> 302 to Google's consent screen
    if (url.pathname === '/connect/google' && req.method === 'GET') {
      const to = authUrl(url.searchParams.get('scope') || 'gmail');
      if (!to) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Google connector is not configured. Run: npm run keys'); }
      res.writeHead(302, { Location: to }); return res.end();
    }
    // ----- Google OAuth: Google sends the user back here with ?code -----
    if (url.pathname === '/connect/google/callback' && req.method === 'GET') {
      const err = url.searchParams.get('error');
      const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title><body style="font:16px system-ui;background:#0e141b;color:#e7edf3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:360px"><h2 style="margin:0 0 8px">${title}</h2><p style="opacity:.75;margin:0 0 18px">${body}</p><a href="/" style="color:#4aa8ff">Back to Skyline</a><script>try{if(window.opener){window.opener.postMessage('connectors-updated','*');setTimeout(()=>window.close(),1200)}}catch(e){}</script></div></body>`;
      if (err) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page('Not connected', 'You can close this tab and try again.')); }
      const out = await handleCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(out.ok
        ? page('Connected', 'Varun can use this now. You can close this tab.')
        : page('Not connected', 'Something went wrong linking the account. You can close this tab and try again.'));
    }
    // live event stream for the screen
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      recentEvents().slice(-50).forEach(send);
      bus.on('event', send);
      req.on('close', () => bus.off('event', send));
      return;
    }
    const h = routes[`${req.method} ${url.pathname}`];
    if (h) return json(res, 200, (await h(req.method === 'POST' ? await readBody(req) : {}, url.searchParams, req)) ?? null);
    // static files from public/
    // (/map3d/ is the 3D city renderer in city/, shown inside the dashboard)
    let f = 'public' + (url.pathname === '/' ? '/index.html' : url.pathname);
    if (url.pathname.startsWith('/map3d/')) f = 'city/' + (url.pathname.slice(7) || 'index.html');
    if (req.method === 'GET' && !f.includes('..') && existsSync(f) && statSync(f).isFile()) {
      const type = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', mp3: 'audio/mpeg' }[f.split('.').pop()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(readFileSync(f));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    emit('error', { where: url.pathname, message: e.message });
    json(res, 500, { say: 'Something went wrong on our side. Ask the rider which shop he can see and try again.', error: e.message });
  }
});

// Polls a live Bolna call and emits each new transcript line once, plus the end of the call.
function followCall(visit, execution, userRole = 'rider', number = '') {
  let seen = 0, tries = 0;
  const timer = setInterval(async () => {
    try {
      const e = await (await fetch('https://api.bolna.ai/executions/' + execution, { headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}` } })).json();
      const lines = String(e.transcript || '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (; seen < lines.length; seen++) {
        const m = lines[seen].match(/^(assistant|user)\s*:\s*(.*)$/i);
        if (m && m[2]) {
          emit('call.line', { visit, role: m[1].toLowerCase() === 'user' ? userRole : 'agent', text: m[2] });
          // every word the caller says on Varun's line is scanned too, not just what reaches a tool
          if (number && m[1].toLowerCase() === 'user') A.screen(number, G.cap(m[2], 500));
        }
      }
      if (['completed', 'failed', 'no-answer', 'busy', 'canceled', 'error'].includes(e.status) || ++tries > 300) {
        clearInterval(timer); emit('call.ended', { visit, status: e.status });
        // the caller (or Bolna's goodbye hangup) ended it before Varun logged it: log it from the transcript, so the
        // owner still gets the one-line summary and the call shows up in the history
        if (number && A.peek(number)) {
          const said = lines.filter((l) => /^user\s*:/i.test(l)).map((l) => l.replace(/^user\s*:\s*/i, '')).join(' ');
          A.endCall({ caller_number: number, summary: said ? `Hung up before I wrapped up. They said: "${G.cap(said, 180)}"` : 'Hung up without saying anything', outcome: 'caller hung up' });
        }
      }
    } catch {}
  }, 1500);
}

// One way into every tool (HTTP from Bolna, the demos, the evals): cap the arguments, scan the caller's words on
// Varun's line, run the tool, and put any security warning in front of its note.
export async function runTool(name, raw) {
  const args = G.capArgs(raw);
  emit('tool.call', { tool: name, args });
  let check = null;
  if (LINE_TOOLS.has(name)) check = A.screen(val(args.caller_number), CALLER_WORDS.map((k) => val(args[k])));
  const out = await TOOLS[name](args);
  if (check?.warn && out && typeof out === 'object') { out.say = `${check.warn} ${out.say || ''}`.trim(); out.security = check.flags.map((f) => f.id); }
  emit('tool.result', { tool: name, out });
  return out;
}
export { TOOLS };
export function start(port = PORT) {
  return new Promise((ok) => server.listen(port, () => {
    emit('server.started', { port });
    // deliveries nobody answered for an hour count as delivered
    const sweep = setInterval(() => { closeUnanswered(); A.sweepReminders(); }, 30e3); sweep.unref?.();
    if (env.DRY_RUN !== '1') startTelegram();
    ok(server);
  }));
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) start().then(() => console.log(`Skyline on http://localhost:${PORT}`));
