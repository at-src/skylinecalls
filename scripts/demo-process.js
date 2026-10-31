// Turns the recorded demo calls (scripts/demo-calls.js) into:
//   1. the landing page's example calls: one clip per turn cut from Bolna's stereo recording (left: Varun, right: the
//      caller), dead air trimmed, Varun's words transcribed, the server's tool calls slotted in between, and the
//      Telegram line Sam actually got  ->  ../skylinecalls-frontend/calls.json + audio/<id>-<n>.mp3
//   2. per-call video segments for the demo video: the dashboard screen recording with the call audio, long silences
//      cut out of both  ->  C:/Users/at261/ttd-tools/calls/<id>/segment.mp4
// Usage: node scripts/demo-process.js [id ...]
import '../src/env.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
const IN = process.env.OUT || 'C:/Users/at261/ttd-tools/calls';
const FRONT = process.env.FRONT || '../skylinecalls-frontend';
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const OPENAI = process.env.OPENAI_API_KEY;
const run = (args) => execFileSync(FF, ['-y', '-loglevel', 'error', ...args]);
const probe = (args) => String(spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '');

// speech intervals on one channel of the recording
function speech(file, ch, noise = '-40dB', min = 0.35) {
  const out = probe(['-i', file, '-af', `pan=mono|c0=c${ch},silencedetect=noise=${noise}:d=${min}`, '-f', 'null', '-']);
  const dur = Number((out.match(/Duration: (\d+):(\d+):([\d.]+)/) || []).slice(1).reduce((s, x, i) => s + Number(x) * [3600, 60, 1][i], 0));
  const segs = []; let start = 0;
  for (const m of out.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    if (m[1] === 'start') { if (Number(m[2]) - start > 0.12) segs.push([start, Number(m[2])]); }
    else start = Number(m[2]);
  }
  if (!/silence_start/.test(out.split('silence_end').pop() || '') && dur - start > 0.12 && out.includes('silence_end')) segs.push([start, dur]);
  return { segs: segs.filter(([a, b]) => b - a > 0.18), dur };
}
const merge = (segs, gap) => segs.reduce((o, s) => { const l = o.at(-1); if (l && s[0] - l[1] < gap) l[1] = s[1]; else o.push([...s]); return o; }, []);

async function transcribe(file) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(file)]), 'a.mp3'); fd.append('model', 'gpt-4o-transcribe');
  fd.append('prompt', 'Hinglish phone call. Varun, Sam, Zepto, BDA Complex, McDonald\'s, OTP, KYC, zero-dep, Acko.');
  fd.set('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), 'a.mp3');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI}` }, body: fd });
  const j = await r.json(); if (!r.ok) throw new Error('transcribe ' + r.status + ' ' + JSON.stringify(j).slice(0, 120));
  return j.text.trim();
}
async function romanise(text) {
  if (!/[\u0900-\u097F]/.test(text)) return text;
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1-mini', temperature: 0, messages: [
      { role: 'system', content: 'Write this Hindi/Hinglish line in romanised Hinglish (Latin script), the way Indians type on WhatsApp: "Main Sam ko bata deta hoon." Keep English words as they are, numbers as digits with ₹ for money. Output only the line.' },
      { role: 'user', content: text }] }) });
  const j = await r.json(); return j.choices[0].message.content.trim();
}

// what the server did, as a short chip in the conversation
function chip(e) {
  const o = e.out || {}, say = String(o.say || '');
  if (o.security?.length) return 'flagged: ' + (/scam/.test(say) ? 'likely scam' : 'tried to trick me') + ` · ${o.security.join(', ').replace(/_/g, ' ')}`;
  switch (e.tool) {
    case 'lookup_caller': return o.known ? `known: ${o.name}${o.relation ? ', ' + o.relation : ''}` : 'unknown number';
    case 'classify_caller': return o.verified ? `expected ${o.service || 'delivery'}: verified` : o.claimed ? `says ${o.claimed}: not on file` : o.briefing ? `briefing: ${o.briefing.goal || o.briefing.about}` : `sorted: ${String(o.label || o.kind || '').toLowerCase()}`;
    case 'verify_caller': return o.verified ? 'expected delivery: verified' : 'not expected';
    case 'next_instruction': return 'guiding: ' + (say.match(/^[^.]*?(Next|Say|Tell)[^:]*:\s*"?([^".]+)/)?.[2] || 'next stop').slice(0, 48);
    case 'check_passcode': return o.locked ? 'passcode locked' : o.ok ? 'passcode correct' : 'wrong passcode';
    case 'take_message': return 'message sent to Sam';
    case 'alert_owner': return 'Sam alerted';
    case 'set_reminder': return 'reminder saved';
    case 'end_call': return o.held ? null : 'logged · Sam told on Telegram';
    default: return null;
  }
}

