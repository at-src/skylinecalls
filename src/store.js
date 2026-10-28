// Tiny JSON-file storage in data/ (git-ignored) plus an in-process event feed for the dashboard.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const DIR = process.env.TTD_DATA || 'data';
mkdirSync(DIR, { recursive: true });
const file = (name) => `${DIR}/${name}.json`;

export const load = (name, fallback) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), 'utf8')) : structuredClone(fallback));
export const save = (name, value) => writeFileSync(file(name), JSON.stringify(value, null, 1));

// events: everything that happens (tool calls, rider moves, Telegram messages) for logs and the live screen
export const bus = new EventEmitter();
const events = [];
export function emit(type, data = {}) {
  const e = { t: new Date().toISOString(), type, ...data };
  events.push(e);
  if (events.length > 500) events.shift();
  bus.emit('event', e);
  return e;
}
export const recentEvents = () => events.slice();

export const id = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 8);
