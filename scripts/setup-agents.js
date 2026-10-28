// Creates or updates the Bolna agents and points their tools at PUBLIC_URL. Places no calls.
//   guide: answers the rider, verifies him, guides him to the door
//   alert: rings the customer with one message (used by call_customer)
// Usage: node scripts/setup-agents.js
import '../src/env.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { GUIDE_WELCOME, GUIDE_PROMPT, ALERT_PROMPT } from '../src/prompts.js';

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
const PRE = { verify_caller: 'Haan ji, ek second', ask_customer: 'Ek minute, ghar pe pooch leta hoon', check_approval: 'Bas ek second', next_instruction: '', rider_status: 'Ek second', call_customer: 'Ruko, abhi bulata hoon', log_outcome: '' };

const apiTools = {
  tools: TOOL_DEFS.map(([name, description, properties, required]) => ({
    name, description, key: 'custom_task', ...(PRE[name] ? { pre_call_message: PRE[name] } : {}),
    parameters: { type: 'object', properties, required },
  })),
  tools_params: Object.fromEntries(TOOL_DEFS.map(([name, , properties]) => [name, {
    method: 'POST', url: `${PUBLIC_URL}/tools/${name}`,
    param: Object.fromEntries(Object.keys(properties).map((k) => [k, `%(${k})s`])),
    api_token: `Bearer ${TOOL_TOKEN}`, headers: { 'ngrok-skip-browser-warning': '1' },
  }])),
};

// ---------- agents ----------
const agentBody = ({ name, welcome, prompt, tools, terminate = 600 }) => ({
  agent_config: {
    agent_name: name,
    agent_welcome_message: welcome,
    webhook_url: `${PUBLIC_URL}/bolna/webhook`,
    tasks: [{
      task_type: 'conversation',
      toolchain: { execution: 'parallel', pipelines: [['transcriber', 'llm', 'synthesizer']] },
      task_config: { hangup_after_silence: 20, call_terminate: terminate, optimize_latency: true, number_of_words_for_interruption: 2, incremental_delay: 400, backchanneling: false, use_fillers: false },
      tools_config: {
        input: { format: 'wav', provider: 'plivo' },
        output: { format: 'wav', provider: 'plivo' },
        llm_agent: {
          agent_type: 'simple_llm_agent', agent_flow_type: 'streaming',
          llm_config: { provider: 'openai', family: 'openai', model: 'gpt-4.1-mini', temperature: 0.3, max_tokens: 120, agent_flow_type: 'streaming' },
        },
        synthesizer: { stream: true, provider: VOICE.provider, buffer_size: 150, audio_format: 'wav', provider_config: { model: VOICE.model, voice: VOICE.voice, voice_id: VOICE.voice_id, language: VOICE.language } },
        transcriber: { provider: 'elevenlabs', model: 'scribe_v2_realtime', language: 'hi', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 250 },
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
const guideId = await upsert('BOLNA_GUIDE_AGENT_ID', agentBody({ name: 'ToTheDoor guide', welcome: GUIDE_WELCOME, prompt: guidePrompt, tools: apiTools }));
const alertId = await upsert('BOLNA_ALERT_AGENT_ID', agentBody({ name: 'ToTheDoor customer alert', welcome: 'Hello, {customer_name}?', prompt: ALERT_PROMPT, terminate: 90 }));
writeFileSync('.env', env);

// read back and confirm tools are attached and point at PUBLIC_URL
const g = await api('/v2/agent/' + guideId);
const tc = (g.agent_config?.tasks || g.tasks)[0].tools_config;
console.log('guide tools:', tc.api_tools.tools.map((t) => t.name).join(', '));
console.log('tool urls ok:', Object.values(tc.api_tools.tools_params).every((p) => p.url.startsWith(PUBLIC_URL)));
console.log('voice:', tc.synthesizer.provider_config.voice, '| asr:', tc.transcriber.provider, tc.transcriber.model);
console.log('alert agent ready:', !!alertId);
