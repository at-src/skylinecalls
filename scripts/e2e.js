// End-to-end test of the whole flow through the real HTTP tool endpoints and real Google Maps.
// Nothing is sent: no phone calls, no Telegram messages (DRY_RUN=1). Data goes to a temp folder.
// Usage: node scripts/e2e.js
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DRY_RUN = '1';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-'));
process.env.APPROVAL_WAIT_MS = '1500';
process.env.TOOL_TOKEN = 'test-token';

const { start } = await import('../src/server.js');
const { handleText } = await import('../src/telegram.js');
const { recentEvents } = await import('../src/store.js');
const PORT = 3299;
const server = await start(PORT);
const base = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  | ' + extra : ''}`); };
const tool = async (name, args) => (await fetch(`${base}/tools/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(args) })).json();
const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const say = (o) => (o.say || '').slice(0, 230);
const noDirections = (o) => !/14th Main|McDonald|blue gate|stairs|second floor|nameplate/i.test(o.say || '');

console.log('\n== 1. Nobody registered: a stranger calls asking for the address');
let r = await tool('verify_caller', { service: 'Zepto' });
check('stranger is not verified', r.verified === false, say(r));
check('no directions given', noDirections(r));
r = await tool('next_instruction', { visit_id: 'v_fake', seen: 'BDA Complex' });
check('guessing a visit id gives nothing', noDirections(r), say(r));
r = await tool('ask_customer', { caller_says: 'Zepto delivery' });
check('customer asked on Telegram, still no directions', r.approved === false && noDirections(r), say(r));
await post('/api/approvals/resolve', { approval_id: r.approval_id, status: 'blocked' });
r = await tool('check_approval', { approval_id: r.approval_id });
check('customer blocked -> refused politely', r.approved === false && /can't share/i.test(r.say), say(r));
check('Telegram approval request was raised', recentEvents().some((e) => e.type === 'approval.requested'));

console.log('\n== 2. Customer tells the bot: "I have an order with Zepto"');
const reply = handleText('I have an order with Zepto');
check('bot confirms and gives a code', /expecting Zepto/i.test(reply) && /code: \d{4}/.test(reply), reply.split('\n')[0]);
const code = reply.match(/code: (\d{4})/)[1];
const visits = (await (await fetch(base + '/api/state')).json()).visits;
const visit = visits.find((v) => v.service === 'zepto');
check('visit is active', !!visit);

console.log('\n== 3. Rider calls: says Zepto but wrong code, then right code');
r = await tool('verify_caller', { service: 'zepto' });
check('unconfirmed -> ask the customer, never asks for a code', r.need === 'customer' && /ask_customer/.test(r.say) && /Do not ask him for any code/.test(r.say), say(r));
r = await tool('verify_caller', { service: 'zepto', code: '0000' });
check('wrong code refused', r.verified === false, say(r));
r = await tool('verify_caller', { service: 'zepto', code });
check('right code verified', r.verified === true && r.visit_id === visit.id);
const vid = r.visit_id;

console.log('\n== 4. Rider is ~1.7 km away (Agara) and took a wrong turn');
await post('/api/rider/plan', { visit_id: vid, from: { lat: 12.9231, lng: 77.6510 }, via: { lat: 12.9205, lng: 77.6455 } });
r = await tool('rider_status', { visit_id: vid });
check('far zone detected from live GPS', r.zone === 'far' && r.distance_to_anchor_m > 800, `${r.distance_to_anchor_m} m, near: ${(r.around_rider || []).slice(0, 2).join('; ')}`);
r = await tool('next_instruction', { visit_id: vid, seen: '' });
check('road directions towards BDA Complex', r.zone === 'far' && /BDA Complex/.test(r.say) && /Turn|Head|Continue/i.test(r.say), say(r));

console.log('\n== 5. Rider names a place that is not on the path (off route)');
r = await tool('next_instruction', { visit_id: vid, seen: 'Agara lake' });
check('finds it on the map and steers him', r.zone === 'far' && /BDA Complex/.test(r.say), say(r));

console.log('\n== 6. Rider rides on; GPS reaches the anchor');
await post('/api/rider/advance', { visit_id: vid, metres: 1e6 });
r = await tool('rider_status', { visit_id: vid });
check('near zone once close', r.zone === 'near', `${r.distance_to_anchor_m} m`);

console.log('\n== 7. Last metres: the door path, by what he says he sees');
r = await tool('next_instruction', { visit_id: vid, seen: 'BDA complex ke gate pe hoon' });
check('at the anchor -> step 1 (towards McDonald\'s)', /step \(1 of 4\)|Next step \(1 of 4\)/.test(r.say) && /McDonald/.test(r.say), say(r));
r = await tool('next_instruction', { visit_id: vid, seen: 'abhi Travel Buddy ke saamne se jaa raha hoon' });
check('midway (passing Travel Buddy) -> keep going, same step', /keep going/i.test(r.say) && /McDonald/.test(r.say), say(r));
r = await tool('next_instruction', { visit_id: vid, seen: "haan McDonald's dikh raha hai" });
check('McDonald\'s -> blue gate', /blue iron gate/i.test(r.say), say(r));
r = await tool('next_instruction', { visit_id: vid, seen: 'blue gate pe hoon' });
check('blue gate -> past the bikes to the stairs', /bikes/i.test(r.say) && /stairs/i.test(r.say), say(r));
r = await tool('next_instruction', { visit_id: vid, seen: 'stairs ke paas' });
check('stairs -> second floor, green nameplate', /second floor/i.test(r.say) && /green nameplate/i.test(r.say), say(r));
r = await tool('next_instruction', { visit_id: vid, seen: 'green nameplate wala door' });
check('at the door -> knock, fallback ready', r.zone === 'door' && /knock/i.test(r.say), say(r));

console.log('\n== 8. Nobody opens: ring the customer, then use the fallback');
r = await tool('call_customer', { visit_id: vid, reason: 'is at the door and nobody is opening' });
check('customer rung (dry run) and fallback given', recentEvents().some((e) => e.type === 'customer.ring') && /shoe rack/i.test(r.say), say(r));
r = await tool('log_outcome', { visit_id: vid, result: 'left on the shoe rack', note: 'photo sent' });
check('outcome logged', /Logged/.test(r.say));
const st = await (await fetch(base + '/api/state')).json();
check('visit closed as delivered', !st.visits.find((v) => v.id === vid));

console.log('\n== 9. Customer messages along the way (would go to Telegram)');
const msgs = recentEvents().filter((e) => e.type === 'notify').map((e) => e.text);
msgs.forEach((m) => console.log('   ' + m.replace(/\n/g, ' ')));
check('rider-on-line, anchor, door, delivered messages sent', ['on the line', 'reached BDA Complex', 'at your', 'delivered'].every((k) => msgs.some((m) => m.includes(k))));

console.log('\n== 10. Unknown caller, customer approves live');
r = await tool('ask_customer', { caller_says: 'Rapido driver, booked by Sam' });
const ap = r.approval_id;
setTimeout(() => post('/api/approvals/resolve', { approval_id: ap, status: 'allowed' }), 300);
r = await tool('check_approval', { approval_id: ap });
check('approved -> new visit, guidance allowed', r.approved === true && r.visit_id, say(r));
r = await tool('next_instruction', { visit_id: r.visit_id, seen: 'Punjab National Bank ke saamne' });
check('PNB next to the gate counts as the anchor', /Next step \(1 of 4\)/.test(r.say), say(r));

console.log('\n== 11. Rider location shared on Telegram (live location)');
const { handleLocation } = await import('../src/telegram.js');
handleText('order with Swiggy');
const sw = (await (await fetch(base + '/api/state')).json()).visits.find((v) => v.service === 'swiggy');
let m = handleLocation({ latitude: 12.9124, longitude: 77.6375, live_period: 900 }, true);
check('first live location acknowledged', /live location/i.test(m || ''), m);
check('later live updates are silent', handleLocation({ latitude: 12.91235, longitude: 77.6376 }, true) === null);
r = await tool('rider_status', { visit_id: sw.id });
check('agent sees the Telegram position (near the door path)', r.zone === 'near', `${r.distance_to_anchor_m} m from anchor`);

console.log('\n== 12. Teaching the door by voice (calibration)');
{
  const D = JSON.parse(readFileSync(new URL('../src/demo/door-hsr.json', import.meta.url), 'utf8'));
  const st = await tool('start_calibration', { customer: 'Sam', door_id: 'test-door' });
  check('calibration starts', !!st.calibration_id, say(st));
  const cid = st.calibration_id;
  const gaps = await tool('finish_calibration', { calibration_id: cid });
  check('an empty path is not saved, and the gaps are named', gaps.complete === false && gaps.gaps.length >= 3, say(gaps));
  const an = await tool('save_anchor', { calibration_id: cid, name: D.anchor.name, lat: D.anchor.lat, lng: D.anchor.lng });
  check('landmark saved', /Found BDA Complex/.test(an.say), say(an));
  for (const s of D.steps) await tool('save_step', { calibration_id: cid, instruction: s.instruction, see: s.see, pass: s.pass, lat: s.lat, lng: s.lng, landmark: s.see[0] });
  await tool('save_door', { calibration_id: cid, ...D.door });
  await tool('save_fallback', { calibration_id: cid, ...D.fallback });
  const fin = await tool('finish_calibration', { calibration_id: cid });
  check('a complete path is saved as the door', fin.complete === true && fin.door_id === 'test-door' && /4 steps/.test(fin.say), say(fin));
  const ev = recentEvents().filter((e) => e.type === 'calib.step');
  check('each taught step reaches the live screen', ev.length === 4 && ev.every((e) => Number.isFinite(e.lat)), `${ev.length} steps`);
  const hl = recentEvents().filter((e) => e.type === 'map.highlight');
  check('what riders said was lit up on the map', hl.some((e) => e.kind === 'seen') && hl.some((e) => e.kind === 'target'), `${hl.length} highlights`);
}
console.log('\n== 13. Sender API: a company registers an order and streams the rider location');
{
  const info = await (await fetch(base + '/api/sender?id=amazon')).json();
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + info.api_key };
  const api = async (path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: auth, body: body && JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  const bad = await fetch(base + '/v1/orders', { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' });
  check('unknown sender key is rejected', bad.status === 401);
  let r = await api('/v1/orders', { order_id: 'AMZ1', receiver: { name: 'Sam', door_id: 'demo-hsr' }, rider: { name: 'Ramesh' } });
  check('order to a taught door opens a guided visit', r.status === 201 && r.j.guided && r.j.visit_id && r.j.needs_doorstep_setup === false, JSON.stringify(r.j).slice(0, 160));
  const oid = r.j.order, vid = r.j.visit_id;
  const r2 = await api('/v1/orders', { order_id: 'AMZ2', receiver: { name: 'Priya', lat: 12.9175, lng: 77.6455 } });
  check('order to an untaught door asks the customer to set up directions', r2.j.guided === false && r2.j.needs_doorstep_setup === true);
  await api(`/v1/orders/${oid}/location`, { lat: 12.91368, lng: 77.6373 });
  r = await tool('rider_status', { visit_id: vid });
  check('the rider app location reaches the agent', r.zone === 'near', `${r.distance_to_anchor_m} m from anchor`);
  r = await tool('verify_caller', { visit_id: vid, service: 'amazon' });
  check('the sender\'s rider is verified for his own order', r.verified === true, say(r));
  await post('/api/consent', { sender: 'uber', allowed: false });
  const uk = (await (await fetch(base + '/api/sender?id=uber')).json()).api_key;
  const ur = await (await fetch(base + '/v1/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + uk }, body: JSON.stringify({ receiver: { door_id: 'demo-hsr' } }) })).json();
  check('a sender the household turned off gets no door path', ur.guided === false && ur.consent === false);
  await api(`/v1/orders/${oid}/status`, { status: 'delivered', note: 'handed over' });
  const st = await (await fetch(base + '/api/state')).json();
  check('delivered by the sender closes the visit', !st.visits.some((v) => v.id === vid));
}
console.log('\n== 14. Tool endpoint is protected');
const unauth = await fetch(`${base}/tools/next_instruction`, { method: 'POST', body: '{}' });
check('request without the token is rejected', unauth.status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
