// Builds .env from the key files on the Desktop. Never prints a key or a phone number.
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

// Indian mobile in E.164: accepts 10 digits, 0 + 10 digits, 91 + 10 digits or +91 + 10 digits
const phone = (s) => {
  const d = s.replace(/\D/g, '');
  const ten = d.length === 10 ? d : d.length === 11 && d[0] === '0' ? d.slice(1) : d.length === 12 && d.startsWith('91') ? d.slice(2) : '';
  return ten ? '+91' + ten : '';
};

// Telegram chat id of whoever last messaged the bot (the builder)
async function telegramChat(token) {
  if (!token) return '';
  try {
    const j = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const chats = (j.result || []).map((u) => (u.message || u.my_chat_member || {}).chat).filter(Boolean);
    return chats.length ? String(chats[chats.length - 1].id) : '';
  } catch { return ''; }
}

const old = existsSync('.env') ? Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).map((l) => l.split(/=(.*)/s)).filter((x) => x[0])) : {};
const tg = read('telegrambottoken.txt') || read('telegrambot.txt');

const vars = {
  BOLNA_API_KEY: read('bolnaapi.txt'),
  MAPPLS_KEY: read('mapplsapi.txt'),
  GOOGLE_MAPS_KEY: read('gmaps3d.txt'),
  TELEGRAM_BOT_TOKEN: tg,
  TELEGRAM_CHAT_ID: (await telegramChat(tg)) || old.TELEGRAM_CHAT_ID || '',
  RIDER_PHONE: phone(read('myphone.txt', 0)),
  CUSTOMER_PHONE: phone(read('myphone.txt', 1)) || phone(read('myphone.txt', 0)),
  BOLNA_GUIDE_AGENT_ID: old.BOLNA_GUIDE_AGENT_ID || '',
  BOLNA_CALIBRATE_AGENT_ID: old.BOLNA_CALIBRATE_AGENT_ID || '',
  GCP_PROJECT: 'your-gcp-project',
  PORT: '3200',
  PUBLIC_URL: old.PUBLIC_URL || '',
  // shared secret Bolna sends to our tool endpoints
  TOOL_TOKEN: old.TOOL_TOKEN || (await import('node:crypto')).randomBytes(18).toString('hex'),
  BOLNA_TEST_AGENT_ID: old.BOLNA_TEST_AGENT_ID || '',
  BOLNA_ALERT_AGENT_ID: old.BOLNA_ALERT_AGENT_ID || '',
};

writeFileSync('.env', Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
for (const [k, v] of Object.entries(vars)) console.log(`${k.padEnd(26)} ${v ? 'set' : 'MISSING'}`);
