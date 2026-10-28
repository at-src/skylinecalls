// Rider position: a simulator that rides a real route (optionally with a wrong turn), or live GPS pushed from a phone.
import { load, save, emit } from './store.js';
import { route, decodePolyline, distance, bearing } from './maps.js';
import { getDoor } from './doors.js';

const state = load('riders', {}); // visit_id -> { lat, lng, heading, path, i, speed, mode, updated }
const persist = () => save('riders', state);
const timers = {};

export const getRider = (vid) => state[vid] || null;

export function setPosition(vid, p, mode = 'gps') {
  const prev = state[vid];
  const heading = prev && distance(prev, p) > 2 ? bearing(prev, p) : prev?.heading ?? 0;
  state[vid] = { ...(prev || {}), lat: p.lat, lng: p.lng, heading, mode, updated: new Date().toISOString() };
  persist();
  emit('rider.position', { visit: vid, lat: p.lat, lng: p.lng, heading, mode });
  return state[vid];
}

// densify a polyline to ~5 m spacing so movement looks smooth
function densify(pts, step = 5) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k], d = distance(a, b), n = Math.max(1, Math.round(d / step));
    for (let j = 1; j <= n; j++) out.push({ lat: a.lat + ((b.lat - a.lat) * j) / n, lng: a.lng + ((b.lng - a.lng) * j) / n });
  }
  return out;
}

// Builds the ride: road route from `from` to the anchor (through `via` for a wrong turn), then the walk along the door path.
export async function planRide(vid, { from, via = null, door_id }) {
  const door = getDoor(door_id);
  const anchor = { lat: door.anchor.lat, lng: door.anchor.lng };
  const legs = via ? [[from, via], [via, anchor]] : [[from, anchor]];
  let pts = [];
  for (const [a, b] of legs) pts = pts.concat(decodePolyline((await route(a, b)).polyline));
  pts = pts.concat(door.steps.map((s) => ({ lat: s.lat, lng: s.lng })));
  const path = densify(pts);
  state[vid] = { ...(state[vid] || {}), path, i: 0, lat: path[0].lat, lng: path[0].lng, heading: bearing(path[0], path[1] || path[0]), mode: 'sim', speed: 8, updated: new Date().toISOString() };
  persist();
  emit('rider.planned', { visit: vid, points: path.length, length_m: Math.round(path.slice(1).reduce((s, p, k) => s + distance(path[k], p), 0)) });
  return state[vid];
}

// move the simulated rider forward by `metres`
export function advance(vid, metres) {
  const r = state[vid]; if (!r?.path) return null;
  let left = metres;
  while (left > 0 && r.i < r.path.length - 1) { left -= distance(r.path[r.i], r.path[r.i + 1]); r.i++; }
  return setPosition(vid, r.path[r.i], 'sim');
}

export function startSim(vid, speed = 8) {
  stopSim(vid);
  state[vid].speed = speed;
  timers[vid] = setInterval(() => {
    const r = advance(vid, state[vid].speed);
    if (!r || state[vid].i >= state[vid].path.length - 1) stopSim(vid);
  }, 1000);
}
export function stopSim(vid) { clearInterval(timers[vid]); delete timers[vid]; }
export const isRiding = (vid) => !!timers[vid];

// Approximate position from the app's ETA when there's no live GPS.
// With a known origin (restaurant / store): a point along the road route, remaining distance from the anchor.
// Without one: no point, only a radius around the anchor (shown as a ring).
const routes = {};
export async function estimatePosition(v, door, remainingM) {
  if (remainingM == null) return null;
  const anchor = { lat: door.anchor.lat, lng: door.anchor.lng };
  if (!v.origin) return { approx: true, radius_m: remainingM, center: anchor };
  const key = `${v.origin.lat},${v.origin.lng}`;
  if (!routes[key]) routes[key] = densify(decodePolyline((await route(v.origin, anchor)).polyline), 10);
  const pts = routes[key];
  // walk back from the anchor along the route by the remaining distance
  let left = remainingM, i = pts.length - 1;
  while (left > 0 && i > 0) { left -= distance(pts[i], pts[i - 1]); i--; }
  return { approx: true, lat: pts[i].lat, lng: pts[i].lng, radius_m: Math.max(80, Math.round(remainingM * 0.25)) };
}
