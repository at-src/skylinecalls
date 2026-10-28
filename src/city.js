// Bakes a small 3D-ready city around a point from OpenStreetMap: building footprints with heights,
// roads with widths, water, green areas and trees, all in local metres (x = east, z = south).
// Data: OpenStreetMap main API (/api/0.6/map), cached in data/city-*.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const M_LAT = 110540;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// ---------- download ----------
export async function fetchOsm(lat, lng, halfM = 850) {
  const dLat = halfM / M_LAT, dLng = halfM / mLng(lat);
  const box = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(5)).join(',');
  const r = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${box}`, {
    headers: { 'User-Agent': 'ToTheDoor-hackathon/0.1 (local demo)' }, signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`OSM ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.text();
}

// ---------- parse (the OSM XML is regular enough for this) ----------
function parse(xml) {
  const nodes = new Map(), trees = [], ways = [];
  const attr = (s, k) => { const m = s.match(new RegExp(`\\s${k}="([^"]*)"`)); return m ? m[1] : null; };
  const tagsOf = (body) => { const t = {}; for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)) t[m[1]] = m[2]; return t; };
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = attr(m[1], 'id'), la = attr(m[1], 'lat'), lo = attr(m[1], 'lon');
    if (!id || la == null) continue;
    nodes.set(id, [Number(la), Number(lo)]);
    if (m[3] && /k="natural" v="tree"/.test(m[3])) trees.push([Number(la), Number(lo)]);
  }
  for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const refs = [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((x) => x[1]);
    ways.push({ id: attr(m[1], 'id'), refs, tags: tagsOf(m[2]) });
  }
  return { nodes, trees, ways };
}

// ---------- heights ----------
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; }
function area(pts) { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; }
function heightOf(tags, a, id) {
  const r = hash(id);
  if (tags.height) { const h = parseFloat(tags.height); if (h > 2 && h < 300) return h; }
  if (tags['building:levels']) { const l = parseFloat(tags['building:levels']); if (l > 0 && l < 80) return l * 3.3 + 0.8; }
  const b = tags.building;
  let floors;
  if (/apartments|residential_tower|hotel/.test(b)) floors = 5 + Math.round(r * 9);
  else if (/commercial|office|retail|hospital|college|university/.test(b)) floors = 3 + Math.round(r * (a > 800 ? 7 : 4));
  else if (/school|public|civic|government/.test(b)) floors = 2 + Math.round(r * 2);
  else if (/house|detached|semidetached_house|terrace/.test(b)) floors = 2 + Math.round(r * 1.4);
  else if (/shed|garage|roof|carport|hut/.test(b)) floors = 1;
  else floors = a < 90 ? 2 + Math.round(r * 1.5) : a < 300 ? 3 + Math.round(r * 2) : a < 1200 ? 4 + Math.round(r * 4) : 5 + Math.round(r * 8);
  return floors * 3.3 + 0.6 + r * 1.2;
}

const ROAD_W = { motorway: 20, trunk: 18, primary: 15, secondary: 12, tertiary: 10, unclassified: 7, residential: 7, living_street: 5, service: 4.5, pedestrian: 4, footway: 2, path: 1.8, cycleway: 2, steps: 2, track: 3 };
const ROAD_RANK = { motorway: 5, trunk: 5, primary: 4, secondary: 3, tertiary: 2, unclassified: 1, residential: 1 };

// ---------- bake ----------
export function bake(xml, lat0, lng0, radius = 820) {
  const { nodes, trees, ways } = parse(xml);
  const k = mLng(lat0);
  const P = (ll) => [Math.round((ll[1] - lng0) * k * 10) / 10, Math.round(-(ll[0] - lat0) * M_LAT * 10) / 10];
  const ring = (w) => w.refs.map((r) => nodes.get(r)).filter(Boolean).map(P);
  const inside = (pts) => pts.some(([x, z]) => x * x + z * z < radius * radius);
  const out = { origin: { lat: lat0, lng: lng0 }, radius, buildings: [], roads: [], water: [], green: [], trees: [], landmarks: [] };

  for (const w of ways) {
    const t = w.tags;
    if (t.building && t.building !== 'no') {
      const pts = ring(w); if (pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
      if (pts.length < 3 || !inside(pts)) continue;
      const a = area(pts); if (a < 12) continue;
      out.buildings.push({ p: pts.flat(), h: Math.round(heightOf(t, a, w.id) * 10) / 10, k: /commercial|retail|office/.test(t.building) || t.shop ? 1 : 0 });
      if (t.name && a > 400) { const c = pts.reduce((s, q) => [s[0] + q[0] / pts.length, s[1] + q[1] / pts.length], [0, 0]); out.landmarks.push({ name: t.name, x: Math.round(c[0]), z: Math.round(c[1]) }); }
    } else if (t.highway && ROAD_W[t.highway]) {
      const pts = ring(w); if (pts.length < 2 || !inside(pts)) continue;
      const lanes = parseFloat(t.lanes);
      out.roads.push({ p: pts.flat(), w: lanes > 1 ? Math.max(ROAD_W[t.highway], lanes * 3.4) : ROAD_W[t.highway], r: ROAD_RANK[t.highway] || 0, f: /footway|path|steps|pedestrian|cycleway/.test(t.highway) ? 1 : 0, n: t.name || '' });
    } else if (t.natural === 'water' || t.landuse === 'reservoir' || t.water) {
      const pts = ring(w); if (pts.length > 3 && inside(pts)) out.water.push({ p: pts.flat() });
    } else if (/park|playground|pitch|garden/.test(t.leisure || '') || /grass|recreation_ground|forest|meadow/.test(t.landuse || '')) {
      const pts = ring(w); if (pts.length > 3 && inside(pts)) out.green.push({ p: pts.flat() });
    }
  }
  for (const tr of trees) { const [x, z] = P(tr); if (x * x + z * z < radius * radius) out.trees.push(x, z); }
  out.stats = { buildings: out.buildings.length, roads: out.roads.length, water: out.water.length, green: out.green.length, trees: out.trees.length / 2 };
  return out;
}

// ---------- cached access ----------
const key = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
export async function cityAt(lat, lng, dir = 'data') {
  const f = `${dir}/city-${key(lat, lng)}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let xml;
  try { xml = await fetchOsm(lat, lng, 850); } catch { xml = await fetchOsm(lat, lng, 550); } // dense areas exceed the node limit
  const city = bake(xml, lat, lng, 820);
  writeFileSync(f, JSON.stringify(city));
  return city;
}
