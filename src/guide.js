// Guidance logic behind the agent's tools. Every function returns a short English fact sheet the agent turns into Hinglish speech.
import { getDoor, matchSeen, nearestStep, matchHub, bestHub } from './doors.js';
import { getVisit, updateVisit, verifyCaller, closeVisit, remainingMin, approxDistanceM } from './visits.js';
import { getRider } from './rider.js';
import { route, landmarks, findPlace, distance, direction, relativeSide } from './maps.js';
import { emit } from './store.js';
import { notify } from './notify.js';

const FAR_M = 150; // beyond this from the anchor, use road directions

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const round = (m) => (m < 100 ? Math.round(m / 5) * 5 : Math.round(m / 10) * 10);
const clean = (t) => t.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();

// notify the customer once per milestone
function milestone(v, key, text) {
  if ((v.log || []).includes(key)) return;
  updateVisit(v.id, { log: [...(v.log || []), key] });
  notify(text);
}

export function verify(args) {
  const r = verifyCaller(args);
  emit('tool.verify', { ok: r.ok, reason: r.reason, visit: r.visit?.id });
  if (r.ok) {
    milestone(r.visit, 'verified', `📞 Your ${cap(r.visit.service)} rider is on the line. I'm guiding them to your door.`);
    return { verified: true, visit_id: r.visit.id, service: r.visit.service, say: 'Verified. Now ask where he is right now (or use what he already said) and call next_instruction.' };
  }
  if (r.reason === 'need code') return { verified: false, need: 'customer', say: `Could not confirm him from what he said. Do not ask him for any code. Give no directions. Say "Haan, ruko ek second" and call ask_customer.` };
  if (r.reason === 'wrong code') return { verified: false, need: 'customer', say: 'Could not confirm him. Give no directions. Call ask_customer.' };
  return { verified: false, need: 'customer', say: `${r.reason}. Do not give any directions. Say you'll check with the family and call ask_customer.` };
}

// where the rider is and what's around him
async function context(v) {
  const door = getDoor(v.door_id);
  const r = getRider(v.id);
  const anchor = { lat: door.anchor.lat, lng: door.anchor.lng };
  if (!r) return { door, r: null, anchor };
  const toAnchor = distance(r, anchor);
  // near = within FAR_M of any point of the door path, not just the anchor (the door can be far from the anchor)
  const nearest = nearestStep(door, r);
  return { door, r, anchor, toAnchor, nearest, zone: nearest.d > FAR_M ? 'far' : 'near' };
}

export async function status(v) {
  const { door, r, anchor, toAnchor, zone } = await context(v);
  if (!r) {
    const m = remainingMin(v);
    if (m != null) return { eta_min: Math.round(m), approx_distance_m: approxDistanceM(v), say: `No live location. By the app ETA he is about ${Math.max(1, Math.round(m))} min (roughly ${(approxDistanceM(v) / 1000).toFixed(1)} km) away. Ask him where he is.` };
    return { say: 'No live location for this rider yet. Ask him which landmark or shop he can see.' };
  }
  let around = [];
  try { around = (await landmarks(r)).landmarks.slice(0, 3).map((l) => `${l.name} (${l.relation}, ${l.distance_m} m)`); } catch {}
  return {
    zone, distance_to_anchor_m: Math.round(toAnchor), anchor: door.anchor.name,
    anchor_direction: direction(r, anchor), around_rider: around,
    say: zone === 'far'
      ? `Rider is about ${round(toAnchor)} m from ${door.anchor.name}. Landmarks near him: ${around.join('; ') || 'none'}.`
      : `Rider is close, about ${round(toAnchor)} m from ${door.anchor.name}.`,
  };
}

