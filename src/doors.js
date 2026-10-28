// Door paths: the learned "mental map" from an anchor landmark to the customer's door.
import { readFileSync } from 'node:fs';
import { load, save } from './store.js';
import { distance } from './maps.js';

const DEMO = JSON.parse(readFileSync(new URL('./demo/door-hsr.json', import.meta.url), 'utf8'));

export function doors() {
  const d = load('doors', {});
  if (!d[DEMO.id]) { d[DEMO.id] = DEMO; save('doors', d); }
  return d;
}
export const getDoor = (id) => doors()[id] || doors()[DEMO.id];
export const defaultDoorId = () => DEMO.id;
export function putDoor(door) { const d = doors(); d[door.id] = door; save('doors', d); return door; }

// ---------- matching what the rider says against the path ----------
const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'near', 'at', 'on', 'in', 'to', 'is', 'i', 'am', 'here', 'ke', 'ka', 'ki', 'paas', 'pe', 'par', 'hoon', 'hu', 'hai', 'main', 'mai', 'saamne', 'samne', 'side', 'dikh', 'raha', 'rahi', 'gaya', 'aa', 'gya', 'abhi', 'bhai', 'sir', 'ji', 'haan', 'yes']);
const words = (s) => norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));

// how strongly `seen` mentions `label`: 1 = all meaningful words of the label present
function score(seen, label) {
  const lw = words(label); if (!lw.length) return 0;
  const sw = new Set(words(seen));
  const hit = lw.filter((w) => sw.has(w) || [...sw].some((x) => x.length > 3 && (x.startsWith(w) || w.startsWith(x)))).length;
  return hit / lw.length;
}

// What the rider says he sees -> where he is on the path.
//   { kind: 'at', n }      reached the end of step n (n = 0: at the anchor) -> give step n+1
//   { kind: 'during', n }  somewhere along step n (passing things)          -> repeat step n
// Returns the best match or null. Later steps win ties, "at" beats "during".
export function matchSeen(door, seen) {
  if (!seen) return null;
  let best = null;
  const rank = (m) => m.score * 10 + (m.kind === 'at' ? 1 : 0) + m.n / 100;
  const consider = (kind, n, label) => {
    const s = score(seen, label);
    if (s < 0.6) return;
    const m = { kind, n, label, score: s };
    if (!best || rank(m) > rank(best)) best = m;
  };
  [door.anchor.name, ...(door.anchor.also_called || [])].forEach((l) => consider('at', 0, l));
  for (const st of door.steps) {
    (st.see || []).forEach((l) => consider('at', st.n, l));
    (st.pass || []).forEach((l) => consider('during', st.n, l));
  }
  return best;
}

// nearest point on the path to a position (n = 0 is the anchor, n = k is the end of step k)
export function nearestStep(door, p) {
  const pts = [{ n: 0, lat: door.anchor.lat, lng: door.anchor.lng }, ...door.steps.map((s) => ({ n: s.n, lat: s.lat, lng: s.lng }))];
  return pts.map((x) => ({ ...x, d: distance(p, x) })).sort((a, b) => a.d - b.d)[0];
}

// short spoken summary used only for the customer's own read-back; never given to visitors
export const summary = (door) => [`Start: ${door.anchor.name}.`, ...door.steps.map((s) => `${s.n}. ${s.instruction}`), `Fallback: ${door.fallback.if_no_answer}`].join('\n');
