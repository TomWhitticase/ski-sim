import { ACESFilmicToneMapping, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

import { CAMERA, DEFAULT_RESORT, SIM_TIME, TERRAIN } from './config';
import { FlyControls } from './controls/fly-controls';
import { Environment } from './env/environment';
import { createBuildings } from './features/buildings';
import { createLifts } from './features/lifts';
import type { ResortFeatures } from './features/types';
import { Heightmap } from './geo/heightmap';
import { LocalFrame, worldToEnu } from './geo/local-frame';
import { type HeightmapMeta, loadManifest, resortUrl } from './resort/manifest';
import { createNormalTexture } from './terrain/normals';
import { Terrain } from './terrain/terrain';
import { createTerrainMaterial } from './terrain/terrain-material';
import { Hud } from './ui/hud';
import { Minimap } from './ui/minimap';

declare global {
  interface Window {
    /** Exposed for Playwright screenshot tests. */
    __sim?: { ready: boolean; frames: number };
  }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = $('#status');

async function loadHeightmap(resortId: string, meta: HeightmapMeta): Promise<Heightmap> {
  const res = await fetch(resortUrl(resortId, meta.file));
  if (!res.ok) throw new Error(`Failed to load ${meta.file} (HTTP ${res.status})`);
  return Heightmap.decode(await res.arrayBuffer(), meta);
}

async function loadFeatures(resortId: string, file: string): Promise<ResortFeatures> {
  const res = await fetch(resortUrl(resortId, file));
  if (!res.ok) throw new Error(`Failed to load ${file} (HTTP ${res.status})`);
  return (await res.json()) as ResortFeatures;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const resortId = params.get('resort') ?? DEFAULT_RESORT;

  const manifest = await loadManifest(resortId);
  $('#resort-name').textContent = manifest.resort.name;
  document.title = `${manifest.resort.name} · mountain-map`;
  $('#attribution').textContent =
    'Terrain: ' + manifest.provenance.map((p) => p.attribution).join(' · ');

  status.textContent = 'Loading terrain…';
  const [near, far, features] = await Promise.all([
    loadHeightmap(resortId, manifest.terrain.near),
    loadHeightmap(resortId, manifest.terrain.far),
    loadFeatures(resortId, manifest.features.file),
  ]);
  const frame = new LocalFrame(manifest.projection);
  const groundHeight = (x: number, z: number) => {
    const { east, north } = worldToEnu(x, z);
    return near.contains(east, north) ? near.sample(east, north) : far.sample(east, north);
  };

  const canvas = $<HTMLCanvasElement>('#scene');
  const renderer = new WebGPURenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  await renderer.init();

  const scene = new Scene();
  const camera = new PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  const environment = new Environment(scene, SIM_TIME, manifest.origin.lat, manifest.origin.lon);

  status.textContent = 'Building terrain…';
  await nextFrame();
  const nearTerrain = new Terrain(
    near,
    createTerrainMaterial(near, createNormalTexture(near)),
    TERRAIN.near,
  );
  const farTerrain = new Terrain(
    far,
    createTerrainMaterial(far, createNormalTexture(far), near.extent),
    { ...TERRAIN.far, skip: near.extent },
  );
  scene.add(
    nearTerrain.object,
    farTerrain.object,
    createLifts(features.lifts),
    createBuildings(features.buildings),
  );

  const farExtent = far.extent;
  const controls = new FlyControls(camera, canvas, groundHeight, {
    minX: farExtent.west + 500,
    maxX: farExtent.east - 500,
    minZ: -farExtent.north + 500,
    maxZ: -farExtent.south - 500,
  });
  placeCamera(camera, controls, frame, manifest.spawn, params);

  nearTerrain.update(camera.position, Infinity);
  farTerrain.update(camera.position, Infinity);

  const hud = new Hud($('#hud'));
  const minimap = await Minimap.load(
    $<HTMLCanvasElement>('#minimap canvas'),
    resortUrl(resortId, manifest.minimap.file),
    manifest.minimap.extent,
  );
  const debug = $('#debug');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('flying', controls.locked);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'F3') {
      e.preventDefault();
      debug.hidden = !debug.hidden;
    }
  });
  const start = $<HTMLButtonElement>('#start');
  start.addEventListener('click', () => void controls.lock());
  status.textContent =
    manifest.resort.country === 'FR' ? 'Savoie, France' : manifest.resort.country;
  start.hidden = false;

  const sim = { ready: false, frames: 0 };
  window.__sim = sim;
  let last = performance.now();
  let lastX = camera.position.x;
  let lastY = camera.position.y;
  let lastZ = camera.position.z;
  let speed = 0;
  let fps = 60;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    controls.update(dt);
    const pos = camera.position;
    if (dt > 0) {
      const moved = Math.hypot(pos.x - lastX, pos.y - lastY, pos.z - lastZ) / dt;
      speed += (moved - speed) * Math.min(1, dt * 8);
      fps += (1 / dt - fps) * Math.min(1, dt * 2);
    }
    lastX = pos.x;
    lastY = pos.y;
    lastZ = pos.z;

    nearTerrain.update(pos, TERRAIN.buildBudgetMs);
    farTerrain.update(pos, TERRAIN.buildBudgetMs);
    environment.update(camera);
    renderer.render(scene, camera);

    const { east, north } = worldToEnu(pos.x, pos.z);
    const { lat, lon } = frame.toLatLon(east, north);
    hud.update({ altitude: pos.y, lat, lon, speed });
    minimap.draw(east, north, controls.heading);

    if (!debug.hidden) {
      const info = renderer.info.render;
      const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL 2';
      debug.textContent = [
        `${fps.toFixed(0)} fps · ${backend}`,
        `draw calls ${info.drawCalls} · triangles ${(info.triangles / 1e6).toFixed(2)}M`,
        `E ${east.toFixed(1)}  N ${north.toFixed(1)}  ground ${groundHeight(pos.x, pos.z).toFixed(1)} m`,
        `heading ${controls.heading.toFixed(1)}° · fly speed ${controls.speed.toFixed(0)} m/s${controls.sprinting ? ' (sprint)' : ''}`,
        `sun az ${environment.sun.azimuth.toFixed(1)}° el ${environment.sun.elevation.toFixed(1)}°`,
      ].join('\n');
    }

    sim.frames++;
    sim.ready = true;
  });
}

/** Spawn from the manifest, overridable with ?at=lat,lon,alt&heading=deg&pitch=deg. */
function placeCamera(
  camera: PerspectiveCamera,
  controls: FlyControls,
  frame: LocalFrame,
  spawn: { east: number; north: number; altitude: number; heading: number },
  params: URLSearchParams,
): void {
  let { east, north, altitude } = spawn;
  const at = params.get('at')?.split(',').map(Number);
  if (at && at.length === 3 && at.every(Number.isFinite)) {
    ({ east, north } = frame.toLocal(at[0]!, at[1]!));
    altitude = at[2]!;
  }
  camera.position.set(east, altitude, -north);
  controls.setHeading(Number(params.get('heading') ?? spawn.heading));
  controls.setPitch(Number(params.get('pitch') ?? -8));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error);
  status.classList.add('error');
  status.textContent = error instanceof Error ? error.message : String(error);
});
