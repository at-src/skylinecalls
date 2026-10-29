// ToTheDoor live screen: a night-time 3D city (three.js, built from OpenStreetMap) + the live call.
// Everything on the map is driven by server events: where the agent believes the rider is, the door path, the home.
import * as THREE from 'three';
import { City } from './city3d.js';
import { SlopCity, prebuiltFor } from './slop-city.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
const clock = () => new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

let cfg, door, home, city, taught = false;
let pins = [], riderPin = null, riderStep = -1;
let expecting = false, callActive = false;
let callStart = 0, timerId = null, pendingApproval = null, lastNext = null;

boot();

async function boot() {
  cfg = await (await fetch('/api/config')).json();
  door = cfg.door;
  frameHooks.push(placePins);
  const saved0 = cfg.home || JSON.parse(localStorage.getItem('ttd-home') || 'null');
  useCityFor(saved0 || { lat: 12.9128, lng: 77.6374 });
  bindUi();
  listen();
  refreshExpect();
  const saved = cfg.home || JSON.parse(localStorage.getItem('ttd-home') || 'null');
  if (saved) await setHome(saved, false); else showOnboard();
}

// ======================= home and city =======================
// The renderer: the pre-built 3D city (an iframe, slop-city.js) where there is one for the home, else the in-page city
// built from OpenStreetMap on the fly (city3d.js). Frame hooks are kept here so they survive a switch.
const frameHooks = [];
const addFrameHook = (f) => { frameHooks.push(f); if (city) city.onFrame.push(f); };
function useCityFor(ll) {
  const pre = ll && !new URLSearchParams(location.search).has('classic') ? prebuiltFor(ll.lat, ll.lng) : null;
  const want = pre ? 'slop:' + pre.id : 'classic';
  if (city && city.kind === want) return;
  const tod = city ? { ...city.tod } : null;
  if (city) {
    if (city.destroy) city.destroy();
    else { city.renderer.setAnimationLoop(null); city.renderer.domElement.remove(); }
  }
  city = pre ? new SlopCity($('#globe'), pre.id) : new City($('#globe'));
  city.kind = want;
  if (tod) { if (tod.mode === 'live') city.setLive(); else if (tod.mode === 'play') { city.tod.hour = tod.hour; city.playDay(tod.dayLength); } else city.setHour(tod.hour); }
  frameHooks.forEach((f) => city.onFrame.push(f));
  window.__city = city;
}
const lastStep = () => (door?.steps?.length ? door.steps[door.steps.length - 1] : door.anchor);
function distKm(a, b) { const R = 6371, d = (x) => (x * Math.PI) / 180; const dl = d(b.lat - a.lat), dg = d(b.lng - a.lng); return 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(d(a.lat)) * Math.cos(d(b.lat)) * Math.sin(dg / 2) ** 2)); }

async function setHome(h, persist = true) {
  home = { lat: h.lat, lng: h.lng, label: h.label || 'Home' };
  if (persist) {
    localStorage.setItem('ttd-home', JSON.stringify(home));
    fetch('/api/home', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(home) });
  }
  $('#onboard').hidden = true;
  veil(true, 'Building ' + (home.label === 'Home' ? 'your neighbourhood' : home.label));
  if (!callActive) status('Building the neighbourhood', false);
  taught = !!door && distKm(home, lastStep()) < 0.4;
  let data;
  try {
    data = await (await fetch(`/api/city?lat=${home.lat}&lng=${home.lng}`)).json();
    if (data.error) throw new Error(data.error);
  } catch (e) { veil(true, "Couldn't load map data for this spot. Try the demo home."); return; }
  useCityFor(home);
  await city.build(data, home);
  clearPins();
  addPin(home, 'home', `<div class="pin-home"><span></span></div><div class="pin-tag">${esc(home.label)}</div>`, null, 'home');
  if (taught) {
    const stops = [door.anchor, ...door.steps];
    city.setPath(stops);
    addPin(door.anchor, 'stop', `<div class="pin-dot">S</div><div class="pin-tag">${esc(door.anchor.name)}</div>`, 'stop-0');
    door.steps.forEach((s, i) => { if (i < door.steps.length - 1 && distKm(s, home) * 1000 > 22) addPin(s, 'stop', `<div class="pin-dot">${s.n}</div><div class="pin-tag">${esc(stopLabel(s))}</div>`, 'stop-' + s.n); });
  }
  (data.landmarks || []).slice(0, 14).forEach((l) => addPinLocal(fromBake(data, l, 30), 'hub', `<div class="pin-tag hub">${esc(l.name.replace(/&amp;/g, '&'))}</div>`));
  city.expecting = expecting;
  renderRibbon();
  // cinematic arrival: start high and far, settle over the home while the city rises
  const H = city.home;
  city.camera.position.set(H.x + 900, 1300, H.z + 1300);
  city.controls.target.set(H.x, 0, H.z);
  city.look(new THREE.Vector3(H.x, 0, H.z), 300, 1.12, Math.PI * 0.2, 4.2);
  setTimeout(() => veil(false), 350);
  window.dispatchEvent(new Event('ttd-home'));
  if (!callActive) status(expecting ? 'Someone is on the way' : 'Watching the door', expecting);
}

