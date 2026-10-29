import { GEO } from './geodata.js';
import { toPts, createBlocks, createBlockIndex, signalPhase, walkSignal, vehiclesFor } from './city-common.js';

// js/open-city-config.js
// A city built from OpenStreetMap (tools/city/build.mjs: js/<city>-geodata.js, version 2) behind the same interface as

const F = GEO.frame;
const CITY = { id: GEO.city, name: GEO.name, short: GEO.short, open: true, driveSide: F.driveSide || 'right', units: F.units === 'imperial' ? 'imperial' : 'metric', vehicles: vehiclesFor(GEO.vehicles) };

// ---------------------------------------------------------------------------------------------------------------------
// Land: the land masses ({ outer, holes } outlines, [{ x, z }]) and the detailed area (blocks stand inside it)
// ---------------------------------------------------------------------------------------------------------------------
const LAND_REGIONS = GEO.land.map(([outer, ...holes]) => ({ outer: toPts(outer), holes: holes.map(toPts) }));

const ISLAND_BOUNDS = (() => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of LAND_REGIONS) {
    for (const p of r.outer) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  }
  return { minX, maxX, minZ, maxZ, sidewalkHeight: 0.22, waterLevel: -2.2 };
})();

// The westernmost and easternmost land at every 2 m of z (the outermost crossings of the land outlines), what
const SHORE = (() => {
  const step = 2;
  const z0 = Math.ceil(ISLAND_BOUNDS.minZ / step) * step;
  const n = Math.max(2, Math.floor((ISLAND_BOUNDS.maxZ - z0) / step) + 1);
  const west = new Float32Array(n).fill(NaN);
  const east = new Float32Array(n).fill(NaN);
  for (const { outer: P } of LAND_REGIONS) {
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[j];
      const b = P[i];
      if (a.z === b.z) continue;
      const lo = Math.min(a.z, b.z);
      const hi = Math.max(a.z, b.z);
      for (let k = Math.max(0, Math.ceil((lo - z0) / step)); k < n && z0 + k * step < hi; k++) {
        const z = z0 + k * step + 1e-3;
        if (z < lo || z >= hi) continue;
        const x = a.x + ((z - a.z) * (b.x - a.x)) / (b.z - a.z);
        if (!(west[k] <= x)) west[k] = x;
        if (!(east[k] >= x)) east[k] = x;
      }
    }
  }
  for (let k = 1; k < n; k++) if (Number.isNaN(west[k])) { west[k] = west[k - 1]; east[k] = east[k - 1]; }
  for (let k = n - 2; k >= 0; k--) if (Number.isNaN(west[k])) { west[k] = west[k + 1]; east[k] = east[k + 1]; }
  return { z0, step, n, west, east };
})();
function getIslandBoundsAtZ(z) {
  const f = (z - SHORE.z0) / SHORE.step;
  const k = Math.max(0, Math.min(SHORE.n - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - k));
  return {
    westX: SHORE.west[k] + (SHORE.west[k + 1] - SHORE.west[k]) * t,
    eastX: SHORE.east[k] + (SHORE.east[k + 1] - SHORE.east[k]) * t
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks (city-common.js) and roads: the street graph's links chained per name into polylines for labels, lookups and
// the maps. Each: { name, raw, w, dir, lanes, highway, pts }
// ---------------------------------------------------------------------------------------------------------------------
const BLOCKS = createBlocks(GEO.blocks);
const { blockAt, blocksInRect } = createBlockIndex(BLOCKS);

// knows the styles), or 'generic'
const DISTRICTS = GEO.districts || [];
function districtAt(x, z) {
  let best = null;
  let bd = Infinity;
  for (const d of DISTRICTS) {
    const dist = Math.hypot(x - d.x, z - d.z);
    if (dist < d.r && dist < bd) { bd = dist; best = d; }
  }
  return best ? best.style : 'generic';
}
for (const b of BLOCKS) b.district = districtAt(b.cx, b.cz);






const ALL_AVENUES = [];
const ALL_STREETS = [];
const CENTRAL_PARK_BOUNDS = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
const NONE = [];
const streetZ = (n) => (42 - n) * 79.5;

export { CITY, LAND_REGIONS, ALL_AVENUES, CENTRAL_PARK_BOUNDS, getIslandBoundsAtZ, NONE as NJ_SHORELINE_POLYGON, NONE as LONG_ISLAND_POLYGONS, ALL_STREETS, ISLAND_BOUNDS, BLOCKS, streetZ, districtAt, blockAt, signalPhase, walkSignal };
