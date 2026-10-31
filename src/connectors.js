// Connectors: real integrations Varun can use, plus honest "coming soon" tiles.
//   maps     — key-based, connected whenever GOOGLE_MAPS_KEY is set (already used across the app)
//   gmail    — real Google OAuth (gmail.readonly), reads a few recent subjects/snippets
//   gcal     — real Google OAuth (calendar.readonly), checks if the owner is free on a day
//   telegram — already wired (see telegram.js / notify.js); shown connected when creds are set
//   whatsapp / contacts / github — not built yet, marked "soon" (not fake-connectable)
//
// The Google flow is the standard web-server OAuth 2.0 code flow, done with plain fetch (no googleapis SDK):
//   /connect/google?scope=gmail|calendar -> 302 to Google consent (access_type=offline, prompt=consent)
//   /connect/google/callback?code=...     -> POST https://oauth2.googleapis.com/token -> store refresh_token
//   then access tokens are minted on demand from the refresh_token.
// Refs: Google "Using OAuth 2.0 for Web Server Applications"
//   https://developers.google.com/identity/protocols/oauth2/web-server
//   token endpoint + refresh: https://developers.google.com/identity/protocols/oauth2
//   Gmail users.messages.list: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/list
//   Calendar events.list:      https://developers.google.com/calendar/v3/reference/events/list
import { env } from './env.js';
import { load, save, emit } from './store.js';
import { newState, takeState } from './guard.js';

// Google OAuth client, read from .env (built by scripts/keys.js from the Desktop googleauth.txt).
const CLIENT_ID = () => env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = () => env.GOOGLE_CLIENT_SECRET || '';
const hasGoogle = () => !!(CLIENT_ID() && CLIENT_SECRET());
// Where Google sends the user back. This exact URI must be an "Authorized redirect URI" on the OAuth client.
export const redirectUri = () => `${env.PUBLIC_URL || 'http://localhost:3200'}/connect/google/callback`;

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
// Each of our Google connectors maps to one read-only scope.
const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
};
// which connector id a scope name belongs to
const CONN_OF_SCOPE = { gmail: 'gmail', calendar: 'gcal' };

// ---------- stored tokens ----------
// data/connectors.json: { gmail: { refresh_token, scope, email, at }, gcal: {...} }
const store = () => load('connectors', {});
const saveStore = (s) => { save('connectors', s); emit('line.updated', { what: 'connectors' }); return s; };
const record = (id) => store()[id] || null;
const connected = (id) => !!record(id)?.refresh_token;

// ---------- the registry the UI and API show ----------
// kind: 'oauth' | 'key' | 'builtin' | 'soon'. connected is the live, derived state.
export function registry() {
  const s = store();
  const tgOn = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  return [
    { id: 'telegram', name: 'Telegram', sub: 'Messages and alerts to you', kind: 'builtin', color: '#229ED9', letter: 'T', connected: tgOn },
    { id: 'maps', name: 'Google Maps', sub: 'Place and route lookups', kind: 'key', color: '#34a853', letter: '◎', connected: !!env.GOOGLE_MAPS_KEY },
    { id: 'gmail', name: 'Gmail', sub: 'Read the "out for delivery" mail', kind: 'oauth', scope: 'gmail', color: '#ea4335', letter: 'M', connected: !!s.gmail?.refresh_token, account: s.gmail?.email || '' },
    { id: 'gcal', name: 'Google Calendar', sub: 'Know when you are busy', kind: 'oauth', scope: 'calendar', color: '#4285f4', letter: '31', connected: !!s.gcal?.refresh_token, account: s.gcal?.email || '' },
    { id: 'whatsapp', name: 'WhatsApp', sub: 'Updates on WhatsApp too', kind: 'soon', color: '#25d366', letter: 'W', connected: false },
    { id: 'contacts', name: 'Contacts', sub: 'Import who you know', kind: 'soon', color: '#9d7bff', letter: '@', connected: false },
    { id: 'github', name: 'GitHub', sub: 'Answer dev questions', kind: 'soon', color: '#8b8b95', letter: '', connected: false },
  ];
}

export function disconnect(id) {
  const s = store();
  if (s[id]) { delete s[id]; saveStore(s); emit('connector.disconnected', { id }); }
  return { ok: true, id, connected: false };
}

