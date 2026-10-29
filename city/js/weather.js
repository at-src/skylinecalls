import * as THREE from 'three/webgpu';
import { cityUniforms } from './tsl-materials.js';

// js/weather.js
// Rain over the map: the light dims and greys, the haze closes in, clouds fill the sky, the roads go wet and shiny,
// rain streaks fall over the part of the city in view and lightning flashes now and then. Laid over the time-of-day
// preset (js/lighting.js) without re-baking its environment map: the preset's values are kept and scaled.

const DROPS = 26000;
const BOX = [520, 220, 520]; // m around the point the camera looks at
const FALL = 24; // m/s (streaks seen from far: faster and longer than real drops, or they don't read)
const STREAK = 3.2; // m
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

class Weather {
  constructor(scene, lightingSystem) {
    this.scene = scene;
    this.lighting = lightingSystem;
    this.target = 0;
    this.storm = 0; // 0 clear .. 1 full rain
    this.lightning = true; // flashes in heavy rain
    this.flash = 0;
    this.nextStrike = 6;
    this.flickers = [];
    this.base = null;
    this.basePreset = null;
    this.random = Math.random;
    // the rain: streaks (line segments) in a box that wraps around the point in view
    this.offsets = new Float32Array(DROPS * 3);
    for (let i = 0; i < DROPS; i++) {
      this.offsets[i * 3] = this.random() * BOX[0];
      this.offsets[i * 3 + 1] = this.random() * BOX[1];
      this.offsets[i * 3 + 2] = this.random() * BOX[2];
    }
    const geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(DROPS * 6);
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicNodeMaterial({ color: 0xc9d3dc, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(geometry, this.material);
    this.rain.name = 'Rain';
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.rain.castShadow = this.rain.receiveShadow = false;
    scene.add(this.rain);
  }

  get raining() {
    return this.target > 0;
  }

  // `amount` 0..1 (drizzle to downpour); `immediate`: already raining, no build-up
  setRain(amount, immediate = false) {
    this.target = clamp(amount);
    if (immediate) this.storm = this.target;
    if (this.target > 0) this.nextStrike = 3 + this.random() * 4;
  }

  // The preset's own values, captured whenever the preset changes (applyPreset has just set them)
  captureBase() {
    const L = this.lighting;
    this.basePreset = L.activePresetId;
    this.base = {
      sun: L.sunLight.intensity,
      hemi: L.hemiLight.intensity,
      fog: L.uFogDensity ? L.uFogDensity.value : this.scene.fog?.density ?? 0,
      env: this.scene.environmentIntensity ?? 1,
      wet: cityUniforms.uRoadWetness.value,
      clouds: L.sky?.cloudCoverage?.value ?? 0,
      cloudDensity: L.sky?.cloudDensity?.value ?? 0
    };
  }

  update(dt, centre) {
    if (!this.base || this.basePreset !== this.lighting.activePresetId) this.captureBase();
    // the rain rolls in over ~8 s and clears over ~12 s
    this.storm += clamp(this.target - this.storm, -dt / 12, dt / 8);
    const s = this.storm;
    // lightning in heavy rain: a strike every few seconds, as one to three quick flickers
    if (this.lightning && s > 0.6) {
      this.nextStrike -= dt;
      if (this.nextStrike <= 0) {
        const distance = 300 + this.random() ** 1.5 * 7000;
        const bright = 0.35 + 0.65 * (1 - distance / 7300);
        const n = 1 + Math.floor(this.random() * 3);
        for (let k = 0; k < n; k++) this.flickers.push({ at: k * (0.07 + this.random() * 0.12), life: 0.06 + this.random() * 0.08, bright: bright * (k ? 0.6 : 1) });
        this.nextStrike = 4 + this.random() * 11;
      }
    }
    let flash = 0;
    for (let i = this.flickers.length - 1; i >= 0; i--) {
      const f = this.flickers[i];
      f.at -= dt;
      if (f.at > 0) continue;
      f.life -= dt;
      if (f.life <= 0) this.flickers.splice(i, 1);
      else flash = Math.max(flash, f.bright);
    }
    this.flash = flash;
    // (once more when it has cleared, to put the preset's values back)
    if (s > 0 || this.applied) {
      this.applied = s > 0;
      const B = this.base;
      const L = this.lighting;
      L.sunLight.intensity = B.sun * (1 - 0.82 * s);
      L.hemiLight.intensity = B.hemi * (1 - 0.35 * s) + flash * 7;
      this.scene.environmentIntensity = B.env * (1 - 0.45 * s) + flash * 1.5;
      if (L.uFogDensity) L.uFogDensity.value = B.fog * (1 + 2.2 * s) + 0.0005 * s;
      cityUniforms.uRoadWetness.value = Math.max(B.wet, 0.95 * s);
      if (L.sky?.cloudCoverage) L.sky.cloudCoverage.value = B.clouds + (0.95 - B.clouds) * s;
      if (L.sky?.cloudDensity) L.sky.cloudDensity.value = B.cloudDensity + (0.9 - B.cloudDensity) * s;
    }
    // rain streaks over the part of the city in view
    const visible = s > 0.02;
    this.rain.visible = visible;
    if (!visible) return;
    this.material.opacity = 0.42 * clamp((s - 0.1) / 0.6);
    const o = this.offsets;
    const p = this.positions;
    const fall = FALL * dt;
    const x0 = centre.x - BOX[0] / 2, z0 = centre.z - BOX[2] / 2;
    const wrap = (v, m) => ((v % m) + m) % m;
    // the fewer drops falling, the lighter the rain
    const n = Math.round(DROPS * clamp(0.25 + s * 0.75));
    for (let i = 0; i < DROPS; i++) {
      let y = o[i * 3 + 1] - fall;
      if (y < 0) y += BOX[1];
      o[i * 3 + 1] = y;
      // the box stays put in the world as the view moves (so the rain doesn't travel with it)
      const x = x0 + wrap(o[i * 3] - x0, BOX[0]);
      const z = z0 + wrap(o[i * 3 + 2] - z0, BOX[2]);
      const wy = i < n ? y : -1000;
      p[i * 6] = x; p[i * 6 + 1] = wy; p[i * 6 + 2] = z;
      p[i * 6 + 3] = x + 0.15; p[i * 6 + 4] = wy - STREAK; p[i * 6 + 5] = z + 0.1;
    }
    this.rain.geometry.attributes.position.needsUpdate = true;
  }
}

export { Weather };