// The core: next thing to tell the rider, using his live position and what he says he sees.
export async function next(v, seen = '') {
  const { door, r, anchor, toAnchor, zone } = await context(v);
  const match = matchSeen(door, seen);
  emit('tool.next', { visit: v.id, seen, match: match && `${match.kind}:${match.n}`, zone, distance_m: toAnchor && Math.round(toAnchor) });

  // 1) He named something on our path: that fixes where he is, whatever the GPS says.
  if (match) seenOnMap(v, door, match, seen);
  if (match?.kind === 'at') { placed(v, stepPoint(door, match.n), match.n, match.label); return pathFrom(v, door, match.n, `He is at "${match.label}".`); }
  if (match?.kind === 'during') { const a = stepPoint(door, match.n - 1), b = stepPoint(door, match.n); placed(v, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, match.n - 1, match.label); return pathFrom(v, door, match.n - 1, `He is passing "${match.label}", still on the way.`, true); }

  // 2) He named one of the big landmarks around the area: send him on from there, like a person would.
  const hub = matchHub(door, seen);
  if (hub) { placed(v, hub, -1, hub.name); highlight(v, 'seen', hub, hub.name, seen); }
  if (hub) return reply(v, 'far', `He is at ${hub.name}. Tell him, one part at a time: ${hub.to_anchor} Ask him to tell you when he reaches ${door.anchor.name}.`);

  // 3) He named something not on the path: find it on the map and steer him from there.
  //    When he's already close, only accept places within 300 m of him (avoids jumping to a same-named place elsewhere).
  if (seen && seen.trim().length > 2) {
    const near = r || anchor;
    const maxFromRider = zone === 'near' ? 300 : 2500;
    let place = null;
    try { place = (await findPlace(seen, near, 2000)).find((p) => p.distance_m < maxFromRider); } catch {}
    if (place) {
      placed(v, place, -1, place.name);
      highlight(v, 'seen', place, place.name, seen);
      const d = distance(place, anchor);
      if (d <= 60) return pathFrom(v, door, 0, `He is at ${place.name}, right at ${door.anchor.name}.`);
      if (d <= FAR_M) {
        return reply(v, 'near', `He is at ${place.name}. ${door.anchor.name} is about ${round(d)} m ${direction(place, anchor)} of there. Tell him to go ${direction(place, anchor)} for about ${round(d)} metres to the ${door.anchor.name} gate on 14th Main Road, then tell you when he is there.`);
      }
      return roadDirections(v, door, place, anchor, `He says he is at ${place.name}, ${round(d)} m from ${door.anchor.name}.`);
    }
    if (!r) return reply(v, zone, `Could not find "${seen}" on the map. Ask him for the name of a big shop, bank, school or temple near him.`);
  }

  // 4) Nothing useful said: use his live position.
  if (!r) return reply(v, null, 'No location yet. Ask him which shop or landmark he can see right now.');
  if (zone === 'far') return roadDirections(v, door, r, anchor, `He is about ${round(toAnchor)} m away.`);
  const near = nearestStep(door, r);
  return pathFrom(v, door, near.d < 25 ? near.n : Math.max(0, near.n - 1), `By GPS he is near step ${near.n}.`);
}

async function roadDirections(v, door, from, anchor, lead) {
  // like a person: if he's right at a big landmark, go from there; if one is on his way, send him there first
  const atHub = (door.hubs || []).find((h) => distance(from, h) < 300);
  if (atHub) return reply(v, 'far', `${lead} He is near ${atHub.name}. Tell him, one part at a time: ${atHub.to_anchor} Ask him to tell you when he reaches ${door.anchor.name}.`);
  const hub = distance(from, anchor) > 600 ? bestHub(door, from) : null;
  if (hub) return reply(v, 'far', `${lead} Tell him to come to ${hub.name} first (about ${(distance(from, hub) / 1000).toFixed(1)} km, he can ask anyone). When he says he is there: ${hub.to_anchor}`);
  let text = `${lead} Guide him to ${door.anchor.name}, ${door.anchor.description}`;
  try {
    const rt = await route(from, anchor);
    const steps = rt.steps.filter((s) => s.distance_m > 5).slice(0, 2).map((s) => `${clean(s.text)} (${round(s.distance_m)} m)`);
    text += ` Road directions from where he is: ${steps.join(' Then ')}. Total about ${(rt.distance_m / 1000).toFixed(1)} km. Give him only the first direction now, then ask him to tell you when he has done it.`;
  } catch {
    text += ` It is ${round(distance(from, anchor))} m to the ${direction(from, anchor)}.`;
  }
  return reply(v, 'far', text);
}

