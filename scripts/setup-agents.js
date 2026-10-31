// Creates or updates the Bolna agents and points their tools at PUBLIC_URL. Places no calls.
//   guide: answers the rider, verifies him, guides him to the door
//   alert: rings the customer with one message (used by call_customer)
//   calibrate: the customer teaches the way from a big landmark to their door, once
// Usage: node scripts/setup-agents.js
import '../src/env.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { LINE_DEFS } from '../src/line-tools.js';
import { GUIDE_WELCOME, GUIDE_PROMPT, ALERT_PROMPT, CALIB_WELCOME, CALIB_PROMPT, KEYWORDS, LINE_WELCOME, LINE_PROMPT, LINE_KEYWORDS } from '../src/prompts.js';

const { BOLNA_API_KEY: KEY, PUBLIC_URL, TOOL_TOKEN } = process.env;
if (!PUBLIC_URL) throw new Error('PUBLIC_URL missing: start ngrok and set it in .env');

const api = async (path, opts = {}) => {
  const r = await fetch('https://api.bolna.ai' + path, { ...opts, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
};

const VOICE = { provider: 'cartesia', model: 'sonic-3', voice: 'Varun', voice_id: '4cd9f881-58f7-4969-876a-00983214c362', language: 'hi' };

// ---------- tools ----------
const S = (description) => ({ type: 'string', description });
const TOOL_DEFS = [
  ['verify_caller', 'Check who the caller is before giving ANY direction. Call it as soon as he says which service he is from (and again if he gives a delivery code).',
    { visit_id: S('The visit id given in the call context, if any. Leave empty if none.'), service: S('Service he says he is from, e.g. zepto, swiggy, amazon, uber, rapido'), code: S('4-digit delivery code if he gave one') }, ['service']],
  ['ask_customer', 'Ask the family on their phone whether to help an unknown caller. Use when verify_caller cannot verify him.',
    { caller_says: S('Who he says he is, in his words, e.g. "Zepto delivery, order for Sam"') }, ['caller_says']],
  ['check_approval', 'Check whether the family answered an ask_customer request.',
    { approval_id: S('approval_id returned by ask_customer') }, ['approval_id']],
  ['next_instruction', 'Get the next direction for a verified rider. Call it every time he says where he is or what he can see.',
    { visit_id: S('visit_id returned by verify_caller'), seen: S("What he says he can see or where he says he is, in his own words. Empty if he didn't say.") }, ['visit_id']],
  ['rider_status', 'How far the verified rider is and what is around him, from his live location.',
    { visit_id: S('visit_id returned by verify_caller') }, ['visit_id']],
  ['call_customer', 'Ring the customer when the rider needs them: nobody opens the door, cash or OTP needed, or a problem.',
    { visit_id: S('visit_id returned by verify_caller'), reason: S('Short reason, e.g. "is at the door and nobody is opening"') }, ['visit_id', 'reason']],
  ['log_outcome', 'Record how the visit ended, once the parcel is handed over or left as told.',
    { visit_id: S('visit_id returned by verify_caller'), result: S('What happened, e.g. "handed over", "left on the shoe rack"'), note: S('Anything else worth noting') }, ['visit_id', 'result']],
];
const C = (d) => S(d);
const CALIB_DEFS = [
  ['start_calibration', 'Start setting up the door path. Call it first, once.',
    { customer: S('Customer first name'), door_id: S('door_id from the call context, if any') }, ['customer']],
  ['save_anchor', 'Save the big starting landmark near the house.',
    { calibration_id: C('calibration_id from start_calibration'), name: S('Landmark name, e.g. BDA Complex'), also_called: S('Other names people use, comma separated'), description: S('One line about it, e.g. main gate on 14th Main, PNB next to it') }, ['calibration_id', 'name']],
  ['save_step', 'Save one step of the way, from the end of the previous step (or the landmark).',
    { calibration_id: C('calibration_id from start_calibration'), instruction: S('The step in plain English'), landmark: S('What he sees at the end of this step'), see: S('That thing and other ways to say it, comma separated'), pass: S('Things he passes on the way, comma separated'), distance_m: S('Distance in metres, if given'), side: S('left, right or straight') }, ['calibration_id', 'instruction', 'landmark']],
  ['save_door', 'Save which door it is and what to do there.',
    { calibration_id: C('calibration_id from start_calibration'), floor: S('Floor, e.g. 2nd'), side: S('left, right, front...'), action: S('knock, ring the bell, call...'), marks: S('How to recognise it, comma separated') }, ['calibration_id']],
  ['save_fallback', 'Save what the rider should do if nobody opens.',
    { calibration_id: C('calibration_id from start_calibration'), if_no_answer: S('What to do if nobody opens'), safe_spot: S('Where to leave it, if any'), contact: S('Who else can take it, if anyone') }, ['calibration_id', 'if_no_answer']],
  ['finish_calibration', 'Check the path for gaps and save it.',
    { calibration_id: C('calibration_id from start_calibration') }, ['calibration_id']],
];
// Varun's line: every call. The delivery tools (minus verify_caller, which classify_caller runs) come along.
// The line tools live in src/line-tools.js so the red-team eval tests exactly what's deployed.
// when Bolna may end the call: only on a real goodbye, never on a mid-call "ok" or "theek hai"
const HANGUP_PROMPT = `A conversation is considered complete if ANY of these is true:
1. The assistant has already said a closing line (for example "alvida", "bye", "phir milte hain", "Namaste" to end, "Dhanyavaad, alvida"), and the user's reply after it is a goodbye or a short acknowledgement: "bye", "ok bye", "goodbye", "alvida", "theek hai", "ok", "okay", "thank you", "thanks", "dhanyavaad", "shukriya", "chalo", or similar.
2. The assistant has confirmed it will pass the message on, or asked whether there is anything else ("Kuch aur batana hai?", "Anything else?"), and the user replies with only an acknowledgement or a no: "ok", "okay", "theek hai", "nahi", "bas", "bas itna hi", "nothing", "no", "bye", or similar.
3. The user clearly ends the call themselves: "bye", "goodbye", "ok bye", "chalo bye", "bas itna hi", "rakhta hoon", "phone rakhta hoon", "baad mein baat karte hain", or similar.
The conversation is NOT complete if:
- the assistant has not yet said a closing line and the user only says "haan", "ok", "theek hai", "achha" in the middle of the conversation;
- the user is still explaining, asking something, giving a message, a time, an amount or a code;
- the user says something new after the assistant's goodbye (anything more than a goodbye or acknowledgement).
The last message in the transcript must be from the user.`;

// what Varun says while a tool runs (otherwise Bolna fills the pause with an English "Just give me a moment…")
const PRE = { lookup_caller: 'Haan ji', classify_caller: 'Achha', check_passcode: 'Ek second', take_message: 'Haan, likh raha hoon', alert_owner: 'Ek minute', set_reminder: 'Haan, note kar liya', end_call: 'Theek hai', verify_caller: 'Haan ji, bolo', ask_customer: 'Haan, ruko ek second', check_approval: 'Haan ek second', next_instruction: 'Haan', rider_status: 'Ek second', call_customer: 'Ruko, bulata hoon', log_outcome: 'Theek hai', check_calendar: 'Ek second, dekhta hoon', check_mail: 'Ek second, check karta hoon' };

const toolsFor = (defs) => ({
  tools: defs.map(([name, description, properties, required]) => ({
    name, description, key: 'custom_task', ...(PRE[name] ? { pre_call_message: PRE[name] } : {}),
    parameters: { type: 'object', properties, required },
  })),
  tools_params: Object.fromEntries(defs.map(([name, , properties]) => [name, {
    method: 'POST', url: `${PUBLIC_URL}/tools/${name}`,
    param: Object.fromEntries(Object.keys(properties).map((k) => [k, `%(${k})s`])),
    api_token: `Bearer ${TOOL_TOKEN}`, headers: { 'ngrok-skip-browser-warning': '1' },
  }])),
});
const apiTools = toolsFor(TOOL_DEFS);
// ---------- agents ----------
const agentBody = ({ name, welcome, prompt, tools, terminate = 600 }) => ({
  agent_config: {
    agent_name: name,
    agent_welcome_message: welcome,
    webhook_url: `${PUBLIC_URL}/bolna/webhook`,
    tasks: [{
      task_type: 'conversation',
      toolchain: { execution: 'parallel', pipelines: [['transcriber', 'llm', 'synthesizer']] },
      task_config: {
        hangup_after_silence: 15, call_terminate: terminate, optimize_latency: true, number_of_words_for_interruption: 2, incremental_delay: 400, backchanneling: false, use_fillers: false,
        // in Hinglish, like the rest of the call (Bolna's default is an English "Hey, are you still there")
        check_if_user_online: true, check_user_online_message: 'Hello? Aap line pe hain?', trigger_user_online_message_after: 10,
        // hang up on a real goodbye (Bolna checks this prompt after the caller speaks). Mid-call "haan"/"theek hai" must
        // not end it, and if the caller cuts into the goodbye with something new, the hangup is cancelled.
        hangup_after_LLMCall: true, interruptible_hangup_message: true, call_cancellation_prompt: HANGUP_PROMPT,
        call_hangup_message: 'Theek hai ji, alvida!',
      },
      tools_config: {
        input: { format: 'wav', provider: 'plivo' },
        output: { format: 'wav', provider: 'plivo' },
        llm_agent: {
          agent_type: 'simple_llm_agent', agent_flow_type: 'streaming',
          llm_config: { provider: 'openai', family: 'openai', model: 'gpt-4.1-mini', temperature: 0.3, max_tokens: 120, agent_flow_type: 'streaming' },
        },
        synthesizer: { stream: true, provider: VOICE.provider, buffer_size: 150, audio_format: 'wav', provider_config: { model: VOICE.model, voice: VOICE.voice, voice_id: VOICE.voice_id, language: VOICE.language } },
        transcriber: { provider: 'elevenlabs', model: 'scribe_v2_realtime', language: 'hi', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 250, keywords: KEYWORDS.join(', ') },
        ...(tools ? { api_tools: tools } : {}),
      },
    }],
  },
  agent_prompts: { task_1: { system_prompt: prompt } },
});

let env = readFileSync('.env', 'utf8');
const setEnv = (k, v) => { env = new RegExp(`^${k}=.*$`, 'm').test(env) ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`) : env.trimEnd() + `\n${k}=${v}\n`; };

async function upsert(envKey, body) {
  const id = process.env[envKey];
  if (id) { await api('/v2/agent/' + id, { method: 'PUT', body: JSON.stringify(body) }); console.log('updated', body.agent_config.agent_name); return id; }
  const r = await api('/v2/agent', { method: 'POST', body: JSON.stringify(body) });
  const nid = r.agent_id || r.id; setEnv(envKey, nid); console.log('created', body.agent_config.agent_name); return nid;
}

const guidePrompt = GUIDE_PROMPT.replace('{visit_hint}', '. If the call context below has a visit_id, pass it too').replaceAll('{customer_name}', '{customer_name}')
  + '\n\nCall context: customer_name = {customer_name}; visit_id = {visit_id}.';
const guideId = await upsert('BOLNA_GUIDE_AGENT_ID', agentBody({ name: 'Skyline guide', welcome: GUIDE_WELCOME, prompt: guidePrompt, tools: apiTools }));
const alertId = await upsert('BOLNA_ALERT_AGENT_ID', agentBody({ name: 'Skyline customer alert', welcome: 'Hello, {customer_name}?', prompt: ALERT_PROMPT, terminate: 90 }));
const calibId = await upsert('BOLNA_CALIB_AGENT_ID', agentBody({ name: 'Skyline teach the door', welcome: CALIB_WELCOME, prompt: CALIB_PROMPT + '\n\nCall context: customer_name = {customer_name}; door_id = {door_id}.', tools: toolsFor(CALIB_DEFS), terminate: 600 }));
const linePrompt = LINE_PROMPT + '\n\nCall context: owner = {owner}; caller_number = {caller_number}.';
const lineTools = toolsFor([...LINE_DEFS, ...TOOL_DEFS.filter(([n]) => n !== 'verify_caller')]);
const lineBody = agentBody({ name: "Skyline · Varun", welcome: LINE_WELCOME, prompt: linePrompt, tools: lineTools, terminate: 600 });
lineBody.agent_config.tasks[0].tools_config.transcriber.keywords = [...KEYWORDS, ...LINE_KEYWORDS].join(', ');
const lineId = await upsert('BOLNA_LINE_AGENT_ID', lineBody);
writeFileSync('.env', env);
const l = await api('/v2/agent/' + lineId);
console.log('line tools:', (l.agent_config?.tasks || l.tasks)[0].tools_config.api_tools.tools.map((t) => t.name).join(', '));

// read back and confirm tools are attached and point at PUBLIC_URL
const g = await api('/v2/agent/' + guideId);
const tc = (g.agent_config?.tasks || g.tasks)[0].tools_config;
console.log('guide tools:', tc.api_tools.tools.map((t) => t.name).join(', '));
console.log('tool urls ok:', Object.values(tc.api_tools.tools_params).every((p) => p.url.startsWith(PUBLIC_URL)));
console.log('voice:', tc.synthesizer.provider_config.voice, '| asr:', tc.transcriber.provider, tc.transcriber.model);
console.log('alert agent ready:', !!alertId);
const c = await api('/v2/agent/' + calibId);
console.log('calibrate tools:', (c.agent_config?.tasks || c.tasks)[0].tools_config.api_tools.tools.map((t) => t.name).join(', '));
