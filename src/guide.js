// Guidance logic behind the agent's tools. Every function returns a short English fact sheet the agent turns into Hinglish speech.
import { getDoor, matchSeen, nearestStep } from './doors.js';
import { getVisit, updateVisit, verifyCaller, closeVisit } from './visits.js';
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
  if (!r) return { say: 'No live location for this rider yet. Ask him which landmark or shop he can see.' };
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
  if (match?.kind === 'at') return pathFrom(v, door, match.n, `He is at "${match.label}".`);
  if (match?.kind === 'during') return pathFrom(v, door, match.n - 1, `He is passing "${match.label}", still on the way.`, true);

  // 2) He named something not on the path: find it on the map and steer him from there.
  //    When he's already close, only accept places within 300 m of him (avoids jumping to a same-named place elsewhere).
  if (seen && seen.trim().length > 2) {
    const near = r || anchor;
    const maxFromRider = zone === 'near' ? 300 : 2500;
    let place = null;
    try { place = (await findPlace(seen, near, 2000)).find((p) => p.distance_m < maxFromRider); } catch {}
    if (place) {
      const d = distance(place, anchor);
      if (d <= 60) return pathFrom(v, door, 0, `He is at ${place.name}, right at ${door.anchor.name}.`);
      if (d <= FAR_M) {
        return reply(v, 'near', `He is at ${place.name}. ${door.anchor.name} is about ${round(d)} m ${direction(place, anchor)} of there. Tell him to go ${direction(place, anchor)} for about ${round(d)} metres to the ${door.anchor.name} gate on 14th Main Road, then tell you when he is there.`);
      }
      return roadDirections(v, door, place, anchor, `He says he is at ${place.name}, ${round(d)} m from ${door.anchor.name}.`);
    }
    if (!r) return reply(v, zone, `Could not find "${seen}" on the map. Ask him for the name of a big shop, bank, school or temple near him.`);
  }

  // 3) Nothing useful said: use his live position.
  if (!r) return reply(v, null, 'No location yet. Ask him which shop or landmark he can see right now.');
  if (zone === 'far') return roadDirections(v, door, r, anchor, `He is about ${round(toAnchor)} m away.`);
  const near = nearestStep(door, r);
  return pathFrom(v, door, near.d < 25 ? near.n : Math.max(0, near.n - 1), `By GPS he is near step ${near.n}.`);
}

async function roadDirections(v, door, from, anchor, lead) {
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
    return reply(v, 'near', `${lead} Tell him he is on the right way and to keep going: ${st.instruction} Then ask: "${st.check}"`);
  }
  if (at === 0) milestone(v, 'anchor', `📍 Your ${cap(v.service)} rider has reached ${door.anchor.name}.`);
  if (!st) {
    milestone(v, 'door', `🚪 Your ${cap(v.service)} rider is at your door now.`);
    updateVisit(v.id, { step: door.steps.length });
    return reply(v, 'door', `${lead} He is at the door. Tell him: ${door.door.action}. If nobody opens: ${door.fallback.if_no_answer}`);
  }
  updateVisit(v.id, { step: at, zone: 'near' });
  if (st.n === door.steps.length) milestone(v, 'door', `🚪 Your ${cap(v.service)} rider is at your building, coming up now.`);
  const last = st.n === door.steps.length;
  return reply(v, 'near', `${lead} Next step (${st.n} of ${door.steps.length}): ${st.instruction}${last ? '' : ` Then ask: "${st.check}"`}`);
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