function pathFrom(v, door, at, lead, continuing = false) {
  const st = door.steps.find((s) => s.n === at + 1);
  if (continuing && st) {
    updateVisit(v.id, { step: at, zone: 'near' });
    targetOnMap(v, st);
    return reply(v, 'near', `${lead} Tell him he is on the right way and to keep going: ${st.instruction} Then ask: "${st.check}"`);
  }
  if (at === 0) milestone(v, 'anchor', `📍 Your ${cap(v.service)} rider has reached ${door.anchor.name}.`);
  if (!st) {
    milestone(v, 'door', `🚪 Your ${cap(v.service)} rider is at your door now.`);
    updateVisit(v.id, { step: door.steps.length });
    return reply(v, 'door', `${lead} He is at the door. Tell him: ${door.door.action}. If nobody opens: ${door.fallback.if_no_answer}`);
  }
  updateVisit(v.id, { step: at, zone: 'near' });
  targetOnMap(v, st);
  if (st.n === door.steps.length) milestone(v, 'door', `🚪 Your ${cap(v.service)} rider is at your building, coming up now.`);
  const last = st.n === door.steps.length;
  return reply(v, 'near', `${lead} Next step (${st.n} of ${door.steps.length}): ${st.instruction}${last ? '' : ` Then ask: "${st.check}"`}`);
}

// What the conversation points at, for the live map: 'seen' is what the rider says he can see (lit up where it is), 'target'
// is where the agent is sending him next. A step's landmark uses its own mapped spot (map_matches) when the door has one.
function spotFor(st, label) {
  const want = String(label || '').toLowerCase();
  const m = (st?.map_matches || []).find((x) => want && (x.name.toLowerCase().includes(want) || want.includes(x.name.toLowerCase())));
  return m ? { lat: m.lat, lng: m.lng, name: m.name } : st ? { lat: st.lat, lng: st.lng, name: label } : null;
}
function highlight(v, kind, p, label, said = '') {
  if (!p) return;
  emit('map.highlight', { visit: v.id, kind, lat: p.lat, lng: p.lng, label, said });
}
function seenOnMap(v, door, match, said) {
  if (match.n === 0) return highlight(v, 'seen', door.anchor, door.anchor.name, said);
  const st = door.steps.find((s) => s.n === match.n);
  highlight(v, 'seen', spotFor(st, match.label), match.label, said);
}
function targetOnMap(v, st) {
  const label = (st.see && st.see[0]) || st.instruction.split('.')[0];
  highlight(v, 'target', spotFor(st, label), label);
}
// where the agent now believes the rider is (drives the live map)
const stepPoint = (door, n) => (n === 0 ? { lat: door.anchor.lat, lng: door.anchor.lng } : { lat: door.steps[n - 1].lat, lng: door.steps[n - 1].lng });
function placed(v, p, step, label) {
  if (!p) return;
  emit('rider.placed', { visit: v.id, lat: p.lat, lng: p.lng, step, label });
}

function reply(v, zone, say) {
  if (zone) updateVisit(v.id, { zone });
  emit('tool.reply', { visit: v.id, zone, say });
  return { zone, say };
}

export function outcome(v, result, note = '') {
  const status = /deliver|done|handed|received|left|kept|rack/i.test(result) ? 'delivered' : 'closed';
  closeVisit(v.id, status, `${result}${note ? ' — ' + note : ''}`);
  const time = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  notify(status === 'delivered' ? `✅ ${cap(v.service)} delivered: ${result}${note ? ' (' + note + ')' : ''}, ${time}.` : `ℹ️ ${cap(v.service)} visit closed: ${result}.`);
  return { say: 'Logged. Thank him and say bye.' };
}

export const visitOf = (visit_id) => (visit_id ? getVisit(visit_id) : null);
