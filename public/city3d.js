// ToTheDoor city renderer: a night-time 3D city built from OpenStreetMap in three.js.
// Buildings rise around the home on load, windows light up, sodium street lamps pool on the roads,
// headlights and taillights stream along the main roads, and the door path glows to the home.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const M_LAT = 110540;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const FOG = new THREE.Color('#0b1222');

// ------------------------------------------------------------------ shaders
const NOISE = /* glsl */`
  float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
const FOG_GLSL = /* glsl */`
  uniform vec3 uFog; uniform float uFogDensity;
  vec3 fogMix(vec3 c, float d){ float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d); return mix(c, uFog, clamp(f, 0., 1.)); }
`;

const buildingMat = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uRise: { value: 0 }, uFog: { value: FOG }, uFogDensity: { value: 0.00105 }, uGlow: { value: 1 } },
  vertexShader: /* glsl */`
    attribute vec2 aWall; attribute vec3 aMeta; // seed, kind, rise delay
    uniform float uRise;
    varying vec3 vN; varying vec3 vW; varying vec2 vWall; varying vec3 vMeta; varying float vDist; varying float vTop;
    void main(){
      float r = clamp((uRise - aMeta.z) / 1.15, 0., 1.);
      r = 1. - pow(1. - r, 3.);
      vec3 p = position; p.y *= max(r, 0.0001);
      vTop = position.y;
      vec4 w = modelMatrix * vec4(p, 1.);
      vW = w.xyz; vN = normal; vWall = vec2(aWall.x, aWall.y * r); vMeta = aMeta;
      vec4 mv = viewMatrix * w; vDist = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    ${NOISE}${FOG_GLSL}
    uniform float uTime; uniform float uGlow;
    varying vec3 vN; varying vec3 vW; varying vec2 vWall; varying vec3 vMeta; varying float vDist; varying float vTop;
    void main(){
      vec3 n = normalize(vN);
      float seed = vMeta.x; float shop = vMeta.y;
      bool wall = abs(n.y) < 0.5;
      // facade base: cool slate with a little per-building variety
      vec3 base = mix(vec3(.018,.022,.034), vec3(.034,.038,.052), seed);
      base = mix(base, vec3(.042,.032,.030), step(.78, h11(seed * 91.7)) * .7);
      vec3 moon = normalize(vec3(-.45, .8, .35));
      float lam = max(dot(n, moon), 0.) * .55 + .45;
      float hemi = mix(.55, 1.0, n.y * .5 + .5);
      vec3 col = base * lam * hemi;
      // warm bounce from the streets, strongest near the ground
      col += vec3(.20,.11,.04) * exp(-vW.y / 5.) * .32;
      vec3 emit = vec3(0.);
      if (wall) {
        float bay = 2.6 + seed * 1.1, fl = 3.3;
        vec2 g = vec2(vWall.x / bay, (vWall.y - .5) / fl);
        vec2 id = floor(g), f = fract(g);
        float win = step(.2, f.x) * step(f.x, .8) * step(.3, f.y) * step(f.y, .78) * step(0., g.y);
        float r1 = h21(id + seed * 57.3), r2 = h21(id.yx + seed * 13.1 + 7.), r3 = h21(id * 1.7 + seed);
        float lit = step(r1, .36 + .18 * seed);
        // some rooms flicker on and off slowly (TVs, people moving)
        lit *= step(.04, fract(r2 * 9. + uTime * .02 * step(.93, r3)));
        vec3 wc = mix(vec3(1., .66, .34), vec3(.72, .84, 1.), step(.82, r2));
        wc = mix(wc, vec3(1., .86, .62), step(.55, r3) * .5);
        float inten = .7 + r3 * 1.6;
        vec3 w = win * lit * wc * inten;
        // dark glass on unlit windows
        col = mix(col, vec3(.035,.045,.07), win * (1. - lit) * .8);
        // shop fronts on the ground floor
        float gf = step(vWall.y, 3.2) * step(.6, vWall.y);
        vec3 shopC = mix(vec3(1., .55, .2), mix(vec3(.4, .9, 1.), vec3(1., .3, .5), step(.5, r2)), step(.6, r1));
        w = mix(w, shopC * (1.1 + .6 * r3) * step(.15, f.x) * step(f.x, .92), gf * shop);
        // far away: blend the window pattern to its average glow to avoid shimmer
        float fw = fwidth(g.x) + fwidth(g.y);
        vec3 avg = wc * inten * (.36 + .18 * seed) * .26;
        emit = mix(w, avg, smoothstep(.25, .9, fw)) * uGlow;
      } else {
        // roofs: darker, faint rooftop lights and water tanks catching the sky
        col = base * .55 + vec3(.006,.008,.014);
        float spot = step(.985, h21(floor(vW.xz / 3.) + seed));
        emit = vec3(1., .5, .25) * spot * .6;
      }
      col += emit;
      gl_FragColor = vec4(fogMix(col, vDist), 1.);
    }`,
  extensions: { derivatives: true },
});

const roadMat = () => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uFog: { value: FOG }, uFogDensity: { value: 0.00105 } },
  vertexShader: /* glsl */`
    attribute vec3 aRoad; // width, rank, footway
    varying vec2 vUv; varying vec3 vRoad; varying float vDist; varying vec3 vW;
    void main(){ vUv = uv; vRoad = aRoad; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    ${NOISE}${FOG_GLSL}
    varying vec2 vUv; varying vec3 vRoad; varying float vDist; varying vec3 vW;
    void main(){
      float across = vUv.x, along = vUv.y, w = vRoad.x, rank = vRoad.y, foot = vRoad.z;
      vec3 col = mix(vec3(.030,.034,.044), vec3(.045,.046,.050), foot);
      col += h21(floor(vW.xz * 2.)) * .008;
      // sodium street lamps: warm pools along both edges
      float spacing = 26. + 8. * step(rank, .5);
      float lampAlong = fract(along / spacing) - .5;
      float pool = exp(-pow(lampAlong * spacing / 7.5, 2.));
      float edge = smoothstep(.5, 0., abs(abs(across - .5) - .42) * w / 3.5);
      col += vec3(1., .52, .16) * pool * (.22 + .25 * edge) * (1. - foot * .6);
      // lane paint
      float centre = (1. - smoothstep(.0, .12 / w * 4., abs(across - .5))) * step(.5, rank) * step(.5, fract(along / 6.));
      col += vec3(.55, .52, .45) * centre * .35;
      float kerb = smoothstep(.02, 0., min(across, 1. - across)) * step(.5, rank);
      col += vec3(.3) * kerb * .25;
      gl_FragColor = vec4(fogMix(col, vDist), 1.);
    }`,
  extensions: { derivatives: true },
});

const flatMat = (hex, sheen = 0) => new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(hex) }, uSheen: { value: sheen }, uFog: { value: FOG }, uFogDensity: { value: 0.00105 } },
  vertexShader: /* glsl */`varying float vDist; varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`
    ${NOISE}${FOG_GLSL}
    uniform vec3 uColor; uniform float uSheen; uniform float uTime; varying float vDist; varying vec3 vW;
    void main(){
      vec3 c = uColor;
      if (uSheen > 0.) { // water: city lights shimmering on the surface
        float s = sin(vW.x * .08 + uTime * .7) * sin(vW.z * .11 - uTime * .5);
        c += vec3(1., .6, .3) * pow(max(s, 0.), 6.) * .25 * uSheen + vec3(.05,.1,.2) * .4;
      }
      gl_FragColor = vec4(fogMix(c, vDist), 1.);
    }`,
});

