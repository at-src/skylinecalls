// Loads Google's photorealistic 3D tiles over the demo spot in a headless browser and screenshots it,
// so we can see whether HSR Layout has real building coverage before building the dashboard around 3D.
import '../src/env.js';
import { createRequire } from 'node:module'; const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');
import { writeFileSync } from 'node:fs';

const KEY = process.env.GOOGLE_MAPS_KEY;
const LAT = 12.9128, LNG = 77.6374; // near BDA Complex, 14th Main, HSR Layout

const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#map{height:100%;margin:0}</style>
<script src="https://unpkg.com/three@0.169.0/build/three.min.js"></script>
</head><body><div id="map"></div>
<script type="module">
  // Minimal: use Google's Map Tiles 3D via the Maps JS "Map3DElement" (experimental) if available,
  // else just report tile availability by fetching a viewport tile.
  const KEY=${JSON.stringify(KEY)};
  window.__done=null;
  (async()=>{
    try{
      await new Promise((res,rej)=>{const s=document.createElement('script');
        s.src='https://maps.googleapis.com/maps/api/js?key='+KEY+'&v=alpha&libraries=maps3d';
        s.onload=res;s.onerror=rej;document.head.appendChild(s);});
      await google.maps.importLibrary('maps3d');
      const {Map3DElement}=await google.maps.importLibrary('maps3d');
      const el=new Map3DElement({center:{lat:${LAT},lng:${LNG},altitude:120},tilt:67,range:600,heading:40});
      document.getElementById('map').appendChild(el);
      await new Promise(r=>setTimeout(r,6000));
      window.__done={ok:true,mode:'Map3DElement'};
    }catch(e){ window.__done={ok:false,error:String(e).slice(0,200)}; }
  })();
</script></body></html>`;

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'C:/hc/tothedoor/.chrome-3d', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage();
await p.setViewport({ width: 1100, height: 760 });
const logs = [];
p.on('console', (m) => logs.push(m.text().slice(0, 160)));
p.on('pageerror', (e) => logs.push('ERR ' + e.message.slice(0, 160)));
await p.setContent(html, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise((r) => setTimeout(r, 9000));
const done = await p.evaluate(() => window.__done);
await p.screenshot({ path: 'scripts/3d-check.png' });
writeFileSync('scripts/3d-check.log', JSON.stringify({ done, logs }, null, 1));
console.log('result:', JSON.stringify(done));
logs.slice(0, 8).forEach((l) => console.log(' ', l));
console.log('screenshot: scripts/3d-check.png');
await b.close();
