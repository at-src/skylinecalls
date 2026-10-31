// Turns the recorded demo calls (scripts/demo-calls.js) into:
//   1. the landing page's example calls: one clip per turn cut from Bolna's stereo recording, the server's tool calls
//      slotted in between, and the Telegram line Sam actually got  ->  ../skylinecalls-frontend/calls.json + audio/
//   2. a video segment per call: the dashboard screen recording with the call audio and captions, dead air cut
//      ->  C:/Users/at261/ttd-tools/calls/<id>/segment.mp4
// How turns are found: Bolna's recording is stereo (left: caller, right: Varun). The caller speaks our scripted lines,
// one per slot with long gaps, so caller turns are the left-channel speech chunks, in order. Varun's turn is all his
// speech between two caller turns; its words come from Whisper on the right channel. Usage: node scripts/demo-process.js [id ...]
import '../src/env.js';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { SCENARIOS } from './demo-calls.js';
const IN = process.env.OUT || 'C:/Users/at261/ttd-tools/calls';
const FRONT = process.env.FRONT || '../skylinecalls-frontend';
const FF = process.env.FFMPEG || 'C:/ffmpeg-4.3.1/ffmpeg-2020-10-28-git-e5be4c5a88-essentials_build/bin/ffmpeg.exe';
const OPENAI = process.env.OPENAI_API_KEY;
const run = (args) => execFileSync(FF, ['-y', '-loglevel', 'error', ...args]);
const probe = (args) => String(spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).stderr || '');

// speech intervals on one channel
function speech(file, ch, noise = '-40dB', min = 0.35) {
  const out = probe(['-i', file, '-af', `pan=mono|c0=c${ch},silencedetect=noise=${noise}:d=${min}`, '-f', 'null', '-']);
  const dm = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const dur = dm ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : 0;
  const segs = []; let start = 0, inSilence = false;
  for (const m of out.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === 'start') { if (t - start > 0.12) segs.push([start, t]); inSilence = true; }
    else { start = t; inSilence = false; }
  }
  if (!inSilence && dur - start > 0.12) segs.push([start, dur]);
  return { segs, dur };
}
const merge = (segs, gap) => segs.reduce((o, s) => { const l = o.at(-1); if (l && s[0] - l[1] < gap) l[1] = Math.max(l[1], s[1]); else o.push([...s]); return o; }, []);