// a point of the OpenStreetMap bake (x east, z south of data.origin, metres) in the current renderer's frame
function fromBake(data, p, y) {
  const o = data.origin, lat = o.lat - p.z / 110540, lng = o.lng + p.x / (111320 * Math.cos((o.lat * Math.PI) / 180));
  const v = city.local(lat, lng); v.y = y; return v;
}

function veil(on, text) { const v = $('#veil'); if (text) $('#veilText').textContent = text; v.classList.toggle('off', !on); }

// ======================= pins (HTML over the 3D scene) =======================
function clearPins() { pins.forEach((p) => p.node.remove()); pins = []; if (riderPin) { riderPin.node.remove(); riderPin = null; } }
function addPin(ll, kind, html, id, height = 'stop') {
  const v = city.local(ll.lat, ll.lng); v.y = kind === 'home' ? (city.homeH || 12) + 14 : 9;
  return addPinLocal(v, kind, html, id);
}
function addPinLocal(v, kind, html, id) {
  const node = el('div', 'pin ' + kind, html);
  if (id) node.dataset.id = id;
  $('#globe').appendChild(node);
  const pin = { node, kind, world: v };
  pins.push(pin);
  return pin;
}
const PRI = { rider: 0, home: 1, now: 2, anchor: 3, stop: 4, hub: 5 };
function priority(p) {
  if (p.kind !== 'stop') return PRI[p.kind] ?? 6;
  if (p.node.classList.contains('now')) return PRI.now;
  return p.node.dataset.id === 'stop-0' ? PRI.anchor : PRI.stop;
}
function placePins() {
  if (!city.home) return;
  const shown = [], dist = city.camera.position.distanceTo(city.controls.target);
  const all = [...pins, ...(riderPin ? [riderPin] : [])].map((p) => ({ p, w: city.project(riderPin === p ? city.rider.position.clone().add(new THREE.Vector3(0, 8, 0)) : p.world) }));
  all.sort((a, b) => priority(a.p) - priority(b.p));
  for (const { p, w } of all) {
    const hideHub = p.kind === 'hub' && dist < 260;
    if (!w || hideHub) { p.node.style.opacity = 0; continue; }
    p.node.style.opacity = 1;
    p.node.style.transform = `translate(${w.x}px, ${w.y}px)`;
    const clash = shown.some((q) => Math.abs(q.x - w.x) < 96 && Math.abs(q.y - w.y) < 26);
    p.node.classList.toggle('quiet', clash);
    if (!clash) shown.push({ x: w.x, y: w.y });
  }
}

const stopLabel = (s) => cap((s.see && s.see[0]) || s.instruction.split('.')[0]);

function renderRibbon() {
  const r = $('#ribbon'); r.innerHTML = '';
  if (!taught) { r.append(el('div', 'stop now', '<span class="num">?</span><span class="lbl">Door not taught yet. Call ToTheDoor to teach it.</span>')); return; }
  const stops = [{ n: 0, l: door.anchor.name }, ...door.steps.map((s, i) => ({ n: s.n, l: i === door.steps.length - 1 ? `Door · ${door.door.floor} floor ${door.door.side}` : stopLabel(s) }))];
  stops.forEach((s, i) => r.append(el('div', 'stop' + (i === stops.length - 1 ? ' home' : ''), `<span class="num">${i === stops.length - 1 ? '⌂' : s.n === 0 ? 'S' : s.n}</span><span class="lbl">${esc(s.l)}</span>`)));
  markRibbon();
}
function markRibbon() {
  [...$('#ribbon').children].forEach((c, i) => { c.classList.toggle('done', riderStep >= 0 && i < riderStep); c.classList.toggle('now', i === riderStep); });
  document.querySelectorAll('.pin.stop').forEach((p) => {
    const n = Number(p.dataset.id.split('-')[1]);
    p.classList.toggle('done', riderStep >= 0 && n < riderStep); p.classList.toggle('now', n === riderStep);
  });
  city.setProgress(riderStep);
}

