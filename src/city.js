// Bakes a 3D-ready city around a point from OpenStreetMap, classifying every building from the map data:
// its tags, the land-use zone it sits in, the shops and places inside it, its footprint and whether it fronts a main road.
// Output is in local metres (x = east, z = south). Data: OpenStreetMap main API (/api/0.6/map), cached in data/city-*.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const M_LAT = 110540;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// building types (kept in sync with public/city3d.js)
export const T = { HOUSE: 0, APARTMENT: 1, SHOPS: 2, OFFICE: 3, CIVIC: 4, LOW: 5, RELIGIOUS: 6, MALL: 7 };
// land-use zones
export const Z = { RESIDENTIAL: 0, COMMERCIAL: 1, INDUSTRIAL: 2, PARK: 3, CONSTRUCTION: 4, WATER: 5, RELIGIOUS: 6, CEMETERY: 7, PITCH: 8, PARKING: 9 };

// ---------- download ----------
export async function fetchOsm(lat, lng, halfM = 850) {
  const dLat = halfM / M_LAT, dLng = halfM / mLng(lat);
  const box = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((v) => v.toFixed(5)).join(',');
  const r = await fetch(`https://api.openstreetmap.org/api/0.6/map?bbox=${box}`, {
    headers: { 'User-Agent': 'Skyline-hackathon/0.1 (local demo)' }, signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error(`OSM ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.text();
}

// ---------- parse ----------
function parse(xml) {
  const nodes = new Map(), points = [], ways = [];
  const attr = (s, k) => { const m = s.match(new RegExp(`\\s${k}="([^"]*)"`)); return m ? m[1] : null; };
  const tagsOf = (body) => { const t = {}; for (const m of body.matchAll(/<tag k="([^"]*)" v="([^"]*)"\/>/g)) t[m[1]] = m[2]; return t; };
  for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = attr(m[1], 'id'), la = attr(m[1], 'lat'), lo = attr(m[1], 'lon');
    if (!id || la == null) continue;
    const ll = [Number(la), Number(lo)];
    nodes.set(id, ll);
    if (m[3]) { const t = tagsOf(m[3]); if (Object.keys(t).length) points.push({ ll, t }); }
  }
  for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
    const refs = [...m[2].matchAll(/<nd ref="(\d+)"\/>/g)].map((x) => x[1]);
    ways.push({ id: attr(m[1], 'id'), refs, tags: tagsOf(m[2]) });
  }
  return { nodes, points, ways };
}

// ---------- geometry helpers ----------
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
const area = (pts) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; a += x1 * z2 - x2 * z1; } return Math.abs(a) / 2; };
const centroid = (pts) => pts.reduce((s, q) => [s[0] + q[0] / pts.length, s[1] + q[1] / pts.length], [0, 0]);
function pip(x, z, pts) { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, zi] = pts[i], [xj, zj] = pts[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; }
function segDist(px, pz, ax, az, bx, bz) { const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1; let t = ((px - ax) * dx + (pz - az) * dz) / L; t = Math.max(0, Math.min(1, t)); return Math.hypot(px - ax - t * dx, pz - az - t * dz); }
// oriented size of a footprint: longest edge direction, length and width
function dims(pts) {
  let best = 0, ang = 0;
  for (let i = 0; i < pts.length; i++) { const [ax, az] = pts[i], [bx, bz] = pts[(i + 1) % pts.length]; const L = Math.hypot(bx - ax, bz - az); if (L > best) { best = L; ang = Math.atan2(bz - az, bx - ax); } }
  const c = Math.cos(-ang), s = Math.sin(-ang); let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { const u = x * c - z * s, v = x * s + z * c; x0 = Math.min(x0, u); x1 = Math.max(x1, u); z0 = Math.min(z0, v); z1 = Math.max(z1, v); }
  return { len: x1 - x0, wid: z1 - z0, ang };
}

// simple spatial grid for "what's near here"
class Grid {
  constructor(cell) { this.c = cell; this.m = new Map(); }
  key(x, z) { return `${Math.floor(x / this.c)},${Math.floor(z / this.c)}`; }
  add(x0, z0, x1, z1, v) { for (let x = Math.floor(x0 / this.c); x <= Math.floor(x1 / this.c); x++) for (let z = Math.floor(z0 / this.c); z <= Math.floor(z1 / this.c); z++) { const k = `${x},${z}`; if (!this.m.has(k)) this.m.set(k, []); this.m.get(k).push(v); } }
  near(x, z) { return this.m.get(this.key(x, z)) || []; }
}

