// Checks whether custom function tools can be attached to a Bolna agent through the API (no call is placed).
// Tries the documented api_tools shapes on the test agent and reads the agent back.
import '../src/env.js';
import { readFileSync } from 'node:fs';

const KEY = process.env.BOLNA_API_KEY, ID = process.env.BOLNA_TEST_AGENT_ID;
const api = async (path, opts = {}) => {
  const r = await fetch('https://api.bolna.ai' + path, { ...opts, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } });
  return { status: r.status, body: (await r.text()).slice(0, 300) };
};

const def = {
  name: 'rider_status',
  description: "Get the rider's live position and the next direction to the customer's door. Call this whenever the rider says where he is.",
  pre_call_message: 'Ek second',
  parameters: { type: 'object', properties: { seen: { type: 'string', description: 'What the rider says he can see right now' } }, required: [] },
  key: 'custom_task',
};
const value = { method: 'POST', url: 'https://example.com/tools/rider_status', param: { seen: '%(seen)s' }, api_token: 'Bearer test', headers: {} };

// rebuild the test agent body from the call-test script
const src = readFileSync('scripts/bolna-test-call.js', 'utf8');
const VARUN = '4cd9f881-58f7-4969-876a-00983214c362';
let agent; eval(src.slice(src.indexOf('const agent ='), src.indexOf('const env =')).replace('const agent', 'agent'));
const tc = agent.agent_config.tasks[0].tools_config;

const shapes = {
  'tools as JSON string': { tools: JSON.stringify([def]), tools_params: { rider_status: value } },
  'tools as array': { tools: [def], tools_params: { rider_status: value } },
};

for (const [label, shape] of Object.entries(shapes)) {
  tc.api_tools = shape;
  const put = await api('/v2/agent/' + ID, { method: 'PUT', body: JSON.stringify(agent) });
  const got = await (await fetch('https://api.bolna.ai/v2/agent/' + ID, { headers: { Authorization: `Bearer ${KEY}` } })).json();
  const saved = (got.agent_config?.tasks || got.tasks || [])[0]?.tools_config?.api_tools;
  console.log(`${label}: PUT ${put.status} ${put.status === 200 ? '' : put.body}`);
  console.log('  saved:', JSON.stringify(saved).slice(0, 300));
  if (put.status === 200 && saved && JSON.stringify(saved).includes('rider_status')) { console.log('  -> WORKS'); break; }
}
