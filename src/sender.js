// Senders: the companies that send someone to a door (Zepto, Amazon, Uber...). Their app talks to ToTheDoor through
// the sender API (an SDK in the rider app): it registers each order with the receiver and the rider, streams the
// rider's live location, and reports the order's status. Their riders' "Call customer" button reaches ToTheDoor, which
// already knows the receiver's door path and guides them in. A receiver who hasn't taught their door yet is asked to,
// in the sender's own app ("set up doorstep directions"), so the next order arrives with no call at all.
import { load, save, emit, id } from './store.js';
import { createVisit, getVisit, closeVisit } from './visits.js';
import { setPosition } from './rider.js';
import { getDoor, defaultDoorId } from './doors.js';
import { notify } from './notify.js';
import { env } from './env.js';

// the senders this deployment knows, with the number their riders reach (the company provisions it on onboarding)
export const SENDERS = {
  zepto: { name: 'Zepto', kind: 'Quick commerce', colour: '#5b2be0' },
  swiggy: { name: 'Swiggy', kind: 'Food delivery', colour: '#fc8019' },
  amazon: { name: 'Amazon', kind: 'Parcels', colour: '#232f3e' },
  uber: { name: 'Uber', kind: 'Rides', colour: '#111111' },
};
export const GUIDE_NUMBER = env.GUIDE_NUMBER || '+91 80 4718 2200';

// an API key per sender, made on first use and kept in the data folder
export function senderKeys() {
  const k = load('sender_keys', {});
  let changed = false;
  for (const s of Object.keys(SENDERS)) if (!k[s]) { k[s] = 'ttd_' + s + '_' + Math.random().toString(36).slice(2, 14); changed = true; }
  if (changed) save('sender_keys', k);
  return k;
}
export function senderFor(authHeader) {
  const key = String(authHeader || '').replace(/^Bearer\s+/i, '');
  const k = senderKeys();
  return Object.keys(k).find((s) => k[s] === key) || null;
}

// The receiver's choice of which senders may guide riders with their door path (all allowed unless turned off).
export const consent = () => ({ ...Object.fromEntries(Object.keys(SENDERS).map((s) => [s, true])), ...load('consent', {}) });
export function setConsent(sender, allowed) { const c = load('consent', {}); c[sender] = !!allowed; save('consent', c); emit('consent', { sender, allowed: !!allowed }); return consent(); }

const orders = () => load('orders', {});
const putOrder = (o) => { const a = orders(); a[o.id] = o; save('orders', a); return o; };
export const getOrder = (oid) => orders()[oid] || null;
export const ordersOf = (sender) => Object.values(orders()).filter((o) => o.sender === sender).sort((a, b) => (a.created < b.created ? 1 : -1));

// POST /v1/orders. The receiver is matched by door (a household that has taught its door) or by the address point.
export function registerOrder(sender, b) {
  const S = SENDERS[sender];
  const door_id = b.receiver?.door_id || null;
  const door = door_id ? getDoor(door_id) : null;
  const taught = !!door && !!door.steps?.length;
  const allowed = consent()[sender] !== false;
  const o = {
    id: id('ord'), sender, order_id: String(b.order_id || id('o')), created: new Date().toISOString(),
    receiver: { name: b.receiver?.name || 'Customer', area: b.receiver?.area || '', lat: Number(b.receiver?.lat), lng: Number(b.receiver?.lng), door_id: taught ? door_id : null },
    rider: { name: b.rider?.name || 'Rider', phone: b.rider?.phone || null },
    pickup: b.pickup || null, status: 'assigned', guided: false, events: [{ t: Date.now(), s: 'assigned' }]
  };
  // only an order to a household that taught its door, and allows this sender, gets a guided visit
  if (taught && allowed) {
    const v = createVisit({ service: sender, door_id, source: `sender:${sender}` });
    o.visit_id = v.id;
    notify(`📦 ${S.name} order ${o.order_id} is on its way. If the rider can't find the door, ToTheDoor will guide them in.`);
  }
  putOrder(o);
  emit('order.created', { order: o.id, sender, order_id: o.order_id, receiver: o.receiver, rider: o.rider, guided: !!o.visit_id });
  return {
    order: o.id, guided: !!o.visit_id, visit_id: o.visit_id || null, guide_number: GUIDE_NUMBER,
    // no door path yet: the sender's app asks the customer to set one up, for next time
    needs_doorstep_setup: !taught, setup_prompt: !taught ? 'Add doorstep directions so riders reach your door without calling you' : null,
    consent: allowed
  };
}

// POST /v1/orders/:id/location: the rider app's live location (every few seconds)
export function orderLocation(o, { lat, lng, speed = null }) {
  const p = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return { ok: false, error: 'lat and lng are numbers' };
  o.at = { ...p, t: Date.now(), speed };
  if (o.status === 'assigned' || o.status === 'picked_up') { o.status = 'en_route'; o.events.push({ t: Date.now(), s: 'en_route' }); }
  putOrder(o);
  if (o.visit_id) setPosition(o.visit_id, p, 'sdk');
  emit('order.location', { order: o.id, sender: o.sender, lat: p.lat, lng: p.lng, status: o.status });
  return { ok: true };
}

// POST /v1/orders/:id/status: picked_up, en_route, arrived, stuck (rider tapped "Call customer"), delivered, failed
const STATUSES = new Set(['picked_up', 'en_route', 'arrived', 'stuck', 'guiding', 'delivered', 'failed']);
export function orderStatus(o, { status, note = '' }) {
  if (!STATUSES.has(status)) return { ok: false, error: 'unknown status' };
  o.status = status;
  o.events.push({ t: Date.now(), s: status, note });
  if (status === 'guiding') o.guided = true;
  if ((status === 'delivered' || status === 'failed') && o.visit_id) { const v = getVisit(o.visit_id); if (v?.status === 'active') closeVisit(o.visit_id, status === 'delivered' ? 'delivered' : 'closed', note); }
  putOrder(o);
  emit('order.status', { order: o.id, sender: o.sender, status, note, guided: o.guided });
  return { ok: true };
}

// The sender's numbers for today: the baseline is the demo's morning so far, the live orders add to it
export function senderStats(sender) {
  const live = ordersOf(sender);
  const guided = live.filter((o) => o.guided);
  const done = live.filter((o) => o.status === 'delivered');
  const base = { zepto: [1284, 61, 57, 108], swiggy: [2210, 94, 86, 121], amazon: [612, 38, 35, 146], uber: [3470, 129, 120, 74] }[sender] || [0, 0, 0, 0];
  const times = guided.map((o) => { const a = o.events.find((e) => e.s === 'stuck'), b = o.events.find((e) => e.s === 'delivered'); return a && b ? (b.t - a.t) / 1000 : null; }).filter(Boolean);
  const avg = times.length ? Math.round((base[3] * base[1] + times.reduce((s, x) => s + x, 0)) / (base[1] + times.length)) : base[3];
  return {
    deliveries: base[0] + done.length, guided: base[1] + guided.length, saved: base[2] + guided.filter((o) => o.status === 'delivered').length,
    calls_avoided: base[2] + guided.filter((o) => o.status === 'delivered').length, avg_stuck_to_door_s: avg,
    doorstep_ready: 0.31 // share of this sender's receivers who've taught their door
  };
}
export const defaultDoor = () => defaultDoorId();
