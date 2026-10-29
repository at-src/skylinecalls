// Scripted sender shift: a company's riders out on deliveries across HSR Layout, their app (with the ToTheDoor SDK)
// sending each rider's live location through the real sender API functions. One rider is heading to Sam, who taught
// his door: near Agara he can't find it, taps "Call customer", and the guided call plays through the real tools
// (demo/replay.js). The others deliver on their own; two go to customers with no door path yet, who get asked in the
// app to set one up. Nothing is sent to a phone or to Telegram.
import { load, save, emit, bus } from '../store.js';
import { route, decodePolyline, distance } from '../maps.js';
import { defaultDoorId, getDoor } from '../doors.js';
import { flags } from '../notify.js';
import { SENDERS, registerOrder, orderLocation, orderStatus, getOrder } from '../sender.js';
import { replay } from './replay.js';

// dark stores, kitchens and pickup points, and customers, round HSR (the receivers are invented)
const PICKUPS = [
  { name: 'HSR Sector 1 store', lat: 12.9212, lng: 77.6481 },
  { name: '27th Main store', lat: 12.9118, lng: 77.6449 },
  { name: 'Agara hub', lat: 12.9226, lng: 77.6412 },
  { name: 'Sector 4 kitchen', lat: 12.9097, lng: 77.6312 }
];
const RECEIVERS = [
  { name: 'Priya', area: 'Sector 2', lat: 12.9175, lng: 77.6455 },
  { name: 'Arjun', area: 'Sector 7', lat: 12.9083, lng: 77.6381 },
  { name: 'Meera', area: 'Sector 3', lat: 12.9131, lng: 77.6468 },
  { name: 'Kabir', area: 'Sector 5', lat: 12.9104, lng: 77.6418 },
  { name: 'Ananya', area: 'Sector 6', lat: 12.9152, lng: 77.6335 }
];
const RIDERS = ['Ramesh', 'Suresh K', 'Imran', 'Vikram', 'Santosh', 'Deepak'];

// road routes, cached so repeated demos don't ask Google again
async function path(a, b) {
  const cache = load('route_cache', {});
  const key = [a.lat, a.lng, b.lat, b.lng].map((x) => x.toFixed(5)).join(',');
  if (!cache[key]) { cache[key] = (await route(a, b)).polyline; save('route_cache', cache); }
  const pts = decodePolyline(cache[key]);
  // ~6 m spacing for smooth movement
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const d = distance(pts[k - 1], pts[k]), n = Math.max(1, Math.round(d / 6));
    for (let j = 1; j <= n; j++) out.push({ lat: pts[k - 1].lat + ((pts[k].lat - pts[k - 1].lat) * j) / n, lng: pts[k - 1].lng + ((pts[k].lng - pts[k - 1].lng) * j) / n });
  }
  return out;
}

let running = null;
export const fleetRunning = () => !!running;
export function stopFleet() { if (running) { running.stop = true; } }

export async function fleet(TOOLS, { sender = 'zepto', pace = 1 } = {}) {
  if (running) return { ok: false, error: 'already running' };
  if (!SENDERS[sender]) return { ok: false, error: 'unknown sender' };
  const S = SENDERS[sender];
  const run = (running = { stop: false });
  flags.noCalls = true; flags.quiet = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / pace));
  const door = getDoor(defaultDoorId());
  emit('fleet.started', { sender, name: S.name });
  try {
    // the riders: one to Sam (taught door), the rest to other customers, two of whom have no door path yet
    const plans = [];
    const stuckAt = { lat: 12.92160, lng: 77.64390 }; // past BDA on the wrong side, near Agara lake
    plans.push({ rider: RIDERS[0], receiver: { name: 'Sam', area: 'Sector 6', lat: door.steps.at(-1).lat, lng: door.steps.at(-1).lng, door_id: door.id }, from: { lat: 12.92282, lng: 77.64705 }, to: stuckAt, guided: true }); // a few hundred metres out, coming the wrong way
    for (let i = 0; i < 5; i++) plans.push({ rider: RIDERS[i + 1], receiver: { ...RECEIVERS[i], door_id: null }, from: PICKUPS[(i + 1) % PICKUPS.length], to: RECEIVERS[i] });
    for (const p of plans) {
      try { p.pts = await path(p.from, p.to); } catch { p.pts = [p.from, p.to]; }
      // the rider for Sam is already close: his last ~200 m, so his call comes in a few seconds into the shift
      if (p.guided) p.pts = p.pts.slice(-34);
      const r = registerOrder(sender, { order_id: `${S.name.slice(0, 2).toUpperCase()}${Math.floor(100000 + Math.random() * 899999)}`, receiver: p.receiver, rider: { name: p.rider }, pickup: p.from });
      p.order = r.order;
      p.visit = r.visit_id;
      orderStatus(getOrder(p.order), { status: 'picked_up' });
      await sleep(250);
    }
    // ride: every rider moves along his route, one location ping a second (sped up for the demo)
    const speed = 15; // m per ping (about 50 km/h of city riding, sped up for the demo)
    let callStarted = false;
    const guided = plans[0];
    for (let tick = 0; tick < 400 && !run.stop; tick++) {
      let moving = 0;
      for (const p of plans) {
        if (p.done || p.paused) continue;
        p.i = Math.min((p.i || 0) + Math.max(1, Math.round(speed / 6)), p.pts.length - 1);
        const o = getOrder(p.order);
        orderLocation(o, p.pts[p.i]);
        moving++;
        if (p.i >= p.pts.length - 1) {
          if (p.guided) {
            // the rider for Sam can't find the door: he taps "Call customer" in the app and reaches ToTheDoor
            p.paused = true;
            orderStatus(getOrder(p.order), { status: 'stuck', note: 'rider tapped Call customer' });
          } else {
            p.done = true;
            orderStatus(o, { status: 'arrived' });
            setTimeout(() => { const oo = getOrder(p.order); if (oo) orderStatus(oo, { status: 'delivered', note: 'handed over' }); }, 2500 / pace);
          }
        }
      }
      if (guided.paused && !callStarted) {
        callStarted = true;
        orderStatus(getOrder(guided.order), { status: 'guiding' });
        // the guided call, through the real tools, for this order's visit
        const off = (e) => { if (e.type === 'visit.closed' && e.visit === guided.visit) { const o = getOrder(guided.order); if (o) orderStatus(o, { status: e.status === 'delivered' ? 'delivered' : 'failed', note: e.note || 'guided to the door' }); bus.off('event', off); } };
        bus.on('event', off);
        replay(TOOLS, { pace, visit_id: guided.visit, caller: `${S.name} rider · ${guided.rider}`, service: sender }).catch((e) => emit('error', { where: 'fleet replay', message: e.message }));
      }
      if (!moving && callStarted) break;
      await sleep(1000);
    }
    emit('fleet.ended', { sender });
    return { ok: true };
  } finally { running = null; flags.noCalls = false; flags.quiet = false; }
}
