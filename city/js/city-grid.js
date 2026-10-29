import * as THREE from 'three/webgpu';
import { vec2, color, positionWorld, fract, floor, sin, dot, mix, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ISLAND_BOUNDS, BLOCKS, CITY, LAND_REGIONS } from './open-city-config.js';
import { createRoadSurfaceMaterial, createSidewalkMaterial, createCurbMaterial, createWaterMaterial, createParkLawnMaterial } from './tsl-materials.js';
import { GEO } from './geodata.js';

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let centralParkClearings;
let parkTreeSites;
let parkLampSites;
let pavedPlazaRects;
let sidewalkBlocks;
let fdrViaduct;



/**
 * Merges static non-instanced THREE.Mesh objects sharing the same material into a single
 * batched BufferGeometry per material to minimize WebGPU render & shadow pass draw calls.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  if (!mergeGeometries) return;
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * Helper to convert an array of world {x, z} polygon vertices into a horizontal THREE.Shape
 * in (x, -z) space so that rotating by rotateX(-Math.PI / 2) maps (x, -z, 0) -> (x, 0, z)
 * with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts, holes = []) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  for (const hole of holes) {
    const path = new THREE.Path();
    hole.forEach((p, i) => (i === 0 ? path.moveTo(p.x, -p.z) : path.lineTo(p.x, -p.z)));
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// A land region ({ outer, holes }, city-config.js LAND_REGIONS) as a slab from bottomY up `height`, or a flat surface
function createRegionMesh({ outer, holes }, bottomY, height, material) {
  const shape = createWorldXZShape(outer, holes);
  const geo = height > 0 ? new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 }) : new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  return mesh;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}






/**
 * Tags every vertex of a mesh using the shared park paving material with its paving style (uv.x, see
 * createParkPavingMaterial: 0 hex asphalt pavers, 1 light granite plaza pavers, 2 bluestone slabs).
 */
/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}











/**
 * Raised sidewalk slabs & granite curbstones of the blocks (curb islands, city-config.js BLOCKS) into `group`:
 * rectangular islands as instanced slabs, the rest extruded from their outlines, a clipped hedge on the planted malls.
 * `skip(b)`: blocks built elsewhere; `cover`: how far the lot rects of an irregular island grow back out to its curb for
 * the consumers working on rectangles. Returns the slabs ({ cx, cz, w, d, block, cover? }) and the curbs the road
 * network bounds the roads with: rects, or with `outlines` an irregular island's own outline ({ minX..maxZ, poly })
 * instead of its grown lot rects, which reach past a curb running at an angle to the axes (islands without lots, the
 * traffic islands & medians between the roadways of divided roads, bound none either way)
 */
function buildBlockSidewalks(group, blocks, { sidewalkMat, curbMat, medianHedgeMat }, { addFootprint, skip, cover, outlines = false }) {
  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const blockSidewalks = []; // { cx, cz, w, d, block } axis-aligned slabs (irregular islands: their lot cover)
  const roadSidewalks = []; // the curbs road-network.js bounds the roads with (medians go in as footprints)
  const slabGeos = [];
  const curbGeos = [];
  const hedgeGeos = [];
  const SW_TOP = 0.22;
  for (const b of blocks) {
    if (skip(b)) continue;
    if (b.rect) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    } else {
      // curb (granite) ring under a sidewalk slab inset by 0.25 m, like the instanced pair below
      const curb = createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry;
      curbGeos.push(curb);
      const inner = offsetPolygonInward(b.poly, 0.25);
      if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
      // rect cover for the consumers that work on rectangles: the lot rects grown back out to the curb
      for (const [x0, x1, z0, z1] of b.rects) {
        const r = { minX: x0 - cover, maxX: x1 + cover, minZ: z0 - cover, maxZ: z1 + cover };
        blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true });
        if (!b.median && !outlines) roadSidewalks.push(r);
      }
      if (!b.median && outlines && b.rects.length) roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ, poly: b.poly });
      if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    if (b.median && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 2.2) {
      const hedge = offsetPolygonInward(b.poly, 1.0);
      if (hedge) hedgeGeos.push(createExtrudedPolygonMesh(hedge, SW_TOP, 0.55, medianHedgeMat).geometry);
    }
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat, true);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(hedgeGeos, medianHedgeMat, true);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, rectSlabs.length);
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, rectSlabs.length);
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  curbInstanced.castShadow = true;

  rectSlabs.forEach((blk, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);

    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  group.add(swInstanced, curbInstanced);
  return { blockSidewalks, roadSidewalks };
}

