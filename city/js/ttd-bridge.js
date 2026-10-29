import * as THREE from 'three/webgpu';
import { uniform, uv, vec3, float, fract, pow, step, time, max, abs, exp, smoothstep, attribute } from 'three/tsl';
import { GEO } from './geodata.js';
const F = GEO.frame;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// the dashboard's hour -> the nearest lighting preset
const presetFor = (h) => (h < 5 || h >= 20 ? 'midnight' : h < 6.3 ? 'twilight' : h < 8.5 ? 'golden' : h < 16.5 ? 'midday' : h < 18.4 ? 'golden' : 'twilight');

export function startBridge({ scene, camera, orbit, applyPreset, weather, footprints = [] }) {
  const fx = new THREE.Group();
  fx.name = 'ToTheDoor';
  scene.add(fx);
  const post = (m) => window.parent !== window && window.parent.postMessage({ ttd: true, ...m }, '*');
  const ray = new THREE.Raycaster();
  // the top of whatever stands at (x, z): a roof, else the ground
  const topAt = (x, z) => {
    ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0));
    const roofs = scene.getObjectByName('CityBuildings_roofs');
    const hit = roofs && ray.intersectObject(roofs, false)[0];
    return hit ? hit.point.y : 0;
  };

  // ---- home: a soft shaft of light and a pulsing ring
  let beam = null, ring = null, homeY = 12;
  const ringOpacity = uniform(0.4), pulse = { expecting: false };
  function setHome(x, z) {
    if (beam) fx.remove(beam, ring);
    homeY = topAt(x, z) || 12;
    const bg = new THREE.CylinderGeometry(0.6, 1.8, 160, 24, 1, true);
    bg.translate(0, 80, 0);
    const bm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const fade = pow(float(1).sub(uv().y), 3.2);
    bm.colorNode = vec3(1.6, 0.9, 0.3).mul(fade).mul(0.8);
    bm.opacityNode = fade;
    beam = new THREE.Mesh(bg, bm);
    beam.position.set(x, homeY, z);
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    rm.colorNode = vec3(2.4, 1.3, 0.35);
    rm.opacityNode = ringOpacity;
    ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64).rotateX(-Math.PI / 2), rm);
    ring.position.set(x, homeY + 0.6, z);
    fx.add(beam, ring);
    post({ type: 'homeH', h: homeY });
  }

  // ---- door path: a glowing tube with light flowing along it, filling in as the rider passes each stop
  let path = null;
  const prog = uniform(0);
  let progFrom = 0, progTo = 0, progT = 1, stopParams = [];
  function setPath(pts) {
    if (path) fx.remove(path);
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 3.2, z)), false, 'centripetal', 0.2);
    const g = new THREE.TubeGeometry(curve, Math.max(60, pts.length * 40), 1.6, 10, false);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });
    const flow = pow(fract(uv().x.mul(14).sub(time.mul(0.9))), 6);
    m.colorNode = vec3(1.5, 0.8, 0.22).mul(flow.mul(1.2).add(0.45)).add(vec3(1.8, 1.1, 0.4).mul(step(uv().x, prog)).mul(1.1));
    m.opacityNode = float(0.8);
    path = new THREE.Mesh(g, m);
    path.renderOrder = 10;
    fx.add(path);
    stopParams = pts.map((_, i) => i / (pts.length - 1));
  }
  function setProgress(step) {
    progFrom = prog.value;
    progTo = step < 0 ? 0 : stopParams[Math.min(step, stopParams.length - 1)] ?? 0;
    progT = 0;
  }

  // ---- rider: a bright blue marker that hops to each new position, with a ripple under it
  let rider = null, halo = null, riderFrom = null, riderTo = null, riderT = 1;
  const haloOpacity = uniform(1);
  function placeRider(x, z) {
    const to = new THREE.Vector3(x, 4, z);
    if (!rider) {
      const m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = vec3(0.9, 2.2, 4.5);
      rider = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), m);
      rider.position.copy(to).add(new THREE.Vector3(0, 120, 0));
      const hm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      hm.colorNode = vec3(0.5, 1.4, 3);
      hm.opacityNode = haloOpacity;
      halo = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48).rotateX(-Math.PI / 2), hm);
      fx.add(rider, halo);
    }
    riderFrom = rider.position.clone();
    riderTo = to;
    riderT = 0;
  }

  // ---- camera moves
  let tween = null;
  function look(x, z, dist, polar, az, dur) {
    const s0 = new THREE.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
    tween = { t: 0, dur, from: orbit.target.clone(), to: new THREE.Vector3(x, 0, z), s0, s1: new THREE.Spherical(dist, polar, az ?? s0.theta) };
  }
  orbit.addEventListener('start', () => (tween = null));

  const night = buildNightLights(fx);
  const marks = buildHighlights(fx, footprints);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.ttd) return;
    if (m.type === 'home') setHome(m.x, m.z);
    else if (m.type === 'path') setPath(m.pts);
    else if (m.type === 'progress') setProgress(m.step);
    else if (m.type === 'rider') placeRider(m.x, m.z);
    else if (m.type === 'look') look(m.x, m.z, m.dist, m.polar, m.az, m.dur);
    else if (m.type === 'jump') { camera.position.set(...m.pos); orbit.target.set(...m.target); orbit.update(); }
    else if (m.type === 'expecting') pulse.expecting = !!m.on;
    else if (m.type === 'autoRotate') orbit.autoRotate = !!m.on;
    else if (m.type === 'rain') weather.setRain(m.amount || 0);
    else if (m.type === 'highlight') { const at = marks.add(m.x, m.z, m.kind, m.id); post({ type: 'highlighted', id: m.id, ...at }); }
    else if (m.type === 'clearHighlights') marks.clear();
    else if (m.type === 'hour') { applyPreset(presetFor(m.hour)); night.setHour(m.hour); }
  });
  window.addEventListener('ttd-rendered', () => post({ type: 'rendered' }), { once: true });
  post({ type: 'ready', frame: { lat0: F.lat0, lon0: F.lon0, bearingDeg: F.bearingDeg || 0 }, detail: GEO.detail || null });

  let elapsed = 0;
  return {
    update() {
      // wall-clock time, so camera moves and the rider hop take their real duration even when frames are slow
      const now = performance.now(), dt = Math.min(0.25, (now - (this._t || now)) / 1000);
      this._t = now;
      elapsed += dt;
      night.update(Math.min(dt, 0.05));
      marks.update(dt, elapsed);
      if (ring) {
        const ph = (elapsed * (pulse.expecting ? 0.6 : 0.4)) % 1;
        ring.scale.setScalar(6 + ph * (pulse.expecting ? 42 : 24));
        ringOpacity.value = (1 - ph) * (pulse.expecting ? 0.55 : 0.35);
      }
      if (progT < 1) { progT = Math.min(1, progT + dt / 1.6); prog.value = progFrom + (progTo - progFrom) * ease(progT); }
      if (rider) {
        if (riderT < 1) {
          riderT = Math.min(1, riderT + dt / 1.8);
          const k = ease(riderT);
          rider.position.lerpVectors(riderFrom, riderTo, k);
          rider.position.y = 4 + Math.sin(k * Math.PI) * (riderFrom.distanceTo(riderTo) > 60 ? 26 : 4);
        }
        const p = (elapsed * 0.9) % 1;
        halo.position.set(rider.position.x, 0.6, rider.position.z);
        halo.scale.setScalar(4 + p * 22);
        haloOpacity.value = 1 - p;
      }
      if (tween) {
        const w = tween;
        w.t = Math.min(1, w.t + dt / w.dur);
        const k = ease(w.t);
        orbit.target.lerpVectors(w.from, w.to, k);
        let dth = w.s1.theta - w.s0.theta;
        if (dth > Math.PI) dth -= 2 * Math.PI;
        if (dth < -Math.PI) dth += 2 * Math.PI;
        const s = new THREE.Spherical(w.s0.radius + (w.s1.radius - w.s0.radius) * k, w.s0.phi + (w.s1.phi - w.s0.phi) * k, w.s0.theta + dth * k);
        camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(s));
        if (w.t >= 1) tween = null;
      }
      fx.updateMatrixWorld(true);
      // the camera, for the dashboard's pins
      post({
        type: 'cam', p: camera.position.toArray(), t: orbit.target.toArray(), fov: camera.fov, aspect: camera.aspect,
        rider: rider ? rider.position.toArray() : null
      });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Night lights for the map view: a street light every 30-40 m along every road (white LED on the main roads, a mix of
// old orange sodium, warm and white on the lanes), each with its pool of light on the road, and the head and tail
// lights of traffic streaming along the roads, busy in the evening rush and thin after midnight. All of it fades in
// at dusk and out at dawn.
const smoothH = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// how many vehicles are out, by hour
const TRAFFIC = [[0, 0.18], [2, 0.08], [5, 0.12], [6.5, 0.4], [8.5, 1], [10.5, 0.8], [13, 0.65], [16, 0.7], [18, 1], [20.5, 0.9], [22, 0.55], [23.5, 0.28], [24, 0.18]];
const curveAt = (keys, h) => { for (let i = 1; i < keys.length; i++) if (h <= keys[i][0]) { const [h0, a] = keys[i - 1], [h1, b] = keys[i]; return a + (b - a) * ((h - h0) / (h1 - h0)); } return keys[keys.length - 1][1]; };

function buildNightLights(fx) {
  const R = GEO.roadGraph;
  const N = R.nodes, cls = R.classes;
  const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
  const BUSY = new Set([...MAIN, 'tertiary', 'tertiary_link']);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const LED = [0.9, 0.9, 0.85], SODIUM = [1, 0.5, 0.16], WARM = [1, 0.74, 0.45];
  const lamps = { LED: [], SODIUM: [], WARM: [] };
  const lanes = [];
  // the lit road surface: a ribbon over each road, brightest under each pole and never fully dark between them
  const rPos = [], rLit = [], rCol = [], rIdx = [];
  const ribbon = (pts, half, phase, gap, c, strength) => {
    let along = 0;
    const base = rPos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[Math.max(0, i - 1)], n = pts[Math.min(pts.length - 1, i + 1)];
      let dx = n[0] - p[0], dz = n[1] - p[1];
      const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      if (i) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      rPos.push(pts[i][0] - dz * half, 0.42, pts[i][1] + dx * half, pts[i][0] + dz * half, 0.42, pts[i][1] - dx * half);
      rLit.push(along, 0, phase, gap, along, 1, phase, gap);
      rCol.push(c[0] * strength, c[1] * strength, c[2] * strength, c[0] * strength, c[1] * strength, c[2] * strength);
      if (i) { const v = base + (i - 1) * 2; rIdx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
    }
  };
  for (const L of R.links) {
    const [a, b, , w, nl, , line, ci] = L;
    const pts = [[N[a * 2], N[a * 2 + 1]]];
    for (let i = 0; i < (line || []).length; i += 2) pts.push([line[i], line[i + 1]]);
    pts.push([N[b * 2], N[b * 2 + 1]]);
    const kind = cls[ci] || 'residential';
    const main = MAIN.has(kind);
    const gap = main ? 22 : 26; // (closer than the 30-40 m of many streets, so the pools overlap and no stretch is dark)
    const roll = rnd();
    const col = main ? 'LED' : roll < 0.4 ? 'SODIUM' : roll < 0.7 ? 'WARM' : 'LED';
    // one light pole every gap metres, on alternating kerbs of the main roads, one kerb of the lanes
    const carry0 = rnd() * gap;
    let carry = carry0, k = 0, len = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
      const S = Math.hypot(bx - ax, bz - az);
      len += S; cum.push(len);
      if (S < 0.01) continue;
      const ux = (bx - ax) / S, uz = (bz - az) / S;
      for (let t = carry; t < S; t += gap, k++) {
        const side = main ? (k % 2 ? 1 : -1) : 1, off = (w || 7) / 2 + 0.4;
        lamps[col].push(ax + ux * t - uz * off * side, az + uz * t + ux * off * side);
      }
      carry = ((carry - S) % gap + gap) % gap;
    }
    ribbon(pts, (w || 7) / 2 + 1.6, carry0, gap, { LED, SODIUM, WARM }[col], main ? 1 : BUSY.has(kind) ? 0.85 : 0.7);
    // traffic: a vehicle slot every 25 m each way on the busy roads only (the lanes stay quiet)
    if (len > 30 && BUSY.has(kind)) {
      const per = 25;
      for (let c = 0; c < len / per; c++) for (const dir of [1, -1]) {
        lanes.push({ pts, cum, len, d: rnd() * len, dir, q: rnd(), v: (main ? 9 : 6) + rnd() * 5, off: (w || 7) * 0.25, main });
      }
    }
  }

  const on = uniform(0);
  const group = new THREE.Group();
  group.name = 'NightLights';
  fx.add(group);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  const headGeo = new THREE.SphereGeometry(0.45, 8, 6);
  const cols = { LED, SODIUM, WARM };
  for (const [name, xs] of Object.entries(lamps)) {
    const n = xs.length / 2; if (!n) continue;
    const c = cols[name];
    const pm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const d = uv().sub(0.5).length().mul(2.0);
    const fall = pow(max(float(1).sub(d), 0.0), 2.0);
    pm.colorNode = vec3(...c).mul(fall).mul(on).mul(0.38);
    pm.opacityNode = float(1);
    const pools = new THREE.InstancedMesh(poolGeo, pm, n);
    const hm = new THREE.MeshBasicNodeMaterial();
    hm.colorNode = vec3(...c).mul(on.mul(3.2).add(0.15));
    const heads = new THREE.InstancedMesh(headGeo, hm, n);
    for (let i = 0; i < n; i++) {
      m4.compose(new THREE.Vector3(xs[i * 2], 0.45, xs[i * 2 + 1]), flat, new THREE.Vector3(20, 20, 1));
      pools.setMatrixAt(i, m4);
      m4.compose(new THREE.Vector3(xs[i * 2], 8.2, xs[i * 2 + 1]), q, one);
      heads.setMatrixAt(i, m4);
    }
    pools.renderOrder = 3;
    pools.frustumCulled = heads.frustumCulled = false;
    group.add(pools, heads);
  }

  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(rPos, 3));
    g.setAttribute('aLit', new THREE.Float32BufferAttribute(rLit, 4));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(rCol, 3));
    g.setIndex(rIdx);
    const lit = attribute('aLit', 'vec4'), col = attribute('aCol', 'vec3');
    const along = lit.x, across = lit.y, phase = lit.z, gap = lit.w;
    // distance to the nearest pole along the road, and a soft edge across it
    const dl = abs(fract(along.sub(phase).div(gap).add(0.5)).sub(0.5)).mul(gap);
    const peak = exp(dl.mul(dl).div(gap.mul(gap).mul(0.045)).negate());
    const edge = smoothstep(0.0, 0.22, across).mul(smoothstep(1.0, 0.78, across));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // light falls from each pole: bright under it, fading towards the next, only a faint spill between
    m.colorNode = col.mul(peak.mul(0.85).add(0.05)).mul(edge).mul(on).mul(0.6);
    m.opacityNode = float(1);
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // traffic light streams: white headlights ahead, red tail lights behind each vehicle
  const cars = lanes.slice(0, 2600);
  const hdM = new THREE.MeshBasicNodeMaterial(); hdM.colorNode = vec3(4, 3.8, 3.2).mul(on);
  const tlM = new THREE.MeshBasicNodeMaterial(); tlM.colorNode = vec3(4, 0.25, 0.12).mul(on);
  const lightGeo = new THREE.SphereGeometry(0.75, 6, 4);
  const heads = new THREE.InstancedMesh(lightGeo, hdM, cars.length * 2);
  const tails = new THREE.InstancedMesh(lightGeo, tlM, cars.length * 2);
  heads.frustumCulled = tails.frustumCulled = false;
  group.add(heads, tails);
  let dens = 0.5, lampOn = 0;
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  const v = new THREE.Vector3();

  return {
    setHour(h) {
      // street lights: on from 6:15 pm, off by 6:30 am
      lampOn = Math.max(1 - smoothH(5.6, 6.6, h), smoothH(17.9, 18.7, h));
      on.value = lampOn;
      dens = curveAt(TRAFFIC, h);
    },
    update(dt) {
      group.visible = lampOn > 0.01;
      if (!group.visible) return;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        if (c.q > dens) { for (const m of [heads, tails]) { m.setMatrixAt(i * 2, hide); m.setMatrixAt(i * 2 + 1, hide); } continue; }
        c.d = (c.d + c.v * dt * c.dir + c.len) % c.len;
        let lo = 0, hi = c.cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c.cum[mid] <= c.d) lo = mid; else hi = mid; }
        const p0 = c.pts[lo], p1 = c.pts[hi], seg = c.cum[hi] - c.cum[lo] || 1, t = (c.d - c.cum[lo]) / seg;
        const ux = ((p1[0] - p0[0]) / seg) * c.dir, uz = ((p1[1] - p0[1]) / seg) * c.dir;
        // drive on the left: offset to the left of the direction of travel
        const x = p0[0] + (p1[0] - p0[0]) * t + uz * c.off, z = p0[1] + (p1[1] - p0[1]) * t - ux * c.off;
        const sx = -uz * 0.7, sz = ux * 0.7; // the two lamps either side
        for (const [m, along] of [[heads, 2.1], [tails, -2.1]]) {
          m4.makeTranslation(v.set(x + ux * along + sx, 0.9, z + uz * along + sz)); m.setMatrixAt(i * 2, m4);
          m4.makeTranslation(v.set(x + ux * along - sx, 0.9, z + uz * along - sz)); m.setMatrixAt(i * 2 + 1, m4);
        }
      }
      heads.instanceMatrix.needsUpdate = tails.instanceMatrix.needsUpdate = true;
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the conversation points at, lit up on the map. 'seen' (blue): a place the caller says he can see, where he is
// now. 'target' (amber): where the agent is sending him next. 'taught' (green): a stop the customer has just described
// while teaching the way. The building on that spot gets a glowing shell and a ring pulses on the ground round it; a
// spot with no building (a gate, a lane) gets the ring and a short light post. Older marks fade to a faint trace, so
// the last few stay readable without cluttering the map.
const MARK_COLOURS = { seen: [0.25, 0.75, 1.9], target: [1.9, 1.0, 0.22], taught: [0.3, 1.6, 0.7] };
function buildHighlights(fx, footprints) {
  // footprints by 50 m cell, for finding the building at a spot
  const CELL = 50, grid = new Map();
  const key = (i, j) => i * 100003 + j;
  footprints.forEach((f, k) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < f.pts.length; i += 2) { x0 = Math.min(x0, f.pts[i]); x1 = Math.max(x1, f.pts[i]); z0 = Math.min(z0, f.pts[i + 1]); z1 = Math.max(z1, f.pts[i + 1]); }
    f.bb = [x0, x1, z0, z1];
    for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
      const kk = key(i, j); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k);
    }
  });
  const inside = (x, z, p) => { let c = false; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { if ((p[i + 1] > z) !== (p[j + 1] > z) && x < ((p[j] - p[i]) * (z - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) c = !c; } return c; };
  const edgeDist = (x, z, p) => { let d = Infinity; for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) { const ax = p[j], az = p[j + 1], bx = p[i], bz = p[i + 1]; const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)); d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz)); } return d; };
  // the building at (x, z): the one it stands in, else the nearest within 18 m (shops are mapped a few metres off)
  const buildingAt = (x, z) => {
    let best = null, bestD = 18;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const k of grid.get(key(Math.floor(x / CELL) + di, Math.floor(z / CELL) + dj)) || []) {
      const f = footprints[k];
      if (inside(x, z, f.pts)) return f;
      const d = edgeDist(x, z, f.pts);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  };

  const live = [];
  const group = new THREE.Group();
  group.name = 'Highlights';
  fx.add(group);
  function shell(f, c, strength) {
    // the footprint pushed out 0.6 m and raised 0.8 m above the roof, open at the bottom
    let cx = 0, cz = 0; const n = f.pts.length / 2;
    for (let i = 0; i < n; i++) { cx += f.pts[i * 2]; cz += f.pts[i * 2 + 1]; }
    cx /= n; cz /= n;
    const pos = [], uvs = [], top = f.h + 0.8;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const grow = (x, z) => { const dx = x - cx, dz = z - cz, L = Math.hypot(dx, dz) || 1; return [x + (dx / L) * 0.6, z + (dz / L) * 0.6]; };
      const [ax, az] = grow(f.pts[i * 2], f.pts[i * 2 + 1]), [bx, bz] = grow(f.pts[j * 2], f.pts[j * 2 + 1]);
      pos.push(ax, 0, az, bx, 0, bz, bx, top, bz, ax, 0, az, bx, top, bz, ax, top, az);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    // brightest along the roof line and the ground, a soft wash between
    const v = uv().y;
    m.colorNode = vec3(...c).mul(pow(v, 6.0).mul(1.4).add(pow(float(1).sub(v), 8.0).mul(0.6)).add(0.12)).mul(strength);
    m.opacityNode = float(1);
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 8;
    return { mesh, cx, cz, r: Math.max(6, Math.hypot(f.bb[1] - f.bb[0], f.bb[3] - f.bb[2]) / 2), h: f.h };
  }
  function add(x, z, kind = 'seen', idTag = '') {
    const c = MARK_COLOURS[kind] || MARK_COLOURS.seen;
    // the newest of each kind is the bright one; the ones before fade to a trace
    for (const l of live) if (l.kind === kind) l.fadeTo = 0.18;
    const strength = uniform(0), ringA = uniform(0);
    const f = buildingAt(x, z);
    const item = { kind, idTag, strength, ringA, t: 0, fadeTo: 1, level: 0, parts: [] };
    let cx = x, cz = z, r = 7, h = 0;
    if (f) {
      const s = shell(f, c, strength);
      item.parts.push(s.mesh); cx = s.cx; cz = s.cz; r = s.r; h = s.h;
    } else {
      // no building: a short post of light
      const pg = new THREE.CylinderGeometry(0.25, 0.9, 16, 12, 1, true); pg.translate(0, 8, 0);
      const pm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      pm.colorNode = vec3(...c).mul(pow(float(1).sub(uv().y), 2.5)).mul(strength);
      pm.opacityNode = float(1);
      const post = new THREE.Mesh(pg, pm); post.position.set(x, 0, z); item.parts.push(post);
    }
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    rm.colorNode = vec3(...c).mul(ringA);
    rm.opacityNode = float(1);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), rm);
    ring.position.set(cx, 0.6, cz);
    ring.renderOrder = 8;
    item.ring = ring; item.r = r; item.h = h; item.x = cx; item.z = cz;
    item.parts.push(ring);
    for (const p of item.parts) { p.frustumCulled = false; p.matrixAutoUpdate = true; group.add(p); }
    live.push(item);
    // keep the last eight
    while (live.length > 8) { const old = live.shift(); for (const p of old.parts) group.remove(p); }
    return { x: cx, z: cz, h };
  }
  function clear() { for (const l of live) for (const p of l.parts) group.remove(p); live.length = 0; }
  return {
    add, clear,
    update(dt, t) {
      for (const l of live) {
        l.t += dt;
        // ease towards its level: in quickly when new, slowly down to a trace when superseded
        l.level += (l.fadeTo - l.level) * Math.min(1, dt * (l.fadeTo > l.level ? 4 : 1.2));
        const beat = l.fadeTo === 1 ? 0.75 + 0.25 * Math.sin(t * 3.2) : 1;
        l.strength.value = l.level * beat;
        const ph = (t * 0.7 + l.x * 0.01) % 1;
        l.ring.scale.setScalar(l.r * (1.05 + ph * 1.6));
        l.ring.updateMatrix(); l.ring.updateMatrixWorld();
        l.ringA.value = (1 - ph) * l.level * 0.9;
      }
      group.updateMatrixWorld(true);
    }
  };
}
