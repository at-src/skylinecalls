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
let callKind = 'guide', pendingTarget = null, teaching = null;

boot();

async function boot() {
  // ?reset starts over (role and home); there is no button for it
  if (new URLSearchParams(location.search).has('reset')) {
    localStorage.removeItem('ttd-role'); localStorage.removeItem('ttd-home');
    await fetch('/api/home/clear', { method: 'POST' }).catch(() => {});
    history.replaceState(null, '', location.pathname);
  }
  cfg = await (await fetch('/api/config')).json();
  door = cfg.door;
  frameHooks.push(placePins);
  const saved0 = cfg.home || JSON.parse(localStorage.getItem('ttd-home') || 'null');
  useCityFor(saved0 || { lat: 12.9128, lng: 77.6374 });
  bindUi();
  bindLine();
  setView('mind');
  listen();
  refreshExpect();
  loadLine();
  const role = localStorage.getItem('ttd-role');
  if (!role) return showRole();
  if (role.startsWith('sender:')) return startSender(role.slice(7));
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

async function setHome(h, persist = true, { sender = false } = {}) {
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
  await city.build(data, home, { marker: !sender });
  clearPins();
  if (sender) { (data.landmarks || []).slice(0, 14).forEach((l) => addPinLocal(fromBake(data, l, 30), 'hub', `<div class="pin-tag hub">${esc(l.name.replace(/&amp;/g, '&'))}</div>`)); const H = city.home; city.camera.position.set(H.x + 900, 1500, H.z + 1500); city.controls.target.set(H.x, 0, H.z); city.look(new THREE.Vector3(H.x + 180, 0, H.z - 420), 760, 0.9, Math.PI * 0.2, 4.2); setTimeout(() => veil(false), 350); window.dispatchEvent(new Event('ttd-home')); return; }
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
  renderConsent();
  if (!callActive) status(expecting ? 'Someone is on the way' : 'Answering for Sam', expecting);
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
const PRI = { callout: 0, rider: 0, home: 1, now: 2, anchor: 3, stop: 4, hub: 5 };
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

// ---- the door path as stops: one format everywhere, built only from what the receiver taught
// start: the landmark's name; each step: the first thing the rider will see there; the door: floor and side
const clip = (s, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
function floorText(f) {
  const t = String(f ?? '').trim().toLowerCase().replace(/\s*floor$/, '');
  if (!t) return '';
  if (/^(0|g|ground)$/.test(t)) return 'Ground floor';
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? `${ordinal(n)} floor` : `${cap(t)} floor`;
}
function doorText(d) {
  const side = String(d?.side ?? '').trim().toLowerCase().replace(/\s*side$/, '');
  return ['Door', [floorText(d?.floor), side].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
}
const stopLabel = (s) => clip(cap(String((s.see && s.see[0]) || s.label || s.instruction.split('.')[0]).trim()));
const stopNode = (num, label, cls = '') => el('div', 'stop' + (cls ? ' ' + cls : ''), `<span class="num">${num}</span><span class="lbl">${esc(label)}</span>`);

function renderRibbon() {
  const r = $('#ribbon'); r.innerHTML = '';
  if (!taught) { r.append(el('div', 'stop now', '<span class="num">?</span><span class="lbl">Door not taught yet. Call ToTheDoor to teach it.</span>')); return; }
  r.append(stopNode('S', clip(door.anchor.name)));
  door.steps.forEach((s, i) => r.append(i === door.steps.length - 1 ? stopNode('⌂', doorText(door.door), 'home') : stopNode(i + 1, stopLabel(s))));
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
function placeRider(p, step, label, { frame = true } = {}) {
  const v = city.placeRider(p.lat, p.lng);
  if (!riderPin) { riderPin = { node: el('div', 'pin rider', '<div class="pin-tag rider"></div>'), kind: 'rider', world: v }; $('#globe').appendChild(riderPin.node); }
  riderPin.node.querySelector('.pin-tag').textContent = label ? `Rider · ${label}` : 'Rider';
  if (typeof step === 'number' && step >= 0) { riderStep = step; markRibbon(); }
  if (!frame) return;
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
  $('#callerAvatar').textContent = /^\+/.test(svc) ? '#' : svc.charAt(0).toUpperCase();
  $('#callerAvatar').style.background = { Zepto: '#5b2be0', Swiggy: '#fc8019', Blinkit: '#f8cb46', Zomato: '#e23744', Amazon: '#232f3e', Uber: '#111', Rapido: '#f9c935' }[svc] || '#3b3b36';
  $('#callerAvatar').style.color = ['Blinkit', 'Rapido'].includes(svc) ? '#111' : '#fff';
  $('#callerMeta').textContent = 'On call';
  callStart = Date.now(); clearInterval(timerId);
  timerId = setInterval(() => { const s = Math.floor((Date.now() - callStart) / 1000); $('#timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
  callActive = true; lockDock(true);
  tag('Live', 'live'); status(callKind === 'calibration' ? 'Sam is teaching the door' : 'On a call', true);
  sys('Call connected · answering for Sam');
}
function endCall() {
  callActive = false; lockDock(false);
  clearInterval(timerId); $('#caller').classList.add('ended'); $('#callerMeta').textContent = 'Call ended';
  $('#wave').className = 'wave';
}
function line(role, text) {
  clearEmpty();
  const by = role === 'rider' || role === 'caller' ? (live?.kind === 'delivery' ? 'Rider' : $('#callerName').textContent || 'Caller') : role === 'customer' ? 'Sam' : callKind === 'calibration' ? 'ToTheDoor' : "Sam's line";
  // callers share the rider's bubble (".caller" is the call card's class)
  const m = el('div', 'msg ' + (role === 'caller' ? 'rider' : role), `<span class="by">${esc(by)}</span><div class="b">${esc(text)}</div>`);
  $('#stream').append(m); scroll();
  // a target the agent was told to send him to gets marked in the agent's next line
  if (role === 'agent' && pendingTarget) { markWords(m.querySelector('.b'), pendingTarget.label, 'target', pendingTarget.top); pendingTarget = null; }
  const w = $('#wave'); w.className = 'wave talk ' + role; clearTimeout(w._t); w._t = setTimeout(() => (w.className = 'wave'), Math.min(4000, 700 + text.length * 45));
}
function think(html, kind = '') { const t = el('div', 'think ' + kind, `<span>${html}</span>`); $('#stream').append(t); scroll(); }
function sys(text) { $('#stream').append(el('div', 'sys', esc(text))); scroll(); }
const scroll = () => { const s = $('#stream'); s.scrollTop = s.scrollHeight; };

function tg(text, from = 'bot', buttons = null) {
  const f = $('#tgFeed'); f.querySelector('.none')?.remove();
  const li = el('li', from === 'sam' ? 'me' : '', `<div class="tgb"><span>${esc(text)}</span>${buttons ? '<div class="tgk"></div>' : ''}</div><time>${clock()}</time>`);
  // the bot's "did it arrive?" buttons: the same answer as on Telegram
  for (const b of (buttons || []).flat()) {
    const [act, vid] = String(b.data).split(':');
    const btn = el('button', 'tgbtn', esc(b.text));
    btn.dataset.visit = vid;
    btn.onclick = async () => {
      li.querySelectorAll('.tgbtn').forEach((x) => (x.disabled = true));
      btn.classList.add('picked');
      await fetch('/api/visits/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visit_id: vid, received: act === 'got' }) });
    };
    li.querySelector('.tgk').append(btn);
  }
  f.prepend(li);
  $('#tgCount').textContent = f.children.length + (f.children.length === 1 ? ' message' : ' messages');
}
// once a visit is answered (here, on Telegram, or by the hour running out) its buttons stop working
const answered = (vid) => document.querySelectorAll(`.tgbtn[data-visit="${vid}"]`).forEach((b) => (b.disabled = true));
function reasonFor(tool, out, args) {
  const say = String(out?.say || '');
  if (tool === 'lookup_caller') return out.blocked ? ['<b>Blocked number</b> · cutting it off', 'bad'] : out.known ? [`<b>Known</b> · ${esc(out.name)}, ${esc(out.relation || out.kind)}`, 'ok'] : ['<b>Unknown number</b> · asking who it is', ''];
  if (tool === 'classify_caller') {
    if (out.kind === 'delivery') return out.verified ? [`<b>Delivery</b> · expected ${esc(cap(out.service))} order, guiding`, 'ok'] : ['<b>Delivery, not expected</b> · giving nothing away', 'bad'];
    return [`<b>${esc(out.label || out.kind)}</b>${out.budget ? ` · ${out.budget}s limit` : ''}${out.briefing ? ' · using a briefing' : ''}`, out.kind === 'sales' ? 'bad' : 'ok'];
  }
  if (tool === 'check_passcode') return out.ok ? ['<b>Code correct</b> · Sam alerted', 'ok'] : ['<b>Wrong code</b>', 'bad'];
  if (tool === 'take_message') return ['<b>Message sent to Sam</b>', 'ok'];
  if (tool === 'alert_owner') return ['<b>Alerted Sam</b>', 'bad'];
  if (tool === 'end_call') return ['<b>Logged</b> · Sam told what happened', 'ok'];
  if (tool === 'verify_caller') return out.verified ? [`<b>Caller checked</b> · expected ${esc(cap(out.service))} order`, 'ok'] : ['<b>Not expected</b> · giving nothing away', 'bad'];
  if (tool === 'ask_customer') return ['<b>Asking Sam</b> · Allow or Block sent to Telegram', 'bad'];
  if (tool === 'check_approval') return out.approved ? ['<b>Sam allowed</b> · guiding now', 'ok'] : ['<b>Not approved</b> · ending politely', 'bad'];
  if (tool === 'call_customer') return ['<b>Ringing Sam</b> · fallback ready: shoe rack + photo', ''];
  if (tool === 'log_outcome') return [`<b>Delivered</b> · ${esc(args?.result || '')}`, 'ok'];
  if (tool === 'save_anchor') return [`<b>Landmark found on the map</b> · ${esc(args?.name || '')}`, 'ok'];
  if (tool === 'save_step') { const n = say.match(/Step (\d+) saved/); return [`<b>Step ${n ? n[1] : ''} saved</b> · ends at ${esc(args?.landmark || '')}`, 'ok']; }
  if (tool === 'save_door') return [`<b>Door saved</b> · ${esc(args?.floor || '')} floor ${esc(args?.side || '')}, ${esc(args?.action || '')}`, 'ok'];
  if (tool === 'save_fallback') return [`<b>If nobody opens</b> · ${esc(args?.if_no_answer || '')}`, 'ok'];
  if (tool === 'finish_calibration') return out.complete ? [`<b>Door path saved</b> · checked, no gaps`, 'ok'] : [`<b>Gaps</b> · ${esc((out.gaps || []).join('; '))}`, 'bad'];
  if (tool === 'next_instruction' || tool === 'rider_status') {
    const heard = args?.seen ? `heard <b>"${esc(args.seen)}"</b>` : 'checked his position';
    const step = say.match(/Next step \((\d+) of (\d+)\)/);
    const at = say.match(/He is (?:at|passing|near) "?([^".]+)"?/);
    const where = step ? `step ${step[1]} of ${step[2]}` : out.zone === 'far' ? 'far away · routing via a big landmark' : out.zone === 'door' ? 'at the door' : 'on the way';
    return [`${heard} → ${at ? 'at ' + esc(at[1]) + ' · ' : ''}${where}`, ''];
  }
  return [esc(tool), ''];
}

// ======================= the conversation, on the map =======================
// What the call points at lights up on the map (city.highlight), gets a callout over it, and is underlined in the
// transcript; clicking the underlined words looks there.
const callouts = {};
function clearCallouts() { for (const k of Object.keys(callouts)) { const p = callouts[k]; p.node.remove(); pins = pins.filter((x) => x !== p); delete callouts[k]; } }
async function spotAt(lat, lng, kind) {
  if (city.highlight) return city.highlight(lat, lng, kind);
  const v = city.local(lat, lng); v.y = 14; return v;
}
async function callout(kind, lat, lng, title, sub) {
  const top = await spotAt(lat, lng, kind);
  if (callouts[kind]) { callouts[kind].node.remove(); pins = pins.filter((x) => x !== callouts[kind]); }
  const p = addPinLocal(top, 'callout', `<div class="pin-tag call ${kind}">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>`);
  callouts[kind] = p;
  return top;
}
function markWords(node, label, kind, top) {
  if (!node || !label) return;
  const words = String(label).replace(/[’']/g, "'").split(/\s+/).filter((w) => w.length > 2).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch));
  if (!words.length) return;
  // the whole label if it's there, else its longest word
  const html = node.innerHTML;
  const whole = new RegExp(words.join("[\\s']*"), 'i');
  const one = new RegExp(words.sort((a, b) => b.length - a.length)[0], 'i');
  const re = whole.test(html) ? whole : one;
  if (!re.test(html)) return;
  node.innerHTML = html.replace(re, (w) => `<mark class="spot ${kind}">${w}</mark>`);
  const mk = node.querySelector('mark.spot:last-of-type');
  if (mk && top) mk.onclick = () => city.look(top.clone ? top.clone().setY(0) : new THREE.Vector3(top.x, 0, top.z), 220, 1.0, null, 1.6);
}
async function onHighlight(e) {
  if (e.kind === 'seen') {
    const top = await callout('seen', e.lat, e.lng, e.label, e.said ? `"${e.said}"` : 'rider is here');
    const last = [...document.querySelectorAll('#stream .msg.rider .b, #stream .msg.caller .b')].pop();
    markWords(last, e.label, 'seen', top);
  } else if (e.kind === 'target') {
    const top = await callout('target', e.lat, e.lng, 'Next: ' + e.label, 'sending him here');
    pendingTarget = { label: e.label, top };
  }
}
// ---- teaching the door by voice: the path is drawn stop by stop as Sam describes it
function beginTeaching() {
  teaching = { stops: [] };
  city.setPath([]);
  pins.filter((p) => p.kind === 'stop').forEach((p) => p.node.remove());
  pins = pins.filter((p) => p.kind !== 'stop');
  const r = $('#ribbon'); r.innerHTML = '';
  r.append(el('div', 'stop now', '<span class="num">…</span><span class="lbl">Learning the way from Sam</span>'));
  status('Learning the door path', true); tag('Teaching', 'live');
}
async function taughtStop(s) {
  if (!teaching) beginTeaching();
  teaching.stops.push(s);
  if (teaching.stops.length > 1) city.setPath(teaching.stops);
  city.setProgress(teaching.stops.length - 1);
  const top = await callout('taught', s.lat, s.lng, s.n === 0 ? s.label : `Step ${s.n}: ${cap(s.label)}`, s.n === 0 ? 'starting landmark' : 'just learned');
  const last = [...document.querySelectorAll('#stream .msg.customer .b')].pop();
  markWords(last, s.label, 'taught', top);
  // the ribbon grows as it learns
  const r = $('#ribbon');
  r.querySelector('.stop.now')?.remove();
  r.append(stopNode(s.n === 0 ? 'S' : s.n, s.n === 0 ? clip(s.label) : stopLabel(s), 'done'));
  r.append(el('div', 'stop now', '<span class="num">…</span><span class="lbl">listening</span>'));
  city.look(top.clone ? top.clone().setY(0) : new THREE.Vector3(top.x, 0, top.z), 230, 1.02, null, 2.0);
}
function teachDoor(d) {
  const r = $('#ribbon');
  r.querySelector('.stop.now')?.remove();
  const done = r.querySelectorAll('.stop.done');
  if (done.length > 2) done[done.length - 1].remove();
  r.append(stopNode('⌂', doorText(d), 'home now'));
}
async function doneTeaching() {
  try { door = await (await fetch('/api/door')).json(); } catch {}
  teaching = null;
  status('Door path learned', false, true); tag('Saved', 'done');
  // redraw everything from the saved door
  if (home) { taught = !!door && distKm(home, lastStep()) < 0.4; if (taught) { city.setPath([door.anchor, ...door.steps]); renderRibbon(); riderStep = -1; markRibbon(); } }
}
// ======================= receiving or sending =======================
// first run: the neighbourhood builds behind the question
async function showRole() {
  if (!city.home) await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: 'HSR Layout' }, false, { sender: true });
  $('#onboard').hidden = false; $('#roleCard').hidden = false; $('#senderCard').hidden = true; $('#homeCard').hidden = true; veil(false); status('Welcome', false);
}
let SENDERS = [], sender = null;
const fleet = new Map(); // order -> { o, pin, drop, cur, target }
async function pickSender() {
  SENDERS = await (await fetch('/api/senders')).json();
  const b = $('#brands'); b.innerHTML = '';
  for (const x of SENDERS) {
    const btn = el('button', 'brand-pick', `<i style="background:${x.colour}">${esc(x.name[0])}</i><span><b>${esc(x.name)}</b><small>${esc(x.kind)}</small></span>`);
    btn.onclick = () => { localStorage.setItem('ttd-role', 'sender:' + x.id); startSender(x.id); };
    b.append(btn);
  }
  $('#roleCard').hidden = true; $('#senderCard').hidden = false;
}
async function startSender(id) {
  sender = await (await fetch('/api/sender?id=' + encodeURIComponent(id))).json();
  if (sender.error) { localStorage.removeItem('ttd-role'); return showRole(); }
  document.body.classList.add('role-sender');
  $('#onboard').hidden = true;
  $('#roleLabel').textContent = 'Sending as';
  $('#household').textContent = sender.name;
  $('#senderPanel').hidden = false;
  $('#guideNumber').textContent = sender.guide_number;
  $('#apiKey').textContent = sender.api_key;
  const e = $('#empty');
  if (e) { e.querySelector('h3').textContent = 'No rider needs help right now'; e.querySelector('p').textContent = `When a ${sender.name} rider can't find the door and taps Call customer, ToTheDoor answers. The call shows up here, and on the map.`; }
  $('#dock').hidden = true; $('#viewToggle').hidden = true; setView('map');
  document.querySelector('.phone-head').firstChild.nextSibling.textContent = "Sam's phone · a receiver";
  renderSenderStats(sender.stats);
  renderOrders();
  $('#ribbon').parentElement.hidden = true;
  await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: 'HSR Layout' }, false, { sender: true });
  status(`${sender.name} · watching deliveries`, false);
}
function renderSenderStats(st) {
  const fmt = (n) => n.toLocaleString('en-IN');
  const m = Math.floor(st.avg_stuck_to_door_s / 60), sec = st.avg_stuck_to_door_s % 60;
  $('#senderStats').innerHTML = [[fmt(st.deliveries), 'Deliveries today'], [fmt(st.guided), 'Guided to the door'], [fmt(st.saved), 'Saved from failing'], [`${m}:${String(sec).padStart(2, '0')}`, 'Stuck to door, avg']]
    .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
}
let statsT = null;
const refreshStats = () => { clearTimeout(statsT); statsT = setTimeout(async () => { if (!sender) return; const s2 = await (await fetch('/api/sender?id=' + sender.id)).json(); renderSenderStats(s2.stats); }, 400); };
const ST = { assigned: 'Assigned', picked_up: 'Picked up', en_route: 'On the way', arrived: 'At the door', stuck: "Can't find it", guiding: 'ToTheDoor guiding', delivered: 'Delivered', failed: 'Failed' };
function renderOrders() {
  const ol = $('#orders'); ol.innerHTML = '';
  if (!fleet.size) { ol.append(el('li', 'none', 'No riders out. Run a delivery shift to see them on the map.')); return; }
  const rank = (o) => (o.status === 'guiding' || o.status === 'stuck' ? 0 : o.status === 'delivered' ? 2 : 1);
  for (const f of [...fleet.values()].reverse().sort((x, y) => rank(x.o) - rank(y.o))) {
    const o = f.o, ready = !!o.guided;
    const li = el('li', 'order' + (o.status === 'guiding' ? ' guided' : ''), `<span class="who"><b>${esc(o.rider.name)}</b> → ${esc(o.receiver.name)}</span><span class="st ${o.status}">${ST[o.status] || o.status}</span><span class="to">${esc(o.order_id)} · ${esc(o.receiver.area || 'HSR Layout')}</span><span class="tagline ${ready ? 'ready' : 'ask'}">${ready ? 'Doorstep directions ready' : 'Asked in the app to add doorstep directions'}</span>`);
    li.onclick = () => f.cur && city.look(f.cur.clone().setY(0), 260, 1.0, null, 1.6);
    ol.append(li);
  }
}
function onOrder(e) {
  if (!sender || e.sender !== sender.id) return;
  if (e.type === 'order.created') {
    const o = { id: e.order, order_id: e.order_id, receiver: e.receiver, rider: e.rider, status: 'assigned', guided: e.guided };
    const r = e.receiver;
    const drop = Number.isFinite(r.lat) ? addPin({ lat: r.lat, lng: r.lng }, 'drop', `<div class="drop-dot"></div><div class="pin-tag">${esc(r.name)}</div>`) : null;
    if (drop && e.guided) drop.node.classList.add('ready');
    fleet.set(e.order, { o, drop, pin: null, cur: null, target: null });
    renderOrders();
  } else if (e.type === 'order.location') {
    const f = fleet.get(e.order); if (!f) return;
    const v = city.local(e.lat, e.lng); v.y = 6;
    if (!f.pin) {
      f.pin = addPinLocal(v.clone(), 'fleet', `<div class="fleet-dot" style="background:${SENDERS.find((x) => x.id === sender.id)?.colour || sender.colour}"></div><div class="pin-tag">${esc(f.o.rider.name)}</div>`);
      f.cur = v.clone();
    }
    f.target = v;
    if (f.o.status !== e.status) { f.o.status = e.status; renderOrders(); }
  } else if (e.type === 'order.status') {
    const f = fleet.get(e.order); if (!f) return;
    f.o.status = e.status;
    if (f.pin) { f.pin.node.classList.toggle('stuck', e.status === 'stuck'); f.pin.node.classList.toggle('delivered', e.status === 'delivered'); }
    // ToTheDoor takes the call: this rider's door path appears, and the call view follows him from here
    if (e.status === 'guiding') {
      if (f.pin) f.pin.node.hidden = true;
      taught = true; city.setPath([door.anchor, ...door.steps]);
      $('#ribbon').parentElement.hidden = false; renderRibbon();
    }
    renderOrders(); refreshStats();
  }
}
// riders glide between their location pings
addFrameHook(() => { for (const f of fleet.values()) if (f.pin && f.target) { f.cur.lerp(f.target, 0.06); f.pin.world.copy(f.cur); } });
// ---- receiver: which senders may guide riders with this door path
async function renderConsent() {
  const box = $('#consent'); if (!box) return;
  const [list, c] = await Promise.all([fetch('/api/senders').then((r) => r.json()), fetch('/api/consent').then((r) => r.json())]);
  box.innerHTML = '<span class="lbl">Riders guided with your door path</span>';
  for (const x of list) {
    const b = el('button', '', esc(x.name)); b.setAttribute('aria-pressed', String(c[x.id] !== false));
    b.onclick = async () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: x.id, allowed: on }) }); };
    box.append(b);
  }
}
// ======================= guard =======================
function showGuard(id, caller) { pendingApproval = id; $('#guardSays').textContent = `"${caller}"`; $('#guard').hidden = false; tag('Checking', 'stop'); status('Unknown caller · asking Sam', true); }
function hideGuard(st) {
  $('#guard').hidden = true; pendingApproval = null;
  if (st === 'blocked') { think('<b>Blocked by Sam</b> · no address shared', 'bad'); tag('Blocked', 'stop'); }
  if (st === 'allowed') { think('<b>Allowed by Sam</b>', 'ok'); tag('Live', 'live'); }
}
async function resolve(st) { if (!pendingApproval) return; await fetch('/api/approvals/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_id: pendingApproval, status: st }) }); }

// the scripted demo calls come with recorded lines: play each as it appears in the transcript
const voice = new Audio();
function playLine(src) { voice.pause(); voice.src = src; voice.play().catch(() => {}); }
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
    case 'visit.awaiting': setExpecting(false); refreshExpect(); status('Rider says delivered · waiting for Sam', true); tag('Confirming', 'live'); break;
    case 'visit.closed': setExpecting(false); refreshExpect(); answered(e.visit); if (e.status === 'not_received') { status('Not received · flagged', false); tag('Not received', 'stop'); } if (e.status === 'delivered') { status('Delivered', false, true); tag('Delivered', 'done'); riderStep = $('#ribbon').children.length - 1; markRibbon(); if (home) setTimeout(() => city.look(city.home.clone(), 260, 0.9, null, 2.6), 900); } break;
    case 'call.started':
      callKind = e.kind || 'guide'; clearCallouts(); city.clearHighlights?.();
      if (callKind === 'line') onLineStart(e); else live = null;
      startCall(e.caller || 'Rider');
      if (callKind === 'calibration') { setView('map'); beginTeaching(); }
      break;
    case 'call.line': line(e.role, e.text); if (e.audio) playLine(e.audio); break;
    case 'call.ended': endCall(); if (live && live.kind !== 'delivery' && !sender) { status('Answering for Sam', false, true); tag('Done', 'done'); clearTimeout(backT); backT = setTimeout(() => { if (!callActive) showLineView(); }, 9000); } break;
    case 'tool.call': lastNext = { tool: e.tool, args: e.args }; break;
    case 'tool.result': {
      const args = e.args || (lastNext?.tool === e.tool ? lastNext.args : null);
      onLineTool(e.tool, e.out, args);
      const r = reasonFor(e.tool, e.out, args); if (r) think(r[0], r[1]);
      break;
    }
    case 'line.ended': onLineEnded(e); break;
    case 'line.updated': reloadLine(); break;
    case 'map.highlight': onHighlight(e); break;
    case 'order.created': case 'order.location': case 'order.status': onOrder(e); break;
    case 'calib.anchor': taughtStop({ lat: e.lat, lng: e.lng, label: e.name, n: 0 }); break;
    case 'calib.step': taughtStop({ lat: e.lat, lng: e.lng, label: e.label, n: e.n }); break;
    case 'calib.door': teachDoor(e); break;
    case 'calib.done': doneTeaching(); break;
    case 'rider.placed': placeRider(e, e.step, e.label); break;
    // live GPS (Telegram or a sender's rider app): move the marker, don't swing the camera every ping; a sender's view
    // shows its riders as the fleet instead
    case 'rider.position': if (e.mode !== 'sim' && !sender) placeRider(e, -1, 'live location', { frame: !riderPin }); break;
    case 'notify': tg(e.text, 'bot', e.buttons); break;
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

// ======================= time and weather =======================
// The map always shows the real time and weather at the home, like a maps app: nothing to drag or toggle.
// ?hour=22 and ?rain fix them for screenshots only.
const fmtHour = (h) => { const m = Math.floor((h % 1) * 60), hh = Math.floor(h) % 24; return `${hh % 12 || 12}:${String(m).padStart(2, '0')} ${hh < 12 ? 'am' : 'pm'}`; };
// WMO weather codes (Open-Meteo) -> a word
const sky = (code, clouds) => {
  if (code == null) return '';
  if (code >= 95) return 'Thunderstorm';
  if (code >= 80) return 'Showers';
  if (code >= 61) return 'Rain';
  if (code >= 51) return 'Drizzle';
  if (code >= 45) return 'Fog';
  if (code >= 3) return 'Cloudy';
  if (code >= 1 || clouds > 40) return 'Partly cloudy';
  return 'Clear';
};
function bindClock() {
  const label = $('#tLabel'), icon = $('#tIcon'), wx = $('#tWx');
  const qs = new URLSearchParams(location.search);
  const fixed = parseFloat(qs.get('hour'));
  if (!Number.isNaN(fixed)) city.setHour(fixed);
  const fixedRain = qs.has('rain');
  if (fixedRain) city.setRain?.(1);
  async function liveWeather() {
    if (!home) return;
    try {
      const w = await (await fetch(`/api/weather?lat=${home.lat}&lng=${home.lng}`)).json();
      city.setSun?.(w);
      if (!fixedRain) city.setRain?.(w.rain || 0);
      const word = fixedRain ? 'Rain' : sky(w.code, w.clouds);
      wx.textContent = [w.temp != null ? `${Math.round(w.temp)}°` : '', word].filter(Boolean).join(' ');
      wx.hidden = !wx.textContent;
    } catch { /* offline: keep what is shown */ }
  }
  setInterval(liveWeather, 10 * 60 * 1000);
  window.addEventListener('ttd-home', liveWeather);
  liveWeather();
  let last = '';
  addFrameHook(() => {
    const h = city.hour, txt = fmtHour(h);
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
  $('#pickReceiver').onclick = () => { localStorage.setItem('ttd-role', 'receiver'); $('#roleCard').hidden = true; $('#homeCard').hidden = false; status('Set your home', false); };
  $('#pickSender').onclick = () => pickSender();
  $('#backRole').onclick = () => showRole();
  $('#runShift').onclick = async () => { for (const f of fleet.values()) { f.pin?.node.remove(); f.drop?.node.remove(); pins = pins.filter((p) => p !== f.pin && p !== f.drop); } fleet.clear(); renderOrders(); await fetch('/api/demo/fleet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sender: sender?.id }) }); };
  $('#allow').onclick = () => resolve('allowed');
  $('#block').onclick = () => resolve('blocked');
  $('#teachDemo').onclick = async () => {
    lockDock(true);
    if (!home) await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: "Sam's home" });
    setView('map');
    await fetch('/api/demo/teach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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
  $('#onboard').hidden = false; $('#roleCard').hidden = true; $('#senderCard').hidden = true; $('#homeCard').hidden = false; veil(false); status('Set your home', false);
}

// ======================= Sam's line =======================
// The left panel shows the line (who it knows, rules, briefings, the call log) between calls, and what the agent is
// thinking during a call. The map only comes up when the call turns out to be a delivery or cab, or when Sam teaches
// the door.
let LINE = null, live = null, view = 'mind', backT = null;
const KLABEL = { close: 'Close one', vip: 'VIP', known: 'Known', service: 'Service', sales: 'Sales / spam', delivery: 'Delivery / cab', unknown: 'Unknown', blocked: 'Blocked' };
const KORDER = ['close', 'vip', 'known', 'service', 'delivery', 'sales', 'blocked', 'unknown'];
const KCOLOR = { close: '#7a5a12', vip: '#5b2f80', known: '#1f4a73', service: '#1c5a3b', sales: '#7a2420', blocked: '#7a2420', delivery: '#f5b84a', unknown: '#3b3b36' };
const showNum = (n) => { const m = String(n || '').match(/^\+91(\d{5})(\d{5})$/); return m ? `+91 ${m[1]} ${m[2]}` : n || 'Unknown number'; };
const kchip = (k) => `<span class="kchip ${esc(k)}">${esc(KLABEL[k] || k)}</span>`;
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

function setView(v) {
  view = v;
  const st = document.querySelector('.stage');
  st.classList.toggle('view-map', v === 'map'); st.classList.toggle('view-mind', v !== 'map');
  $('#viewToggle').textContent = v === 'map' ? "Sam's line" : 'Door map';
}
function showLineView() { clearTimeout(backT); $('#liveView').hidden = true; $('#lineView').hidden = false; if (!sender) setView('mind'); }

async function loadLine() {
  try { LINE = await (await fetch('/api/line')).json(); } catch { return; }
  renderLine(); renderDock();
}
let lineT = null;
const reloadLine = () => { clearTimeout(lineT); lineT = setTimeout(loadLine, 250); };

function renderLine() {
  const P = LINE.profile;
  document.querySelectorAll('#modeSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.mode === P.mode); b.setAttribute('aria-pressed', String(b.dataset.mode === P.mode)); });
  $('#modeNote').textContent = { available: 'Sam is available: close ones and VIPs can get him right away. Everyone else is handled by the rules.', busy: `Sam is in a meeting${P.busy_until ? ' till ' + P.busy_until : ''}: everyone hears he's busy, messages go to his phone.`, sleep: 'Sam is asleep: nobody reaches him unless they say his code.' }[P.mode];
  $('#codeVal').textContent = $('#codeChip').dataset.show ? P.passcode : '•••••';
  // the call log
  const log = $('#callLog'); log.innerHTML = '';
  if (!LINE.calls.length) log.append(el('li', 'none-note', 'No calls yet. Try one from the right.'));
  for (const c of LINE.calls) {
    const over = c.budget && c.seconds > c.budget;
    const who = c.name ? `${c.name}${c.org && c.org !== c.name ? ' · ' + c.org : ''}` : c.org || showNum(c.number);
    const learn = c.learned === 'blocked' ? '<span class="learn blocked">Blocked: next time it hangs up without talking</span>' : c.learned === 'saved' ? `<span class="learn">Saved ${esc(showNum(c.number))} as ${esc((KLABEL[c.kind] || c.kind).toLowerCase())}</span>` : '';
    log.append(el('li', '', `<span class="w">${kchip(c.kind)}<span>${esc(who)}</span></span><span class="t${over ? ' over' : ''}">${c.seconds}s${c.budget ? ' / ' + c.budget + 's' : ''}</span><span class="s">${esc(c.summary || c.outcome)}</span>${learn}`));
  }
  // briefings
  const bl = $('#briefList'); bl.innerHTML = '';
  if (!LINE.briefings.length) bl.append(el('p', 'none-note', 'No briefings. Tell it about a call you expect.'));
  for (const b of LINE.briefings) {
    const node = briefNode(b);
    const x = el('button', 'x', '×'); x.title = 'Remove'; x.setAttribute('aria-label', 'Remove briefing');
    x.onclick = async () => { await post('/api/briefings/delete', { id: b.id }); loadLine(); };
    node.append(x); bl.append(node);
  }
  // people
  const pl = $('#peopleList'); pl.innerHTML = '';
  const ppl = [...LINE.people].sort((a, b) => KORDER.indexOf(a.kind) - KORDER.indexOf(b.kind));
  for (const p of ppl) {
    const li = el('li', '', `<span>${esc(p.name || p.org || 'Unnamed')} <span class="rel">${esc(p.relation || '')}</span><small>${esc(p.shown)}${p.calls ? ` · ${p.calls} call${p.calls > 1 ? 's' : ''}` : ''}</small></span>${kchip(p.kind)}`);
    const x = el('button', 'x', '×'); x.title = 'Forget'; x.setAttribute('aria-label', 'Forget ' + (p.name || p.shown));
    x.onclick = async () => { await post('/api/people/forget', { number: p.number }); loadLine(); };
    li.append(x); pl.append(li);
  }
  // rules
  const rl = $('#rules'); rl.innerHTML = '';
  for (const k of ['close', 'vip', 'known', 'service', 'sales', 'delivery', 'unknown']) {
    const r = P.rules[k]; if (!r) continue;
    const row = el('div', 'rule', `<label>${kchip(k)}</label><textarea rows="2" aria-label="Rule for ${esc(KLABEL[k])}">${esc(r.say)}</textarea><input type="number" min="5" max="600" value="${r.budget}" aria-label="Seconds for ${esc(KLABEL[k])}" title="Time limit, seconds" />`);
    const [ta, inp] = [row.querySelector('textarea'), row.querySelector('input')];
    ta.onchange = () => post('/api/line/rule', { kind: k, say: ta.value });
    inp.onchange = () => post('/api/line/rule', { kind: k, budget: Number(inp.value) });
    rl.append(row);
  }
}
function briefNode(b) {
  const li = (cls, arr) => arr.map((x) => `<li class="${cls}">${esc(x)}</li>`).join('');
  return el('div', 'brief', `<b>${esc(b.who)}</b><span class="src">${esc(b.source || '')}</span><p>${esc(b.about)}${b.goal ? ' ' + esc(b.goal) : ''}</p><ul>${li('ok', b.can_agree || [])}${li('no', b.must_not || [])}${li('pv', b.private || [])}</ul>`);
}

// ---- the try-it dock: call the line as one of these people, or talk to it yourself
function renderDock() {
  const box = $('#personas'); box.innerHTML = '';
  const list = [...(LINE.personas || []), { id: 'delivery', label: 'Zepto rider', sub: 'Delivery Sam expects' }];
  for (const p of list) {
    const b = el('button', 'persona', `<b>${esc(p.label)}</b><small>${esc(p.sub)}</small>`);
    b.onclick = () => demoCall(p.id);
    box.append(b);
  }
  const sel = $('#talkAs'), was = sel.value; sel.innerHTML = '';
  sel.append(el('option', '', 'Calling from a new number'));
  sel.lastChild.value = 'new';
  for (const p of LINE.people.filter((x) => x.kind !== 'blocked')) { const o = el('option', '', `As ${esc(p.name || p.org || p.shown)} (${esc(p.shown)})`); o.value = p.number; sel.append(o); }
  if (was) sel.value = was;
  lockDock(callActive);
}
function lockDock(on) { document.querySelectorAll('#personas .persona').forEach((b) => (b.disabled = on)); $('#teachDemo').disabled = on; }
async function demoCall(id) {
  lockDock(true);
  if (id === 'delivery') {
    if (!taught) await setHome({ lat: lastStep().lat, lng: lastStep().lng, label: "Sam's home" });
    await post('/api/demo/replay', {});
  } else await post('/api/demo/call', { persona: id });
}

// ---- talking to the line from the browser (Bolna web call)
let webCall = null;
async function toggleTalk() {
  const btn = $('#talkBtn'), hint = $('#callHint');
  if (webCall) { await webCall.stop().catch(() => {}); return; }
  if (!LINE?.web_call) { hint.textContent = 'Talking to it needs the live server (web calls are off here). Try the calls above.'; return; }
  if (!window.BolnaWebCall) { hint.textContent = "The call library didn't load. Check the connection and reload."; return; }
  const from = $('#talkAs').value;
  const number = from === 'new' ? '+9190' + String(Math.floor(10000000 + Math.random() * 89999999)) : from;
  hint.textContent = 'Connecting… allow the microphone.';
  btn.disabled = true;
  webCall = new window.BolnaWebCall({
    getSession: async () => {
      const r = await post('/api/webcall/session', { user_data: { caller_number: number } });
      if (r.error) throw new Error(r.error);
      return r;
    },
  });
  webCall.on('call-start', () => { btn.disabled = false; btn.classList.add('on'); btn.querySelector('span').textContent = 'Hang up'; hint.textContent = 'You are on Sam\'s line. Say who you are and why you called.'; });
  webCall.on('call-end', () => { webCall = null; btn.disabled = false; btn.classList.remove('on'); btn.querySelector('span').textContent = 'Talk to it'; hint.textContent = ''; });
  webCall.on('error', (e) => { hint.textContent = e.code === 'microphone_denied' ? 'Microphone blocked. Allow it in the browser and try again.' : e.code === 'at_capacity' ? 'The line is busy. Try again shortly.' : `Couldn't connect: ${e.message || e.code}`; });
  try { await webCall.start(); } catch (e) { hint.textContent = `Couldn't connect: ${e.message}`; webCall = null; btn.disabled = false; }
}

// ---- during a call: the agent's picture of who this is and what it's doing
function onLineStart(e) {
  clearTimeout(backT);
  live = { number: e.number || '', start: Date.now(), kind: 'unknown', budget: null, ended: false };
  if (!sender) setView('mind');
  $('#lineView').hidden = true; $('#liveView').hidden = false;
  $('#lcName').textContent = showNum(live.number);
  $('#lcSub').textContent = 'Looking up the number…';
  $('#lcAv').textContent = '#'; $('#lcAv').style.background = '';
  $('#lcKinds').innerHTML = KORDER.filter((k) => k !== 'blocked').map((k) => `<span class="kchip ${k}" data-k="${k}">${KLABEL[k]}</span>`).join('');
  setLiveKind('unknown', true);
  $('#lcKnow').innerHTML = '<p class="none-note">Checking who this is…</p>';
  $('#lcRule').textContent = '—'; $('#lcTime').textContent = ''; $('#lcBar').style.width = '0'; $('#lcBar').className = '';
  $('#lcBriefBox').hidden = true; $('#lcOutBox').hidden = true; $('#lcSteps').innerHTML = '';
}
function setLiveKind(k, sorting = false) {
  live.kind = k;
  $('#lcKind').outerHTML = `<span class="kchip ${k}" id="lcKind">${sorting ? 'Sorting…' : KLABEL[k] || k}</span>`;
  document.querySelectorAll('#lcKinds .kchip').forEach((c) => c.classList.toggle('on', !sorting && (c.dataset.k === k || (k === 'blocked' && c.dataset.k === 'sales'))));
  if (!sorting) { $('#lcAv').style.background = KCOLOR[k] || ''; $('#lcAv').style.color = k === 'delivery' ? '#2a1f08' : '#fff'; }
}
function liveStep(html, cls = '') { const s = el('li', cls, html); $('#lcSteps').append(s); }
function liveRule(kind, budget) {
  const r = LINE?.profile?.rules?.[kind];
  if (r) $('#lcRule').textContent = r.say;
  live.budget = budget || r?.budget || null;
}
function liveWho(name, sub) {
  if (name) { $('#lcName').textContent = name; $('#lcAv').textContent = name.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, '').charAt(0).toUpperCase(); $('#callerName').textContent = name; $('#callerAvatar').textContent = $('#lcAv').textContent; }
  if (sub != null) $('#lcSub').textContent = sub;
}
function onLineTool(tool, out, args) {
  if (!live) return;
  if (tool === 'lookup_caller') {
    if (out.blocked) {
      setLiveKind('blocked'); liveWho(out.name || 'Blocked number', `${showNum(live.number)} · blocked`);
      $('#lcKnow').innerHTML = `<div class="know">${esc(out.note || 'Marked as spam')}<div class="k">Called ${out.calls || 1} time${(out.calls || 1) > 1 ? 's' : ''} before</div></div>`;
      $('#lcRule').textContent = 'Blocked numbers are cut off without talking.';
      liveStep('<b>Blocked number</b> · hanging up without talking', 'bad');
    } else if (out.known) {
      setLiveKind(out.kind); liveWho(out.name, `${showNum(live.number)} · ${out.relation || KLABEL[out.kind]}`);
      $('#lcKnow').innerHTML = `<div class="know">${esc(out.name)}, Sam's ${esc(out.relation || KLABEL[out.kind].toLowerCase())}<div class="k">${out.calls ? `Called ${out.calls} time${out.calls > 1 ? 's' : ''} before${out.last_summary ? ': ' + esc(out.last_summary) : ''}` : 'In Sam\'s contacts'}</div></div>`;
      liveRule(out.kind, out.budget);
      liveStep(`<b>Knows this number</b> · ${esc(out.name)}, ${esc(KLABEL[out.kind].toLowerCase())} · greeting by name, not asking who`, 'ok');
      if (out.briefing) showBrief(out.briefing);
    } else {
      $('#lcSub').textContent = `${showNum(live.number)} · first call`;
      $('#lcKnow').innerHTML = '<p class="none-note">Not in Sam\'s contacts. Never called before.</p>';
      liveStep('<b>Unknown number</b> · asking who it is and why, not saying Sam is away yet');
    }
    liveStep(`Mode: <b>${esc({ available: 'Sam available', busy: 'Sam in a meeting', sleep: 'Sam asleep' }[out.mode] || out.mode || '')}</b>`);
  } else if (tool === 'classify_caller') {
    const name = [args?.name, args?.org].filter(Boolean).join(' · ');
    setLiveKind(out.kind);
    if (name) liveWho(name, null);
    liveRule(out.kind, out.budget);
    liveStep(`heard <b>"${esc(args?.purpose || args?.org || '')}"</b> → ${esc(KLABEL[out.kind])}${out.budget ? ` · ${out.budget}s limit` : ''}`, out.kind === 'sales' ? 'bad' : 'ok');
    if (out.briefing) showBrief(out.briefing);
    if (out.kind === 'delivery') {
      liveStep(out.verified ? `<b>Expected ${esc(cap(out.service))} order</b> · opening the door map` : '<b>Not expected</b> · asking Sam before giving anything away', out.verified ? 'ok' : 'bad');
      if (out.verified) setTimeout(() => setView('map'), 900);
    }
  } else if (tool === 'check_passcode') liveStep(out.ok ? '<b>Code correct</b> · Sam alerted to call back now' : '<b>Wrong code</b> · not alerting Sam', out.ok ? 'ok' : 'bad');
  else if (tool === 'take_message') liveStep(`<b>Message to Sam</b> · ${esc(args?.message || '')}`, 'ok');
  else if (tool === 'alert_owner') liveStep(`<b>Alerted Sam</b> · ${esc(args?.reason || '')}`, 'bad');
  else if (tool === 'end_call') liveStep('<b>Logged</b> · telling Sam what happened', 'ok');
}
function showBrief(b) {
  $('#lcBriefBox').hidden = false;
  const box = $('#lcBrief'); box.innerHTML = ''; box.append(briefNode(b));
  liveStep(`<b>Using briefing</b> · ${esc(b.who)}`, 'ok');
}
function onLineEnded(rec) {
  if (!live) return;
  live.ended = true;
  const over = rec.budget && rec.seconds > rec.budget;
  $('#lcOutBox').hidden = false;
  $('#lcOut').innerHTML = `<p>${esc(rec.summary || rec.outcome)}</p><p class="none-note">${rec.seconds}s${rec.budget ? ` of ${rec.budget}s allowed${over ? ' · over time' : ''}` : ''}</p>${rec.learned === 'blocked' ? '<p class="learned blocked">Blocked this number: next time it hangs up without talking.</p>' : rec.learned === 'saved' ? `<p class="learned">Saved ${esc(showNum(rec.number))} as ${esc((KLABEL[rec.kind] || '').toLowerCase())}.</p>` : ''}`;
  reloadLine();
}
// the time limit for this kind of caller, filling up as the call goes
setInterval(() => {
  if (!live || live.ended || !live.budget) return;
  const s = Math.round((Date.now() - live.start) / 1000), f = s / live.budget;
  $('#lcBar').style.width = Math.min(100, f * 100) + '%';
  $('#lcBar').className = f > 1 ? 'over' : f > 0.75 ? 'warn' : '';
  $('#lcTime').textContent = f > 1 ? `${s}s · ${s - live.budget}s over` : `${s}s of ${live.budget}s`;
}, 500);

function bindLine() {
  $('#viewToggle').onclick = () => { if (view === 'map') { setView('mind'); if (!live || live.ended) showLineView(); } else setView('map'); };
  $('#backLine').onclick = showLineView;
  document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = async () => { await post('/api/line/mode', { mode: b.dataset.mode }); loadLine(); }));
  $('#codeChip').onclick = () => { const c = $('#codeChip'); if (c.dataset.show) delete c.dataset.show; else c.dataset.show = '1'; renderLine(); };
  $('#personAdd').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const r = await post('/api/people', Object.fromEntries(f));
    if (r) { ev.target.reset(); loadLine(); }
  };
  $('#briefSample').onclick = () => { $('#briefText').value = LINE?.sample_chat || ''; };
  $('#briefRead').onclick = async () => {
    const btn = $('#briefRead'), d = $('#briefDraft');
    btn.disabled = true; btn.textContent = 'Reading…';
    const r = await post('/api/briefings/import', { text: $('#briefText').value });
    btn.disabled = false; btn.textContent = 'Read it';
    d.hidden = false; d.innerHTML = '';
    if (r.error) { d.append(el('p', 'none-note', esc(r.error))); return; }
    d.append(el('p', 'none-note', 'Check it before the agent uses it:'));
    d.append(briefNode(r.draft));
    const row = el('div', 'row'); const ok = el('button', 'small primary', 'Use this briefing'); const no = el('button', 'small ghostbtn', 'Discard');
    ok.onclick = async () => { await post('/api/briefings', r.draft); d.hidden = true; $('#briefText').value = ''; loadLine(); };
    no.onclick = () => { d.hidden = true; };
    row.append(ok, no); d.append(row);
  };
  $('#talkBtn').onclick = toggleTalk;
}