async function whisper(file) {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), 'a.mp3');
  fd.append('model', 'whisper-1'); fd.append('response_format', 'verbose_json'); fd.append('language', 'hi');
  fd.append('prompt', 'Hinglish phone call. Varun, Sam, Rohit, Zepto, BDA Complex, McDonald\'s, OTP, KYC, SBI, HDFC, Acko, zero-dep.');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI}` }, body: fd });
  const j = await r.json(); if (!r.ok) throw new Error('whisper ' + r.status);
  return (j.segments || []).map((s) => ({ a: s.start, b: s.end, text: s.text.trim(), nsp: s.no_speech_prob }));
}
// romanise many lines at once (Devanagari -> how Indians type Hinglish)
async function romaniseAll(lines) {
  if (!lines.length) return [];
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4.1-mini', temperature: 0, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: 'You get {"lines":[...]} of a Hinglish phone call between Varun (an assistant answering Sam\'s phone) and a caller, transcribed by speech-to-text (often Devanagari, with recognition slips). Return {"lines":[...]} with the same count and order: each line in romanised Hinglish as Indians type it on WhatsApp ("Main Sam ko bata deta hoon."), names fixed (Sam, Varun, Rohit, Zepto, SBI, HDFC, Acko, BDA Complex, McDonald\'s), money with ₹ and digits, obvious slips corrected, nothing added. Reply in JSON.' },
      { role: 'user', content: JSON.stringify({ lines }) }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('romanise ' + r.status + ' ' + JSON.stringify(j).slice(0, 120)); const out = JSON.parse(j.choices[0].message.content).lines || [];
  return lines.map((l, i) => out[i] || l);
}

// what the server did, as a short chip in the conversation
function chip(e) {
  const o = e.out || {}, say = String(o.say || '');
  if (o.security?.length) return (/scam/.test(say) ? 'flagged: likely scam' : 'flagged: tried to trick me') + ` · ${o.security.join(', ').replace(/_/g, ' ')}`;
  switch (e.tool) {
    case 'lookup_caller': return o.known ? `known: ${o.name}${o.relation ? ', ' + o.relation : ''}` : null;
    case 'classify_caller': return o.verified ? `expected ${o.service || 'delivery'} · verified` : o.claimed ? `says ${o.claimed}: not on file` : o.briefing ? `briefing: ${o.briefing.goal || o.briefing.about}` : `sorted: ${String(o.label || o.kind || '').toLowerCase()}`;
    case 'next_instruction': return /not verified/i.test(say) ? null : 'guiding to the door';
    case 'check_passcode': return o.locked ? 'passcode locked' : o.ok ? 'passcode correct · Sam alerted' : 'wrong passcode';
    case 'take_message': return 'message sent to Sam';
    case 'alert_owner': return 'Sam alerted';
    case 'set_reminder': return 'reminder saved';
    case 'end_call': return o.held ? null : 'logged · Sam told on Telegram';
    default: return null;
  }
}

async function turnsOf(id) {
  const dir = join(IN, id);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const rec = join(dir, 'call.flac');
  if (!existsSync(rec)) return null;
  const sc = SCENARIOS[id];
  const callerChunks = merge(speech(rec, 0, '-38dB').segs, 2.6).filter(([x, y]) => y - x > 0.6);
  const agentSegs = speech(rec, 1).segs.filter(([x, y]) => y - x > 0.2);
  const ag = join(dir, 'agent.mp3');
  run(['-i', rec, '-af', 'pan=mono|c0=c1', '-ar', '16000', '-ac', '1', '-b:a', '48k', ag]);
  const words = (await whisper(ag)).filter((s) => s.nsp < 0.7 && s.text);
  // recording clock -> event clock: the recording starts as the call connects
  const recStart = (meta.startAt || meta.clickAt) - 600;
  const ended = (meta.events || []).find((e) => e.type === 'line.ended');
  const until = ended ? (Date.parse(ended.t) - recStart) / 1000 + 5 : Infinity;
  // which scripted line each caller chunk is: find the shift between the microphone timeline and the recording that
  // lines up the most chunks with line starts, then give each chunk the line it starts next to
  const starts = meta.lineStarts || [];
  let best = { s: 0, hits: -1 };
  for (const c of callerChunks) for (const e of starts) {
    const s = c[0] - e, hits = callerChunks.filter((q) => starts.some((x) => Math.abs(q[0] - (x + s)) < 1.6)).length;
    if (hits > best.hits) best = { s, hits };
  }
  const lineOf = (c) => { let k = -1, d = 1.8; starts.forEach((x, i) => { const dd = Math.abs(c[0] - (x + best.s)); if (dd < d) { d = dd; k = i; } }); return k; };
  const turns = [];
  const bounds = [0, ...callerChunks.map(([x]) => x), Infinity];
  for (let k = 0; k < bounds.length - 1; k++) {
    // Varun's speech in this window (before the next caller line)
    const a0 = k === 0 ? 0 : callerChunks[k - 1][1] - 0.6, a1 = bounds[k + 1];
    const mine = agentSegs.filter(([x]) => x >= a0 && x < a1 && x < until);
    if (mine.length) {
      const text = words.filter((w) => (w.a + w.b) / 2 >= mine[0][0] - 0.8 && (w.a + w.b) / 2 <= mine.at(-1)[1] + 0.8).map((w) => w.text).join(' ');
      if (text && !/line pe hain|are you still/i.test(text)) turns.push({ who: 'varun', a: mine[0][0], b: mine.at(-1)[1], segs: mine, raw: text });
    }
    if (k < callerChunks.length && callerChunks[k][0] < until) {
      const li = starts.length ? lineOf(callerChunks[k]) : k, line = li >= 0 ? sc.lines[li] : null;
      if (line) turns.push({ who: 'caller', a: callerChunks[k][0], b: callerChunks[k][1], segs: [callerChunks[k]], raw: line, scripted: true });
    }
  }
  // Varun's words: romanised; the caller's are the lines we scripted
  const rom = await romaniseAll(turns.filter((t) => !t.scripted).map((t) => t.raw));
  let ri = 0; for (const t of turns) t.text = t.scripted ? t.raw : rom[ri++];
  const tools = (meta.events || []).filter((e) => e.type === 'tool.result').map((e) => ({ t: (Date.parse(e.t) - recStart) / 1000, label: chip(e) })).filter((x) => x.label && x.t < until + 2);
  const tg = (meta.events || []).filter((e) => e.type === 'notify' && Date.parse(e.t) >= (meta.clickAt || 0)).map((e) => e.text);
  const telegram = tg.filter((x) => !/is on the line|expecting/i.test(x)).at(-1) || tg.at(-1) || '';
  return { meta, rec, turns, tools, telegram, recStart, until };
}

// ---------- landing page clips ----------
function pageCall(id, T) {
  const outDir = join(FRONT, 'audio'); mkdirSync(outDir, { recursive: true });
  for (const x of readdirSync(outDir)) if (x.startsWith(id + '-') && x.endsWith('.mp3')) rmSync(join(outDir, x));
  const lines = []; let n = 0, ti = 0;
  for (const t of T.turns) {
    while (ti < T.tools.length && T.tools[ti].t < t.a + 0.4) { if (lines.at(-1)?.[1] !== T.tools[ti].label) lines.push(['tool', T.tools[ti].label]); ti++; }
    const file = join(outDir, `${id}-${n}.mp3`), ch = t.who === 'varun' ? 1 : 0;
    run(['-i', T.rec, '-ss', String(Math.max(0, t.a - 0.08)), '-to', String(t.b + 0.15), '-af', `pan=mono|c0=c${ch},silenceremove=stop_periods=-1:stop_duration=0.45:stop_threshold=-45dB,loudnorm=I=-17:TP=-2`, '-ar', '24000', '-b:a', '64k', file]);
    if (statSync(file).size < 2500) { rmSync(file); continue; }
    n++; lines.push([t.who, t.text]);
  }
  while (ti < T.tools.length) { if (lines.at(-1)?.[1] !== T.tools[ti].label) lines.push(['tool', T.tools[ti].label]); ti++; }
  return { lines, tg: T.telegram, map: id === 'rider' };
}

// ---------- video segment: dashboard + call audio + captions, dead air cut ----------
const assTime = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
const assEsc = (s) => String(s).replace(/[{}]/g, '').replace(/\n/g, ' ');
function segment(id, T, title) {
  const dir = join(IN, id), meta = T.meta;
  if (!meta.frames?.length) return;
  const f0 = meta.frames[0][1];
  const recAt = (T.recStart - f0) / 1000; // where the recording starts on the screen clock
  const end = Math.min((meta.endAt - f0) / 1000 + 4, recAt + T.until + 3);
  const talk = merge(T.turns.flatMap((t) => t.segs.map(([x, y]) => [x + recAt, y + recAt])).sort((p, q) => p[0] - q[0]), 1.4);
  // keep 2.5 s of the dashboard before the call, each stretch of talk (padded), and the Telegram summary landing
  const keep = merge([[Math.max(0, recAt - 2.5), recAt + 0.5], ...talk.map(([x, y]) => [x - 0.35, y + 0.7]), [end - 3.5, end]]
    .map(([x, y]) => [Math.max(0, x), Math.min(end, y)]).filter(([x, y]) => y > x).sort((p, q) => p[0] - q[0]), 0.05);
  const cut = (t) => { let o = 0; for (const [x, y] of keep) { if (t <= x) return o; if (t < y) return o + t - x; o += y - x; } return o; };
  // frames, each shown until the next, clipped to the kept ranges
  const fr = meta.frames.map(([f, t]) => [f, (t - f0) / 1000]);
  const list = ['ffconcat version 1.0'];
  for (const [x, y] of keep) for (let i = 0; i < fr.length; i++) {
    const s = fr[i][1], e = fr[i + 1]?.[1] ?? end, a0 = Math.max(s, x), b0 = Math.min(e, y);
    if (b0 - a0 > 0.004) list.push(`file '${fr[i][0].replace(/\\/g, '/')}'`, `duration ${(b0 - a0).toFixed(3)}`);
  }
  writeFileSync(join(dir, 'frames.txt'), list.join('\n'));
  // captions: who is speaking and what, bottom centre; a title card for the first seconds
  const ass = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1600', 'PlayResY: 900', '',
    '[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Varun,Segoe UI,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&HC8121211,-1,0,0,0,100,100,0,0,3,14,0,2,220,220,46,1',
    'Style: Caller,Segoe UI,30,&H00F0EAE4,&H00FFFFFF,&H00000000,&HC83A3936,0,0,0,0,100,100,0,0,3,14,0,2,220,220,46,1',
    'Style: Title,Georgia,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&HD8121211,0,1,0,0,100,100,0,0,3,22,0,8,200,200,40,1', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (title) ass.push(`Dialogue: 0,${assTime(0)},${assTime(3.2)},Title,,0,0,0,,${assEsc(title)}`);
  for (const t of T.turns) {
    const a = cut(t.a + recAt), b = Math.max(a + 1.2, cut(t.b + recAt) + 0.4);
    ass.push(`Dialogue: 0,${assTime(a)},${assTime(b)},${t.who === 'varun' ? 'Varun' : 'Caller'},,0,0,0,,${t.who === 'varun' ? 'VARUN  ' : 'CALLER  '}${assEsc(t.text)}`);
  }
  writeFileSync(join(dir, 'captions.ass'), ass.join('\n'));
  // audio: the recording placed at recAt, both sides mixed, then the same ranges kept
  const N = keep.length;
  const fc = [`[0:a]pan=mono|c0=0.55*c0+0.55*c1,adelay=${Math.round(Math.max(0, recAt) * 1000)},apad=whole_dur=${end.toFixed(2)},asplit=${N}${keep.map((_, i) => `[s${i}]`).join('')}`,
    ...keep.map(([x, y], i) => `[s${i}]atrim=${x.toFixed(3)}:${y.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`),
    `${keep.map((_, i) => `[a${i}]`).join('')}concat=n=${N}:v=0:a=1,loudnorm=I=-16:TP=-1.5,aresample=48000[out]`].join(';');
  const audio = join(dir, 'audio.m4a');
  run(['-i', T.rec, '-filter_complex', fc, '-map', '[out]', '-c:a', 'aac', '-b:a', '128k', audio]);
  const subs = join(dir, 'captions.ass').replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
  run(['-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-i', audio, '-vf', `fps=30,scale=1600:900:flags=lanczos,subtitles='${subs}',format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', join(dir, 'segment.mp4')]);
  console.log(id, `video ${keep.reduce((s, [x, y]) => s + y - x, 0).toFixed(1)}s (was ${end.toFixed(1)}s)`);
}