// ---------- OAuth: build the consent URL ----------
// scope is a connector key ('gmail' | 'calendar'); returns the Google consent URL to 302 to, or null if not set up.
export function authUrl(scope) {
  if (!hasGoogle() || !SCOPES[scope]) return null;
  const p = new URLSearchParams({
    client_id: CLIENT_ID(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES[scope],
    access_type: 'offline',        // we want a refresh_token for offline use
    include_granted_scopes: 'true',// keep scopes already granted to this client
    prompt: 'consent',             // force a refresh_token even on a repeat connect
    state: newState(scope),        // one-time nonce (CSRF): the callback only accepts a state we issued
  });
  return `${AUTH}?${p}`;
}

// ---------- OAuth: the callback exchanges the code for tokens ----------
// Returns { ok, id } so the route can redirect. Never throws the raw error outward.
export async function handleCallback({ code, state }) {
  if (!hasGoogle()) return { ok: false, error: 'google not configured' };
  // a callback we didn't start (a forged link that would attach someone else's Google account) is refused
  const scope = takeState(state);
  if (!scope || !SCOPES[scope] || !code) return { ok: false, error: 'invalid or expired state' };
  const id = CONN_OF_SCOPE[scope];
  try {
    const r = await fetch(TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
        redirect_uri: redirectUri(), grant_type: 'authorization_code',
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) { emit('connector.error', { id, where: 'token', status: r.status }); return { ok: false, id, error: j.error || 'token exchange failed' }; }
    // Google only returns refresh_token the first time unless prompt=consent (which we set). Keep the old one if absent.
    const prev = record(id);
    const email = await whoAmI(j.access_token).catch(() => '');
    const s = store();
    s[id] = { refresh_token: j.refresh_token || prev?.refresh_token || '', scope: j.scope || SCOPES[scope], email, at: new Date().toISOString() };
    saveStore(s);
    emit('connector.connected', { id, account: email });
    return { ok: true, id };
  } catch (e) {
    emit('connector.error', { id, message: e.message });
    return { ok: false, id, error: e.message };
  }
}

// ---------- OAuth: mint an access token from the stored refresh_token ----------
async function accessToken(id) {
  const rec = record(id);
  if (!rec?.refresh_token) return null;
  const r = await fetch(TOKEN, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
      refresh_token: rec.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) { emit('connector.error', { id, where: 'refresh', status: r.status }); return null; }
  return j.access_token;
}

// the connected Google account's email (OpenID userinfo), just for showing which account is linked
async function whoAmI(token) {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return '';
  const j = await r.json();
  return j.email || '';
}

// ---------- Gmail: a few recent messages (subject + snippet) ----------
// Defensive: returns { ok:false } if not connected or the API is unhappy, never throws.
export async function gmailRecent({ query = '', max = 5 } = {}) {
  if (!connected('gmail')) return { ok: false, connected: false, messages: [] };
  const token = await accessToken('gmail');
  if (!token) return { ok: false, connected: true, messages: [] };
  const h = { Authorization: `Bearer ${token}` };
  try {
    const q = new URLSearchParams({ maxResults: String(Math.min(max, 10)) });
    if (query) q.set('q', query);
    const list = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, { headers: h, signal: AbortSignal.timeout(8000) })).json();
    const ids = (list.messages || []).map((m) => m.id);
    const messages = [];
    for (const mid of ids) {
      // metadata format keeps it small: just the headers we need plus the snippet
      const m = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${mid}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers: h, signal: AbortSignal.timeout(8000) })).json();
      const hdr = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      messages.push({ from: hdr.from || '', subject: hdr.subject || '(no subject)', date: hdr.date || '', snippet: (m.snippet || '').slice(0, 200) });
    }
    return { ok: true, connected: true, messages };
  } catch (e) { emit('connector.error', { id: 'gmail', where: 'list', message: e.message }); return { ok: false, connected: true, messages: [] }; }
}

// ---------- Calendar: the owner's events for a day, and whether they're free ----------
// date is 'YYYY-MM-DD' (defaults to today, IST). Returns events and a simple free/busy read.
export async function calendarBusy(date = '') {
  if (!connected('gcal')) return { ok: false, connected: false, events: [] };
  const token = await accessToken('gcal');
  if (!token) return { ok: false, connected: true, events: [] };
  // day window in IST, expressed as an RFC3339 range with the +05:30 offset
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const timeMin = `${day}T00:00:00+05:30`, timeMax = `${day}T23:59:59+05:30`;
  try {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '20' });
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!r.ok) { emit('connector.error', { id: 'gcal', where: 'events', status: r.status }); return { ok: false, connected: true, events: [] }; }
    const events = (j.items || [])
      .filter((e) => e.status !== 'cancelled')
      .map((e) => ({ summary: e.summary || '(busy)', start: e.start?.dateTime || e.start?.date || '', end: e.end?.dateTime || e.end?.date || '', allDay: !e.start?.dateTime }));
    return { ok: true, connected: true, date: day, events, free: events.length === 0 };
  } catch (e) { emit('connector.error', { id: 'gcal', where: 'events', message: e.message }); return { ok: false, connected: true, events: [] }; }
}

export { connected };
