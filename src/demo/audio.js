// The demo calls' recorded lines (scripts/render-demo-audio.js). Each line plays on the dashboard, and the script
// waits for it to finish before the next one, so the demo sounds like a real call.
import { readFileSync } from 'node:fs';
let manifest = {};
try { manifest = JSON.parse(readFileSync(new URL('../../public/demo-audio/manifest.json', import.meta.url), 'utf8')); } catch { /* not rendered: silent demo */ }
// { src, seconds } for line i of a script ('guide' or 'teach'), or null
export function clipFor(script, i, service) {
  for (const name of [`${script}-${i}-${service}`, `${script}-${i}`]) if (manifest[name]) return { src: `/demo-audio/${name}.mp3`, seconds: manifest[name] };
  return null;
}
