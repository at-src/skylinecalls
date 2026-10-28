// ToTheDoor city renderer: an Indian neighbourhood through the day and night, built from OpenStreetMap in three.js.
// Every building is drawn by type (house, apartment, shops, office, civic, temple, shed) with its own colours,
// floors, windows, balconies, shop signboards and rooftop water tanks. Land use colours the ground (parks, pitches,
// construction, water). Street lights come from the map; traffic runs where the roads are busy.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const M_LAT = 110540;
const mLng = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const T = { HOUSE: 0, APARTMENT: 1, SHOPS: 2, OFFICE: 3, CIVIC: 4, LOW: 5, RELIGIOUS: 6, MALL: 7 };
const Z = { RESIDENTIAL: 0, COMMERCIAL: 1, INDUSTRIAL: 2, PARK: 3, CONSTRUCTION: 4, WATER: 5, RELIGIOUS: 6, CEMETERY: 7, PITCH: 8, PARKING: 9 };

// atmosphere; every value below is rewritten each frame by applyTime() for the hour of the day
const FOG = new THREE.Color('#2a3146');
const SUN = new THREE.Vector3(-0.62, 0.26, 0.42).normalize();

// One set of lighting uniforms shared by reference across every custom shader, so the time of day
// changes the whole city at once.
const ENV = {
  uFog: { value: FOG }, uFogDensity: { value: 0.0011 }, uSun: { value: SUN },
  uSunCol: { value: new THREE.Vector3(0.85, 0.51, 0.31) }, uSkyCol: { value: new THREE.Vector3(0.10, 0.12, 0.185) }, uBounce: { value: new THREE.Vector3(0.044, 0.033, 0.026) },
  uNight: { value: 0.8 },  // 0 broad daylight .. 1 full night: how much artificial light shows
  uOcc: { value: 1 },      // share of homes with lights on at this hour
  uShop: { value: 1 },     // share of shops open at this hour
  uLamp: { value: 1 },     // street lights on
};

// Bengaluru's day. Sun, sky and fog colours are linear; skyTop/Mid/Hor are sRGB for the sky dome.
const NIGHT = { sun: [0.05, 0.06, 0.10], sky: [0.035, 0.045, 0.08], bounce: [0.02, 0.016, 0.013], fog: '#0d1220', top: [0.01, 0.015, 0.04], mid: [0.03, 0.045, 0.09], hor: [0.10, 0.10, 0.14], stars: 1, bloom: 0.5 };
const DAY_KEYS = [
  [0, NIGHT],
  [5.0, NIGHT],
  [6.0, { sun: [0.45, 0.26, 0.2], sky: [0.08, 0.09, 0.15], bounce: [0.04, 0.03, 0.03], fog: '#3c3a4c', top: [0.08, 0.12, 0.28], mid: [0.30, 0.30, 0.45], hor: [0.92, 0.58, 0.45], stars: 0.25, bloom: 0.4 }],
  [7.0, { sun: [0.95, 0.65, 0.42], sky: [0.14, 0.17, 0.26], bounce: [0.07, 0.05, 0.04], fog: '#8a8a96', top: [0.18, 0.34, 0.66], mid: [0.48, 0.58, 0.78], hor: [0.95, 0.78, 0.62], stars: 0, bloom: 0.25 }],
  [9.0, { sun: [1.1, 1.0, 0.86], sky: [0.25, 0.29, 0.37], bounce: [0.15, 0.13, 0.10], fog: '#a6b3c2', top: [0.20, 0.42, 0.80], mid: [0.48, 0.66, 0.90], hor: [0.78, 0.84, 0.90], stars: 0, bloom: 0.15 }],
  [12.5, { sun: [1.15, 1.1, 1.0], sky: [0.28, 0.32, 0.40], bounce: [0.17, 0.15, 0.12], fog: '#b4c2d1', top: [0.17, 0.40, 0.82], mid: [0.45, 0.65, 0.92], hor: [0.80, 0.87, 0.94], stars: 0, bloom: 0.12 }],
  [16.0, { sun: [1.1, 0.95, 0.76], sky: [0.24, 0.27, 0.35], bounce: [0.14, 0.11, 0.09], fog: '#aab2bd', top: [0.19, 0.40, 0.78], mid: [0.48, 0.64, 0.88], hor: [0.84, 0.84, 0.86], stars: 0, bloom: 0.15 }],
  [17.6, { sun: [1.0, 0.68, 0.40], sky: [0.14, 0.15, 0.24], bounce: [0.08, 0.05, 0.04], fog: '#8c7f86', top: [0.18, 0.30, 0.58], mid: [0.50, 0.50, 0.62], hor: [1.0, 0.70, 0.45], stars: 0, bloom: 0.3 }],
  [18.4, { sun: [0.85, 0.51, 0.31], sky: [0.10, 0.12, 0.185], bounce: [0.044, 0.033, 0.026], fog: '#2a3146', top: [0.035, 0.06, 0.14], mid: [0.16, 0.19, 0.32], hor: [0.62, 0.40, 0.30], stars: 0.6, bloom: 0.45 }],
  [19.3, { sun: [0.12, 0.10, 0.14], sky: [0.05, 0.06, 0.11], bounce: [0.025, 0.02, 0.018], fog: '#141a2c', top: [0.015, 0.025, 0.07], mid: [0.06, 0.08, 0.16], hor: [0.22, 0.16, 0.20], stars: 0.9, bloom: 0.5 }],
  [21.0, NIGHT],
  [24, NIGHT],
];
// share of homes with a light on, by hour: up early to cook, out at work, everyone home after 8, asleep by 1
const OCC_KEYS = [[0, 0.4], [1, 0.22], [3, 0.1], [5, 0.15], [6, 0.42], [7.5, 0.45], [9.5, 0.25], [16, 0.25], [18, 0.6], [19.5, 0.9], [21.5, 1], [23, 0.7], [24, 0.4]];
// shops: a pharmacy or two all night, shutters up from 9 to 10:30 pm
const SHOP_KEYS = [[0, 0.06], [6, 0.06], [7.5, 0.3], [9.5, 1], [22, 1], [23, 0.3], [24, 0.06]];
// traffic: empty roads at 3 am, school and office rush 8 to 10 and 6 to 8 pm
const TRAFFIC_KEYS = [[0, 0.12], [2, 0.06], [5, 0.1], [6.5, 0.35], [8.5, 1], [10.5, 0.8], [13, 0.65], [16, 0.7], [18, 1], [20.5, 0.85], [22, 0.5], [23.5, 0.22], [24, 0.12]];
const curve = (keys, h) => { for (let i = 1; i < keys.length; i++) if (h <= keys[i][0]) { const [h0, a] = keys[i - 1], [h1, b] = keys[i]; return a + (b - a) * ((h - h0) / (h1 - h0 || 1)); } return keys[keys.length - 1][1]; };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _fa = new THREE.Color(), _fb = new THREE.Color();
function palette(h) {
  let i = 1; while (i < DAY_KEYS.length - 1 && h > DAY_KEYS[i][0]) i++;
  const [h0, a] = DAY_KEYS[i - 1], [h1, b] = DAY_KEYS[i], k = (h - h0) / (h1 - h0 || 1);
  const mix = (x, y) => x.map((v, j) => v + (y[j] - v) * k);
  return { sun: mix(a.sun, b.sun), sky: mix(a.sky, b.sky), bounce: mix(a.bounce, b.bounce), top: mix(a.top, b.top), mid: mix(a.mid, b.mid), hor: mix(a.hor, b.hor), stars: a.stars + (b.stars - a.stars) * k, bloom: a.bloom + (b.bloom - a.bloom) * k, fog: _fa.set(a.fog).lerp(_fb.set(b.fog), k) };
}

// ------------------------------------------------------------------ shared GLSL
const COMMON = /* glsl */`
  uniform vec3 uFog; uniform float uFogDensity; uniform vec3 uSun; uniform float uTime;
  uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uBounce;
  uniform float uNight; uniform float uOcc; uniform float uShop; uniform float uLamp;
  float h11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
  vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
  vec3 fogMix(vec3 c, float d){ float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d); return mix(c, uFog, clamp(f, 0., .92)); }
  // sun (or moon), sky and ground bounce for the current hour
  vec3 light(vec3 n){
    float sun = max(dot(n, uSun), 0.);
    float sky = .5 + .5 * n.y;
    return uSunCol * sun + uSkyCol * sky + uBounce * (1. - sky);
  }
`;
const sharedUniforms = () => ({ ...ENV, uTime: { value: 0 } });

