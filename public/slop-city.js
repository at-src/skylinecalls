// The 3D city of the dashboard when the home is inside a pre-built city (city/, served at /map3d/): the renderer runs
// in an iframe and is driven by postMessage (city/js/ttd-bridge.js). This class has the same surface app.js uses on
// the in-page City (city3d.js), so the rest of the dashboard doesn't know which one it has: local(), build(),
// setPath(), setProgress(), placeRider(), look(), project(), home, homeH, camera, controls, expecting, time of day.
import * as THREE from 'three';

// the pre-built cities: [south, west, north, east]
export const PREBUILT = [{ id: 'bengaluru', box: [12.902, 77.626, 12.924, 77.65] }];
export const prebuiltFor = (lat, lng) => PREBUILT.find(({ box: [s, w, n, e] }) => lat > s && lat < n && lng > w && lng < e) || null;

const A = 6378137.0, E2 = 6.69437999014e-3;
const clockHour = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600; };

export class SlopCity {
  constructor(host, cityId) {
    this.host = host;
    this.onFrame = [];
    this.camera = new THREE.PerspectiveCamera(38, 1, 1, 60000);
    this.camera.position.set(-180, 330, 360);
    const target = new THREE.Vector3();
    const self = this;
    this.controls = { target, get autoRotate() { return self._auto ?? true; }, set autoRotate(v) { self._auto = v; self.send({ type: 'autoRotate', on: v }); } };
    this.rider = null;
    this.home = null;
    this.homeH = 12;
    this._expecting = false;
    this.tod = { mode: 'live', hour: clockHour(), dayLength: 60 };
    this._lastPreset = null;
    this.queue = [];
    this.frame = null;
    this.ready = new Promise((r) => (this._resolveReady = r));
    this.rendered = new Promise((r) => (this._resolveRendered = r));
    this.iframe = document.createElement('iframe');
    this.iframe.className = 'map3d';
    this.iframe.title = '3D map of the neighbourhood';
    this.iframe.src = `/map3d/?city=${cityId}`;
    this.iframe.allow = 'autoplay';
    host.appendChild(this.iframe);
    this._onMsg = (e) => this.onMessage(e);
    window.addEventListener('message', this._onMsg);
    this._last = performance.now();
  }

  destroy() { window.removeEventListener('message', this._onMsg); this.iframe.remove(); }

  send(m) {
    if (!this.frame) { this.queue.push(m); return; }
    this.iframe.contentWindow.postMessage({ ttd: true, ...m }, '*');
  }

