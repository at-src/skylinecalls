// tools/city/gen-trees.mjs — plants trees for a city with no public tree inventory, into tools/data/<city>/trees.csv
// (the format tools/city/fetch.mjs writes: lng, lat, height (m), family): OpenStreetMap's mapped trees and tree rows,
// avenue trees along both kerbs of the streets (Bengaluru's rain trees, gulmohars, the odd coconut palm), and clumps in
// the parks. tools/city/build.mjs then keeps them off the roads and out of the buildings.
// usage: node tools/city/gen-trees.mjs <city>
import fs from 'node:fs';
import path from 'node:path';
import { loadCity, dataDir } from './config.mjs';

const city = await loadCity(process.argv[2]);
const dir = dataDir(city);
const load = (layer) => JSON.parse(fs.readFileSync(path.join(dir, `osm_${layer}.json`), 'utf8')).elements;
const [S, W, N, E] = city.detail, M = city.margin;
const inBox = (lat, lon) => lat > S - M && lat < N + M && lon > W - M && lon < E + M;
const mLat = 110540, mLon = 111320 * Math.cos((city.origin.lat * Math.PI) / 180);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const out = ['lng,lat,height,family'];
const plant = (lat, lon, h, family) => { if (inBox(lat, lon)) out.push(`${lon.toFixed(6)},${lat.toFixed(6)},${h.toFixed(1)},"${family}"`); };
// families map to crown shapes in the city config's trees.shapes
const kind = () => { const r = rnd(); return r < 0.55 ? 'Fabaceae (Leguminosae)' : r < 0.72 ? 'Bignoniaceae' : r < 0.8 ? 'Arecaceae (Palmae)' : 'Moraceae'; };

// avenue trees: every 9-20 m on each side of the streets, more on the quiet ones, fewer on the busy main roads
// spacing (m) and the share of spots left empty: the main roads are lined, the lanes only have a tree here and there
const SPACING = { primary: 16, secondary: 14, tertiary: 14, residential: 26, unclassified: 26, living_street: 30 };
const GAPS = { primary: 0.3, secondary: 0.35, tertiary: 0.45, residential: 0.65, unclassified: 0.65, living_street: 0.75 };
const OFFSET = { primary: 13, secondary: 9, tertiary: 7, residential: 5.2, unclassified: 5.5, living_street: 4.2 };
let avenue = 0;
for (const w of load('roads')) {
  const hw = (w.tags && w.tags.highway || '').replace(/_link$/, '');
  if (!SPACING[hw] || !w.geometry) continue;
  const g = w.geometry;
  for (let i = 1; i < g.length; i++) {
    const ax = g[i - 1].lon * mLon, az = g[i - 1].lat * mLat, bx = g[i].lon * mLon, bz = g[i].lat * mLat;
    const L = Math.hypot(bx - ax, bz - az); if (L < 2) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    for (let t = rnd() * SPACING[hw]; t < L; t += SPACING[hw] * (0.7 + rnd() * 0.8)) {
      for (const side of [-1, 1]) {
        if (rnd() < GAPS[hw]) continue; // gaps: gates, shopfronts, a tree cut down
        const off = (OFFSET[hw] + rnd() * 1.2) * side;
        const x = ax + ux * t - uz * off, z = az + uz * t + ux * off;
        const fam = kind();
        plant(z / mLat, x / mLon, fam.startsWith('Areca') ? 9 + rnd() * 6 : 7 + rnd() * 9, fam);
        avenue++;
      }
    }
  }
}
// parks: clumps across their area
let park = 0;
for (const a of load('parks')) {
  const g = a.geometry || (a.members || []).flatMap((m) => m.geometry || []);
  if (!g || g.length < 3) continue;
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const p of g) { la0 = Math.min(la0, p.lat); la1 = Math.max(la1, p.lat); lo0 = Math.min(lo0, p.lon); lo1 = Math.max(lo1, p.lon); }
  const area = (la1 - la0) * mLat * (lo1 - lo0) * mLon;
  const n = Math.min(260, area / 240);
  const inside = (lat, lon) => { let c = false; for (let i = 0, j = g.length - 1; i < g.length; j = i++) { const yi = g[i].lat, yj = g[j].lat; if ((yi > lat) !== (yj > lat) && lon < ((g[j].lon - g[i].lon) * (lat - yi)) / (yj - yi) + g[i].lon) c = !c; } return c; };
  for (let k = 0; k < n; k++) {
    const lat = la0 + rnd() * (la1 - la0), lon = lo0 + rnd() * (lo1 - lo0);
    if (!inside(lat, lon)) continue;
    plant(lat, lon, 8 + rnd() * 10, kind()); park++;
  }
}
fs.writeFileSync(path.join(dir, 'trees.csv'), out.join('\n') + '\n');
console.log(`[trees] ${city.name}: ${avenue} avenue trees, ${park} park trees -> ${path.join(dir, 'trees.csv')}`);
