// Check outbound calling, the voice and speech recognition on this Bolna account.
// Creates or updates a small test agent, calls RIDER_PHONE, follows the call to completion.
// Usage: node scripts/bolna-test-call.js      (never prints the phone number)
import '../src/env.js';
import { readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.BOLNA_API_KEY, TO = process.env.RIDER_PHONE;
const api = async (path, opts = {}) => {
  const r = await fetch('https://api.bolna.ai' + path, { ...opts, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${path} ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
};
const mask = (s) => String(s).replace(/\+?\d{10,13}/g, (x) => '****' + x.slice(-2));

const VARUN = '4cd9f881-58f7-4969-876a-00983214c362'; // Cartesia sonic-3, male Hindi

const agent = {
  agent_config: {
    agent_name: 'ToTheDoor connection test',
    agent_welcome_message: 'Hello?',
    tasks: [{
      task_type: 'conversation',
      toolchain: { execution: 'parallel', pipelines: [['transcriber', 'llm', 'synthesizer']] },
      task_config: { hangup_after_silence: 12, call_terminate: 120, optimize_latency: true, number_of_words_for_interruption: 1, incremental_delay: 400 },
      tools_config: {
        input: { format: 'wav', provider: 'plivo' },
        output: { format: 'wav', provider: 'plivo' },
        llm_agent: {
          agent_type: 'simple_llm_agent', agent_flow_type: 'streaming',
          llm_config: { provider: 'openai', family: 'openai', model: 'gpt-4.1-mini', temperature: 0.4, max_tokens: 80, agent_flow_type: 'streaming' },
        },
        synthesizer: { stream: true, provider: 'cartesia', buffer_size: 150, audio_format: 'wav', provider_config: { model: 'sonic-3', voice: 'Varun', voice_id: VARUN, language: 'hi' } },
        transcriber: { provider: 'deepgram', model: 'nova-3', language: 'hi', stream: true, encoding: 'linear16', sampling_rate: 16000, endpointing: 200 },
      },
    }],
  },
  agent_prompts: {
    task_1: {
      system_prompt: `You are answering the phone at Sam's home. A delivery rider is calling. Talk exactly like a normal Indian person answering a delivery call: casual Hinglish, one short sentence at a time, never more than about 10 words.
Never introduce yourself, never mention any app or company, never explain what you are.
This is a short connection test:
1. When the rider says who he is, reply: "Haan ji, bataiye, abhi kahan pahunche ho?"
2. Whatever he answers, reply with a short acknowledgement and one simple direction, e.g. "Achha, wahan se seedha aao, main bata deta hoon."
3. Then say "Theek hai, thank you" and end the call.
If you can't understand him, say "Haan? Phir se bolna" once.`,
    },
  },
};

const env = readFileSync('.env', 'utf8');
let id = (env.match(/^BOLNA_TEST_AGENT_ID=(.*)$/m) || [])[1];
if (id) {
  await api('/v2/agent/' + id, { method: 'PUT', body: JSON.stringify(agent) });
  console.log('updated test agent');
} else {
  const r = await api('/v2/agent', { method: 'POST', body: JSON.stringify(agent) });
  id = r.agent_id || r.id;
  writeFileSync('.env', env.trimEnd() + `\nBOLNA_TEST_AGENT_ID=${id}\n`);
  console.log('created test agent');
}

const call = await api('/call', { method: 'POST', body: JSON.stringify({ agent_id: id, recipient_phone_number: TO }) });
console.log('call', call.status);

let last = '';
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 4000));
  const e = await api('/executions/' + call.execution_id);
  if (e.status !== last) { console.log('status:', e.status); last = e.status; }
  if (['completed', 'failed', 'no-answer', 'busy', 'canceled', 'error'].includes(e.status)) {
    console.log(mask(JSON.stringify({
      duration: e.conversation_duration, cost: e.total_cost, reason: e.termination_reason || e.telephony_data?.hangup_reason,
      first_audio_ms: e.latency_data?.time_to_first_audio, transcript: e.transcript || '',
    }, null, 1)));
    break;
  }
}
