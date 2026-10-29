// ToTheDoor server: Bolna tool endpoints, Telegram bot, rider position/simulator, live event feed.
// Plain node:http, no dependencies.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { env } from './env.js';
import { emit, bus, recentEvents, load, save } from './store.js';
import { createVisit, activeVisits, detectService, getVisit, closeVisit } from './visits.js';
import { getDoor, defaultDoorId } from './doors.js';
import { verify, status, next, outcome, visitOf } from './guide.js';
import { requestApproval, waitApproval, getApproval, resolveApproval, ringCustomer, notify } from './notify.js';
import { setPosition, planRide, startSim, stopSim, getRider, advance } from './rider.js';
import { startTelegram } from './telegram.js';
import { findPlace } from './maps.js';
import { replay } from './demo/replay.js';
import { cityAt } from './city.js';

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

  async log_outcome(a) {
    const v = visitOf(val(a.visit_id));
    if (!v) return { say: 'OK.' };
    return outcome(v, val(a.result) || 'delivered', val(a.note));
  },
};

// ---------- http ----------
const weatherCache = new Map();
const routes = {
  'GET /health': () => ({ ok: true }),
  'GET /api/state': () => ({ visits: activeVisits(), door: getDoor(defaultDoorId()), events: recentEvents().slice(-100) }),
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
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=precipitation,rain,weather_code`, { signal: AbortSignal.timeout(6000) });
      const c = (await r.json()).current || {};
      // mm in the last hour -> 0..1: a drizzle at 0.2 mm, a downpour from 4 mm; thunderstorm codes are heavy rain
      const mm = c.precipitation ?? c.rain ?? 0;
      const rain = c.weather_code >= 95 ? 1 : mm <= 0 ? 0 : Math.min(1, 0.3 + mm / 5);
      const value = { rain, mm, code: c.weather_code ?? null };
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
  'POST /api/visits': async (b) => createVisit({ service: detectService(b.service) || b.service || 'delivery', rider_phone: b.rider_phone || null, source: 'api' }),
  'POST /api/visits/close': async (b) => closeVisit(b.visit_id, b.status || 'closed', b.note || ''),
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
  'POST /bolna/webhook': async (b) => { emit('bolna.event', { status: b.status, execution: b.id || b.execution_id, transcript: (b.transcript || '').slice(-600) }); return { ok: true }; },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // tools: POST /tools/<name>, protected by the shared token Bolna sends
    const tm = url.pathname.match(/^\/tools\/([a-z_]+)$/);
    if (tm && req.method === 'POST') {
      if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { say: 'unauthorized' });
      const fn = TOOLS[tm[1]];
      if (!fn) return json(res, 404, { say: 'unknown tool' });
      const args = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
      emit('tool.call', { tool: tm[1], args });
      const out = await fn(args);
      emit('tool.result', { tool: tm[1], out });
      return json(res, 200, out);
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
    if (h) return json(res, 200, (await h(req.method === 'POST' ? await readBody(req) : {}, url.searchParams)) ?? null);
    // static files from public/
    // (/map3d/ is the 3D city renderer in city/, shown inside the dashboard)
    let f = 'public' + (url.pathname === '/' ? '/index.html' : url.pathname);
    if (url.pathname.startsWith('/map3d/')) f = 'city/' + (url.pathname.slice(7) || 'index.html');
    if (req.method === 'GET' && !f.includes('..') && existsSync(f) && statSync(f).isFile()) {
      const type = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg' }[f.split('.').pop()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); return res.end(readFileSync(f));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    emit('error', { where: url.pathname, message: e.message });
    json(res, 500, { say: 'Something went wrong on our side. Ask the rider which shop he can see and try again.', error: e.message });
  }
});

// Polls a live Bolna call and emits each new transcript line once, plus the end of the call.
function followCall(visit, execution) {
  let seen = 0, tries = 0;
  const timer = setInterval(async () => {
    try {
      const e = await (await fetch('https://api.bolna.ai/executions/' + execution, { headers: { Authorization: `Bearer ${env.BOLNA_API_KEY}` } })).json();
      const lines = String(e.transcript || '').split('\n').map((l) => l.trim()).filter(Boolean);
      for (; seen < lines.length; seen++) {
        const m = lines[seen].match(/^(assistant|user)\s*:\s*(.*)$/i);
        if (m && m[2]) emit('call.line', { visit, role: m[1].toLowerCase() === 'user' ? 'rider' : 'agent', text: m[2] });
      }
      if (['completed', 'failed', 'no-answer', 'busy', 'canceled', 'error'].includes(e.status) || ++tries > 300) {
        clearInterval(timer); emit('call.ended', { visit, status: e.status });
      }
    } catch {}
  }, 1500);
}

export { TOOLS };
export function start(port = PORT) {
  return new Promise((ok) => server.listen(port, () => {
    emit('server.started', { port });
    if (env.DRY_RUN !== '1') startTelegram();
    ok(server);
  }));
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) start().then(() => console.log(`ToTheDoor on http://localhost:${PORT}`));
