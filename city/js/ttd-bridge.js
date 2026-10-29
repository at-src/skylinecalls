import * as THREE from 'three/webgpu';
import { uniform, uv, vec3, float, fract, pow, step, time, max, abs, exp, smoothstep, attribute } from 'three/tsl';
import { GEO } from './geodata.js';
const F = GEO.frame;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// the dashboard's hour -> the nearest lighting preset
const presetFor = (h) => (h < 5 || h >= 20 ? 'midnight' : h < 6.3 ? 'twilight' : h < 8.5 ? 'golden' : h < 16.5 ? 'midday' : h < 18.4 ? 'golden' : 'twilight');

export function startBridge({ scene, camera, orbit, applyPreset, weather }) {
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
    const gap = main ? 30 : 38;
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
    pm.colorNode = vec3(...c).mul(fall).mul(on).mul(0.3);
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
    const peak = exp(dl.mul(dl).div(gap.mul(gap).mul(0.06)).negate());
    const edge = smoothstep(0.0, 0.22, across).mul(smoothstep(1.0, 0.78, across));
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    m.colorNode = col.mul(peak.mul(0.6).add(0.32)).mul(edge).mul(on).mul(0.55);
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
