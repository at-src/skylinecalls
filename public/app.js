// ToTheDoor live dashboard. Listens to the server event stream and drives the map, the call panel and the door strip.
const $ = (s) => document.querySelector(s);
const stream = $('#stream'), emptyState = $('#emptyState'), doorRow = $('#doorRow');
const statusPill = $('#statusPill'), guard = $('#guard'), guardSays = $('#guardSays'), legend = $('#legend');

let cfg, door, map3d, map2d, marker3d, marker2d, ring, use3d = true, pendingApproval = null;

init();
async function init() {
  cfg = await (await fetch('/api/config')).json();
  door = cfg.door;
  renderDoorStrip();
  await initMaps();
  $('#b3d').onclick = () => setMode(true);
  $('#b2d').onclick = () => setMode(false);
  $('#allow').onclick = () => resolve('allowed');
  $('#block').onclick = () => resolve('blocked');
  listen();
}

// ---------- maps ----------
const home = () => ({ lat: door.anchor.lat, lng: door.anchor.lng });

async function initMaps() {
  await loadMaps();
  // 2D always available as the reliable fallback
  map2d = new google.maps.Map($('#map2d'), { center: home(), zoom: 17, mapId: 'DEMO_MAP', disableDefaultUI: true, backgroundColor: '#0d0d0d', tilt: 47, heading: 40 });
  pins2d();
  try {
    const { Map3DElement, Marker3DElement } = await google.maps.importLibrary('maps3d');
    map3d = new Map3DElement({ center: { ...home(), altitude: 60 }, tilt: 67, range: 450, heading: 40 });
    $('#map3dHost').appendChild(map3d);
    pins3d(Marker3DElement);
  } catch (e) {
    console.warn('3D unavailable, using 2D', e);
    setMode(false); $('#b3d').style.display = 'none';
  }
}
const loadMaps = () => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${cfg.mapsKey}&v=alpha&libraries=maps3d,marker`;
  s.onload = res; s.onerror = rej; document.head.appendChild(s);
});

function setMode(threeD) {
  use3d = threeD && map3d;
  $('#map3dHost').style.display = use3d ? 'block' : 'none';
  $('#map2d').style.display = use3d ? 'none' : 'block';
  $('#b3d').classList.toggle('on', use3d); $('#b2d').classList.toggle('on', !use3d);
}

function pins2d() {
  new google.maps.Marker({ position: home(), map: map2d, label: { text: '🏠', fontSize: '20px' } });
  door.steps.forEach((st) => new google.maps.Marker({ position: { lat: st.lat, lng: st.lng }, map: map2d, label: { text: String(st.n), color: '#fff', fontSize: '12px' }, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: '#ffbf1f', fillOpacity: 0.9, strokeColor: '#131209', strokeWeight: 2 } }));
  (door.hubs || []).forEach((h) => new google.maps.Marker({ position: { lat: h.lat, lng: h.lng }, map: map2d, label: { text: h.name, color: '#9b9b9b', fontSize: '11px' }, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: '#5ab0ff', fillOpacity: 0.7, strokeWeight: 0 } }));
  ring = new google.maps.Circle({ map: map2d, center: home(), radius: 400, strokeColor: '#ffbf1f', strokeOpacity: 0.7, strokeWeight: 2, fillColor: '#ffbf1f', fillOpacity: 0.07, visible: false });
  marker2d = new google.maps.Marker({ position: home(), map: map2d, visible: false, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#5ab0ff', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 } });
}
async function pins3d(Marker3DElement) {
  const mk = (p, label) => { const m = new Marker3DElement({ position: { ...p, altitude: 30 }, label, altitudeMode: 'RELATIVE_TO_GROUND', extruded: true }); map3d.appendChild(m); return m; };
  mk(home(), '🏠 Home');
  door.steps.forEach((st) => mk({ lat: st.lat, lng: st.lng }, String(st.n)));
  (door.hubs || []).forEach((h) => mk({ lat: h.lat, lng: h.lng }, h.name));
  marker3d = new Marker3DElement({ position: { ...home(), altitude: 40 }, label: '🛵' });
}

function placeRider(lat, lng) {
  const p = { lat, lng };
  if (marker2d) { marker2d.setPosition(p); marker2d.setVisible(true); map2d.panTo(p); }
  if (marker3d && map3d) { marker3d.position = { ...p, altitude: 40 }; map3d.appendChild(marker3d); if (use3d) flyTo(p); }
}
function flyTo(p) { try { map3d.center = { ...p, altitude: 50 }; map3d.range = 300; } catch {} }

let ringTimer;
function setRing(on, approxRadius) {
  if (ring) { ring.setVisible(on); if (on && approxRadius) ring.setRadius(approxRadius); }
  clearInterval(ringTimer);
  if (on && ring) { let grow = true; ringTimer = setInterval(() => { const r = ring.getRadius(); ring.setRadius(grow ? r * 1.06 : r / 1.06); grow = !grow; }, 700); }
}

// ---------- door strip ----------
function renderDoorStrip() {
  doorRow.innerHTML = '';
  const cells = [{ n: 0, t: door.anchor.name }, ...door.steps.map((s) => ({ n: s.n, t: shortStep(s) }))];
  cells.forEach((c) => { const d = document.createElement('div'); d.className = 'step'; d.id = 'step' + c.n; d.innerHTML = `<div class="n">${c.n === 0 ? 'START' : 'STEP ' + c.n}</div><div class="t">${c.t}</div>`; doorRow.appendChild(d); });
}
const shortStep = (s) => (s.see && s.see[0]) ? s.see[0] : s.instruction.split('.')[0];
function lightStep(n) {
  document.querySelectorAll('.step').forEach((el) => {
    const i = Number(el.id.replace('step', ''));
    el.classList.toggle('done', i < n); el.classList.toggle('active', i === n);
  });
}

// ---------- live events ----------
function addTurn(role, text) {
  emptyState?.remove();
  const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'rider' ? 'Rider' : 'Home';
  const t = document.createElement('div'); t.className = 'turn ' + role; t.textContent = text;
  stream.append(who, t); stream.scrollTop = stream.scrollHeight;
}
function addReason(html) { const r = document.createElement('div'); r.className = 'reason'; r.innerHTML = html; stream.append(r); stream.scrollTop = stream.scrollHeight; }
function setStatus(text, live) { statusPill.textContent = text; statusPill.classList.toggle('live', !!live); }

function listen() {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch {} };
}

function handle(e) {
  switch (e.type) {
    case 'visit.created': setStatus(`${cap(e.service)} · expected`, true); setRing(true, 500); break;
    case 'visit.eta': setStatus(`${cap(e.service || 'Delivery')} · ~${e.eta_min} min`, true); setRing(true, Math.max(150, e.eta_min * 300)); break;
    case 'bolna.event': if (e.transcript) renderTranscript(e.transcript); break;
    case 'tool.verify': if (e.ok) { addReason('verified the caller ✓'); setStatus('On the line', true); } break;
    case 'tool.next': {
      const where = e.match ? e.match.replace('at:', 'at step ').replace('during:', 'near step ') : (e.seen || 'location');
      addReason(`heard <b>"${(e.seen || '').slice(0, 40)}"</b> → ${where}`);
      if (typeof e.distance_m === 'number' && e.distance_m < 60) placeRiderAtAnchor();
      break;
    }
    case 'tool.reply': if (typeof e.step === 'number') lightStep(e.step); break;
    case 'rider.position': placeRider(e.lat, e.lng); break;
    case 'notify': flashStatusFromNotify(e.text); break;
    case 'approval.requested': showGuard(e.approval, e.caller); break;
    case 'approval.resolved': hideGuard(); break;
    case 'visit.closed': setStatus(e.status === 'delivered' ? 'Delivered ✓' : 'Closed', false); setRing(false); lightStep(door.steps.length); break;
  }
}

// map milestones to the strip + rider marker from the visit step inside guide replies
function placeRiderAtAnchor() { placeRider(door.anchor.lat, door.anchor.lng); lightStep(0); }
function flashStatusFromNotify(text) {
  if (/at your door/i.test(text)) { lightStep(door.steps.length); setStatus('At the door', true); }
  else if (/reached /i.test(text)) { lightStep(0); setStatus('At the anchor', true); }
  else if (/delivered/i.test(text)) { setStatus('Delivered ✓', false); setRing(false); }
}

function renderTranscript(t) {
  // Bolna sends a rolling transcript "assistant: ..\nuser: .."; show only new lines
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last || last === window.__lastLine) return; window.__lastLine = last;
  const [role, ...rest] = last.split(':');
  addTurn(role.trim() === 'user' ? 'rider' : 'agent', rest.join(':').trim());
}

function showGuard(id, caller) { pendingApproval = id; guardSays.textContent = `"${caller}"`; guard.classList.add('show'); setStatus('Unknown caller', true); }
function hideGuard() { guard.classList.remove('show'); pendingApproval = null; }
async function resolve(status) { if (!pendingApproval) return; await fetch('/api/approvals/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approval_id: pendingApproval, status }) }); hideGuard(); }

const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