function buildCityGrid(scene) {
  return buildOpenCityGrid(scene);
}

// Open ground in an Indian city or village: patches of green grass, dry yellow grass, sandy soil, red earth and some
// paving, in irregular patches tens of metres across with finer variation inside them. `far` (0..1) mutes it a
// little for the land beyond the mapped area.
function openLandMaterial(far = 1) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.96, metalness: 0.0 });
  const h2 = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));
  const vn = (p) => {
    const i = floor(p), f = fract(p), u = f.mul(f).mul(f.mul(-2.0).add(3.0));
    return mix(mix(h2(i), h2(i.add(vec2(1, 0))), u.x), mix(h2(i.add(vec2(0, 1))), h2(i.add(vec2(1, 1))), u.x), u.y);
  };
  // two octaves, so the patches have ragged edges instead of round blobs
  const fbm = (p) => vn(p).mul(0.65).add(vn(p.mul(2.7).add(31.0)).mul(0.35));
  const wp = positionWorld.xz;
  const delhi = GEO.city === 'delhi';
  const earth = color(delhi ? 0x8a7a62 : 0x7a5442);   // red laterite soil (dusty brown in the north)
  const sand = color(delhi ? 0xb8a682 : 0xa48a68);    // sandy, trodden ground
  const dry = color(0x8c8550);                        // dry, yellowed grass
  const green = color(0x4f6a34);                      // green grass
  const lush = color(0x3d5a2a);                       // thick grass and weeds after the rains
  const paved = color(0x6f6c66);                      // concrete and paving
  let c = mix(earth, sand, smoothstep(0.35, 0.7, fbm(wp.mul(0.03).add(5.0))));
  c = mix(c, dry, smoothstep(0.45, 0.7, fbm(wp.mul(0.022).add(41.0))).mul(0.85));
  c = mix(c, green, smoothstep(0.52, 0.72, fbm(wp.mul(0.026).add(87.0))).mul(0.9));
  c = mix(c, lush, smoothstep(0.62, 0.8, fbm(wp.mul(0.05).add(13.0))).mul(0.7));
  c = mix(c, paved, smoothstep(0.7, 0.85, fbm(wp.mul(0.07).add(63.0))).mul(0.6 * far));
  // fine grain: tufts, stones, tyre marks
  m.colorNode = c.mul(vn(wp.mul(0.9)).mul(0.18).add(vn(wp.mul(3.1)).mul(0.08)).add(0.82)).mul(mix(1.0, 0.9, 1.0 - far));
  return m;
}

/**
 * The ground of a city built from OpenStreetMap (open-city-config.js): the harbour water, each land mass as a seawall
 * slab under an asphalt deck at y = 0 with its rivers and lakes cut out, every block's raised sidewalk & curbs with a lawn
 * inside, and decks for the bridges over water. Same return value & live exports as buildCityGrid.
 */
function buildOpenCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGrid';
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  const waterMat = createWaterMaterial();
  const waterGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  // An inland Indian city has no sea around it: the land runs on past the mapped area to the haze
  const INLAND = ['bengaluru', 'delhi'].includes(GEO.city);
  const water = new THREE.Mesh(waterGeo, INLAND ? openLandMaterial(0.8) : waterMat);
  water.position.set(0, INLAND ? -0.05 : ISLAND_BOUNDS.waterLevel, 0);
  water.receiveShadow = true;
  group.add(water);

  const seawallMat = new THREE.MeshStandardNodeMaterial({ color: 0x5c5a55, roughness: 0.82, metalness: 0.1 });
  const roadMat = createRoadSurfaceMaterial();
  for (const region of LAND_REGIONS) {
    group.add(createRegionMesh(region, -2.35, 2.31, seawallMat));
    group.add(createRegionMesh(region, 0.0, 0, roadMat));
  }

  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const medianHedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const sidewalk = GEO.frame.sidewalk || 4.6;
  const { blockSidewalks, roadSidewalks } = buildBlockSidewalks(group, BLOCKS, { sidewalkMat, curbMat, medianHedgeMat }, {
    addFootprint,
    skip: () => false,
    cover: sidewalk - 0.2,
    outlines: true
  });
  // Bridges carrying streets across the water at grade (open-city-config.js: the street graph's links flagged over
  // water): a concrete deck under the roadway with a parapet along each edge, segment by segment
  const deckMat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8780, roughness: 0.8, metalness: 0.05 });
  const deckGeos = [];
  const RG = GEO.roadGraph;
  const deckBox = (ax, az, bx, bz, w, y0, h, side) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) return;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    const g = new THREE.BoxGeometry(len + (side ? 0 : w), h, side ? 0.35 : w);
    g.rotateY(-Math.atan2(uz, ux));
    g.translate((ax + bx) / 2 - uz * side, y0 + h / 2, (az + bz) / 2 + ux * side);
    deckGeos.push(g);
  };
  for (const l of RG.links) {
    if (l[9] !== 1) continue;
    const pts = [[RG.nodes[l[0] * 2], RG.nodes[l[0] * 2 + 1]]];
    for (let k = 0; k < l[6].length; k += 2) pts.push([l[6][k], l[6][k + 1]]);
    pts.push([RG.nodes[l[1] * 2], RG.nodes[l[1] * 2 + 1]]);
    const w = l[3] + 3; // the roadway and a walk each side
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      deckBox(ax, az, bx, bz, w, -1.1, 1.08, 0);
      for (const side of [-w / 2, w / 2]) deckBox(ax, az, bx, bz, w, -0.02, 1.1, side);
    }
  }
  if (deckGeos.length) {
    const deck = new THREE.Mesh(mergeGeometries(deckGeos, false), deckMat);
    deck.receiveShadow = deck.castShadow = true;
    group.add(deck);
  }

  // Lawn over the sidewalk slab inside every block's property line (GEO.lawns, traced by tools/city/build.mjs: the
  // ground the buildings and the trees stand on)
  const lawnMat = INLAND ? openLandMaterial() : createParkLawnMaterial(false);
  const lawnGeos = [];
  const L = GEO.lawns || [];
  for (let i = 0, fx = 0, fz = 0; i < L.length;) {
    const n = L[i++];
    const ring = [];
    let px = fx, pz = fz;
    for (let k = 0; k < n; k++) {
      px += L[i++];
      pz += L[i++];
      ring.push({ x: px / 10, z: pz / 10 });
      if (!k) { fx = px; fz = pz; }
    }
    lawnGeos.push(createFlatPolygonMesh(ring, 0.235, lawnMat).geometry);
  }
  // Lakes inside the blocks (Bengaluru's tanks sit inside their parks): drawn over the block ground
  for (const w of GEO.water || []) {
    if (w.ring.length < 8) continue;
    const pts = [];
    for (let k = 0; k < w.ring.length; k += 2) pts.push({ x: w.ring[k], z: w.ring[k + 1] });
    group.add(createFlatPolygonMesh(pts, 0.3, waterMat, true));
  }
  for (let i = 0; i < lawnGeos.length; i += 400) {
    const m = new THREE.Mesh(mergeGeometries(lawnGeos.slice(i, i + 400), false), lawnMat);
    m.receiveShadow = true;
    group.add(m);
  }

  centralParkClearings = null;
  parkTreeSites = [];
  parkLampSites = [];
  pavedPlazaRects = [];
  sidewalkBlocks = blockSidewalks;
  fdrViaduct = null;

  batchStaticGroupMeshes(group, new Set([waterMat, roadMat, lawnMat]));
  scene.add(group);
  console.info(`[cityGrid] ${CITY.name}: ${LAND_REGIONS.length} land masses, ${BLOCKS.length} blocks, ${lawnGeos.length} lawns, ${deckGeos.length / 3} bridge deck segments`);
  return { group, sidewalks: roadSidewalks, footprints, highwayLanes: [], colliders: [] };
}




export { buildCityGrid };
