// ToTheDoor live screen: Google Photorealistic 3D Tiles in CesiumJS + the live call.
// Everything on the map is driven by server events: where the agent believes the rider is, the door path, the home.
const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

let cfg, door, home, viewer, tileset, ground = 830;
let pins = [];               // HTML pins tracked to world positions
let riderPin = null, riderPos = null, riderStep = -1;
let expecting = false, orbit = { on: true, center: null, heading: 0.6, range: 620, pitch: -0.62 };
let callActive = false;
let callStart = 0, timerId = null, pendingApproval = null, lastNext = null;

boot();

async function boot() {
  cfg = await (await fetch('/api/config')).json();
  door = cfg.door;
  await initCity();
  const saved = cfg.home || JSON.parse(localStorage.getItem('ttd-home') || 'null');
  if (saved) await setHome(saved, false); else showOnboard();
  bindUi();
  listen();
  refreshExpect();
}

// ======================= 3D city =======================
async function initCity() {
  viewer = new Cesium.Viewer('globe', {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false, globe: false, skyBox: false, skyAtmosphere: false, creditContainer: $('#credits'),
    msaaSamples: 4,
  });
  const scene = viewer.scene;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#050505');
  scene.fog.enabled = false;
  scene.postProcessStages.fxaa.enabled = true;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);
  tileset = await Cesium.Cesium3DTileset.fromUrl(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${cfg.mapsKey}`, {
    showCreditsOnScreen: true, maximumScreenSpaceError: 10,
  });
  scene.primitives.add(tileset);
  // start over Bengaluru while home loads
  aim({ lat: 12.9716, lng: 77.5946 }, 3200, -0.75);
  scene.postRender.addEventListener(placePins);
  viewer.clock.onTick.addEventListener(tickOrbit);
  // stop orbiting while the user drags; resume after a pause
  const h = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  let resume;
  const hold = () => { orbit.on = false; clearTimeout(resume); resume = setTimeout(() => { syncOrbitFromCamera(); orbit.on = true; }, 6000); };
  [Cesium.ScreenSpaceEventType.LEFT_DOWN, Cesium.ScreenSpaceEventType.WHEEL, Cesium.ScreenSpaceEventType.RIGHT_DOWN].forEach((t) => h.setInputAction(hold, t));
}

const pos = (p, up = 0) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat, (p.h ?? ground) + up);

function aim(p, range, pitch = orbit.pitch) {
  orbit.center = { lat: p.lat, lng: p.lng, h: p.h ?? ground }; orbit.range = range; orbit.pitch = pitch;
  viewer.camera.lookAt(pos(orbit.center), new Cesium.HeadingPitchRange(orbit.heading, pitch, range));
}
function tickOrbit() {
  if (!orbit.on || !orbit.center) return;
  orbit.heading += 0.0009;
  viewer.camera.lookAt(pos(orbit.center), new Cesium.HeadingPitchRange(orbit.heading, orbit.pitch, orbit.range));
}
function syncOrbitFromCamera() { orbit.heading = viewer.camera.heading; }

// smooth camera move to frame a point (and optionally home), then keep orbiting there
function frame(p, { range = 520, pitch = -0.62, duration = 2.2 } = {}) {
  orbit.on = false;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  const target = pos(p);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1), {
    offset: new Cesium.HeadingPitchRange(orbit.heading, pitch, range), duration,
    easingFunction: Cesium.EasingFunction.QUINTIC_IN_OUT,
    complete: () => { aim(p, range, pitch); orbit.on = true; },
  });
}

async function waitTiles(max = 40) {
  let last = -1, stable = 0;
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const s = tileset.statistics;
    if (s.numberOfTilesWithContentReady === last && s.numberOfPendingRequests === 0) { if (++stable >= 3) return; } else stable = 0;
    last = s.numberOfTilesWithContentReady;
  }
}
async function sampleHeights(points) {
  try {
    const carto = points.map((p) => Cesium.Cartographic.fromDegrees(p.lng, p.lat));
    const out = await viewer.scene.sampleHeightMostDetailed(carto);
    out.forEach((c, i) => { points[i].h = Number.isFinite(c?.height) ? c.height : ground; });
  } catch { points.forEach((p) => (p.h = ground)); }
}

// ======================= home, door path, pins =======================
async function setHome(h, persist = true) {
  home = { lat: h.lat, lng: h.lng, label: h.label || 'Home' };
  if (persist) {
    localStorage.setItem('ttd-home', JSON.stringify(home));
    fetch('/api/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(home) });
  }
  $('#onboard').hidden = true;
  veil(true, 'Loading ' + (home.label || 'the neighbourhood') + ' in 3D');
  if (!callActive) status('Loading the neighbourhood', false);
  aim(home, 900, -0.7);
  await waitTiles();
  await sampleHeights([home]);
  ground = home.h;
  // the learned door path only applies if this home is the one it was taught for
  const taught = door && distKm(home, lastStep()) < 0.4;
  const pts = taught ? [door.anchor, ...door.steps, ...(door.hubs || [])].map((p) => ({ ...p })) : [];
  if (pts.length) await sampleHeights(pts);
  drawWorld(taught, pts);
  frame(home, { range: 620, pitch: -0.62, duration: 2.6 });
  await waitTiles(20);
  veil(false);
  if (!callActive) status(expecting ? 'Someone is on the way' : 'Watching the door', expecting);
}

const lastStep = () => (door?.steps?.length ? door.steps[door.steps.length - 1] : door.anchor);
function distKm(a, b) { const R = 6371, d = (x) => (x * Math.PI) / 180; const dl = d(b.lat - a.lat), dg = d(b.lng - a.lng); return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(d(a.lat)) * Math.cos(d(b.lat)) * Math.sin(dg / 2) ** 2)); }

function drawWorld(taught, pts) {
  viewer.entities.removeAll();
  pins.forEach((p) => p.node.remove()); pins = [];
  if (riderPin) { riderPin.node.remove(); riderPin = null; }

  // home: soft disc + pulsing ring draped on the buildings
  const t0 = performance.now();
  viewer.entities.add({ position: pos(home), ellipse: { semiMajorAxis: 14, semiMinorAxis: 14, material: Cesium.Color.fromCssColorString('#f5b84a').withAlpha(0.35), classificationType: Cesium.ClassificationType.CESIUM_3D_TILE } });
  const phase = () => ((performance.now() - t0) / 2200) % 1;
  viewer.entities.add({
    position: pos(home),
    ellipse: {
      semiMajorAxis: new Cesium.CallbackProperty(() => 14 + phase() * (expecting ? 46 : 22), false),
      semiMinorAxis: new Cesium.CallbackProperty(() => 14 + phase() * (expecting ? 46 : 22), false),
      material: new Cesium.ColorMaterialProperty(new Cesium.CallbackProperty(() => Cesium.Color.fromCssColorString('#f5b84a').withAlpha((1 - phase()) * (expecting ? 0.38 : 0.16)), false)),
      classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
    },
  });
  addPin(home, 'home', `<div class="pin-home"><span></span></div><div class="pin-tag">${esc(home.label)}</div>`);

  if (taught) {
    const path = [door.anchor, ...door.steps].map((s) => pts.find((p) => p.lat === s.lat && p.lng === s.lng) || s);
    // full route, faint
    viewer.entities.add({ polyline: { positions: path.map((p) => pos(p)), width: 6, clampToGround: true, classificationType: Cesium.ClassificationType.CESIUM_3D_TILE, material: Cesium.Color.fromCssColorString('#f5b84a').withAlpha(0.28) } });
    // walked part, bright
    viewer.entities.add({
      polyline: {
        positions: new Cesium.CallbackProperty(() => { const n = Math.max(0, riderStep); return n < 1 ? [] : path.slice(0, n + 1).map((p) => pos(p)); }, false),
        width: 7, clampToGround: true, classificationType: Cesium.ClassificationType.CESIUM_3D_TILE,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.25, color: Cesium.Color.fromCssColorString('#f5b84a') }),
      },
    });
    addPin(path[0], 'stop', `<div class="pin-dot">S</div><div class="pin-tag">${esc(door.anchor.name)}</div>`, 'stop-0');
    door.steps.forEach((s, i) => { if (i < door.steps.length - 1) addPin(path[i + 1], 'stop', `<div class="pin-dot">${s.n}</div><div class="pin-tag">${esc(stopLabel(s))}</div>`, 'stop-' + s.n); });
    pts.filter((p) => (door.hubs || []).some((h) => h.name === p.name)).forEach((h) => addPin(h, 'hub', `<div class="pin-tag hub">${esc(h.name)}</div>`));
  }
  renderRibbon(taught);
}

function addPin(p, kind, html, id) {
  const node = el('div', 'pin ' + kind, html);
  if (id) node.dataset.id = id;
  $('#globe').appendChild(node);
  const pin = { node, kind, world: pos(p, kind === 'home' ? 8 : 6) };
  pins.push(pin);
  return pin;
}
const scratch = new Cesium.Cartesian2();
// draw HTML pins over the 3D scene; when labels collide, keep the most important one
const PRI = { rider: 0, home: 1, now: 2, anchor: 3, stop: 4, hub: 5 };
function priority(p) {
  if (p.kind !== 'stop') return PRI[p.kind] ?? 6;
  if (p.node.classList.contains('now')) return PRI.now;
  return p.node.dataset.id === 'stop-0' ? PRI.anchor : PRI.stop;
}
function placePins() {
  const s = viewer.scene, shown = [];
  const all = [...pins, ...(riderPin?.world ? [riderPin] : [])].map((p) => ({ p, w: Cesium.SceneTransforms.worldToWindowCoordinates(s, p.world, new Cesium.Cartesian2()) }));
  const far = orbit.range > 1100;
  all.sort((a, b) => priority(a.p) - priority(b.p));
  for (const { p, w } of all) {
    if (!w || (p.kind === 'hub' && !far)) { p.node.style.opacity = 0; continue; }
    p.node.style.opacity = 1;
    p.node.style.transform = `translate(${w.x}px, ${w.y}px)`;
    const clash = shown.some((q) => Math.abs(q.x - w.x) < 92 && Math.abs(q.y - w.y) < 26);
    p.node.classList.toggle('quiet', clash);
    if (!clash) shown.push({ x: w.x, y: w.y });
  }
}

const stopLabel = (s) => cap((s.see && s.see[0]) || s.instruction.split('.')[0]);

function renderRibbon(taught) {
  const r = $('#ribbon'); r.innerHTML = '';
  if (!taught) { r.append(el('div', 'stop now', '<span class="num">?</span><span class="lbl">Door not taught yet. Call ToTheDoor to teach it.</span>')); return; }
  const stops = [{ n: 0, l: door.anchor.name }, ...door.steps.map((s, i) => ({ n: s.n, l: i === door.steps.length - 1 ? `Door · ${door.door.floor} floor ${door.door.side}` : stopLabel(s) }))];
  stops.forEach((s, i) => r.append(el('div', 'stop' + (i === stops.length - 1 ? ' home' : ''), `<span class="num">${i === stops.length - 1 ? '⌂' : s.n === 0 ? 'S' : s.n}</span><span class="lbl">${esc(s.l)}</span>`)));
  markRibbon();
}
function markRibbon() {
  [...$('#ribbon').children].forEach((c, i) => {
    c.classList.toggle('done', riderStep >= 0 && i < riderStep);
    c.classList.toggle('now', i === riderStep);
  });
  document.querySelectorAll('.pin.stop').forEach((p) => {
    const n = Number(p.dataset.id.split('-')[1]);
    p.classList.toggle('done', riderStep >= 0 && n < riderStep); p.classList.toggle('now', n === riderStep);
  });
}

function veil(on, text) { const v = $('#veil'); if (text) $('#veilText').textContent = text; v.classList.toggle('off', !on); }

// ======================= rider =======================
async function placeRider(p, step, label) {
  const pt = { lat: p.lat, lng: p.lng };
  await sampleHeights([pt]);
  riderPos = pt;
  if (!riderPin) riderPin = { node: el('div', 'pin rider', '<div class="pin-rider"><span></span></div><div class="pin-tag rider"></div>'), world: null };
  if (!riderPin.node.isConnected) $('#globe').appendChild(riderPin.node);
  riderPin.world = pos(pt, 10);
  riderPin.node.querySelector('.pin-tag').textContent = label ? `Rider · ${label}` : 'Rider';
  riderPin.node.classList.remove('arrive'); void riderPin.node.offsetWidth; riderPin.node.classList.add('arrive');
  if (typeof step === 'number' && step >= 0) { riderStep = step; markRibbon(); }
  // frame rider and home together
  const mid = { lat: (pt.lat + home.lat) / 2, lng: (pt.lng + home.lng) / 2, h: ground };
  const km = distKm(pt, home);
  frame(mid, { range: Math.max(320, Math.min(4200, km * 1000 * 2.1)), pitch: km > 0.6 ? -0.85 : -0.6 });
}

// ======================= call panel =======================
function status(text, live, done) {
  $('#statusText').textContent = text;
  $('#statusChip').classList.toggle('live', !!live); $('#statusChip').classList.toggle('done', !!done);
}
function tag(text, kind) { const t = $('#callTag'); t.textContent = text; t.className = 'tag' + (kind ? ' ' + kind : ''); }
function clearEmpty() { $('#empty')?.remove(); }

function startCall(caller) {
  clearEmpty();
  $('#stream').querySelectorAll('.msg,.think,.sys').forEach((n) => n.remove());
  riderStep = -1; markRibbon();
  const c = $('#caller'); c.hidden = false; c.classList.remove('ended');
  const svc = (caller || 'Rider').split(' ')[0];
  $('#callerName').textContent = caller || 'Rider';
  $('#callerAvatar').textContent = svc.charAt(0).toUpperCase();
  $('#callerAvatar').style.background = { Zepto: '#5b2be0', Swiggy: '#fc8019', Blinkit: '#f8cb46', Zomato: '#e23744', Amazon: '#232f3e', Uber: '#111', Rapido: '#f9c935' }[svc] || '#3b3b36';
  $('#callerAvatar').style.color = ['Blinkit', 'Rapido'].includes(svc) ? '#111' : '#fff';
  $('#callerMeta').textContent = 'On call';
  callStart = Date.now(); clearInterval(timerId);
  timerId = setInterval(() => { const s = Math.floor((Date.now() - callStart) / 1000); $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
  callActive = true;
  tag('Live', 'live'); status('Rider on the line', true);
  sys('Call connected · answering as ' + $('#household').textContent);
}
function endCall() {
  callActive = false;
  clearInterval(timerId); $('#caller').classList.add('ended'); $('#callerMeta').textContent = 'Call ended';
  $('#wave').className = 'wave';
}
function line(role, text) {
  clearEmpty();
  const m = el('div', 'msg ' + role, `<span class="by">${role === 'rider' ? 'Rider' : 'Home'}</span><div class="b">${esc(text)}</div>`);
  $('#stream').append(m); scroll();
  const w = $('#wave'); w.className = 'wave talk ' + role; clearTimeout(w._t); w._t = setTimeout(() => (w.className = 'wave'), Math.min(4000, 700 + text.length * 45));
}
function think(html, kind = '') { const t = el('div', 'think ' + kind, `<span>${html}</span>`); $('#stream').append(t); scroll(); }
function sys(text) { $('#stream').append(el('div', 'sys', esc(text))); scroll(); }
const scroll = () => { const s = $('#stream'); s.scrollTop = s.scrollHeight; };

function tg(text, from = 'bot') {
  const f = $('#tgFeed'); f.querySelector('.none')?.remove();
  const li = el('li', from === 'sam' ? 'me' : '', `<span>${esc(text)}</span><time>${clock()}</time>`);
  f.prepend(li);
  $('#tgCount').textContent = f.children.length + ' messages';
}

// summarise a tool result as the agent's visible reasoning
function reasonFor(tool, out, args) {
  const say = String(out?.say || '');
  if (tool === 'verify_caller') return out.verified ? [`<b>Caller checked</b> · expected ${esc(cap(out.service))} order`, 'ok'] : [`<b>Not expected</b> · giving nothing away`, 'bad'];
  if (tool === 'ask_customer') return [`<b>Asking Sam</b> · Allow or Block sent to Telegram`, 'bad'];
  if (tool === 'check_approval') return out.approved ? ['<b>Sam allowed</b> · guiding now', 'ok'] : ['<b>Not approved</b> · ending politely', 'bad'];
  if (tool === 'call_customer') return ['<b>Ringing Sam</b> · fallback ready: shoe rack + photo', ''];
  if (tool === 'log_outcome') return [`<b>Delivered</b> · ${esc(args?.result || '')}`, 'ok'];
  if (tool === 'next_instruction' || tool === 'rider_status') {
    const heard = args?.seen ? `heard <b>"${esc(args.seen)}"</b>` : 'checked his position';
    const step = say.match(/Next step \((\d+) of (\d+)\)/);
    const at = say.match(/He is (?:at|passing|near) "?([^".]+)"?/);
    const where = step ? `step ${step[1]} of ${step[2]}` : out.zone === 'far' ? 'far away · routing via a big landmark' : out.zone === 'door' ? 'at the door' : 'on the way';
    return [`${heard} → ${at ? 'at ' + esc(at[1]) + ' · ' : ''}${where}`, ''];
  }
  return [esc(tool), ''];
}

// ======================= guard =======================
function showGuard(id, caller) {
  pendingApproval = id; $('#guardSays').textContent = `"${caller}"`; $('#guard').hidden = false;
  tag('Checking', 'stop'); status('Unknown caller · asking Sam', true);
}
function hideGuard(st) {
  $('#guard').hidden = true; pendingApproval = null;
  if (st === 'blocked') { think('<b>Blocked by Sam</b> · no address shared', 'bad'); tag('Blocked', 'stop'); }
  if (st === 'allowed') { think('<b>Allowed by Sam</b>', 'ok'); tag('Live', 'live'); }
}
async function resolve(st) {
  if (!pendingApproval) return;
  await fetch('/api/approvals/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_id: pendingApproval, status: st }) });
}

// ======================= events =======================
function listen() {
  const es = new EventSource('/api/events');
  let warm = true; setTimeout(() => (warm = false), 800); // skip the replayed backlog
  es.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } if (!warm) handle(e); };
}

function handle(e) {
  switch (e.type) {
    case 'visit.created': expecting = true; status(`${cap(e.service)} on the way`, true); refreshExpect(); if (e.source === 'telegram') tg(`Expecting ${cap(e.service)}`, 'sam'); break;
    case 'visit.eta': expecting = true; status(`${cap(e.service || 'Delivery')} · about ${e.eta_min} min away`, true); break;
    case 'visit.closed': expecting = false; refreshExpect(); if (e.status === 'delivered') { status('Delivered', false, true); tag('Delivered', 'done'); riderStep = $('#ribbon').children.length - 1; markRibbon(); } break;
    case 'call.started': startCall(e.caller || 'Rider'); break;
    case 'call.line': line(e.role, e.text); break;
    case 'call.ended': endCall(); break;
    case 'tool.result': { const [h, k] = reasonFor(e.tool, e.out, lastNext?.tool === e.tool ? lastNext.args : null); think(h, k); break; }
    case 'tool.call': lastNext = { tool: e.tool, args: e.args }; break;
    case 'rider.placed': placeRider(e, e.step, e.label); break;
    case 'rider.position': if (e.mode !== 'sim') placeRider(e, -1, 'live location'); break;
    case 'notify': tg(e.text); break;
    case 'telegram.in': tg(e.text, 'sam'); break;
    case 'approval.requested': showGuard(e.approval, e.caller); break;
    case 'approval.resolved': hideGuard(e.status); break;
    case 'home.set': break;
  }
}

async function refreshExpect() {
  try {
    const s = await (await fetch('/api/state')).json();
    const box = $('#expect'); if (!box) return;
    box.innerHTML = '';
    s.visits.forEach((v) => box.append(el('div', 'x', `<span>${esc(cap(v.service))}</span><span>until ${new Date(v.expires).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>`)));
    expecting = s.visits.length > 0;
  } catch {}
}

// ======================= ui wiring =======================
function bindUi() {
  $('#v3d').onclick = () => { setSeg('v3d'); frame(orbit.center || home, { range: 620, pitch: -0.62, duration: 1.4 }); };
  $('#vtop').onclick = () => { setSeg('vtop'); frame(orbit.center || home, { range: 900, pitch: -1.5, duration: 1.4 }); };
  $('#recenter').onclick = () => home && frame(home, { range: 620, pitch: -0.62 });
  $('#allow').onclick = () => resolve('allowed');
  $('#block').onclick = () => resolve('blocked');
  $('#playDemo').onclick = async () => {
    $('#playDemo').disabled = true;
    if (!home || distKm(home, lastStep()) > 0.4) await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: "Sam's home" });
    await fetch('/api/demo/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };
  $('#callMe').onclick = async () => {
    const hint = $('#callHint'); hint.textContent = 'Starting a delivery and ringing your phone…';
    const d = await (await fetch('/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'zepto', ride: false }) })).json();
    const r = await (await fetch('/api/call-rider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visit_id: d.visit_id }) })).json();
    hint.textContent = r.ok ? 'Your phone is ringing. Say "Sir, Zepto se".' : `Couldn't place the call: ${r.error}`;
  };
  // onboarding
  $('#useLoc').onclick = () => {
    $('#locErr').textContent = ''; $('#useLoc').disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => setHome({ lat: p.coords.latitude, lng: p.coords.longitude, label: 'Home' }),
      (err) => { $('#useLoc').disabled = false; $('#locErr').textContent = err.code === 1 ? 'Location permission was denied. Search for your area instead.' : 'Could not get your location. Search for your area instead.'; },
      { enableHighAccuracy: true, timeout: 12000 },
    );
  };
  $('#useDemo').onclick = () => setHome({ lat: lastStep().lat, lng: lastStep().lng, label: "Sam's home" });
  let t;
  $('#q').oninput = (ev) => {
    clearTimeout(t); const q = ev.target.value.trim();
    if (q.length < 3) { $('#results').innerHTML = ''; return; }
    t = setTimeout(async () => {
      const list = await (await fetch('/api/geocode?q=' + encodeURIComponent(q))).json();
      const ul = $('#results'); ul.innerHTML = '';
      if (!list.length) { ul.append(el('li', '', '<div class="n">No match</div><div class="a">Try a landmark or society name</div>')); return; }
      list.forEach((r) => { const li = el('li', '', `<div class="n">${esc(r.name)}</div><div class="a">${esc(r.address)}</div>`); li.onclick = () => setHome({ lat: r.lat, lng: r.lng, label: r.name }); ul.append(li); });
    }, 280);
  };
}
function setSeg(id) { ['v3d', 'vtop'].forEach((x) => { $('#' + x).classList.toggle('on', x === id); $('#' + x).setAttribute('aria-pressed', x === id); }); }
function showOnboard() { $('#onboard').hidden = false; status('Set your home', false); aim({ lat: 12.9716, lng: 77.5946 }, 2600, -0.7); }