const VIDEO_W = 1600, VIDEO_H = 900;
async function processCall(id) {
  const dir = join(IN, id);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const rec = join(dir, 'call.flac');
  if (!existsSync(rec)) { console.log(id, 'no recording'); return null; }
  // Bolna's stereo recording: left = the caller, right = the agent
  const agent = speech(rec, 1), caller = speech(rec, 0, '-36dB');
  const callerTurns = merge(caller.segs, 1.4).filter(([a, b]) => b - a > 0.8);
  // Varun's turns: speech on the left channel, joined when the pause is short (a filler + the answer)
  const agentTurns = merge(agent.segs, 1.3);
  // the timeline of turns, in order; drop Varun's "are you still there?" and anything after his goodbye
  const turns = [...agentTurns.map((s) => ({ who: 'varun', s })), ...callerTurns.map((s, i) => ({ who: 'caller', s, i }))].sort((a, b) => a.s[0] - b.s[0]);
  const lastCaller = callerTurns.at(-1)?.[1] ?? 0;
  const kept = []; let afterLast = 0;
  for (const t of turns) {
    if (t.who === 'varun' && t.s[0] > lastCaller) { if (afterLast++ > 0) break; }
    kept.push(t);
  }
  // cut each turn (a little padding), Varun's fillers kept but the gap inside his turn capped
  const outDir = join(FRONT, 'audio'); mkdirSync(outDir, { recursive: true });
  for (const x of readdirSync(outDir)) if (x.startsWith(id + '-') && x.endsWith('.mp3')) rmSync(join(outDir, x));
  const lines = []; let n = 0;
  const clipOf = (t, name) => {
    const [a, b] = t.s, f = join(outDir, `${name}.mp3`);
    const ch = t.who === 'varun' ? 1 : 0;
    run(['-i', rec, '-ss', String(Math.max(0, a - 0.08)), '-to', String(b + 0.12), '-af', `pan=mono|c0=c${ch},silenceremove=stop_periods=-1:stop_duration=0.45:stop_threshold=-42dB,loudnorm=I=-17:TP=-2`, '-ar', '24000', '-b:a', '64k', f]);
    return f;
  };
  // the server's tool results, placed between turns by time (recording starts as the call connects)
  const recStart = (meta.startAt || meta.clickAt) - 600;
  const tools = (meta.events || []).filter((e) => e.type === 'tool.result').map((e) => ({ t: (Date.parse(e.t) - recStart) / 1000, label: chip(e) })).filter((x) => x.label);
  const tg = (meta.events || []).filter((e) => e.type === 'notify' && Date.parse(e.t) >= (meta.clickAt || 0)).map((e) => e.text);
  let ti = 0;
  for (const t of kept) {
    while (ti < tools.length && tools[ti].t < t.s[0] + 0.3) { if (lines.at(-1)?.[1] !== tools[ti].label) lines.push(['tool', tools[ti].label]); ti++; }
    const name = `${id}-${n}`;
    const f = clipOf(t, name);
    // a turn that was only noise cuts to nothing; drop it
    if (statSync(f).size < 3000) { rmSync(f); continue; }
    let heard = '';
    try { heard = await transcribe(f); } catch { rmSync(f); continue; }
    if (!heard || heard.length < 2) { rmSync(f); continue; }
    n++;
    lines.push([t.who, await romanise(heard)]);
    console.log(' ', name, t.who, t.s.map((x) => x.toFixed(1)).join('-'), heard.slice(0, 60));
  }
  while (ti < tools.length) { if (lines.at(-1)?.[1] !== tools[ti].label) lines.push(['tool', tools[ti].label]); ti++; }
  const telegram = tg.filter((x) => !/is on the line|Got it|expecting/i.test(x)).at(-1) || tg.at(-1) || '';
  console.log(id, `${kept.length} turns, ${tools.length} tool chips, telegram: ${telegram.slice(0, 70)}`);
  return { lines, tg: telegram, map: id === 'rider' };
}

