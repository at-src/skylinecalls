// Runs every scripted call to Sam's line through the real tools (DRY_RUN, temp data, fast) and prints what each tool
// decided and what Sam would be told. Usage: node scripts/try-line.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.TTD_DATA = mkdtempSync(join(tmpdir(), 'ttd-line-'));
process.env.DRY_RUN = '1';
const { TOOLS } = await import('../src/server.js');
const { demoCall, PERSONAS } = await import('../src/demo/calls.js');
const { bus } = await import('../src/store.js');
const A = await import('../src/assistant.js');
bus.on('event', (e) => {
  if (e.type === 'tool.result') console.log('  ', e.tool.padEnd(15), (e.out.kind || '').padEnd(8), String(e.out.say).slice(0, 140));
  if (e.type === 'notify') console.log('   TG:', e.text);
});
for (const p of process.argv[2] ? process.argv[2].split(',') : Object.keys(PERSONAS).filter((k) => !PERSONAS[k].hidden)) {
  console.log('==', p);
  await demoCall(TOOLS, { persona: p, pace: 400 });
}
console.log('\npeople now:');
for (const [n, p] of Object.entries(A.people())) console.log(' ', A.showNumber(n), '|', p.name, '|', p.kind, '| calls', p.calls || 0);
process.exit(0);