// ------------------------------------------------------------------ buildings
const buildingMat = () => new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { ...sharedUniforms(), uRise: { value: 0 } },
  vertexShader: /* glsl */`
    attribute vec2 aWall;   // u along the wall (m), v height (m)
    attribute vec4 aB;      // type, floors, occupancy, colour index
    attribute vec4 aM;      // seed, rise delay, has shops, fronts main road
    attribute float aH;     // building height (m)
    uniform float uRise;
    varying vec3 vN; varying vec3 vW; varying vec2 vWall; varying vec4 vB; varying vec4 vM; varying float vDist; varying float vH;
    void main(){
      float r = clamp((uRise - aM.y) / 1.2, 0., 1.); r = 1. - pow(1. - r, 3.);
      vec3 p = position; vH = aH; p.y *= max(r, .0001);
      vec4 w = modelMatrix * vec4(p, 1.);
      vW = w.xyz; vN = normal; vWall = vec2(aWall.x, aWall.y); vB = aB; vM = aM;
      vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    ${COMMON}
    varying vec3 vN; varying vec3 vW; varying vec2 vWall; varying vec4 vB; varying vec4 vM; varying float vDist; varying float vH;

    vec3 housePaint(float i){
      // the colours Indian houses are actually painted
      if (i < 1.) return vec3(.93,.88,.76);   // cream
      if (i < 2.) return vec3(.94,.84,.52);   // pale yellow
      if (i < 3.) return vec3(.95,.95,.93);   // white
      if (i < 4.) return vec3(.73,.84,.76);   // mint
      if (i < 5.) return vec3(.68,.79,.88);   // sky blue
      if (i < 6.) return vec3(.90,.70,.60);   // salmon
      if (i < 7.) return vec3(.80,.74,.86);   // lilac
      if (i < 8.) return vec3(.84,.58,.44);   // terracotta
      if (i < 9.) return vec3(.86,.89,.68);   // light green
      if (i < 10.) return vec3(.96,.80,.64);  // peach
      if (i < 11.) return vec3(.78,.78,.76);  // grey
      return vec3(.87,.80,.68);               // beige
    }
    vec3 signColour(float r){
      if (r < .2) return vec3(1., .16, .12);
      if (r < .38) return vec3(.10, .35, 1.);
      if (r < .55) return vec3(1., .78, .10);
      if (r < .68) return vec3(.10, .80, .35);
      if (r < .80) return vec3(1., 1., 1.);
      if (r < .9) return vec3(1., .45, .05);
      return vec3(.85, .15, .70);
    }

    void main(){
      vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
      float type = vB.x, floors = vB.y, occ = vB.z, ci = vB.w;
      float seed = vM.x, shops = vM.z, mainRoad = vM.w;
      bool wall = abs(n.y) < .5;
      float fh = type > 2.5 && type < 3.5 ? 3.6 : type > 4.5 && type < 5.5 ? 4.2 : type > 5.5 ? 4.5 : 3.2;
      bool isShop = type > 1.5 && type < 2.5 || shops > .5;

      // ---- base paint by building type
      vec3 paint;
      if (type < .5) paint = housePaint(ci);
      else if (type < 1.5) paint = mix(vec3(.88,.85,.78), vec3(.80,.80,.80), step(.5, h11(ci + 3.)));
      else if (type < 2.5) paint = housePaint(mod(ci + 5., 12.)) * .95;
      else if (type < 3.5) paint = vec3(.62,.66,.70);
      else if (type < 4.5) paint = mix(vec3(.86,.78,.60), vec3(.80,.36,.28), step(.6, h11(ci)));
      else if (type < 5.5) paint = vec3(.58,.56,.52);
      else if (type < 6.5) paint = mix(vec3(.97,.95,.88), vec3(.95,.62,.25), step(.65, h11(ci)));
      else paint = vec3(.70,.72,.74);
      paint = lin(paint);
      // weathering: monsoon stains and dirt near the ground
      float stain = vnoise(vec2(vWall.x * .35, vWall.y * .9) + seed * 40.) * .22 + vnoise(vec2(vWall.x * 2.1, vWall.y * .25) + seed * 13.) * .1;
      paint *= 1. - stain * .7;

      vec3 col; vec3 emit = vec3(0.);
      if (wall) {
        float y = vWall.y, u = vWall.x;
        float fl = floor(y / fh), fy = fract(y / fh) * fh;
        bool ground = fl < .5;
        bool top = y > vH - .95 && type < 2.5; // parapet band on flat roofs
        // slab edges: the concrete band at every floor
        float slab = step(fy, .28) * step(.5, fl) * step(type, 2.5);
        // windows
        float bay = type > 2.5 && type < 3.5 ? 1.6 : type < .5 ? 2.9 + h11(seed) * .9 : 3.3;
        float bu = u / bay, bid = floor(bu), bx = fract(bu);
        float wx, wy0, wy1;
        if (type > 2.5 && type < 3.5) { wx = step(.08, bx) * step(bx, .92); wy0 = .55; wy1 = fh - .35; }   // office glazing
        else { wx = step(.26, bx) * step(bx, .74); wy0 = .95; wy1 = 2.25; }                                    // ordinary windows
        float win = wx * step(wy0, fy) * step(fy, wy1) * (top ? 0. : 1.);
        // balconies on homes: every other bay a recessed balcony with a parapet
        float balc = (type < 1.5) ? step(.55, h21(vec2(bid, seed * 7.))) * step(.5, fl) * (top ? 0. : 1.) : 0.;
        float balcRail = balc * step(.28, fy) * step(fy, 1.25) * step(.08, bx) * step(bx, .92);
        float balcRecess = balc * step(1.25, fy) * step(fy, fh - .2) * step(.08, bx) * step(bx, .92);

        vec3 l = light(n);
        col = paint * l;
        col = mix(col, paint * l * .55, balcRecess);                    // shadow inside the balcony
        col = mix(col, lin(vec3(.75,.74,.70)) * l * 1.05, slab * .55);  // slab edge
        col = mix(col, lin(vec3(.86,.85,.82)) * l, top ? .35 : 0.);     // parapet cap
        col = mix(col, paint * l * .82, balcRail);                       // balcony parapet wall

        // window glass and room lights
        float r1 = h21(vec2(bid, fl) + seed * 31.7), r2 = h21(vec2(fl, bid) * 1.3 + seed * 9.1);
        float glow = mix(.1, 1., uNight);                                     // lit rooms barely show in daylight
        float lit = step(r1, occ * uOcc) * glow;
        lit *= step(.03, fract(r2 * 11. + uTime * .015 * step(.95, r2)));     // a few rooms switch on and off
        // Each household has its own kind of light (yellow bulbs, warm LED, neutral LED or tube lights) and most
        // of its rooms use it; the rest is a mix of other bulbs, TVs, night lamps and coloured LED strips.
        float bt = h11(seed * 57.1 + fl * .37);
        vec3 bulb = vec3(1.,.56,.24), warm = vec3(1.,.74,.45), neutral = vec3(1.,.88,.70), tube = vec3(.76,.87,1.);
        vec3 own = bt < .3 ? bulb : bt < .58 ? warm : bt < .78 ? neutral : tube;
        float r3 = h21(vec2(bid * 1.7, fl * 2.3) + seed * 4.3);
        vec3 room = r3 < .58 ? own : r3 < .68 ? bulb : r3 < .76 ? tube : r3 < .82 ? warm
          : r3 < .89 ? vec3(.32,.48,1.) * (.65 + .35 * sin(uTime * 6. + bid * 3. + fl))    // TV glow, flickering
          : r3 < .93 ? vec3(1.,.42,.12) * .55                                                  // dim night lamp / diya
          : r3 < .955 ? vec3(1.,.32,.72) : r3 < .98 ? vec3(.62,.38,1.) : vec3(.32,1.,.55);     // pink, purple, green LED strips
        room *= 1.25;
        if (type > 2.5 && type < 3.5 || type > 6.5) { room = mix(vec3(.82,.9,1.), vec3(1.,.9,.75), step(.6, h11(seed * 13.))) * 1.3; own = room / 1.3; }
        vec3 glass = type > 2.5 && type < 3.5 ? lin(vec3(.20,.28,.36)) * (l * .6 + .15) : lin(vec3(.10,.11,.13)) * l;
        glass += uSkyCol * .35;                                                // sky reflected in the glass by day
        float glassMix = max(win, balcRecess * step(1.5, fy) * .0);
        col = mix(col, glass, glassMix);
        float lw = win + balcRecess * .25;
        vec3 near = room * lit * lw * (.55 + r2 * .6);
        float px = fwidth(bu) + fwidth(y / fh);
        float far = smoothstep(.18, .7, px);
        vec3 avgRoom = own * 1.25 * occ * uOcc * glow * .2;                    // seen from far: the household's tone
        col = mix(col, mix(col, glass, .22), far);
        emit += mix(near, avgRoom * (type < 2.5 ? 1. : .7), far);
        // curtains: some lit windows only glow softly
        emit *= mix(1., .45, step(.7, h21(vec2(bid + 3., fl) + seed)));

        // ground floor: shops with shutters, lit fronts and signboards
        if (ground && isShop) {
          float sy = y;
          float bayS = 4.2, sid = floor(u / bayS), sx = fract(u / bayS);
          float rs = h21(vec2(sid, seed * 17.));
          float open = step(1. - .72 * uShop, rs);                              // late at night only a few stay open
          float sglow = mix(.25, 1., uNight);
          vec3 shutter = lin(vec3(.45,.46,.47)) * l * (.85 + .15 * step(.5, fract(sy * 6.)));
          vec3 front = lin(rs < .5 ? vec3(.92,.96,1.) : rs < .8 ? vec3(1.,.88,.70) : vec3(1.,.97,.92)) * .7 * (.55 + rs * .5);
          float inFront = step(.06, sx) * step(sx, .94) * step(.15, sy) * step(sy, 2.75);
          col = mix(col, open > .5 ? lin(vec3(.25,.22,.18)) : shutter, inFront);
          emit += front * inFront * open * sglow;
          // signboard band
          float board = step(2.9, sy) * step(sy, 3.75) * step(.03, sx) * step(sx, .97);
          vec3 sc = signColour(h21(vec2(sid * 3.1, seed)));
          float glyph = step(.45, vnoise(vec2(u * 3.2, sy * 5.) + sid * 9.)) * step(3.05, sy) * step(sy, 3.6) * step(.1, sx) * step(sx, .9);
          vec3 boardCol = mix(lin(sc) * .9, vec3(1.), glyph * .8);
          col = mix(col, boardCol * mix(l * 1.1, vec3(.25), uNight), board);   // painted board by day, backlit at night
          emit += boardCol * board * (.8 + rs * .8) * uNight * step(.18, rs) * mix(.3, 1., open);
        }
        // malls: full-height glass bands and a lit brand strip at the top
        if (type > 6.5) {
          float band = step(.6, fy) * step(fy, fh - .5);
          col = mix(col, lin(vec3(.12,.18,.24)) * l + vec3(.02,.03,.04), band);
          emit += vec3(.8,.9,1.) * band * (.35 + .4 * h21(vec2(floor(u / 6.), fl) + seed)) * mix(.15, 1., uNight) * mix(.2, 1., uShop);
          float strip = step(vH - 1.6, y) * step(y, vH - .4);
          emit += mix(vec3(1.,.2,.3), vec3(.2,.6,1.), step(.5, seed)) * strip * 2.2 * uNight;
        }
        // temples: warm lamps on the walls
        if (type > 5.5) emit += vec3(1.,.55,.2) * step(.8, h21(floor(vec2(u * .8, y * .8)) + seed)) * .8 * uNight;
        // contact shadow at the base
        col *= .55 + .45 * smoothstep(0., 2.2, y);
      } else {
        // flat concrete roofs, stained, with a lighter parapet line at the edge
        // roof finish varies by house: bare concrete, white heat-proof paint, red oxide, green or blue waterproofing
        float rk = h11(seed * 91.3 + 2.);
        vec3 rbase = rk < .42 ? vec3(.44,.43,.41) : rk < .66 ? vec3(.80,.80,.78) : rk < .78 ? vec3(.55,.28,.22) : rk < .88 ? vec3(.36,.50,.40) : rk < .95 ? vec3(.36,.46,.58) : vec3(.62,.58,.50);
        vec3 roof = lin(rbase * mix(1., .7, vnoise(vW.xz * .25 + seed * 50.)));
        roof *= .8 + .2 * vnoise(vW.xz * 3.1 + seed);                            // patchy monsoon stains
        if (type > 2.5 && type < 3.5) roof = lin(vec3(.40,.43,.47));
        if (type > 5.5) roof = lin(vec3(.95,.88,.70));
        col = roof * light(n) * .7 * (.85 + .15 * vnoise(vW.xz * 1.7));
      }
      gl_FragColor = vec4(fogMix(col + emit, vDist), 1.);
    }`,
  extensions: { derivatives: true },
});