const ROAD_W = { motorway: 22, trunk: 20, trunk_link: 9, primary: 16, primary_link: 8, secondary: 13, secondary_link: 7, tertiary: 10, unclassified: 7, residential: 6.5, living_street: 5, service: 4.5, pedestrian: 4, footway: 2, path: 1.8, cycleway: 2, steps: 2, track: 3 };
const ROAD_RANK = { motorway: 5, trunk: 5, trunk_link: 3, primary: 4, primary_link: 3, secondary: 3, secondary_link: 2, tertiary: 2, unclassified: 1, residential: 1, living_street: 1, service: 0 };

const SHOPPY = /restaurant|cafe|fast_food|bank|atm|pharmacy|clinic|ice_cream|bar|pub|marketplace|fuel|doctors|dentist|bakery/;

// ---------- bake ----------
export function bake(xml, lat0, lng0, radius = 820) {
  const { nodes, points, ways } = parse(xml);
  const k = mLng(lat0);
  const P = (ll) => [Math.round((ll[1] - lng0) * k * 10) / 10, Math.round(-(ll[0] - lat0) * M_LAT * 10) / 10];
  const ring = (w) => w.refs.map((r) => nodes.get(r)).filter(Boolean).map(P);
  const closed = (pts) => { if (pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop(); return pts; };
  const inside = (pts, pad = 0) => pts.some(([x, z]) => x * x + z * z < (radius + pad) ** 2);
  const out = { origin: { lat: lat0, lng: lng0 }, radius, buildings: [], roads: [], zones: [], waterways: [], lamps: [], signals: [], stops: [], pois: [], trees: [], landmarks: [] };

  // --- zones (land use) ---
  const zoneOf = (t) => {
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.water) return Z.WATER;
    if (/park|garden|playground/.test(t.leisure || '') || /grass|recreation_ground|forest|meadow|village_green/.test(t.landuse || '') || t.natural === 'wood') return Z.PARK;
    if (/pitch|sports_centre|track|stadium/.test(t.leisure || '')) return Z.PITCH;
    if (t.landuse === 'construction' || t.landuse === 'brownfield' || t.landuse === 'greenfield') return Z.CONSTRUCTION;
    if (t.landuse === 'commercial' || t.landuse === 'retail') return Z.COMMERCIAL;
    if (t.landuse === 'industrial') return Z.INDUSTRIAL;
    if (t.landuse === 'religious' || t.amenity === 'place_of_worship') return Z.RELIGIOUS;
    if (t.landuse === 'cemetery') return Z.CEMETERY;
    if (t.amenity === 'parking') return Z.PARKING;
    if (t.landuse === 'residential') return Z.RESIDENTIAL;
    return -1;
  };
  const zonePolys = [];
  for (const w of ways) {
    if (w.tags.building) continue;
    const z = zoneOf(w.tags); if (z < 0) continue;
    const pts = closed(ring(w)); if (pts.length < 3 || !inside(pts, 400)) continue;
    const a = area(pts); if (a < 40) continue;
    zonePolys.push({ z, pts, a });
    out.zones.push({ z, p: pts.flat() });
  }
  zonePolys.sort((a, b) => a.a - b.a); // smallest (most specific) zone wins
  const zoneAt = (x, z) => { for (const zp of zonePolys) if (zp.z !== Z.WATER && pip(x, z, zp.pts)) return zp.z; return Z.RESIDENTIAL; };

  // --- waterways: rivers, canals, storm-water drains (rajakaluve) ---
  for (const w of ways) {
    const t = w.tags; if (!t.waterway) continue;
    const pts = ring(w); if (pts.length < 2 || !inside(pts, 60)) continue;
    const width = { river: 18, canal: 9, stream: 4, drain: 4, ditch: 2 }[t.waterway] || 3;
    out.waterways.push({ p: pts.flat(), w: width });
  }

  // --- roads ---
  const mainRoads = new Grid(40);
  for (const w of ways) {
    const t = w.tags; if (!t.highway || !ROAD_W[t.highway]) continue;
    const pts = ring(w); if (pts.length < 2 || !inside(pts, 60)) continue;
    const lanes = parseFloat(t.lanes), rank = ROAD_RANK[t.highway] ?? 0;
    const width = lanes > 1 ? Math.max(ROAD_W[t.highway], lanes * 3.3) : ROAD_W[t.highway];
    const foot = /footway|path|steps|pedestrian|cycleway|track/.test(t.highway) ? 1 : 0;
    out.roads.push({ p: pts.flat(), w: width, r: rank, f: foot, n: t.name || '', o: t.oneway === 'yes' ? 1 : 0 });
    if (rank >= 2) for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i]; mainRoads.add(Math.min(ax, bx) - 30, Math.min(az, bz) - 30, Math.max(ax, bx) + 30, Math.max(az, bz) + 30, [ax, az, bx, bz, width, rank]); }
  }
  const mainRoadDist = (x, z) => { let d = Infinity, rk = 0; for (const [ax, az, bx, bz, w, r] of mainRoads.near(x, z)) { const q = segDist(x, z, ax, az, bx, bz) - w / 2; if (q < d) { d = q; rk = r; } } return { d, rk }; };

  // --- points: lamps, signals, bus stops, shops/places, trees ---
  const poiGrid = new Grid(30);
  for (const { ll, t } of points) {
    const [x, z] = P(ll); if (x * x + z * z > (radius + 50) ** 2) continue;
    if (t.highway === 'street_lamp') out.lamps.push(x, z);
    else if (t.highway === 'traffic_signals') out.signals.push(x, z);
    else if (t.highway === 'bus_stop') out.stops.push(x, z);
    else if (t.natural === 'tree') out.trees.push(x, z);
    else if (t.shop || (t.amenity && SHOPPY.test(t.amenity)) || t.office || t.tourism) {
      const kind = t.shop ? 'shop' : t.amenity || t.office || t.tourism;
      const poi = { x, z, kind, name: t.name || '' };
      out.pois.push({ x: Math.round(x), z: Math.round(z), k: kind, n: poi.name });
      poiGrid.add(x - 1, z - 1, x + 1, z + 1, poi);
    }
  }

  // --- buildings, classified ---
  let id = 0;
  for (const w of ways) {
    const t = w.tags; if (!t.building || t.building === 'no') continue;
    const pts = closed(ring(w)); if (pts.length < 3 || !inside(pts)) continue;
    const a = area(pts); if (a < 10) continue;
    const [cx, cz] = centroid(pts), r = hash(w.id), r2 = hash(w.id + 'x');
    const { len, wid } = dims(pts);
    const zone = zoneAt(cx, cz);
    const road = mainRoadDist(cx, cz);
    const frontsMain = road.d < Math.max(12, wid * 0.8);
    // places inside or right at the building
    let shops = 0, kinds = new Set();
    for (const poi of [...poiGrid.near(cx, cz)]) { if (pip(poi.x, poi.z, pts) || Math.hypot(poi.x - cx, poi.z - cz) < Math.max(8, Math.sqrt(a) * 0.6)) { shops++; kinds.add(poi.kind); } }
    const b = t.building;
    const lv = parseFloat(t['building:levels']), ht = parseFloat(t.height);

    let type;
    if (/temple|church|mosque|religious|chapel|cathedral|shrine/.test(b) || zone === Z.RELIGIOUS) type = T.RELIGIOUS;
    else if (/school|college|university|hospital|public|civic|government|kindergarten|dormitory|grandstand|stadium/.test(b)) type = T.CIVIC;
    else if (/shed|garage|garages|roof|carport|hut|kiosk|service|hangar|warehouse|industrial|construction|container|toilets/.test(b) || zone === Z.INDUSTRIAL || (a < 28 && !lv)) type = T.LOW;
    else if (/mall|supermarket|department_store/.test(b + ' ' + [...kinds].join(' ')) || ((/commercial|retail/.test(b) || zone === Z.COMMERCIAL) && a > 2600)) type = T.MALL;
    else if (/office/.test(b) || (/commercial/.test(b) && a > 900)) type = T.OFFICE;
    else if (/commercial|retail|supermarket|kiosk/.test(b) || shops > 0 || zone === Z.COMMERCIAL || (frontsMain && road.rk >= 2 && a > 70)) type = (a > 1600 && (zone === Z.COMMERCIAL || /commercial/.test(b))) ? T.OFFICE : T.SHOPS;
    else if (/apartments|residential|flats/.test(b) || a > 420) type = T.APARTMENT;
    else type = T.HOUSE;

    // floors: map data first, then what's typical for that type here
    let floors;
    if (Number.isFinite(lv) && lv > 0) floors = Math.round(lv) + (type === T.HOUSE || type === T.APARTMENT ? 0 : 0);
    else if (Number.isFinite(ht) && ht > 2) floors = Math.max(1, Math.round(ht / 3.2));
    else switch (type) {
      case T.HOUSE: { // ground floor only up to G+4, skewed by plot size
        const base = a < 60 ? [1, 2, 2, 2, 3, 3] : a < 140 ? [1, 2, 2, 3, 3, 3, 4, 4, 5] : [2, 3, 3, 4, 4, 5, 5, 6];
        floors = base[Math.floor(r * base.length)]; break; }
      case T.APARTMENT: floors = a < 700 ? 4 + Math.round(r * 3) : a < 1800 ? 5 + Math.round(r * 5) : 8 + Math.round(r * 9); break;
      case T.MALL: floors = 3 + Math.round(r * 3); break;
      case T.SHOPS: floors = (road.rk >= 3 ? 3 : 2) + Math.round(r * (a > 300 ? 3 : 2)); break;
      case T.OFFICE: floors = a < 1500 ? 4 + Math.round(r * 4) : 6 + Math.round(r * 8); break;
      case T.CIVIC: floors = 2 + Math.round(r * (a > 1500 ? 3 : 2)); break;
      case T.RELIGIOUS: floors = 1 + (a > 300 ? 1 : 0); break;
      default: floors = 1;
    }
    floors = Math.max(1, Math.min(40, floors));
    const floorH = type === T.OFFICE ? 3.6 : type === T.MALL ? 5.2 : type === T.LOW ? 4.2 : type === T.RELIGIOUS ? 4.5 : 3.2;
    const h = Math.round((floors * floorH + (type === T.LOW ? 0 : 0.9) + (type === T.HOUSE ? 1.0 : 0)) * 10) / 10;

    // how lit it is tonight (0..1): homes moderate, offices low, shops high
    const occupancy = { [T.HOUSE]: 0.42, [T.APARTMENT]: 0.48, [T.SHOPS]: 0.55, [T.OFFICE]: 0.18, [T.CIVIC]: 0.12, [T.LOW]: 0.08, [T.RELIGIOUS]: 0.7, [T.MALL]: 0.85 }[type] * (0.55 + r2 * 0.9);

    out.buildings.push({
      p: pts.flat(), h, t: type, fl: floors, c: Math.floor(hash(w.id + 'c') * 12), s: shops ? 1 : 0,
      m: frontsMain ? 1 : 0, o: Math.round(Math.min(1, occupancy) * 100) / 100,
      // roof: 0 flat terrace, 1 Mangalore tile gable (old small houses), 2 metal sheet (sheds, top-floor rooms)
      rf: type === T.LOW ? 2 : type === T.HOUSE && floors <= 2 && a < 160 && pts.length <= 5 && hash(w.id + 'r') < 0.22 ? 1 : 0,
      // top floor set back from the edge (very common: a smaller room on the terrace)
      sb: (type === T.HOUSE || type === T.APARTMENT || type === T.SHOPS) && floors >= 2 && a > 55 && hash(w.id + 's') < (type === T.HOUSE ? 0.5 : 0.3) ? 1 : 0,
      tank: (type === T.HOUSE || type === T.APARTMENT) && hash(w.id + 't') < 0.78 ? 1 : 0,
    });
    if (t.name && a > 350 && id++ < 60) { out.landmarks.push({ name: t.name, x: Math.round(cx), z: Math.round(cz) }); }
  }
  // busy roads: how much is around each road, for traffic
  out.stats = { buildings: out.buildings.length, roads: out.roads.length, zones: out.zones.length, lamps: out.lamps.length / 2, pois: out.pois.length, types: Object.fromEntries(Object.entries(T).map(([n, v]) => [n, out.buildings.filter((b) => b.t === v).length])) };
  return out;
}

// ---------- cached access ----------
const VERSION = 3;
const key = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`;
export async function cityAt(lat, lng, dir = 'data') {
  const f = `${dir}/city-v${VERSION}-${key(lat, lng)}.json`;
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let xml;
  try { xml = await fetchOsm(lat, lng, 850); } catch { xml = await fetchOsm(lat, lng, 550); } // dense areas exceed the node limit
  const city = bake(xml, lat, lng, 820);
  writeFileSync(f, JSON.stringify(city));
  return city;
}
