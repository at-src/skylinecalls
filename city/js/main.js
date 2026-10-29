import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CITY } from './open-city-config.js';
import { buildCityGrid } from './city-grid.js';
import { buildOpenCityBuildings } from './open-city-buildings.js';
import { buildOpenCityDetails } from './open-city-details.js';
import { createTrafficSystem, createHighwayTraffic } from './traffic.js';
import { buildRoadPaint } from './road-paint.js';
import { LightingSystem } from './lighting.js';
import { createPostProcessing } from './post-processing.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { Weather } from './weather.js';
import { startBridge } from './ttd-bridge.js';

// js/main.js
// The city as a 3D map: ground, roads, buildings, trees, street furniture and traffic built from OpenStreetMap, lit
// through the day and night, seen through an orbiting camera. The dashboard drives it through ttd-bridge.js.

async function initApp() {
  const container = document.getElementById('canvas-container');
  document.title = `ToTheDoor · ${CITY.name}`;

  // WebGPU renderer with a reversed depth buffer (precision across the whole city) and clustered lights for the
  // street lamps and shop fronts
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // start-up timings, logged once as "[init] ..."
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };
  await renderer.init();
  markInit('renderer');

  // sky, sun, haze and image-based lighting
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  // the city
  const cityGrid = buildCityGrid(scene);
  markInit('cityGrid');
  const cityBlocks = buildOpenCityBuildings(scene);
  markInit('buildings');
  const streetDetails = buildOpenCityDetails(scene);
  markInit('streetDetails');
  const colliders = [...cityBlocks.colliders, ...(cityGrid.colliders || [])];
  const trafficSystem = createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...colliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5)
  ], streetDetails.signalIntersections);
  markInit('traffic');
  const highwayTraffic = createHighwayTraffic(scene, cityGrid.highwayLanes);
  buildRoadPaint(scene, trafficSystem.network);
  if (streetDetails.attach) streetDetails.attach(trafficSystem.network, null);
  markInit('roadPaint');

  // the map camera: orbiting the city, turning slowly by itself until someone takes it
  const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 1, 60000);
  camera.position.set(-180, 330, 360);
  const orbit = new OrbitControls(camera, renderer.domElement);
  Object.assign(orbit, {
    enableDamping: true, dampingFactor: 0.07, minDistance: 40, maxDistance: 2600, maxPolarAngle: Math.PI * 0.45,
    autoRotate: true, autoRotateSpeed: 0.25, rotateSpeed: 0.55, zoomSpeed: 0.9, screenSpacePanning: false
  });
  orbit.target.set(0, 0, 0);
  let idle;
  orbit.addEventListener('start', () => { orbit.autoRotate = false; clearTimeout(idle); });
  orbit.addEventListener('end', () => { clearTimeout(idle); idle = setTimeout(() => (orbit.autoRotate = true), 9000); });
  orbit.update();

  // static geometry: chunked and distance-culled, with shadow stand-ins for the big casters
  const cullingRoots = ['CityGrid', 'CityBuildings', 'CityStreetDetails']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  setupSceneCulling(scene, cullingRoots, lightingSystem.sunLight.shadow);
  // world matrices are set once; only the moving things update theirs each frame
  const dynamicRoots = [
    trafficSystem.group,
    highwayTraffic.group,
    scene.getObjectByName('Rain'),
    scene.getObjectByName('StoreClusteredLights'),
    scene.getObjectByName('StreetClusteredLights')
  ].filter(Boolean);
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;
  markInit('culling');

  // On WebGPU, small instanced meshes keep their matrices in uniform buffers that are re-uploaded on every draw of every
  // pass; storage attributes only upload when they change
  if (renderer.backend.isWebGPUBackend) {
    scene.traverse((object) => {
      if (object.isInstancedMesh) object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
    });
  }

  // render pipeline: half-resolution screen-space reflections on the glossy surfaces, then bloom and colour grading
  const scenePass = pass(scene, camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');
  const ssrPass = ssr(scenePassColor, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.5;
  ssrPass.screenEdgeFadeBlack = true;
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const colorGrade = createPostProcessing(renderer, scenePassColor, ssrPass.mul(reflectionMask));
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // a lighting preset (golden, midday, twilight, midnight) and its colour grade together
  const applyPreset = (id) => {
    lightingSystem.applyPreset(id);
    colorGrade.applyPreset(lightingSystem.activePresetId);
  };
  applyPreset('golden');
  const weather = new Weather(scene, lightingSystem);
  if (new URLSearchParams(location.search).has('rain')) weather.setRain(1, true);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Compile the shaders before the first frame: several compileAsync() calls side by side keep the main thread busy
  // while the GPU process compiles the pipelines in parallel
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    // an empty frame first sets up the post-processing chain, so the pipelines compiled below are the ones it uses
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');
    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    const pipelines = new Set();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      if (o.userData.shadowProxy) return;
      const pipeline = o.userData.sharesPipelineWith || o;
      if (pipelines.has(pipeline)) return;
      pipelines.add(pipeline);
      if (o.isInstancedMesh || Array.isArray(o.material)) { jobs.push([o]); return; }
      let job = jobByMaterial.get(o.material);
      if (!job) { job = []; jobByMaterial.set(o.material, job); jobs.push(job); }
      job.push(o);
    });
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    const compile = async (object) => {
      await nextTask();
      try { await renderer.compileAsync(object, camera, scene); } catch (e) { console.warn('[compile]', e); }
    };
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) for (const object of jobs[next++]) await compile(object);
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  // for poking at from the console
  globalThis.city3d = { scene, camera, orbit, lightingSystem, trafficSystem, applyPreset, weather };

  await precompileShaders();
  markInit('compile');

  const bridge = startBridge({ scene, camera, orbit, applyPreset, weather, footprints: cityBlocks.allBlocks[0].footprints });
  let lastTime = performance.now();
  let elapsed = 0;
  let warmedUp = false;
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(Math.max((now - lastTime) * 0.001, 0.001), 0.05);
    lastTime = now;
    elapsed += dt;

    bridge.update();
    orbit.update(dt);
    streetDetails.signalClock.value = elapsed;
    trafficSystem.update(dt, elapsed, camera.position, null, 'none', camera);
    highwayTraffic.update(dt, camera, null, 'none');
    cityBlocks.update(camera.position.x, camera.position.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(camera);
    if (streetDetails.update) streetDetails.update(camera, null);
    lightingSystem.update(camera.position);
    weather.update(dt, orbit.target);
    if (warmedUp) updateSceneCulling(camera.position);
    for (const root of dynamicRoots) root.updateMatrixWorld();

    if (!warmedUp) {
      // the first frame draws every chunk once with frustum culling off, so the shadow passes' pipelines compile now
      // rather than the first time the camera turns towards them
      const culled = [];
      const pipelines = new Set();
      scene.traverseVisible((o) => {
        const pipeline = o.userData.sharesPipelineWith || o;
        if (pipelines.has(pipeline)) return;
        pipelines.add(pipeline);
        if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
      });
      renderPipeline.render();
      for (const o of culled) o.frustumCulled = true;
      markInit('warmup');
    }
    renderPipeline.render();
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      // tell the dashboard once the GPU has the first frame on screen
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        window.dispatchEvent(new Event('ttd-rendered'));
      });
    }
  });
}

initApp();