// ------------------------------------------------------------------ ground, zones, roads
const groundMat = () => new THREE.ShaderMaterial({
  uniforms: sharedUniforms(),
  vertexShader: 'varying float vDist; varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: /* glsl */`${COMMON} varying float vDist; varying vec3 vW;
    void main(){
      // open ground: red Bangalore earth, paved compounds and grassy verges, mixed in large patches
      float a = vnoise(vW.xz * .018), b = vnoise(vW.xz * .045 + 17.), g = vnoise(vW.xz * .11 + 5.);
      vec3 earth = vec3(.46,.32,.24), paved = vec3(.42,.41,.39), grass = vec3(.24,.32,.18);
      vec3 c = mix(earth, paved, smoothstep(.35, .65, a));
      c = mix(c, grass, smoothstep(.55, .75, b) * .8);
      c = lin(c) * (.8 + .4 * g) * (.88 + .12 * vnoise(vW.xz * .9));
      gl_FragColor = vec4(fogMix(c * light(vec3(0,1,0)), vDist), 1.); }`,
});

const zoneMat = () => new THREE.ShaderMaterial({
  uniforms: sharedUniforms(),
  vertexShader: 'attribute float aZone; varying float vZ; varying float vDist; varying vec3 vW; void main(){ vZ = aZone; vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: /* glsl */`${COMMON} varying float vZ; varying float vDist; varying vec3 vW;
    void main(){
      vec3 c; float n = vnoise(vW.xz * .18), n2 = vnoise(vW.xz * 1.3);
      vec3 L = light(vec3(0,1,0));
      if (vZ < .5) c = lin(vec3(.40,.37,.33)) * (.8 + .3 * n);                         // residential
      else if (vZ < 1.5) c = lin(vec3(.47,.46,.44)) * (.85 + .2 * n2);                  // commercial paving
      else if (vZ < 2.5) c = lin(vec3(.40,.40,.41));                                    // industrial
      else if (vZ < 3.5) c = lin(mix(vec3(.18,.36,.15), vec3(.30,.46,.20), n)) * (.8 + .3 * n2); // park
      else if (vZ < 4.5) c = lin(mix(vec3(.55,.40,.27), vec3(.45,.33,.24), n2));        // construction dirt
      else if (vZ < 5.5) {                                                               // water
        float s = sin(vW.x * .09 + uTime * .6) * sin(vW.z * .12 - uTime * .4);
        c = lin(vec3(.10,.20,.28)) * (uSkyCol * 2.2 + .15) + uSunCol * pow(max(s,0.), 8.) * .3;
        gl_FragColor = vec4(fogMix(c, vDist), 1.); return;
      }
      else if (vZ < 6.5) c = lin(vec3(.62,.55,.42));                                    // temple grounds
      else if (vZ < 7.5) c = lin(vec3(.26,.34,.22));                                    // cemetery
      else if (vZ < 8.5) {                                                               // pitch with lines
        c = lin(vec3(.26,.50,.22)) * (.9 + .15 * step(.5, fract(vW.x * .1)));
        c = mix(c, vec3(.75), step(.96, fract(vW.x * .05)) * .5 + step(.96, fract(vW.z * .05)) * .5);
      }
      else c = lin(vec3(.25,.25,.26));                                                  // parking
      gl_FragColor = vec4(fogMix(c * L, vDist), 1.);
    }`,
});

const roadMat = () => new THREE.ShaderMaterial({
  uniforms: sharedUniforms(),
  vertexShader: /* glsl */`
    attribute vec3 aRoad; // width, rank, footway
    varying vec2 vUv; varying vec3 vRoad; varying float vDist; varying vec3 vW;
    void main(){ vUv = uv; vRoad = aRoad; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vec4 mv = viewMatrix * w; vDist = -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: /* glsl */`${COMMON}
    varying vec2 vUv; varying vec3 vRoad; varying float vDist; varying vec3 vW;
    void main(){
      float across = vUv.x, along = vUv.y, w = vRoad.x, rank = vRoad.y, foot = vRoad.z;
      vec3 L = light(vec3(0,1,0));
      vec3 asphalt = lin(vec3(.20,.20,.21)) * (.85 + .25 * vnoise(vW.xz * .6)) * (1. - .1 * step(.7, vnoise(vW.xz * 3.)));
      if (rank < .5) asphalt = lin(vec3(.27,.26,.24)) * (.8 + .3 * vnoise(vW.xz * .5));
      if (foot > .5) asphalt = lin(vec3(.42,.40,.37));
      vec3 c = asphalt * L;
      // kerb stones painted black and yellow on main roads, a very Bengaluru detail
      float edge = min(across, 1. - across) * w;
      float kerb = step(edge, .35) * step(1.5, rank);
      c = mix(c, step(.5, fract(along / 1.4)) > .5 ? lin(vec3(.85,.72,.12)) * L : lin(vec3(.05)) * L, kerb);
      // lane markings: centre line dashes on main roads, a solid divider on wide ones
      float centre = step(abs(across - .5) * w, .09) * step(1.5, rank) * step(.45, fract(along / 7.));
      float divider = step(abs(across - .5) * w, .22) * step(3.5, rank);
      c = mix(c, lin(vec3(.85)) * L * 1.2, max(centre, divider * .0));
      c = mix(c, lin(vec3(.38,.37,.33)) * L, divider);
      gl_FragColor = vec4(fogMix(c, vDist), 1.);
    }`,
});

// soft pool of light on the ground under each street lamp (additive decals)
const poolMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: sharedUniforms(),
  vertexShader: 'attribute vec3 aCol; varying vec3 vC; varying vec2 vUv; varying float vDist; void main(){ vUv = uv; vC = aCol; vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position,1.); vDist = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: `${COMMON} varying vec3 vC; varying vec2 vUv; varying float vDist;
    void main(){ float d = length(vUv - .5) * 2.; float a = pow(max(1. - d, 0.), 2.2); float f = exp(-uFogDensity * uFogDensity * vDist * vDist); gl_FragColor = vec4(vC * a * .5 * f * uLamp * uNight, 1.); }`,
});

// ------------------------------------------------------------------ city
export class City {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = FOG.clone();
    // same falloff as fogMix() in the custom shaders, so tanks, trees and cars fade with the buildings
    this.scene.fog = new THREE.FogExp2(FOG.clone(), 0.0011);
    // time of day: 'live' follows the clock, 'manual' holds an hour, 'play' runs a day in a minute
    this.tod = { mode: 'live', hour: clockHour(), dayLength: 60 };
    this.dens = 1;
    this.camera = new THREE.PerspectiveCamera(38, 1, 2, 9000);
    this.camera.position.set(0, 1400, 1600);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, minDistance: 40, maxDistance: 3200, maxPolarAngle: Math.PI * 0.46, autoRotate: true, autoRotateSpeed: 0.3, rotateSpeed: 0.55, zoomSpeed: 0.9 });
    let idle;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; clearTimeout(idle); this.tween = null; });
    this.controls.addEventListener('end', () => { clearTimeout(idle); idle = setTimeout(() => (this.controls.autoRotate = true), 9000); });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.32, 1.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.clock = new THREE.Clock();
    this.mats = [];
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.fx = new THREE.Group(); this.scene.add(this.fx);
    this.sky();
    this.resize(); new ResizeObserver(() => this.resize()).observe(host);
    this.onFrame = [];
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  sky() {
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uSun: ENV.uSun, uNight: ENV.uNight, uTop: { value: new THREE.Vector3() }, uMid: { value: new THREE.Vector3() }, uHor: { value: new THREE.Vector3() }, uGlowCol: { value: new THREE.Vector3(1, 0.5, 0.25) }, uStars: { value: 0.6 } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `uniform vec3 uSun; uniform float uNight; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uGlowCol; uniform float uStars; varying vec3 vP;
        float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main(){
          float y = vP.y; float s = max(dot(vP, uSun), 0.);
          vec3 c = mix(uMid, uTop, smoothstep(.05, .6, y));
          c = mix(c, uHor, exp(-max(y, 0.) * 7.) * (.55 + .45 * s));
          // sun disc and halo by day, a faint moon glow at night
          c += uGlowCol * (pow(s, 18.) * .9 + pow(s, 4.) * .18) * (1. - uNight * .75) + vec3(.9,.95,1.) * pow(s, 900.) * uNight * 1.5;
          float st = step(.9982, h21(floor(vP.xz / max(y, .05) * 170.))) * smoothstep(.35, .7, y);
          c += vec3(.85,.9,1.) * st * .5 * uStars;
          gl_FragColor = vec4(pow(c, vec3(2.2)), 1.); }`,
    });
    this.skyMat = m;
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 16), m));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(5200, 64), groundMat());
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; this.scene.add(ground); this.mats.push(ground.material);
  }

  setOrigin(lat, lng) { this.o = { lat, lng, k: mLng(lat) }; }
  local(lat, lng) { return new THREE.Vector3((lng - this.o.lng) * this.o.k, 0, -(lat - this.o.lat) * M_LAT); }

  // ---------- build ----------
  build(city, home) {
    this.world.clear(); this.fx.clear(); this.mats = this.mats.slice(0, 1);
    this.rider = null; this.pathMesh = null;
    this.setOrigin(city.origin.lat, city.origin.lng);
    const H = this.local(home.lat, home.lng);
    this.home = H;
    this.extrasReset();
    this.zones(city);
    this.waterways(city);
    this.buildings(city, H);
    this.roads(city);
    this.roofProps(city);
    this.shelters(city);
    this.stringLights();
    this.flushExtras();
    this.lamps(city);
    this.trees(city);
    this.traffic(city);
    this.beacon(H);
    this.rise0 = this.clock.getElapsedTime();
  }

  zones(city) {
    const pos = [], zs = [], idx = [];
    const order = (z) => ({ [Z.RESIDENTIAL]: 0, [Z.COMMERCIAL]: 1, [Z.INDUSTRIAL]: 1, [Z.PARKING]: 2, [Z.CONSTRUCTION]: 2, [Z.CEMETERY]: 2, [Z.RELIGIOUS]: 2, [Z.PARK]: 3, [Z.PITCH]: 4, [Z.WATER]: 5 }[z] ?? 0);
    for (const zn of city.zones || []) {
      const c = []; for (let i = 0; i < zn.p.length / 2; i++) c.push(new THREE.Vector2(zn.p[i * 2], zn.p[i * 2 + 1]));
      if (c.length < 3) continue;
      const y = 0.01 + order(zn.z) * 0.012, base = pos.length / 3;
      c.forEach((v) => { pos.push(v.x, y, v.y); zs.push(zn.z); });
      THREE.ShapeUtils.triangulateShape(c, []).forEach((t) => idx.push(base + t[0], base + t[2], base + t[1]));
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aZone', new THREE.Float32BufferAttribute(zs, 1));
    g.setIndex(idx);
    const m = zoneMat(); this.mats.push(m); this.world.add(new THREE.Mesh(g, m));
  }

  buildings(city, H) {
    const pos = [], nor = [], wall = [], bb = [], mm = [], hh = [], idx = [];
    let homeIdx = -1, homeIn = false, best = Infinity;
    const pip = (x, z, p) => { let c = false; for (let i = 0, j = p.length / 2 - 1; i < p.length / 2; j = i++) { const xi = p[i * 2], zi = p[i * 2 + 1], xj = p[j * 2], zj = p[j * 2 + 1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; } return c; };
    this.footprints = [];
    city.buildings.forEach((b, bi) => {
      const p = b.p, n = p.length / 2;
      let cx = 0, cz = 0, s = 0;
      for (let i = 0; i < n; i++) { cx += p[i * 2] / n; cz += p[i * 2 + 1] / n; const j = (i + 1) % n; s += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      const d = Math.hypot(cx - H.x, cz - H.z);
      const inHome = pip(H.x, H.z, p);
      if (inHome && !homeIn) { homeIdx = bi; homeIn = true; } else if (!homeIn && d < best && d < 30) { best = d; homeIdx = bi; }
      const seed = ((bi * 9301 + 49297) % 233280) / 233280;
      const delay = Math.min(2.8, d / 330) + seed * 0.25;
      const h = b.h, flip = s < 0 ? -1 : 1;
      this.footprints.push({ cx, cz, h, b });
      const meta = [b.t, b.fl, b.o, b.c], m2 = [seed, delay, b.s, b.m];
      // one extruded prism of the footprint from y0 to y1 (walls + flat top)
      const prism = (pp, y0, y1, top) => {
        let u = 0; const m = pp.length / 2;
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          const ax = pp[i * 2], az = pp[i * 2 + 1], bx = pp[j * 2], bz = pp[j * 2 + 1];
          const len = Math.hypot(bx - ax, bz - az); if (len < 0.05) continue;
          const nx = ((bz - az) / len) * flip, nz = (-(bx - ax) / len) * flip;
          const v0 = pos.length / 3;
          pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
          for (let q = 0; q < 4; q++) { nor.push(nx, 0, nz); bb.push(...meta); mm.push(...m2); hh.push(top); }
          wall.push(u, y0, u + len, y0, u + len, y1, u, y1);
          idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
          u += Math.ceil(len / 3.3) * 3.3 + 1.1; // each wall starts on a fresh bay so windows don't straddle corners
        }
        const contour = []; for (let i = 0; i < m; i++) contour.push(new THREE.Vector2(pp[i * 2], pp[i * 2 + 1]));
        const r0 = pos.length / 3;
        for (let i = 0; i < m; i++) { pos.push(pp[i * 2], y1, pp[i * 2 + 1]); nor.push(0, 1, 0); wall.push(0, y1); bb.push(...meta); mm.push(...m2); hh.push(top); }
        THREE.ShapeUtils.triangulateShape(contour, []).forEach((t) => idx.push(r0 + t[0], r0 + t[2], r0 + t[1]));
      };
      if (b.sb && h > 5) {
        // top floor set back: a smaller room on the terrace, offset towards one side like real houses
        const area = Math.abs(s) / 2, inset = Math.max(0.5, 1 - 2.4 / Math.sqrt(area));
        const ox = (seed - 0.5) * 2.2, oz = (((bi * 7) % 11) / 11 - 0.5) * 2.2;
        const inner = []; for (let i = 0; i < n; i++) inner.push(cx + ox + (p[i * 2] - cx) * inset, cz + oz + (p[i * 2 + 1] - cz) * inset);
        const h1 = Math.max(3.2, h - 3.2);
        prism(p, 0, h1, h1);
        prism(inner, h1, h, h);
        this.footprints.at(-1).roofH = h1;
      } else prism(p, 0, h, h);
      if (b.rf) this.slopedRoof(b, h, seed);
      if (b.t === T.RELIGIOUS) this.gopuram(cx, cz, h, Math.sqrt(Math.abs(s) / 2));
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 2));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(bb, 4));
    g.setAttribute('aM', new THREE.Float32BufferAttribute(mm, 4));
    g.setAttribute('aH', new THREE.Float32BufferAttribute(hh, 1));
    g.setIndex(idx);
    const m = buildingMat(); this.mats.push(m); this.bmat = m;
    this.world.add(new THREE.Mesh(g, m));
    this.homeH = 10;
    if (homeIdx >= 0) {
      const b = city.buildings[homeIdx], pts = [];
      this.homeH = b.h;
      for (let i = 0; i <= b.p.length / 2; i++) { const k = i % (b.p.length / 2); pts.push(b.p[k * 2], b.h + 0.35, b.p[k * 2 + 1]); }
      const top = new THREE.BufferGeometry(); top.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.homeOutline = new THREE.Line(top, new THREE.LineBasicMaterial({ color: new THREE.Color(3, 1.7, 0.5), transparent: true }));
      this.fx.add(this.homeOutline);
    }
  }

  // ---------- roofs, temples, shelters, drains, festive lights ----------
  extrasReset() { this.ex = { pos: [], col: [], nor: [] }; this.festive = []; }
  tri(a, b, c3, col) { const e = this.ex; const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c3, a)).normalize(); for (const v of [a, b, c3]) { e.pos.push(v.x, v.y, v.z); e.col.push(col.r, col.g, col.b); e.nor.push(n.x, n.y, n.z); } }
  quad(a, b, c3, d, col) { this.tri(a, b, c3, col); this.tri(a, c3, d, col); }
  box(x, y, z, sx, sy, sz, rot, col) {
    const cs = Math.cos(rot), sn = Math.sin(rot), V = (dx, dy, dz) => new THREE.Vector3(x + dx * cs - dz * sn, y + dy, z + dx * sn + dz * cs);
    const hx = sx / 2, hz = sz / 2, top = new THREE.Color(col).multiplyScalar(1.08);
    const p = [V(-hx, 0, -hz), V(hx, 0, -hz), V(hx, 0, hz), V(-hx, 0, hz), V(-hx, sy, -hz), V(hx, sy, -hz), V(hx, sy, hz), V(-hx, sy, hz)];
    this.quad(p[4], p[7], p[6], p[5], top); this.quad(p[0], p[1], p[5], p[4], col); this.quad(p[1], p[2], p[6], p[5], col); this.quad(p[2], p[3], p[7], p[6], col); this.quad(p[3], p[0], p[4], p[7], col);
  }
  // Mangalore tile gable (rf 1) or a single-slope metal sheet (rf 2) over the footprint's oriented rectangle
  slopedRoof(b, h, seed) {
    const p = b.p, n = p.length / 2; let best = 0, ang = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n, L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]); if (L > best) { best = L; ang = Math.atan2(p[j * 2 + 1] - p[i * 2 + 1], p[j * 2] - p[i * 2]); } }
    const cs = Math.cos(ang), sn = Math.sin(ang); let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) { const x = p[i * 2], z = p[i * 2 + 1], u = x * cs + z * sn, v = -x * sn + z * cs; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const W = (u, v, y) => new THREE.Vector3(u * cs - v * sn, y, u * sn + v * cs), o = 0.35;
    u0 -= o; u1 += o; v0 -= o; v1 += o;
    if (b.rf === 1) {
      const vm = (v0 + v1) / 2, rise = Math.min(2.6, (v1 - v0) * 0.36);
      const tile = new THREE.Color().setHSL(0.03 + seed * 0.02, 0.62, 0.30 + seed * 0.08);
      this.quad(W(u0, v0, h), W(u1, v0, h), W(u1, vm, h + rise), W(u0, vm, h + rise), tile);
      this.quad(W(u1, v1, h), W(u0, v1, h), W(u0, vm, h + rise), W(u1, vm, h + rise), tile.clone().multiplyScalar(0.82));
      const gab = new THREE.Color('#d9cdb2');
      this.tri(W(u0, v0, h), W(u0, vm, h + rise), W(u0, v1, h), gab); this.tri(W(u1, v1, h), W(u1, vm, h + rise), W(u1, v0, h), gab);
    } else {
      const sheet = new THREE.Color(seed < 0.5 ? '#5d7184' : '#7a4a35'), rise = 1.2;
      this.quad(W(u0, v0, h + rise), W(u1, v0, h + rise), W(u1, v1, h), W(u0, v1, h), sheet);
    }
  }
  // stepped temple tower with a kalasha and lamps
  gopuram(x, z, h, size) {
    const s = Math.max(4, Math.min(12, size * 0.6));
    const tiers = 4; let y = h;
    for (let i = 0; i < tiers; i++) {
      const k = 1 - i * 0.2, th = 2.1;
      this.box(x, y, z, s * k, th, s * k, 0, new THREE.Color(i % 2 ? '#e8b85c' : '#f1e3c4'));
      y += th;
      for (let a = 0; a < 6; a++) this.festive.push(x + Math.cos(a) * s * k * 0.55, y - 0.2, z + Math.sin(a) * s * k * 0.55, 1, 0.62, 0.25);
    }
    this.box(x, y, z, 0.8, 1.6, 0.8, 0, new THREE.Color('#d9a11c'));
  }
  shelters(city) {
    const stops = city.stops || [];
    for (let i = 0; i < stops.length; i += 2) {
      const x = stops[i], z = stops[i + 1];
      // face the nearest road
      let best = Infinity, rot = 0;
      for (const r of this.roadLines || []) for (let k = 1; k < r.pts.length; k++) { const [ax, az] = r.pts[k - 1], [bx, bz] = r.pts[k]; const d = Math.hypot((ax + bx) / 2 - x, (az + bz) / 2 - z); if (d < best) { best = d; rot = Math.atan2(bz - az, bx - ax); } }
      const steel = new THREE.Color('#8f979e'), roof = new THREE.Color('#2d5e8c');
      this.box(x, 2.6, z, 5.2, 0.18, 2.0, rot, roof);
      this.box(x, 0, z, 5.0, 2.6, 0.12, rot, steel);
      this.box(x, 0.45, z, 4.4, 0.1, 0.7, rot, new THREE.Color('#5d6066'));
      this.festive.push(x, 2.45, z, 0.85, 0.95, 1);
    }
  }
  waterways(city) {
    const pos = [], zs = [], idx = [];
    for (const wv of city.waterways || []) {
      const p = wv.p, n = p.length / 2; if (n < 2) continue; const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const a = [p[Math.max(0, i - 1) * 2], p[Math.max(0, i - 1) * 2 + 1]], b2 = [p[Math.min(n - 1, i + 1) * 2], p[Math.min(n - 1, i + 1) * 2 + 1]];
        let dx = b2[0] - a[0], dz = b2[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        pos.push(p[i * 2] - dz * wv.w / 2, 0.07, p[i * 2 + 1] + dx * wv.w / 2, p[i * 2] + dz * wv.w / 2, 0.07, p[i * 2 + 1] - dx * wv.w / 2); zs.push(5, 5);
        if (i > 0) { const v = base + (i - 1) * 2; idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aZone', new THREE.Float32BufferAttribute(zs, 1)); g.setIndex(idx);
    const m = zoneMat(); this.mats.push(m); this.world.add(new THREE.Mesh(g, m));
  }
  // Diwali-season string lights on a few houses: coloured bulbs along the parapet
  stringLights() {
    let s = 5; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const palette = [[1, 0.25, 0.2], [0.25, 1, 0.35], [0.3, 0.5, 1], [1, 0.85, 0.2], [1, 0.35, 0.9], [1, 1, 1]];
    for (const f of this.footprints) {
      if (f.b.t > 2 || rnd() > 0.07) continue;
      const p = f.b.p, n = p.length / 2, y = (f.roofH || f.h) + 0.6, mono = rnd() < 0.4 ? palette[Math.floor(rnd() * 6)] : null;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, L = Math.hypot(p[j * 2] - p[i * 2], p[j * 2 + 1] - p[i * 2 + 1]);
        for (let t = 0; t < L; t += 0.9) { const k = t / L, c3 = mono || palette[Math.floor(rnd() * 6)]; this.festive.push(p[i * 2] + (p[j * 2] - p[i * 2]) * k, y - Math.sin(k * Math.PI) * 0.35, p[i * 2 + 1] + (p[j * 2 + 1] - p[i * 2 + 1]) * k, c3[0], c3[1], c3[2]); }
      }
    }
  }
  flushExtras() {
    const e = this.ex;
    if (e.pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(e.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(e.nor, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(e.col, 3));
      this.world.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    }
    if (this.festive.length) {
      const pos = [], col = []; for (let i = 0; i < this.festive.length; i += 6) { pos.push(this.festive[i], this.festive[i + 1], this.festive[i + 2]); col.push(this.festive[i + 3] * 2.6, this.festive[i + 4] * 2.6, this.festive[i + 5] * 2.6); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.festivePts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.1, vertexColors: true, map: glowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.world.add(this.festivePts);
    }
  }

  roads(city) {
    const pos = [], uv = [], ar = [], idx = [];
    this.roadLines = [];
    const sorted = [...city.roads].sort((a, b) => a.r - b.r);
    for (const r of sorted) {
      const p = r.p, n = p.length / 2; if (n < 2) continue;
      const y = 0.08 + r.r * 0.01 + (r.f ? 0.002 : 0);
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
      if (!r.f) this.roadLines.push({ pts, w: r.w, rank: r.r, len: along, oneway: r.o });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aRoad', new THREE.Float32BufferAttribute(ar, 3));
    g.setIndex(idx);
    const m = roadMat(); this.mats.push(m);
    const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 1; this.world.add(mesh);
  }

  // black Sintex water tanks and stair headrooms on the flat roofs, as on almost every Indian house
  roofProps(city) {
    const tanks = [], heads = [];
    let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const f of this.footprints) {
      const b = f.b; if (b.t > 2) continue;
      const p = b.p; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      if (x1 - x0 < 5 || z1 - z0 < 5) continue;
      const jitter = (a, c) => a + (c - a) * (0.3 + rnd() * 0.4);
      if (b.rf) continue;
      // the tank always sits on something: on the set-back room if there is one, else on top of a stair headroom
      if (f.roofH != null) { if (b.tank) tanks.push(f.cx, f.h, f.cz, 0.75 + rnd() * 0.35); continue; }
      const hx = jitter(x0, x1), hz = jitter(z0, z1);
      if (b.tank || rnd() < (b.t === 1 ? 0.9 : 0.55)) heads.push(hx, f.h, hz, rnd() * Math.PI);
      if (b.tank) tanks.push(hx, f.h + 2.5, hz, 0.75 + rnd() * 0.35);
    }
    const tankMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1.5, 14), new THREE.MeshLambertMaterial({ color: '#34363a' }), tanks.length / 4);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < tanks.length / 4; i++) { const r = tanks[i * 4 + 3]; m4.compose(new THREE.Vector3(tanks[i * 4], tanks[i * 4 + 1] + 0.75, tanks[i * 4 + 2]), q, new THREE.Vector3(r, 1, r)); tankMesh.setMatrixAt(i, m4); }
    const headMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.8, 2.5, 3.2), new THREE.MeshLambertMaterial({ color: '#8a857b' }), heads.length / 4);
    for (let i = 0; i < heads.length / 4; i++) { q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heads[i * 4 + 3]); m4.compose(new THREE.Vector3(heads[i * 4], heads[i * 4 + 1] + 1.25, heads[i * 4 + 2]), q, new THREE.Vector3(1, 1, 1)); headMesh.setMatrixAt(i, m4); }
    // the tanks sit on a little stand above the headroom
    this.world.add(tankMesh, headMesh);
    this.scene.add(this.dusk || (this.dusk = this.duskLights()));
  }
  duskLights() {
    const g = new THREE.Group();
    this.sunLight = new THREE.DirectionalLight(new THREE.Color(1, 0.62, 0.38), 1); this.sunLight.position.copy(SUN).multiplyScalar(100);
    this.hemi = new THREE.HemisphereLight(new THREE.Color(0.30, 0.36, 0.55), new THREE.Color(0.20, 0.15, 0.12), 1);
    g.add(this.sunLight, this.hemi);
    return g;
  }

  // ---------- time of day ----------
  setHour(h) { this.tod.mode = 'manual'; this.tod.hour = ((h % 24) + 24) % 24; }
  setLive() { this.tod.mode = 'live'; this.tod.hour = clockHour(); }
  playDay(seconds = 60) { this.tod.mode = 'play'; this.tod.dayLength = seconds; }
  get hour() { return this.tod.hour; }

  applyTime(h) {
    const p = palette(h);
    const day = smooth(5.3, 7.0, h) * (1 - smooth(17.4, 19.3, h)), night = 1 - day;
    // the sun rises in the east (+x), passes high and a little south (+z) at noon, sets in the west;
    // after dark the light comes from the moon instead
    const ph = (h - 6.1) / 12.3;
    const sun = new THREE.Vector3(Math.cos(ph * Math.PI), Math.max(Math.sin(ph * Math.PI), 0.18), 0.3).normalize();
    const moonK = Math.min(1, 1 - smooth(4.8, 6.0, h) + smooth(18.8, 19.8, h));
    SUN.copy(sun.lerp(new THREE.Vector3(0.35, 0.75, -0.3).normalize(), moonK)).normalize();
    ENV.uSunCol.value.set(...p.sun); ENV.uSkyCol.value.set(...p.sky); ENV.uBounce.value.set(...p.bounce);
    ENV.uNight.value = night;
    ENV.uOcc.value = curve(OCC_KEYS, h);
    ENV.uShop.value = curve(SHOP_KEYS, h);
    ENV.uLamp.value = smooth(0.35, 0.6, night);
    FOG.copy(p.fog); this.scene.background.copy(FOG); this.scene.fog.color.copy(FOG);
    if (this.skyMat) {
      const u = this.skyMat.uniforms, m = Math.max(...p.sun, 0.001);
      u.uTop.value.set(...p.top); u.uMid.value.set(...p.mid); u.uHor.value.set(...p.hor);
      u.uGlowCol.value.set(p.sun[0] / m, p.sun[1] / m * 0.85, p.sun[2] / m * 0.7); u.uStars.value = p.stars;
    }
    // the plain three.js materials (trees, tanks, cars, roofs) get the same light through these two
    if (this.sunLight) { this.sunLight.color.setRGB(p.sun[0] * 1.06, p.sun[1] * 1.06, p.sun[2] * 1.06); this.sunLight.position.copy(SUN).multiplyScalar(100); }
    if (this.hemi) { this.hemi.color.setRGB(p.sky[0] * 1.63, p.sky[1] * 1.63, p.sky[2] * 1.63); this.hemi.groundColor.setRGB(p.bounce[0] * 2.5, p.bounce[1] * 2.5, p.bounce[2] * 2.5); }
    this.bloom.strength = p.bloom; this.bloom.threshold = 1.05 + 0.35 * day;
    if (this.lampHeads) this.lampHeads.material.opacity = ENV.uLamp.value;
    if (this.carLights) this.carLights.material.opacity = 0.15 + 0.85 * night;
    if (this.festivePts) this.festivePts.material.opacity = 0.1 + 0.9 * night;
    this.dens = curve(TRAFFIC_KEYS, h);
  }

  // street lamps: positions from the map, plus regular spacing along the roads the map hasn't covered
  lamps(city) {
    const spots = [];
    for (let i = 0; i < (city.lamps || []).length; i += 2) spots.push([city.lamps[i], city.lamps[i + 1], 1]);
    let s = 3; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const r of this.roadLines) {
      if (r.rank < 1) continue;
      const gap = r.rank >= 3 ? 30 : 42;
      let carry = rnd() * gap;
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
        for (let t = carry; t < L; t += gap) {
          const side = r.rank >= 3 ? (Math.floor(t / gap) % 2 ? 1 : -1) : 1, off = r.w / 2 - 0.6;
          spots.push([a[0] + dx * t - dz * off * side, a[1] + dz * t + dx * off * side, r.rank >= 2 ? 1 : rnd() < 0.3 ? 2 : 1]);
        }
        carry = ((carry - L) % gap + gap) % gap;
      }
    }
    const n = Math.min(spots.length, 5000);
    const poolG = new THREE.PlaneGeometry(1, 1); poolG.rotateX(-Math.PI / 2);
    const cols = new Float32Array(n * 3);
    const pools = new THREE.InstancedMesh(poolG, poolMat(), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    const heads = [], headCol = [];
    for (let i = 0; i < n; i++) {
      const [x, z, kind] = spots[i];
      const roll = (i * 0.618) % 1; const c = kind === 2 || roll < 0.2 ? [1, 0.58, 0.24] : roll < 0.3 ? [1, 0.95, 0.85] : [0.82, 0.9, 1];
      cols.set(c, i * 3);
      m4.compose(new THREE.Vector3(x, 0.2, z), q, new THREE.Vector3(24, 1, 24)); pools.setMatrixAt(i, m4);
      heads.push(x, 8.5, z); headCol.push(c[0] * 3, c[1] * 3, c[2] * 3);
    }
    pools.geometry.setAttribute('aCol', new THREE.InstancedBufferAttribute(cols, 3));
    pools.renderOrder = 2; this.mats.push(pools.material); this.world.add(pools);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(heads, 3));
    hg.setAttribute('color', new THREE.Float32BufferAttribute(headCol, 3));
    this.lampHeads = new THREE.Points(hg, new THREE.PointsMaterial({ size: 3, vertexColors: true, map: glowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.world.add(this.lampHeads);
  }

  trees(city) {
    const occ = new Set(), cell = 5, key = (x, z) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
    for (const f of this.footprints) {
      const p = f.b.p; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      for (let x = x0; x <= x1; x += cell) for (let z = z0; z <= z1; z += cell) occ.add(key(x, z));
    }
    const spots = [];
    for (let i = 0; i < (city.trees || []).length; i += 2) spots.push([city.trees[i], city.trees[i + 1], 1.2]);
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    // HSR's roads are lined with big rain trees and gulmohars
    for (const r of this.roadLines) {
      if (r.rank > 3) continue;
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 1) continue;
        const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
        for (let t = rnd() * 12; t < L; t += 11 + rnd() * 14) for (const side of [-1, 1]) {
          if (rnd() < (r.rank >= 2 ? 0.25 : 0.5)) continue;
          const off = r.w / 2 + 1.2 + rnd() * 1.4;
          const x = a[0] + dx * t - dz * off * side, z = a[1] + dz * t + dx * off * side;
          if (!occ.has(key(x, z)) && x * x + z * z < 780 * 780) spots.push([x, z, r.rank >= 2 ? 1.3 : 1]);
        }
      }
    }
    // parks get clusters of trees
    for (const zn of city.zones || []) {
      if (zn.z !== Z.PARK) continue;
      const p = zn.p; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); }
      const count = Math.min(60, ((x1 - x0) * (z1 - z0)) / 260);
      for (let i = 0; i < count; i++) { const x = x0 + rnd() * (x1 - x0), z = z0 + rnd() * (z1 - z0); if (!occ.has(key(x, z))) spots.push([x, z, 1.1 + rnd() * 0.5]); }
    }
    const n = Math.min(spots.length, 7000);
    // lumpy, faceted canopy instead of a smooth ball; each tree is spun randomly so the lumps differ
    const crownG = new THREE.IcosahedronGeometry(1, 2);
    const cp = crownG.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < cp.count; i++) {
      v.fromBufferAttribute(cp, i).normalize();
      const bump = 1 + 0.16 * Math.sin(v.x * 7.1 + v.z * 3.3) * Math.cos(v.y * 6.3 - v.x * 2.1) + 0.1 * Math.sin(v.z * 11 + v.y * 5);
      cp.setXYZ(i, v.x * bump, v.y * bump * (v.y < 0 ? 0.55 : 1), v.z * bump); // flatter underside
    }
    crownG.computeVertexNormals();
    const crown = new THREE.InstancedMesh(crownG, new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), n);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 1, 6), new THREE.MeshLambertMaterial({ color: '#3a2c22' }), n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    const greens = ['#3a6a30', '#4a7d34', '#2f5e2e', '#5a8538', '#40703a', '#62903e', '#557a2c'];
    for (let i = 0; i < n; i++) {
      const [x, z, k] = spots[i], r = (2.4 + rnd() * 2.6) * k, ht = 2.2 + rnd() * 2 * k;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      m4.compose(new THREE.Vector3(x, ht + r * 0.55, z), q, new THREE.Vector3(r, r * (0.62 + rnd() * 0.2), r)); crown.setMatrixAt(i, m4);
      const fl = rnd();
      crown.setColorAt(i, c.set(fl < 0.04 ? '#b8482a' : fl < 0.07 ? '#a87fb8' : fl < 0.09 ? '#c9a52e' : greens[Math.floor(rnd() * greens.length)])); // a few gulmohar, jacaranda and copper-pod trees in flower
      q.identity(); m4.compose(new THREE.Vector3(x, ht / 2, z), q, new THREE.Vector3(1, ht, 1)); trunk.setMatrixAt(i, m4);
    }
    this.world.add(crown, trunk);
  }

  // traffic: busy on the main roads, a scooter now and then on the lanes. Cars, autos, bikes, buses.
  traffic(city) {
    const kinds = [
      { name: 'car', size: [4.3, 1.5, 1.8], cols: ['#e8e8e8', '#b9bcc0', '#2b2d31', '#7a1e1e', '#1f3d6b', '#d9d4c7'] },
      { name: 'auto', size: [2.9, 1.8, 1.4], cols: ['#b6c62a', '#d7b31c'] },
      { name: 'bike', size: [1.9, 1.3, 0.6], cols: ['#202020', '#5a5a5a', '#8a1d1d', '#1d3c8a'] },
      { name: 'bus', size: [11, 3.1, 2.5], cols: ['#3a5fa8', '#c8392b'] },
    ];
    const lanes = [];
    for (const r of this.roadLines) {
      if (r.len < 50) continue;
      const cum = [0]; for (let i = 1; i < r.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
      const spacing = { 5: 12, 4: 15, 3: 22, 2: 42, 1: 260, 0: 900 }[r.rank] ?? 400;
      const count = Math.floor(r.len / spacing);
      for (let c = 0; c < count; c++) for (const dir of r.oneway ? [1] : [1, -1]) {
        const roll = Math.random();
        const k = r.rank <= 1 ? (roll < 0.75 ? 2 : 0) : r.rank >= 4 && roll < 0.05 ? 3 : roll < 0.42 ? 2 : roll < 0.62 ? 1 : 0;
        lanes.push({ r, cum, q: Math.random(), d: Math.random() * r.len, v: (r.rank >= 4 ? 9 : r.rank >= 2 ? 7 : 5) + Math.random() * 4, dir, off: (r.w * (r.oneway ? 0.1 : 0.24) + (k === 2 ? 0.8 : 0)) * dir * (Math.random() < 0.5 ? 1 : 0.7), k });
      }
    }
    this.cars = lanes.slice(0, 2400);
    this.vehMeshes = kinds.map((kd, ki) => {
      const list = this.cars.filter((c) => c.k === ki);
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(...kd.size), new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, list.length));
      const c = new THREE.Color(); list.forEach((v, i) => { v.idx = i; mesh.setColorAt(i, c.set(kd.cols[Math.floor(Math.random() * kd.cols.length)])); });
      mesh.count = list.length; mesh.userData.h = kd.size[1]; this.world.add(mesh); return mesh;
    });
    this.carLen = kinds.map((k) => k.size[0]);
    const n = this.cars.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    const col = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) { col.set([2.4, 2.3, 2.1], i * 6); col.set([2.4, 0.15, 0.1], i * 6 + 3); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.carLights = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.4, map: glowTex(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.world.add(this.carLights);
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._up = new THREE.Vector3(0, 1, 0);
  }

  stepTraffic(dt) {
    if (!this.cars) return;
    const lp = this.carLights.geometry.attributes.position.array, m4 = this._m4, q = this._q, v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
    // how many vehicles are out depends on the hour; at rush hour the busy roads also crawl
    const dens = this.dens, crawl = 1 - 0.5 * smooth(0.75, 1, dens), zero = new THREE.Vector3(0, 0, 0);
    this.cars.forEach((c, i) => {
      if (c.q > dens) {
        m4.compose(v3.set(0, -50, 0), q, zero); this.vehMeshes[c.k].setMatrixAt(c.idx, m4);
        lp[i * 6 + 1] = lp[i * 6 + 4] = -50; return;
      }
      const v = c.r.rank >= 3 ? c.v * crawl : c.v;
      c.d = (c.d + v * dt * c.dir + c.r.len) % c.r.len;
      const cum = c.cum; let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= c.d) lo = mid; else hi = mid; }
      const p0 = c.r.pts[lo], p1 = c.r.pts[hi], seg = cum[hi] - cum[lo] || 1, t = (c.d - cum[lo]) / seg;
      const dx = ((p1[0] - p0[0]) / seg) * c.dir, dz = ((p1[1] - p0[1]) / seg) * c.dir;
      const x = p0[0] + (p1[0] - p0[0]) * t - dz * c.off * c.dir, z = p0[1] + (p1[1] - p0[1]) * t + dx * c.off * c.dir;
      const mesh = this.vehMeshes[c.k], hh = mesh.userData.h;
      q.setFromAxisAngle(this._up, Math.atan2(-dz, dx));
      m4.compose(v3.set(x, hh / 2 + 0.15, z), q, one); mesh.setMatrixAt(c.idx, m4);
      const half = this.carLen[c.k] / 2;
      lp[i * 6] = x + dx * half; lp[i * 6 + 1] = 0.9; lp[i * 6 + 2] = z + dz * half;
      lp[i * 6 + 3] = x - dx * half; lp[i * 6 + 4] = 0.9; lp[i * 6 + 5] = z - dz * half;
    });
    this.vehMeshes.forEach((m) => (m.instanceMatrix.needsUpdate = true));
    this.carLights.geometry.attributes.position.needsUpdate = true;
  }

  beacon(H) {
    const beamGeo = new THREE.CylinderGeometry(0.5, 1.6, 150, 24, 1, true); beamGeo.translate(0, 75, 0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uTime: { value: 0 } },
      // soft edges (facing ratio) and a quick fade upwards, so it reads as a shaft of light, not a slab
      vertexShader: 'varying vec2 vUv; varying float vF; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.); vF = abs(dot(normalize(normalMatrix * normal), normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform float uTime; varying vec2 vUv; varying float vF; void main(){ float a = pow(1. - vUv.y, 3.5) * pow(vF, 2.5) * (.55 + .15 * sin(uTime * 2.)); gl_FragColor = vec4(vec3(1.4,.8,.25) * a, a); }',
    }));
    this.beam.position.set(H.x, this.homeH, H.z); this.fx.add(this.beam);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.3, 0.35), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.set(H.x, this.homeH + 0.6, H.z); this.fx.add(this.ring);
  }

  // ---------- door path ----------
  setPath(points) {
    if (this.pathMesh) { this.fx.remove(this.pathMesh); this.pathMesh = null; }
    this.stops = points.map((p) => this.local(p.lat, p.lng));
    if (this.stops.length < 2) return;
    const pts = this.stops.map((v) => new THREE.Vector3(v.x, 3.2, v.z));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.2);
    const g = new THREE.TubeGeometry(curve, Math.max(60, pts.length * 40), 1.6, 10, false);
    this.pathMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uTime: { value: 0 }, uProg: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
      fragmentShader: `uniform float uTime; uniform float uProg; varying vec2 vUv; void main(){
        float done = step(vUv.x, uProg); float flow = pow(fract(vUv.x * 14. - uTime * .9), 6.);
        vec3 c = vec3(1.5,.8,.22) * (.45 + flow * 1.2) + done * vec3(1.8,1.1,.4) * 1.1; gl_FragColor = vec4(c, .75); }`,
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
      this.rider = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 2.2, 4.5) }));
      this.riderHalo = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.4, 3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      this.riderHalo.rotation.x = -Math.PI / 2; this.fx.add(this.riderHalo);
      this.rider.position.copy(to).add(new THREE.Vector3(0, 120, 0)); this.fx.add(this.rider);
      this.trail = []; const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(60 * 3), 3));
      this.trailLine = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: new THREE.Color(0.6, 1.6, 3.2), transparent: true, opacity: 0.8 })); this.fx.add(this.trailLine);
    }
    this.riderFrom = this.rider.position.clone(); this.riderTo = to; this.riderT = 0;
    return to;
  }

  // ---------- camera ----------
  look(target, dist, polar = 0.95, az = null, dur = 2.2) {
    const t = target.clone ? target.clone() : new THREE.Vector3(target.x, 0, target.z);
    const s0 = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.tween = { t: 0, dur, from: this.controls.target.clone(), to: t, s0, s1: new THREE.Spherical(dist, polar, az ?? s0.theta) };
  }
  project(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1) return null;
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05), t = this.clock.getElapsedTime();
    if (this.tod.mode === 'live') this.tod.hour = clockHour();
    else if (this.tod.mode === 'play') this.tod.hour = (this.tod.hour + (dt * 24) / this.tod.dayLength) % 24;
    this.applyTime(this.tod.hour);
    for (const m of this.mats) if (m.uniforms?.uTime) m.uniforms.uTime.value = t;
    if (this.bmat && this.rise0 != null) this.bmat.uniforms.uRise.value = t - this.rise0;
    this.stepTraffic(dt);
    if (this.beam) this.beam.material.uniforms.uTime.value = t;
    if (this.ring) { const ph = (t * (this.expecting ? 0.6 : 0.4)) % 1; this.ring.scale.setScalar(6 + ph * (this.expecting ? 42 : 24)); this.ring.material.opacity = (1 - ph) * (this.expecting ? 0.55 : 0.35); }
    if (this.homeOutline) this.homeOutline.material.opacity = 0.7 + 0.3 * Math.sin(t * 3);
    if (this.pathMat) {
      this.pathMat.uniforms.uTime.value = t;
      if (this.progT != null && this.progT < 1) { this.progT = Math.min(1, this.progT + dt / 1.6); this.pathMat.uniforms.uProg.value = this.progFrom + (this.progTo - this.progFrom) * ease(this.progT); }
    }
    if (this.rider) {
      if (this.riderT < 1) { this.riderT = Math.min(1, this.riderT + dt / 1.8); const k = ease(this.riderT); this.rider.position.lerpVectors(this.riderFrom, this.riderTo, k); this.rider.position.y = 4 + Math.sin(k * Math.PI) * (this.riderFrom.distanceTo(this.riderTo) > 60 ? 26 : 4); }
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

function clockHour() { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; }

let _glow;
function glowTex() {
  if (_glow) return _glow;
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.22, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return (_glow = new THREE.CanvasTexture(c));
}
