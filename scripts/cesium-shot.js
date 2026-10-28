// Renders Google Photorealistic 3D Tiles via CesiumJS at candidate spots and screenshots each.
// Camera targets the real ground height (sampled from the tiles), so it looks down at the city instead of sitting underground.
// Usage: node scripts/cesium-shot.js [name lat lng ...]
import '../src/env.js';
import { createRequire } from 'node:module';
const puppeteer = createRequire(process.env.PUPPETEER_PKG || import.meta.url)('puppeteer-core');

const KEY = process.env.GOOGLE_MAPS_KEY;
const args = process.argv.slice(2);
const SPOTS = args.length >= 3
  ? Array.from({ length: args.length / 3 }, (_, i) => [args[i * 3], +args[i * 3 + 1], +args[i * 3 + 2]])
  : [
    ['ubcity', 12.9716, 77.5963],
    ['mgroad', 12.9757, 77.6055],
    ['indiranagar', 12.9784, 77.6408],
    ['koramangala', 12.9352, 77.6245],
    ['hsr', 12.9128, 77.6374],
  ];

const page = (lat, lng) => `<!doctype html><html><head><meta charset=utf-8>
<script src="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Cesium.js"></script>
<link href="https://cesium.com/downloads/cesiumjs/releases/1.123/Build/Cesium/Widgets/widgets.css" rel=stylesheet>
<style>html,body,#c{margin:0;width:100%;height:100%;overflow:hidden;background:#0d0d0d}.cesium-viewer-bottom{display:none}</style>
</head><body><div id=c></div><script>
window.__ready=false;window.__err=null;
(async()=>{try{
  const viewer=new Cesium.Viewer('c',{baseLayerPicker:false,geocoder:false,homeButton:false,sceneModePicker:false,
    navigationHelpButton:false,animation:false,timeline:false,fullscreenButton:false,infoBox:false,selectionIndicator:false,
    globe:false,skyBox:false,skyAtmosphere:false,requestRenderMode:false});
  viewer.scene.backgroundColor=Cesium.Color.fromCssColorString('#0d0d0d');
  const tileset=await Cesium.Cesium3DTileset.fromUrl('https://tile.googleapis.com/v1/3dtiles/root.json?key=${KEY}',{showCreditsOnScreen:true,maximumScreenSpaceError:8});
  viewer.scene.primitives.add(tileset);
  const look=(h)=>viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(${lng},${lat},h),new Cesium.HeadingPitchRange(Cesium.Math.toRadians(35),Cesium.Math.toRadians(-38),520));
  look(830);
  const wait=async()=>{let stable=0,last=-1;for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,500));
    const n=tileset.statistics.numberOfTilesWithContentReady;const pend=tileset.statistics.numberOfPendingRequests;
    if(n===last&&pend===0)stable++;else stable=0;last=n;if(stable>=4)break;}return last;};
  await wait();
  // sample the real ground height under the target and re-aim
  let h=830;
  try{const c=await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(${lng},${lat})]);if(c[0]&&Number.isFinite(c[0].height))h=c[0].height;}catch(e){}
  window.__ground=h;
  look(h);
  window.__tiles=await wait();
  window.__ready=true;
}catch(e){window.__err=String(e).slice(0,200);}})();
</script></body></html>`;

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'C:/hc/tothedoor/.chrome-3d', args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [name, lat, lng] of SPOTS) {
  const p = await b.newPage();
  await p.setViewport({ width: 960, height: 640 });
  await p.setContent(page(lat, lng), { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 90; i++) { if (await p.evaluate(() => window.__ready || window.__err)) break; await new Promise((r) => setTimeout(r, 1000)); }
  await new Promise((r) => setTimeout(r, 1500));
  const info = await p.evaluate(() => ({ err: window.__err, tiles: window.__tiles, ground: window.__ground }));
  await p.screenshot({ path: `scripts/3d-${name}.jpg`, type: 'jpeg', quality: 85 });
  console.log(`${name}: ground=${Math.round(info.ground ?? 0)}m tiles=${info.tiles ?? '?'} ${info.err ? 'ERR ' + info.err : ''}`);
  await p.close();
}
await b.close();
