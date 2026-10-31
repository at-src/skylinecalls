// Expected visitors. The agent only guides people the customer registered (or approved live).
import { load, save, id, emit } from './store.js';
import { defaultDoorId } from './doors.js';

export const SERVICES = ['zepto', 'swiggy', 'instamart', 'zomato', 'blinkit', 'bigbasket', 'amazon', 'flipkart', 'myntra', 'meesho', 'dunzo', 'porter', 'uber', 'ola', 'rapido', 'delhivery', 'bluedart', 'dtdc', 'ekart', 'shadowfax'];
// how long an "I'm expecting a Zepto order" holds, unless the owner says a time ("in 50 mins", "by 7pm")
export const EXPECT_MIN = () => Number(process.env.EXPECT_MIN || 30);

// "in 50 mins", "in an hour", "2 ghante", "half an hour", "by 7:30 pm" -> minutes from now (null if no time said)
export function windowMinutes(text, now = Date.now()) {
  const t = String(text || '').toLowerCase();
  let m = null;
  const mins = t.match(/(\d+)\s*(?:min|mins|minute|minutes|m)\b/);
  const hrs = t.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours|ghanta|ghante)\b/);
  if (mins) m = Number(mins[1]);
  else if (hrs) m = Number(hrs[1]) * 60;
  else if (/half an hour|aadha ghanta|adha ghanta/.test(t)) m = 30;
  else if (/\b(an|one|ek)\s+(hour|ghanta)\b/.test(t)) m = 60;
  else {
    const at = t.match(/\b(?:by|at|till|until)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
    if (at) {
      const ist = new Date(now + 5.5 * 3600e3);
      let h = Number(at[1]) % 12; if (at[3] === 'pm' || (!at[3] && h < 8)) h += 12; // "by 7" in the evening
      let diff = (h * 60 + Number(at[2] || 0)) - (ist.getUTCHours() * 60 + ist.getUTCMinutes());
      if (diff <= 0) diff += 24 * 60;
      m = diff;
    }
  }
  return m == null ? null : Math.max(5, Math.min(12 * 60, Math.round(m)));
}

const all = () => load('visits', {});
const put = (v) => { const a = all(); a[v.id] = v; save('visits', a); return v; };

export function detectService(text) {
  const t = String(text || '').toLowerCase();
  return SERVICES.find((s) => t.includes(s)) || null;
}

export function createVisit({ service, rider_phone = null, door_id = defaultDoorId(), source = 'telegram', minutes = null }) {
  const now = Date.now();
  const v = {
    id: id('v'), service: service || 'delivery', rider_phone, door_id, source,
    status: 'active', created: new Date(now).toISOString(), expires: new Date(now + (minutes || EXPECT_MIN()) * 60e3).toISOString(),
    step: 0, zone: null, log: [],
  };
  emit('visit.created', { visit: v.id, service: v.service, source });
  return put(v);
}

export function getVisit(vid) {
  const v = all()[vid];
  if (v && v.status === 'active' && Date.parse(v.expires) < Date.now()) { v.status = 'expired'; put(v); }
  return v || null;
}

// ---------- ETA from the delivery app ----------
const CITY_M_PER_MIN = 300; // ~18 km/h in city traffic on a two-wheeler

export function setEta(vid, minutes, origin = null) {
  const v = getVisit(vid); if (!v) return null;
  const patch = { eta_min: Number(minutes), eta_at: new Date().toISOString() };
  if (origin) patch.origin = origin;
  emit('visit.eta', { visit: vid, eta_min: patch.eta_min, origin: origin?.name });
  return updateVisit(vid, patch);
}

// minutes left by the last ETA, counting down since it was given
export function remainingMin(v) {
  if (v?.eta_min == null) return null;
  return Math.max(0, v.eta_min - (Date.now() - Date.parse(v.eta_at)) / 60000);
}
export const approxDistanceM = (v) => { const m = remainingMin(v); return m == null ? null : Math.round(m * CITY_M_PER_MIN); };

export const updateVisit = (vid, patch) => { const v = getVisit(vid); if (!v) return null; Object.assign(v, patch); return put(v); };

export const activeVisits = () => Object.values(all()).map((v) => getVisit(v.id)).filter((v) => v && v.status === 'active');

export function closeVisit(vid, status = 'delivered', note = '') {
  const v = updateVisit(vid, { status, closed: new Date().toISOString(), outcome: note });
  if (v) emit('visit.closed', { visit: vid, status, note });
  return v;
}

const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

// Checks a caller. Returns { ok, visit?, reason }
//   - visit_id from our own outbound call (we only dial registered riders): trusted
//   - the rider's number, if the owner gave one: trusted
//   - otherwise: he says the service the owner is expecting, inside the expected window. No code: riders don't carry
//     one, and the window keeps the exposure short. Late, early, or another service -> the owner is asked on Telegram.
export function verifyCaller({ visit_id, service, caller_number }) {
  if (visit_id && !/[{}]/.test(visit_id)) {
    const v = getVisit(visit_id);
    if (v && v.status === 'active') return { ok: true, visit: v, reason: 'called by us' };
  }
  const svc = detectService(service) || (service ? String(service).toLowerCase().trim() : null);
  const active = activeVisits();
  const byPhone = caller_number && active.find((v) => v.rider_phone && digits(v.rider_phone) === digits(caller_number));
  if (byPhone) return { ok: true, visit: byPhone, reason: 'phone matched' };
  if (!svc) return { ok: false, reason: 'which service', expected_service: active[0]?.service || null };
  const match = active.filter((v) => v.service === svc || v.service === 'delivery').sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  if (match) {
    // once he's verified, the visit stays open while he's guided (a rider 5 minutes late isn't cut off mid-way)
    const until = Math.max(Date.parse(match.expires), Date.now() + 45 * 60e3);
    return { ok: true, visit: updateVisit(match.id, { expires: new Date(until).toISOString(), verified_at: new Date().toISOString() }), reason: 'expected service' };
  }
  return { ok: false, reason: `no ${svc} order expected right now` };
}
// ---------- the receiver confirms ----------
// When the rider says it's delivered we don't take his word for it: the visit waits for the receiver to say
// "received" or "not received". Nobody remembers to reply every time, so an hour after the call with no reply it
// counts as delivered.
export const CONFIRM_MS = Number(process.env.CONFIRM_MIN || 60) * 60e3;
export function awaitConfirm(vid, note = '') {
  const v = updateVisit(vid, { status: 'awaiting', outcome: note, said_at: new Date().toISOString(), confirm_by: new Date(Date.now() + CONFIRM_MS).toISOString() });
  if (v) emit('visit.awaiting', { visit: vid, note, confirm_by: v.confirm_by });
  return v;
}
export const awaitingVisits = () => Object.values(all()).filter((v) => v.status === 'awaiting');
export function confirmVisit(vid, received, by = 'receiver') {
  const v = all()[vid];
  if (!v || v.status !== 'awaiting') return null;
  return closeVisit(vid, received ? 'delivered' : 'not_received', received ? `${v.outcome || 'delivered'} (confirmed by ${by})` : `${v.outcome || ''}: receiver says not received`.replace(/^: /, ''));
}
// visits past their hour with no reply; returns the ones it closed
export function sweepAwaiting(now = Date.now()) {
  return awaitingVisits().filter((v) => Date.parse(v.confirm_by) <= now).map((v) => closeVisit(v.id, 'delivered', `${v.outcome || 'delivered'} (no reply within an hour)`));
}
