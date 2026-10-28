// Probes Google Photorealistic 3D Tiles coverage at candidate demo locations.
// It walks the 3D-tiles tree toward each lat/lng and reports the deepest geometricError reached:
// a small geometricError (roughly < 30) means detailed, textured buildings exist there.
import '../src/env.js';

const KEY = process.env.GOOGLE_MAPS_KEY;
const ROOT = 'https://tile.googleapis.com';

const SPOTS = [
  ['UB City / Vittal Mallya Rd', 12.9719, 77.5957],
  ['MG Road metro', 12.9756, 77.6069],
  ['Vidhana Soudha', 12.9794, 77.5907],
  ['Cubbon Park', 12.9763, 77.5929],
  ['Brigade Road', 12.9718, 77.6073],
  ['Indiranagar 100ft Rd', 12.9719, 77.6412],
  ['Koramangala 5th block', 12.9349, 77.6205],
  ['HSR BDA Complex (current)', 12.9137, 77.6373],
  ['Bangalore Palace', 12.9987, 77.5921],
  ['Lalbagh', 12.9507, 77.5848],
];

// convert lat/lng to the ECEF-ish check: we just descend children whose bounding box contains the point's
// approximate tile-space coords. Simpler + robust: fetch tree depth-first following the child whose region
// (if present) contains the point; else follow the first child. Report min geometricError seen with content.
async function get(url) {
  const u = url.startsWith('http') ? url : ROOT + url;
  const sep = u.includes('?') ? '&' : '?';
  const r = await fetch(u + sep + 'key=' + KEY, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 80));
  return r.json();
}

// geodetic (deg) -> unit ECEF direction, to compare against oriented bounding boxes (centre vector)
function dir(lat, lng) {
  const a = (lat * Math.PI) / 180, b = (lng * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

// pick the child whose OBB centre direction is closest to the target direction
function pickChild(node, d) {
  const kids = node.children || [];
  let best = null, bestScore = -2;
  for (const c of kids) {
    const box = c.boundingVolume?.box;
    if (!box) { if (!best) best = c; continue; }
    const centre = [box[0], box[1], box[2]];
    const n = Math.hypot(...centre) || 1;
    const score = dot(d, [centre[0] / n, centre[1] / n, centre[2] / n]);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

async function deepest(lat, lng) {
  const d = dir(lat, lng);
  let tree = await get('/v1/3dtiles/root.json');
  let node = tree.root, best = Infinity, steps = 0, nextUri = null;
  while (node && steps < 22) {
    steps++;
    if (node.content?.uri && node.geometricError != null) best = Math.min(best, node.geometricError);
    // descend: into an external tileset if the chosen child points to one, else into inline children
    const child = pickChild(node, d);
    if (!child) break;
    if (child.content?.uri && /\.json/.test(child.content.uri)) {
      try { tree = await get(child.content.uri); node = tree.root; continue; } catch { break; }
    }
    if (child.children?.length) { node = child; continue; }
    if (child.content?.uri) { if (child.geometricError != null) best = Math.min(best, child.geometricError); break; }
    break;
  }
  return best;
}

for (const [name, lat, lng] of SPOTS) {
  try { const g = await deepest(lat, lng); console.log(`${g < 30 ? 'GOOD' : g < 80 ? 'ok  ' : 'weak'}  ge=${g === Infinity ? 'n/a' : g.toFixed(1).padStart(6)}  ${name}`); }
  catch (e) { console.log(`err   ${name}: ${e.message}`); }
}
