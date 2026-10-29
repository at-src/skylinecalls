// Calibration: the customer teaches the agent the way from a big landmark to their door, in one call. The agent calls
// these tools as the customer talks; each one adds a piece of the door path and answers with a short fact sheet the
// agent can say back. When the path is complete, finish() checks it for gaps and saves it as the household's door.
import { emit, id, load } from './store.js';
import { getDoor, putDoor } from './doors.js';
import { findPlace, distance, direction } from './maps.js';

const sessions = new Map();
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const list = (x) => (Array.isArray(x) ? x : String(x || '').split(/[,;]| and /)).map((s) => s.trim()).filter(Boolean);
const num = (x) => (Number.isFinite(Number(x)) && x !== '' && x != null ? Number(x) : null);

export function startCalibration({ customer = 'Sam', door_id = '', near = null } = {}) {
  // map searches start round the household's home (HSR Layout for the demo)
  near = near || load('home', null) || { lat: 12.9128, lng: 77.6374 };
  const s = { id: id('cal'), customer, door_id, near, anchor: null, steps: [], door: null, fallback: null, started: Date.now() };
  sessions.set(s.id, s);
  emit('calib.started', { calibration: s.id, customer });
  return { calibration_id: s.id, say: `Calibration started for ${customer}. Ask for the nearest big landmark everyone knows, then call save_anchor with calibration_id ${s.id}.` };
}
export const getCalibration = (cid) => sessions.get(cid) || null;

// where a named place is: its own coordinates if the agent passed them, else a map search near where we are
async function locate(name, lat, lng, near, radius) {
  if (num(lat) != null && num(lng) != null) return { lat: num(lat), lng: num(lng), name, source: 'given' };
  if (!name) return null;
  try {
    const p = (await findPlace(name, near, radius))[0];
    if (p && (!near || distance(p, near) <= radius)) return { lat: p.lat, lng: p.lng, name: p.name, source: 'google' };
  } catch { /* no map search: the caller can add the point later */ }
  return null;
}

export async function saveAnchor(s, { name, also_called, description, lat, lng }) {
  const p = await locate(name, lat, lng, s.near, 3000);
  if (!p) return { say: `Could not find "${name}" on the map. Ask for another big landmark nearby (a bank, school, temple or mall), or the road it is on.` };
  s.anchor = { name: cap(name), also_called: list(also_called), description: description || '', lat: p.lat, lng: p.lng, source: p.source, confirmed: true };
  emit('calib.anchor', { calibration: s.id, name: s.anchor.name, lat: p.lat, lng: p.lng });
  return { say: `Found ${s.anchor.name}${p.name && p.name !== name ? ` (${p.name} on the map)` : ''}. Now ask: standing at its gate, which way to go first, how far, and what they will see on the way. Then call save_step.` };
}

export async function saveStep(s, a) {
  if (!s.anchor) return { say: 'Save the landmark first (save_anchor).' };
  const prev = s.steps.length ? s.steps[s.steps.length - 1] : s.anchor;
  const see = list(a.see), pass = list(a.pass);
  const landmark = a.landmark || see[0] || '';
  const d = num(a.distance_m);
  // the end of the step: given, or the landmark found near the last point, or the last point itself
  let p = await locate(landmark, a.lat, a.lng, prev, Math.max(250, (d || 0) * 2));
  if (!p) p = { lat: prev.lat, lng: prev.lng, source: 'previous' };
  const step = {
    n: s.steps.length + 1, instruction: String(a.instruction || '').trim(), see, pass, side: a.side || 'straight',
    distance_m: d ?? Math.round(distance(prev, p)), check: a.check || (see[0] ? `Can you see ${see[0]}?` : ''),
    lat: p.lat, lng: p.lng
  };
  if (a.map_matches) step.map_matches = a.map_matches;
  s.steps.push(step);
  emit('calib.step', { calibration: s.id, n: step.n, instruction: step.instruction, label: landmark || step.instruction.split('.')[0], lat: p.lat, lng: p.lng, from: { lat: prev.lat, lng: prev.lng } });
  const far = distance(prev, p);
  return { say: `Step ${step.n} saved${landmark ? `: ending at ${landmark}` : ''}${far > 5 ? `, about ${Math.round(far)} m ${direction(prev, p)} of the last point` : ''}. Ask what comes next, or, if this was the last step before the door, ask about the door and call save_door.` };
}

export function saveDoor(s, { floor, side, action, marks }) {
  s.door = { floor: floor || '', side: side || '', action: action || 'knock', marks: list(marks) };
  emit('calib.door', { calibration: s.id, ...s.door });
  return { say: 'Door saved. Ask what the rider should do if nobody opens, then call save_fallback.' };
}

export function saveFallback(s, { if_no_answer, contact, safe_spot }) {
  s.fallback = { if_no_answer: if_no_answer || '', contact: contact || '', safe_spot: safe_spot || '' };
  emit('calib.fallback', { calibration: s.id, ...s.fallback });
  return { say: 'Fallback saved. Call finish_calibration.' };
}

// Check the path for the gaps a rider would hit, then save it as the household's door
export function finish(s) {
  const gaps = [];
  if (!s.anchor) gaps.push('no starting landmark');
  if (!s.steps.length) gaps.push('no steps from the landmark');
  s.steps.forEach((st) => {
    if (!st.see.length) gaps.push(`step ${st.n} has nothing the rider will see when he gets there`);
    if (!st.instruction) gaps.push(`step ${st.n} has no direction`);
  });
  if (!s.door?.floor && !s.door?.side) gaps.push('which door it is (floor and side)');
  if (!s.fallback?.if_no_answer) gaps.push('what to do if nobody opens');
  if (gaps.length) {
    emit('calib.gaps', { calibration: s.id, gaps });
    return { complete: false, gaps, say: `Still missing: ${gaps.join('; ')}. Ask about these, one at a time.` };
  }
  const base = s.door_id ? getDoor(s.door_id) : null;
  const door = {
    ...(base || {}),
    id: s.door_id || `door-${s.id}`,
    customer: { ...(base?.customer || {}), name: s.customer },
    anchor: s.anchor, steps: s.steps, door: s.door, fallback: s.fallback,
    verified_at: new Date().toISOString().slice(0, 10), taught: 'voice'
  };
  putDoor(door);
  sessions.delete(s.id);
  emit('calib.done', { calibration: s.id, door_id: door.id, steps: door.steps.length });
  return { complete: true, door_id: door.id, say: `Saved: from ${door.anchor.name}, ${door.steps.length} steps to the ${door.door.floor} floor ${door.door.side} door. Read the whole way back to ${s.customer} in two or three sentences and thank them.` };
}