// ---------- video segment: the dashboard recording with the call audio, long silences cut ----------
function segment(id) {
  const dir = join(IN, id);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const rec = join(dir, 'call.flac');
  if (!existsSync(rec) || !meta.frames?.length) return;
  const f0 = meta.frames[0][1];
  // recording time 0 = when the call connected, on the frame clock
  const recAt = ((meta.startAt || meta.clickAt) - 600 - f0) / 1000;
  const end = (meta.endAt - f0) / 1000 + 6; // keep the Telegram summary landing after the call
  const a = speech(rec, 0).segs, c = speech(rec, 1, '-36dB').segs;
  const busy = merge([...a, ...c].map(([x, y]) => [x + recAt, y + recAt]).sort((p, q) => p[0] - q[0]), 1.6);
  // keep: the lead-in (dashboard before the call), every stretch of talk padded, and the tail
  const keep = merge([[0, Math.max(0.5, recAt + 0.4)], ...busy.map(([x, y]) => [x - 0.5, y + 0.9]), [Math.min(end - 6, (meta.endAt - f0) / 1000), end]].map(([x, y]) => [Math.max(0, x), Math.min(end, y)]).sort((p, q) => p[0] - q[0]), 0.05);
  // frames -> concat list per kept range (each frame shown until the next one, clipped to the range)
  const fr = meta.frames.map(([f, t]) => [f, (t - f0) / 1000]);
  const lines = ['ffconcat version 1.0'];
  for (const [x, y] of keep) {
    for (let i = 0; i < fr.length; i++) {
      const s = fr[i][1], e = fr[i + 1]?.[1] ?? end;
      const a0 = Math.max(s, x), b0 = Math.min(e, y);
      if (b0 - a0 > 0.004) lines.push(`file '${fr[i][0].replace(/\\/g, '/')}'`, `duration ${(b0 - a0).toFixed(3)}`);
    }
  }
  const list = join(dir, 'frames.txt'); writeFileSync(list, lines.join('\n'));
  // audio: the recording placed at recAt, both channels mixed down, then the same ranges kept
  const parts = keep.map(([x, y], i) => `[m]atrim=${x.toFixed(3)}:${y.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(';');
  const pre = `[0:a]pan=mono|c0=0.5*c0+0.5*c1,adelay=${Math.round(Math.max(0, recAt) * 1000)},apad=whole_dur=${end.toFixed(2)},asplit=${keep.length}${keep.map((_, i) => `[s${i}]`).join('')}`;
  const fixed = parts.replace(/\[m\]/g, (_, k) => '').split(';').map((p, i) => `[s${i}]${p}`).join(';');
  const audio = join(dir, 'audio.m4a');
  run(['-i', rec, '-filter_complex', `${pre};${fixed};${keep.map((_, i) => `[a${i}]`).join('')}concat=n=${keep.length}:v=0:a=1,loudnorm=I=-16:TP=-1.5[out]`, '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', audio]);
  run(['-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-vf', `fps=30,scale=${VIDEO_W}:${VIDEO_H}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', join(dir, 'segment.mp4')]);
  const kept = keep.reduce((s, [x, y]) => s + y - x, 0);
  console.log(id, `segment: ${kept.toFixed(1)}s (from ${end.toFixed(1)}s)`);
}

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['sales', 'rider', 'friend', 'mom', 'scam', 'renewal', 'inject'];
const callsFile = join(FRONT, 'calls.json');
const calls = existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, 'utf8')) : {};
for (const id of ids) {
  try {
    const c = await processCall(id);
    if (c) calls[id] = { ...(calls[id] || {}), ...c };
    segment(id);
  } catch (e) { console.log(id, 'FAILED', e.message); }
}
writeFileSync(callsFile, JSON.stringify(calls, null, 2));
console.log('calls.json:', Object.keys(calls).join(', '));