// ------------------------------------------------------------------ city
export class City {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = FOG.clone();
    this.camera = new THREE.PerspectiveCamera(38, 1, 2, 9000);
    this.camera.position.set(0, 1400, 1600);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 45, maxDistance: 3200, maxPolarAngle: Math.PI * 0.47, autoRotate: true, autoRotateSpeed: 0.35, rotateSpeed: 0.55, zoomSpeed: 0.9 });
    let idle; this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(idle); this.tween = null; });
    this.controls.addEventListener('end', () => { clearTimeout(idle); idle = setTimeout(() => (this.controls.autoRotate = true), 9000); });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.32, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    this.mats = [];
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.fx = new THREE.Group(); this.scene.add(this.fx);
    this.sky();
    this.resize(); new ResizeObserver(() => this.resize()).observe(host);
    this.renderer.setAnimationLoop(() => this.frame());
    this.onFrame = [];
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  sky() {
    const g = new THREE.SphereGeometry(6000, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `${NOISE} varying vec3 vP; void main(){
        float y = vP.y;
        vec3 c = mix(vec3(.043,.07,.135), vec3(.012,.02,.05), smoothstep(0., .55, y));
        c = mix(c, vec3(.16,.10,.12), exp(-max(y, 0.) * 9.) * .55); // city glow on the horizon
        float st = step(.9975, h21(floor(vP.xz / max(y, .05) * 160.))) * smoothstep(.15, .5, y);
        c += vec3(.8,.85,1.) * st * .6;
        gl_FragColor = vec4(c, 1.); }`,
    });
    this.scene.add(new THREE.Mesh(g, m));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(5000, 64), flatMat('#070a11'));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; this.scene.add(ground); this.mats.push(ground.material);
  }

  // ---------- projection ----------
  setOrigin(lat, lng) { this.o = { lat, lng, k: mLng(lat) }; }
  local(lat, lng) { return new THREE.Vector3((lng - this.o.lng) * this.o.k, 0, -(lat - this.o.lat) * M_LAT); }

  // ---------- build ----------
  build(city, home) {
    this.world.clear(); this.fx.clear(); this.mats = this.mats.slice(0, 1);
    this.setOrigin(city.origin.lat, city.origin.lng);
    const H = this.local(home.lat, home.lng);
    this.home = H;
    this.buildings(city, H);
    this.roads(city);
    this.areas(city.water, '#06182b', 1, 0.03);
    this.areas(city.green, '#0a1810', 0, 0.025);
    this.trees(city);
    this.traffic(city);
    this.beacon(H);
    this.rise0 = this.clock.getElapsedTime();
  }

  buildings(city, H) {
    const pos = [], nor = [], wall = [], meta = [], idx = [];
    let homeIdx = -1, best = Infinity;
    const pip = (x, z, p) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) { const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
    city.buildings.forEach((b, bi) => {
      const p = b.p; const n = p.length / 2;
      let cx = 0, cz = 0, s = 0;
      for (let i = 0; i < n; i++) { cx += p[i * 2] / n; cz += p[i * 2 + 1] / n; const j = (i + 1) % n; s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      const d = Math.hypot(cx - H.x, cz - H.z);
      if (pip(H.x, H.z, p) || (d < best && d < 25)) { if (pip(H.x, H.z, p) || homeIdx < 0) { homeIdx = bi; best = pip(H.x, H.z, p) ? -1 : d; } }
      const seed = ((bi * 9301 + 49297) % 233280) / 233280;
      const delay = Math.min(2.8, d / 330) + seed * 0.25;
      const h = b.h, flip = s < 0 ? -1 : 1;
      let u = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
        const len = Math.hypot(bx - ax, bz - az); if (len < 0.05) continue;
        const nx = ((bz - az) / len) * flip, nz = (-(bx - ax) / len) * flip;
        const v0 = pos.length / 3;
        pos.push(ax, 0, az, bx, 0, bz, bx, h, bz, ax, h, az);
        for (let q = 0; q < 4; q++) { nor.push(nx, 0, nz); meta.push(seed, b.k, delay); }
        wall.push(u, 0, u + len, 0, u + len, h, u, h);
        idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
        u += len;
      }
      const contour = []; for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const r0 = pos.length / 3;
      for (let i = 0; i < n; i++) { pos.push(p[i * 2], h, p[i * 2 + 1]); nor.push(0, 1, 0); wall.push(0, h); meta.push(seed, b.k, delay); }
      tris.forEach((t) => idx.push(r0 + t[0], r0 + t[2], r0 + t[1]));
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2));
    g.setAttribute('aMeta', new THREE.Float32BufferAttribute(meta, 3));
    g.setIndex(idx);
    const m = buildingMat(); this.mats.push(m); this.bmat = m;
    this.world.add(new THREE.Mesh(g, m));
    // the home building: traced in amber light
    if (homeIdx >= 0) {
      const b = city.buildings[homeIdx], pts = [];
      for (let i = 0; i <= b.p.length / 2; i++) { const k = i % (b.p.length / 2); pts.push(b.p[k * 2], b.h + 0.4, b.p[k * 2 + 1]); }
      const top = new THREE.BufferGeometry(); top.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(3.2, 1.9, 0.6), transparent: true, opacity: 0.95 });
      const line = new THREE.Line(top, lm); this.fx.add(line); this.homeOutline = line; this.homeH = b.h;
      const verts = [];
      for (let i = 0; i < b.p.length / 2; i++) verts.push(b.p[i * 2], 0.3, b.p[i * 2 + 1], b.p[i * 2], b.h + 0.4, b.p[i * 2 + 1]);
      const vg = new THREE.BufferGeometry(); vg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      this.fx.add(new THREE.LineSegments(vg, new THREE.LineBasicMaterial({ color: new THREE.Color(2.2, 1.2, 0.35), transparent: true, opacity: 0.7 })));
    }
  }

  roads(city) {
    const pos = [], uv = [], ar = [], idx = [];
    this.roadLines = [];
    for (const r of city.roads) {
      const p = r.p, n = p.length / 2; if (n < 2) continue;
      const y = 0.06 + r.r * 0.012 + (r.f ? -0.02 : 0);
      const pts = []; for (let i = 0; i < n; i++) pts.push([p[i * 2], p[i * 2 + 1]]);
      let along = 0; const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
        let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const hw = r.w / 2;
        pos.push(pts[i][0] - dz * hw, y, pts[i][1] + dx * hw, pts[i][0] + dz * hw, y, pts[i][1] - dx * hw);
        uv.push(0, along, 1, along); ar.push(r.w, r.r, r.f, r.w, r.r, r.f);
        if (i > 0) { const v = base + (i - 1) * 2; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
      }
      if (!r.f && r.r >= 1) this.roadLines.push({ pts, w: r.w, rank: r.r, len: along });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(ar, 3));
    g.setIndex(idx);
    const m = roadMat(); this.mats.push(m);
    const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 1; this.world.add(mesh);
  }

  areas(list, color, sheen, y) {
    const pos = [], idx = [];
    for (const a of list || []) {
      const c = []; for (let i = 0; i < a.p.length / 2; i++) c.push(new THREE.Vector2(a.p[i * 2], a.p[i * 2 + 1]));
      if (c.length < 3) continue;
      const base = pos.length / 3; c.forEach((v) => pos.push(v.x, y, v.y));
      THREE.ShapeUtils.triangulateShape(c, []).forEach((t) => idx.push(base + t[0], base + t[2], base + t[1]));
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = flatMat(color, sheen); this.mats.push(m); this.world.add(new THREE.Mesh(g, m));
  }

  trees(city) {
    // OSM has few trees here, so line residential roads with them (HSR is leafy), skipping building footprints
    const occ = new Set(), cell = 6, key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    for (const b of city.buildings) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < b.p.length; i += 2) { x0 = Math.min(x0, b.p[i]); x1 = Math.max(x1, b.p[i]); z0 = Math.min(z0, b.p[i + 1]); z1 = Math.max(z1, b.p[i + 1]); }
      for (let x = x0; x <= x1; x += cell) for (let z = z0; z <= z1; z += cell) occ.add(key(x, z));
    }
    const spots = [];
    for (let i = 0; i < (city.trees || []).length; i += 2) spots.push([city.trees[i], city.trees[i + 1]]);
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const r of this.roadLines) {
      if (r.rank > 3) continue;
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
        for (let t = rnd() * 9; t < L; t += 9 + rnd() * 9) {
          for (const side of [-1, 1]) {
            if (rnd() < 0.35) continue;
            const off = r.w / 2 + 1.6 + rnd() * 1.2;
            const x = a[0] + dx * t - dz * off * side, z = a[1] + dz * t + dx * off * side;
            if (!occ.has(key(x, z)) && x * x + z * z < 760 * 760) spots.push([x, z]);
          }
        }
      }
    }
    const n = Math.min(spots.length, 6500);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#0c1c14') });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvY = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vY;').replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * (0.55 + 0.45 * (vY * .5 + .5)) + vec3(.09,.05,.015) * (1. - (vY * .5 + .5)), opacity );');
    };
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < n; i++) {
      const [x, z] = spots[i], r = 2.2 + rnd() * 2.4;
      m4.compose(new THREE.Vector3(x, r * 0.9 + 1.2, z), q, new THREE.Vector3(r, r * 0.85, r)); inst.setMatrixAt(i, m4);
    }
    this.world.add(inst);
  }

  traffic(city) {
    const lanes = [];
    for (const r of this.roadLines) {
      if (r.rank < 1 || r.len < 60) continue;
      const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
      const count = Math.round(r.len / (r.rank >= 4 ? 16 : r.rank >= 2 ? 30 : 75));
      for (let c = 0; c < count; c++) for (const dir of [1, -1]) lanes.push({ r, cum, d: Math.random() * r.len, v: (r.rank >= 4 ? 13 : 8) + Math.random() * 5, dir, off: r.w * (r.rank >= 4 ? 0.27 : 0.22) * dir });
    }
    this.cars = lanes.slice(0, 2600);
    const n = this.cars.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    this.cars.forEach((c, i) => {
      const head = c.dir > 0; const k = head ? [2.4, 2.2, 1.9] : [2.6, 0.25, 0.15];
      col.set(k, i * 3);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const tex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    const m = new THREE.PointsMaterial({ size: 5.5, map: tex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    this.carPoints = new THREE.Points(g, m); this.world.add(this.carPoints);
  }

  stepTraffic(dt) {
    if (!this.cars) return;
    const a = this.carPoints.geometry.attributes.position.array;
    this.cars.forEach((c, i) => {
      c.d = (c.d + c.v * dt * c.dir + c.r.len) % c.r.len;
      const cum = c.cum; let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= c.d) lo = mid; else hi = mid; }
      const p0 = c.r.pts[lo], p1 = c.r.pts[hi], seg = cum[hi] - cum[lo] || 1, t = (c.d - cum[lo]) / seg;
      const dx = (p1[0] - p0[0]) / seg, dz = (p1[1] - p0[1]) / seg;
      a[i * 3] = p0[0] + (p1[0] - p0[0]) * t - dz * c.off; a[i * 3 + 1] = 1.1; a[i * 3 + 2] = p0[1] + (p1[1] - p0[1]) * t + dx * c.off;
    });
    this.carPoints.geometry.attributes.position.needsUpdate = true;
  }

  // home: a column of light and a pulse on the ground
  beacon(H) {
    const beamGeo = new THREE.CylinderGeometry(2.2, 5, 260, 24, 1, true); beamGeo.translate(0, 130, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: 'uniform float uTime; varying vec2 vUv; void main(){ float a = pow(1. - vUv.y, 2.2) * (.55 + .15 * sin(uTime * 2.)); gl_FragColor = vec4(vec3(1.4,.8,.25) * a, a); }',
    }));
    beam.position.copy(H); this.fx.add(beam); this.beam = beam;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.3, 0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2; ring.position.set(H.x, (this.homeH || 0) + 0.8, H.z); this.fx.add(ring); this.ring = ring;
    this.expecting = false;
  }

  // ---------- door path ----------
  setPath(points) {
    if (this.pathMesh) { this.fx.remove(this.pathMesh); this.pathMesh = null; }
    this.stops = points.map((p) => this.local(p.lat, p.lng));
    if (this.stops.length < 2) return;
    const pts = this.stops.map((v) => new THREE.Vector3(v.x, 3.5, v.z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.2);
    this.pathCurve = curve;
    const g = new THREE.TubeGeometry(curve, Math.max(60, pts.length * 40), 1.9, 10, false);
    this.pathMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uProg: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `uniform float uTime; uniform float uProg; varying vec2 vUv; void main(){
        float done = step(vUv.x, uProg);
        float flow = pow(fract(vUv.x * 14. - uTime * .9), 6.);
        vec3 c = vec3(1.5,.8,.22) * (.45 + flow * 1.2) + done * vec3(1.8,1.1,.4) * 1.1;
        gl_FragColor = vec4(c, .75); }`,
    });
    this.pathMesh = new THREE.Mesh(g, this.pathMat); this.pathMesh.renderOrder = 10; this.fx.add(this.pathMesh);
    this.stopParams = this.stops.map((_, i) => i / (this.stops.length - 1));
  }
  setProgress(step) {
    if (!this.pathMat) return;
    const target = step < 0 ? 0 : this.stopParams[Math.min(step, this.stopParams.length - 1)];
    this.progFrom = this.pathMat.uniforms.uProg.value; this.progTo = target; this.progT = 0;
  }

  // ---------- rider ----------
  placeRider(lat, lng) {
    const to = this.local(lat, lng); to.y = 4;
    if (!this.rider) {
      const g = new THREE.SphereGeometry(2.6, 24, 16);
      this.rider = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 2.2, 4.5) }));
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.rotation.x = -Math.PI / 2; this.riderHalo = halo; this.fx.add(halo);
      this.rider.position.copy(to).add(new THREE.Vector3(0, 120, 0));
      this.fx.add(this.rider);
      this.trail = []; const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(60 * 3), 3));
      this.trailLine = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 1.6, 3.2), transparent: true, opacity: 0.8 })); this.fx.add(this.trailLine);
    }
    this.riderFrom = this.rider.position.clone(); this.riderTo = to; this.riderT = 0;
    return to;
  }

  // ---------- camera ----------
  look(target, dist, polar = 0.95, az = null, dur = 2.2) {
    const t = target.clone ? target.clone() : new THREE.Vector3(target.x, 0, target.z);
    const cur = this.camera.position.clone().sub(this.controls.target);
    const s0 = new THREE.Spherical().setFromVector3(cur);
    const s1 = new THREE.Spherical(dist, polar, az ?? s0.theta);
    this.tween = { t: 0, dur, from: this.controls.target.clone(), to: t, s0, s1 };
  }

  project(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.getElapsedTime();
    for (const m of this.mats) if (m.uniforms?.uTime) m.uniforms.uTime.value = t;
    if (this.bmat && this.rise0 != null) this.bmat.uniforms.uRise.value = t - this.rise0;
    this.stepTraffic(dt);
    if (this.beam) { this.beam.material.uniforms.uTime.value = t; }
    if (this.ring) {
      const ph = (t * (this.expecting ? 0.6 : 0.4)) % 1, R = 6 + ph * (this.expecting ? 42 : 24);
      this.ring.scale.setScalar(R); this.ring.material.opacity = (1 - ph) * (this.expecting ? 0.55 : 0.35);
    }
    if (this.homeOutline) this.homeOutline.material.opacity = 0.7 + 0.3 * Math.sin(t * 3);
    if (this.pathMat) {
      this.pathMat.uniforms.uTime.value = t;
      if (this.progT != null && this.progT < 1) { this.progT = Math.min(1, this.progT + dt / 1.6); this.pathMat.uniforms.uProg.value = this.progFrom + (this.progTo - this.progFrom) * ease(this.progT); }
    }
    if (this.rider) {
      if (this.riderT < 1) { this.riderT = Math.min(1, this.riderT + dt / 1.8); const k = ease(this.riderT); this.rider.position.lerpVectors(this.riderFrom, this.riderTo, k); this.rider.position.y = 4 + Math.sin(k * Math.PI) * 26 * (this.riderFrom.distanceTo(this.riderTo) > 60 ? 1 : 0.15); }
      const pulse = (t * 0.9) % 1; this.riderHalo.position.set(this.rider.position.x, 0.5, this.rider.position.z); this.riderHalo.scale.setScalar(4 + pulse * 22); this.riderHalo.material.opacity = 1 - pulse;
      this.trail.push(this.rider.position.clone()); if (this.trail.length > 60) this.trail.shift();
      const ta = this.trailLine.geometry.attributes.position.array; this.trail.forEach((p, i) => ta.set([p.x, p.y, p.z], i * 3));
      for (let i = this.trail.length; i < 60; i++) ta.set([this.rider.position.x, this.rider.position.y, this.rider.position.z], i * 3);
      this.trailLine.geometry.attributes.position.needsUpdate = true;
    }
    if (this.tween) {
      const w = this.tween; w.t = Math.min(1, w.t + dt / w.dur); const k = ease(w.t);
      this.controls.target.lerpVectors(w.from, w.to, k);
      let dth = w.s1.theta - w.s0.theta; if (dth > Math.PI) dth -= 2 * Math.PI; if (dth < -Math.PI) dth += 2 * Math.PI;
      const s = new THREE.Spherical(w.s0.radius + (w.s1.radius - w.s0.radius) * k, w.s0.phi + (w.s1.phi - w.s0.phi) * k, w.s0.theta + dth * k);
      this.camera.position.copy(this.controls.target).add(new THREE.Vector3().setFromSpherical(s));
      if (w.t >= 1) this.tween = null;
    }
    this.controls.update();
    this.composer.render();
    this.onFrame.forEach((f) => f(t));
  }
}
