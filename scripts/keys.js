// Builds .env from the key files on the Desktop. Never prints a key.
// Usage: npm run keys
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const desk = join(homedir(), 'Desktop');
const read = (file, line = 0) => {
  const p = join(desk, file);
  if (!existsSync(p)) return '';
  return (readFileSync(p, 'utf8').split(/\r?\n/)[line] || '').trim();
};

const vars = {
  BOLNA_API_KEY: read('bolnaapi.txt'),
  MAPPLS_KEY: read('mapplsapi.txt'),
  GOOGLE_MAPS_KEY: read('gmaps3d.txt'),
  TELEGRAM_BOT_TOKEN: read('telegrambot.txt'),
  GCP_PROJECT: 'your-gcp-project',
  PORT: '3200',
  PUBLIC_URL: '',
};

writeFileSync('.env', Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
for (const [k, v] of Object.entries(vars)) console.log(`${k.padEnd(20)} ${v ? 'set' : 'MISSING'}`);
