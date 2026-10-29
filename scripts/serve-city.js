// Serves the ported city renderer (city/) on its own, for looking at it before it is wired into the dashboard.
// Usage: node scripts/serve-city.js  ->  http://localhost:3300/?city=bengaluru
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = normalize('C:/hc/tothedoor/city');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const PORT = Number(process.env.PORT) || 3300;
http.createServer(async (req, res) => {
  try {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (!p || p === '.') p = 'index.html';
    const f = join(ROOT, p);
    if (!f.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if ((await stat(f)).isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(f));
  } catch { res.writeHead(404).end(); }
}).listen(PORT, () => console.log(`city renderer on http://localhost:${PORT}/?city=bengaluru`));