export const TITLES = {
  sales: 'Loan pitch · ×20 a day', rider: 'Delivery rider at the gate · ×5 a day', friend: 'A friend with a message · ×4 a day', mom: 'Mom · ×2 a day',
  scam: 'KYC / OTP scam · ×3 a week', renewal: 'Insurance renewal: the haggle · ×2 a month', inject: '"Ignore your rules" · now and then',
};
if (process.argv[1] && process.argv[1].endsWith('demo-process.js')) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['sales', 'rider', 'friend', 'mom', 'scam', 'renewal', 'inject'];
  const callsFile = join(FRONT, 'calls.json');
  const calls = existsSync(callsFile) ? JSON.parse(readFileSync(callsFile, 'utf8')) : {};
  for (const id of ids) {
    try {
      const T = await turnsOf(id);
      if (!T) { console.log(id, 'no recording'); continue; }
      for (const t of T.turns) console.log(' ', id, t.who.padEnd(6), t.a.toFixed(1) + '-' + t.b.toFixed(1), t.text.slice(0, 90));
      calls[id] = { ...(calls[id] || {}), ...pageCall(id, T) };
      segment(id, T, TITLES[id]);
      console.log(id, '| telegram:', T.telegram.slice(0, 90));
    } catch (e) { console.log(id, 'FAILED', e.stack.split('\n').slice(0, 3).join(' | ')); }
  }
  writeFileSync(callsFile, JSON.stringify(calls, null, 2));
}
