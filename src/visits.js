// Expected visitors. The agent only guides people the customer registered (or approved live).
import { load, save, id, emit } from './store.js';
import { defaultDoorId } from './doors.js';

export const SERVICES = ['zepto', 'swiggy', 'instamart', 'zomato', 'blinkit', 'bigbasket', 'amazon', 'flipkart', 'myntra', 'meesho', 'dunzo', 'porter', 'uber', 'ola', 'rapido', 'delhivery', 'bluedart', 'dtdc', 'ekart', 'shadowfax'];
const HOURS = 3;

const all = () => load('visits', {});
const put = (v) => { const a = all(); a[v.id] = v; save('visits', a); return v; };

export function detectService(text) {
  const t = String(text || '').toLowerCase();
  return SERVICES.find((s) => t.includes(s)) || null;
}

export function createVisit({ service, rider_phone = null, door_id = defaultDoorId(), source = 'telegram' }) {
  const now = Date.now();
  const v = {
    id: id('v'), service: service || 'delivery', rider_phone, door_id, source,
    code: String(1000 + Math.floor(Math.random() * 9000)),
    status: 'active', created: new Date(now).toISOString(), expires: new Date(now + HOURS * 3600e3).toISOString(),
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
//   - otherwise the service must match an active visit, and the code or the caller's number must match
export function verifyCaller({ visit_id, service, code, caller_number }) {
  if (visit_id && !/[{}]/.test(visit_id)) {
    const v = getVisit(visit_id);
    if (v && v.status === 'active') return { ok: true, visit: v, reason: 'called by us' };
  }
  const svc = detectService(service) || (service ? String(service).toLowerCase().trim() : null);
  const candidates = activeVisits().filter((v) => !svc || v.service === svc || v.service === 'delivery');
  if (!candidates.length) return { ok: false, reason: svc ? `no active ${svc} order` : 'no active order' };
  const byCode = code && candidates.find((v) => v.code === String(code).replace(/\D/g, ''));
  if (byCode) return { ok: true, visit: byCode, reason: 'code matched' };
  const byPhone = caller_number && candidates.find((v) => v.rider_phone && digits(v.rider_phone) === digits(caller_number));
  if (byPhone) return { ok: true, visit: byPhone, reason: 'phone matched' };
  if (code) return { ok: false, reason: 'wrong code', expected_service: candidates[0].service };
  return { ok: false, reason: 'need code', expected_service: candidates[0].service };
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