  onMessage(e) {
    const m = e.data;
    if (!m || !m.ttd || e.source !== this.iframe.contentWindow) return;
    if (m.type === 'ready') {
      const F = m.frame, phi = (F.lat0 * Math.PI) / 180, s = Math.sin(phi);
      this.frame = { ...F, KX: (Math.PI / 180) * (A / Math.sqrt(1 - E2 * s * s)) * Math.cos(phi), KY: (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5)), th: (F.bearingDeg * Math.PI) / 180 };
      const q = this.queue; this.queue = [];
      q.forEach((x) => this.send(x));
      this.applyTime(true);
      this._resolveReady();
    } else if (m.type === 'rendered') this._resolveRendered();
    else if (m.type === 'highlighted') { const r = this._marks?.get(m.id); if (r) { this._marks.delete(m.id); r(new THREE.Vector3(m.x, (m.h || 0) + 6, m.z)); } }
    else if (m.type === 'homeH') this.homeH = m.h;
    else if (m.type === 'cam') {
      this.camera.position.fromArray(m.p);
      this.controls.target.fromArray(m.t);
      this.camera.fov = m.fov;
      this.camera.aspect = m.aspect;
      if (m.rider) { this.rider = this.rider || { position: new THREE.Vector3() }; this.rider.position.fromArray(m.rider); }
      this.tick();
    }
  }

  // The home's real sun (from /api/weather): its local time zone and today's sunrise and sunset. Live mode shows the
  // home's own local time, and the city's lighting follows the real sun rather than a fixed 6 am / 6 pm.
  setSun({ sunrise, sunset, utcOffset } = {}) {
    if (Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise) this.sun = { rise: sunrise, set: sunset };
    if (Number.isFinite(utcOffset)) this.utcOffset = utcOffset;
    this.applyTime(true);
  }
  localHour() {
    if (!Number.isFinite(this.utcOffset)) return clockHour();
    const d = new Date(Date.now() + this.utcOffset * 1000);
    return d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  }
  // a local hour -> the city's day, where sunrise is 6:15 and sunset 18:15 (what its lighting and street lights are set
  // to): stretched piecewise so dawn, noon and dusk land where the real sun has them today
  solar(h) {
    if (!this.sun) return h;
    const { rise, set } = this.sun, noon = (rise + set) / 2;
    const seg = (x, a, b, c, d) => c + ((x - a) / (b - a)) * (d - c);
    if (h < rise) return seg(h, rise - 6.25 * (rise / 6.25), rise, 0, 6.25);
    if (h < noon) return seg(h, rise, noon, 6.25, 12.25);
    if (h < set) return seg(h, noon, set, 12.25, 18.25);
    return seg(h, set, 24, 18.25, 24);
  }

  // the dashboard's clock: live, a fixed hour, or a day played in a minute; the city shows the nearest lighting preset
  tick() {
    const now = performance.now(), dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (this.tod.mode === 'live') this.tod.hour = this.localHour();
    else if (this.tod.mode === 'play') this.tod.hour = (this.tod.hour + (dt * 24) / this.tod.dayLength) % 24;
    this.applyTime();
    const t = now / 1000;
    this.onFrame.forEach((f) => f(t));
  }
  applyTime(force) {
    const key = Math.round(this.tod.hour * 4);
    if (!force && key === this._lastPreset) return;
    this._lastPreset = key;
    this.send({ type: 'hour', hour: this.solar(this.tod.hour) });
  }
  // rain over the map, 0 (dry) .. 1 (downpour)
  setRain(amount) { this.rain = amount; this.send({ type: 'rain', amount }); }
  setHour(h) { this.tod.mode = 'manual'; this.tod.hour = ((h % 24) + 24) % 24; this.applyTime(true); }
  setLive() { this.tod.mode = 'live'; this.tod.hour = this.localHour(); this.applyTime(true); }
  playDay(seconds = 60) { this.tod.mode = 'play'; this.tod.dayLength = seconds; }
  get hour() { return this.tod.hour; }

  set expecting(on) { this._expecting = on; this.send({ type: 'expecting', on }); }
  get expecting() { return this._expecting; }

  // lat/lng -> the city's world frame (x grid east, z grid south), as city/tools/city/frame.mjs
  local(lat, lng) {
    const F = this.frame;
    const e = (lng - F.lon0) * F.KX, n = (lat - F.lat0) * F.KY, c = Math.cos(F.th), s = Math.sin(F.th);
    return new THREE.Vector3(e * c - n * s, 0, -(e * s + n * c));
  }

  async build(_data, home) {
    await this.ready;
    this.home = this.local(home.lat, home.lng);
    this.send({ type: 'home', x: this.home.x, z: this.home.z });
    this._arrive = true;
    // keep the dashboard's veil up until the city is on screen (and the home's height is known, for the pins)
    await this.rendered;
    await new Promise((r) => setTimeout(r, 60));
  }
  setPath(points) { this.send({ type: 'path', pts: points.map((p) => { const v = this.local(p.lat, p.lng); return [v.x, v.z]; }) }); }
  // light up what the conversation points at: kind 'seen' (where the caller is), 'target' (where he's sent next),
  // 'taught' (a stop the customer just described). Resolves with the spot's top, for a pin.
  highlight(lat, lng, kind = 'seen') {
    const v = this.local(lat, lng), id = Math.random().toString(36).slice(2, 8);
    this.send({ type: 'highlight', x: v.x, z: v.z, kind, id });
    return new Promise((res) => { (this._marks ||= new Map()).set(id, res); setTimeout(() => { if (this._marks.has(id)) { this._marks.delete(id); res(new THREE.Vector3(v.x, 12, v.z)); } }, 1500); });
  }
  clearHighlights() { this.send({ type: 'clearHighlights' }); }
  setProgress(step) { this.send({ type: 'progress', step }); }
  placeRider(lat, lng) {
    const v = this.local(lat, lng); v.y = 4;
    this.rider = this.rider || { position: v.clone().add(new THREE.Vector3(0, 120, 0)) };
    this.send({ type: 'rider', x: v.x, z: v.z });
    return v;
  }
  look(target, dist, polar = 0.95, az = null, dur = 2.2) {
    // app.js sets the camera and target just before the arrival move: start the move from there
    if (this._arrive) { this._arrive = false; this.send({ type: 'jump', pos: this.camera.position.toArray(), target: this.controls.target.toArray() }); }
    this.send({ type: 'look', x: target.x, z: target.z, dist, polar, az, dur });
  }
  project(v) {
    const cam = this.camera;
    cam.lookAt(this.controls.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const p = v.clone().project(cam);
    if (p.z > 1 || p.z < -1) return null;
    const r = this.iframe.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height };
  }
}