// ======================= rider =======================
function placeRider(p, step, label) {
  const v = city.placeRider(p.lat, p.lng);
  if (!riderPin) { riderPin = { node: el('div', 'pin rider', '<div class="pin-tag rider"></div>'), kind: 'rider', world: v }; $('#globe').appendChild(riderPin.node); }
  riderPin.node.querySelector('.pin-tag').textContent = label ? `Rider · ${label}` : 'Rider';
  if (typeof step === 'number' && step >= 0) { riderStep = step; markRibbon(); }
  // frame rider and home together
  const H = city.home, mid = new THREE.Vector3((v.x + H.x) / 2, 0, (v.z + H.z) / 2);
  const d = Math.hypot(v.x - H.x, v.z - H.z);
  city.look(mid, Math.max(170, Math.min(2400, d * 1.8)), d > 500 ? 0.82 : 1.08, null, 2.4);
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
  f.prepend(el('li', from === 'sam' ? 'me' : '', `<span>${esc(text)}</span><time>${clock()}</time>`));
  $('#tgCount').textContent = f.children.length + ' messages';
}

function reasonFor(tool, out, args) {
  const say = String(out?.say || '');
  if (tool === 'verify_caller') return out.verified ? [`<b>Caller checked</b> · expected ${esc(cap(out.service))} order`, 'ok'] : ['<b>Not expected</b> · giving nothing away', 'bad'];
  if (tool === 'ask_customer') return ['<b>Asking Sam</b> · Allow or Block sent to Telegram', 'bad'];
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
function showGuard(id, caller) { pendingApproval = id; $('#guardSays').textContent = `"${caller}"`; $('#guard').hidden = false; tag('Checking', 'stop'); status('Unknown caller · asking Sam', true); }
function hideGuard(st) {
  $('#guard').hidden = true; pendingApproval = null;
  if (st === 'blocked') { think('<b>Blocked by Sam</b> · no address shared', 'bad'); tag('Blocked', 'stop'); }
  if (st === 'allowed') { think('<b>Allowed by Sam</b>', 'ok'); tag('Live', 'live'); }
}
async function resolve(st) { if (!pendingApproval) return; await fetch('/api/approvals/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_id: pendingApproval, status: st }) }); }

// ======================= events =======================
function listen() {
  const es = new EventSource('/api/events');
  let warm = true; setTimeout(() => (warm = false), 800);
  es.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } if (!warm) handle(e); };
}
function setExpecting(on) { expecting = on; if (city) city.expecting = on; }
function handle(e) {
  switch (e.type) {
    case 'visit.created': setExpecting(true); status(`${cap(e.service)} on the way`, true); refreshExpect(); if (e.source === 'telegram') tg(`Expecting ${cap(e.service)}`, 'sam'); break;
    case 'visit.eta': setExpecting(true); status(`${cap(e.service || 'Delivery')} · about ${e.eta_min} min away`, true); break;
    case 'visit.closed': setExpecting(false); refreshExpect(); if (e.status === 'delivered') { status('Delivered', false, true); tag('Delivered', 'done'); riderStep = $('#ribbon').children.length - 1; markRibbon(); if (home) setTimeout(() => city.look(city.home.clone(), 260, 0.9, null, 2.6), 900); } break;
    case 'call.started': startCall(e.caller || 'Rider'); break;
    case 'call.line': line(e.role, e.text); break;
    case 'call.ended': endCall(); break;
    case 'tool.call': lastNext = { tool: e.tool, args: e.args }; break;
    case 'tool.result': { const [h, k] = reasonFor(e.tool, e.out, lastNext?.tool === e.tool ? lastNext.args : null); think(h, k); break; }
    case 'rider.placed': placeRider(e, e.step, e.label); break;
    case 'rider.position': if (e.mode !== 'sim') placeRider(e, -1, 'live location'); break;
    case 'notify': tg(e.text); break;
    case 'telegram.in': tg(e.text, 'sam'); break;
    case 'approval.requested': showGuard(e.approval, e.caller); break;
    case 'approval.resolved': hideGuard(e.status); break;
  }
}
async function refreshExpect() {
  try {
    const s = await (await fetch('/api/state')).json();
    const box = $('#expect'); if (!box) return;
    box.innerHTML = '';
    s.visits.forEach((v) => box.append(el('div', 'x', `<span>${esc(cap(v.service))}</span><span>until ${new Date(v.expires).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span>`)));
    setExpecting(s.visits.length > 0);
  } catch {}
}

// ======================= time of day =======================
const PLAY = 'M8 5.5v13a1 1 0 001.5.86l11-6.5a1 1 0 000-1.72l-11-6.5A1 1 0 008 5.5z', PAUSE = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
const fmtHour = (h) => { const m = Math.floor((h % 1) * 60), hh = Math.floor(h) % 24; return `${hh % 12 || 12}:${String(m).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
function bindClock() {
  const slider = $('#tSlider'), label = $('#tLabel'), icon = $('#tIcon'), live = $('#tLive'), play = $('#tPlay');
  let dragging = false;
  const mode = (m) => {
    live.classList.toggle('on', m === 'live'); live.setAttribute('aria-pressed', String(m === 'live'));
    play.setAttribute('aria-pressed', String(m === 'play')); $('#tPlayIcon').setAttribute('d', m === 'play' ? PAUSE : PLAY);
  };
  // ?hour=7.5 opens the city at a fixed hour (used for screenshots)
  const fixed = parseFloat(new URLSearchParams(location.search).get('hour'));
  if (!Number.isNaN(fixed)) { city.setHour(fixed); mode('manual'); }
  slider.addEventListener('pointerdown', () => (dragging = true));
  window.addEventListener('pointerup', () => (dragging = false));
  slider.oninput = () => { city.setHour(parseFloat(slider.value)); mode('manual'); };
  live.onclick = () => { city.setLive(); mode('live'); rainLive = true; liveRain(); };
  // Rain: in Live it follows the real weather at the home (/api/weather, checked every 10 minutes); the button turns
  // it on or off by hand. ?rain opens the map in the rain.
  const rainBtn = $('#tRain');
  let rainLive = true, rainOn = false;
  const showRain = (on) => { rainOn = on; rainBtn.setAttribute('aria-pressed', String(on)); city.setRain?.(on ? 1 : 0); };
  async function liveRain() {
    if (!home) return;
    try {
      const w = await (await fetch(`/api/weather?lat=${home.lat}&lng=${home.lng}`)).json();
      city.setSun?.(w);
      if (rainLive) { rainOn = w.rain > 0; rainBtn.setAttribute('aria-pressed', String(rainOn)); city.setRain?.(w.rain || 0); }
    } catch { /* offline: keep it as it is */ }
  }
  rainBtn.onclick = () => { rainLive = false; showRain(!rainOn); };
  if (new URLSearchParams(location.search).has('rain')) { rainLive = false; showRain(true); }
  setInterval(liveRain, 10 * 60 * 1000);
  window.addEventListener('ttd-home', liveRain);
  play.onclick = () => { if (city.tod.mode === 'play') { city.setHour(city.hour); mode('manual'); } else { city.playDay(60); mode('play'); } };
  let last = '', lastMode = '';
  addFrameHook(() => {
    const h = city.hour, txt = fmtHour(h);
    if (city.tod.mode !== lastMode) { lastMode = city.tod.mode; mode(lastMode); }
    if (!dragging) slider.value = h.toFixed(2);
    if (txt !== last) { label.textContent = txt; last = txt; icon.classList.toggle('night', h < 6 || h >= 18.8); }
  });
}

// ======================= ui wiring =======================
function bindUi() {
  const H = () => (city.home ? city.home.clone() : new THREE.Vector3());
  $('#v3d').onclick = () => { setSeg('v3d'); city.look(H(), 300, 1.12, null, 1.6); };
  $('#vtop').onclick = () => { setSeg('vtop'); city.look(H(), 700, 0.05, null, 1.6); };
  $('#recenter').onclick = () => city.look(H(), 300, 1.12, null, 1.6);
  const zoom = (f) => { const d = city.camera.position.distanceTo(city.controls.target); const sph = new THREE.Spherical().setFromVector3(city.camera.position.clone().sub(city.controls.target)); city.look(city.controls.target.clone(), Math.max(50, Math.min(3000, d * f)), sph.phi, sph.theta, 0.7); };
  bindClock();
  $('#zin').onclick = () => zoom(0.6);
  $('#zout').onclick = () => zoom(1.6);
  $('#changeHome').onclick = async () => { localStorage.removeItem('ttd-home'); await fetch('/api/home/clear', { method: 'POST' }); home = null; $('#q').value = ''; $('#results').innerHTML = ''; $('#useLoc').disabled = false; showOnboard(); };
  $('#allow').onclick = () => resolve('allowed');
  $('#block').onclick = () => resolve('blocked');
  $('#playDemo').onclick = async () => {
    $('#playDemo').disabled = true;
    if (!taught) await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: "Sam's home" });
    await fetch('/api/demo/replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  };
  $('#callMe').onclick = async () => {
    const hint = $('#callHint'); hint.textContent = 'Starting a delivery and ringing your phone…';
    const d = await (await fetch('/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: 'zepto', ride: false }) })).json();
    const r = await (await fetch('/api/call-rider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visit_id: d.visit_id }) })).json();
    hint.textContent = r.ok ? 'Your phone is ringing. Say "Sir, Zepto se".' : `Couldn't place the call: ${r.error}`;
  };
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
function showOnboard() {
  $('#onboard').hidden = false; veil(false); status('Set your home', false);
}
