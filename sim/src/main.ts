import { ACESFilmicToneMapping, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';

import { CAMERA, DEFAULT_RESORT, SIM_TIME, TERRAIN } from './config';
import { FlyControls } from './controls/fly-controls';
import { Input } from './controls/input';
import { SkiControls } from './controls/ski-controls';
import { Environment } from './env/environment';
import { createBuildings } from './features/buildings';
import { createLifts } from './features/lifts';
import type { ResortFeatures } from './features/types';
import { Heightmap } from './geo/heightmap';
import { LocalFrame, worldToEnu } from './geo/local-frame';
import { type HeightmapMeta, loadManifest, resortUrl } from './resort/manifest';
import { createNormalTexture } from './terrain/normals';
import { AdaptiveResolution } from './render/adaptive-resolution';
import { Terrain } from './terrain/terrain';
import { createTerrainMaterial } from './terrain/terrain-material';
import { buildPlaces } from './nav/places';
import { loadPose, type Pose, savePose } from './nav/pose';
import { Hud } from './ui/hud';
import { type LabelKind, type LabelSpec, Labels, liftLabel, peakLabel } from './ui/labels';
import { Minimap } from './ui/minimap';
import { WorldMap } from './ui/world-map';

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
  const renderer = new WebGPURenderer({ canvas, antialias: true, reversedDepthBuffer: true });
  const resolution = new AdaptiveResolution(Math.min(window.devicePixelRatio, 2));
  renderer.setPixelRatio(resolution.ratio);
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
    createTerrainMaterial(near, createNormalTexture(near), undefined, { snowDetail: true }),
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
  const bounds = {
    minX: farExtent.west + 500,
    maxX: farExtent.east - 500,
    minZ: -farExtent.north + 500,
    maxZ: -farExtent.south - 500,
  };
  const input = new Input(canvas);
  const fly = new FlyControls(camera, groundHeight, bounds);
  const ski = new SkiControls(camera, { height: groundHeight }, bounds);
  scene.add(ski.skier);
  let mode: Mode = loadMode();
  const controls = () => (mode === 'ski' ? ski : fly);
  const spawn: Pose = { ...manifest.spawn, pitch: -8 };
  const inBounds = (p: Pose) =>
    p.east > farExtent.west + 500 &&
    p.east < farExtent.east - 500 &&
    p.north > farExtent.south + 500 &&
    p.north < farExtent.north - 500;
  const saved = loadPose(localStorage, resortId);
  let lastSaved: Pose | null = null;
  const currentPose = (): Pose => {
    // In ski mode, track the skier rather than a chase camera behind them.
    const at = mode === 'ski' ? ski.feet : camera.position;
    const { east, north } = worldToEnu(at.x, at.z);
    return {
      east,
      north,
      altitude: at.y,
      heading: controls().heading,
      pitch: controls().pitchDegrees,
    };
  };
  const persistPose = () => {
    const pose = currentPose();
    const moved =
      !lastSaved ||
      Math.hypot(pose.east - lastSaved.east, pose.north - lastSaved.north) > 1 ||
      Math.abs(pose.altitude - lastSaved.altitude) > 1 ||
      Math.abs(pose.heading - lastSaved.heading) > 1 ||
      Math.abs(pose.pitch - lastSaved.pitch) > 1;
    if (moved) {
      savePose(localStorage, resortId, pose);
      lastSaved = pose;
    }
  };
  // Explicit ?at= link > where you left off > the resort's spawn point.
  const startPose = poseFromUrl(params, frame, spawn) ?? (saved && inBounds(saved) ? saved : spawn);
  controls().place(startPose);
  ski.setActive(mode === 'ski');
  nearTerrain.update(camera.position, Infinity);
  farTerrain.update(camera.position, Infinity);

  const hud = new Hud($('#hud'));
  const minimap = await Minimap.load(
    $<HTMLCanvasElement>('#minimap canvas'),
    resortUrl(resortId, manifest.minimap.file),
    manifest.minimap.extent,
  );
  const labels = new Labels(
    $('#labels'),
    [
      ...features.lifts.map(liftLabel).filter((l): l is LabelSpec => l !== null),
      ...features.peaks.map((p) => peakLabel(p, near.extent)),
    ],
    groundHeight,
    loadLabelPrefs(),
  );
  const toggleLabels = (kind: LabelKind) => {
    labels.setVisible(kind, !labels.isVisible(kind));
    hud.setToggle(kind, labels.isVisible(kind));
    saveLabelPrefs({ lift: labels.isVisible('lift'), peak: labels.isVisible('peak') });
  };
  hud.setToggle('lift', labels.isVisible('lift'));
  hud.setToggle('peak', labels.isVisible('peak'));
  const debug = $('#debug');

  // Teleports reset the speed readout so the jump doesn't register as motion.
  let speedReset = true;
  const worldMap = new WorldMap(
    $('#world-map'),
    {
      resortName: manifest.resort.name,
      image: minimap.image,
      imageExtent: manifest.minimap.extent,
      lifts: features.lifts,
      peaks: features.peaks,
      places: buildPlaces(manifest.resort.name, spawn, features.lifts, features.peaks, near.extent),
      groundHeight: (east, north) => groundHeight(east, -north),
      toLatLon: (east, north) => frame.toLatLon(east, north),
    },
    (pose) => {
      controls().place(pose);
      speedReset = true;
      persistPose();
      closeMap(true);
    },
    () => closeMap(false),
  );
  const setMode = (next: Mode) => {
    const pose = currentPose();
    mode = next;
    // Fly mode picks up from the eye position; ski mode drops onto the snow below.
    controls().place(pose);
    ski.setActive(mode === 'ski');
    hud.setMode(mode);
    document.body.classList.toggle('skiing', mode === 'ski');
    speedReset = true;
    localStorage.setItem(MODE_KEY, mode);
  };
  hud.setMode(mode);
  document.body.classList.toggle('skiing', mode === 'ski');
  const openMap = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    worldMap.open(currentPose());
    document.body.classList.add('map-open');
  };
  const closeMap = (resumeFlying: boolean) => {
    worldMap.close();
    document.body.classList.remove('map-open');
    // Closing from a click or key press counts as a user gesture, so pointer lock is allowed.
    if (resumeFlying) void input.lock();
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('flying', input.locked);
  });
  // Ctrl sprints, but Ctrl+W closes the tab on Windows/Linux and can't be intercepted.
  // Ask before leaving instead. (On macOS Ctrl+W does nothing, so skip the prompt.)
  if (!/Mac|iPhone|iPad/.test(navigator.userAgent)) {
    window.addEventListener('beforeunload', (e) => {
      if (input.locked) e.preventDefault();
    });
  }
  window.addEventListener('pagehide', persistPose);
  document.addEventListener('visibilitychange', persistPose);
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return; // typing in the map search box
    if (e.code === 'KeyM' && !e.repeat) {
      if (worldMap.isOpen) closeMap(true);
      else openMap();
    } else if (e.code === 'Escape' && worldMap.isOpen) {
      closeMap(false);
    } else if (e.code === 'KeyF' && !e.repeat && !worldMap.isOpen) {
      setMode(mode === 'ski' ? 'fly' : 'ski');
    } else if (e.code === 'KeyV' && !e.repeat && mode === 'ski') {
      ski.toggleView();
    } else if (e.code === 'F3') {
      e.preventDefault();
      debug.hidden = !debug.hidden;
    } else if (e.code === 'KeyL' && !e.repeat) {
      toggleLabels('lift');
    } else if (e.code === 'KeyP' && !e.repeat) {
      toggleLabels('peak');
    }
  });
  const start = $<HTMLButtonElement>('#start');
  start.addEventListener('click', () => void input.lock());
  status.textContent =
    manifest.resort.country === 'FR' ? 'Savoie, France' : manifest.resort.country;
  start.hidden = false;

  const sim = { ready: false, frames: 0 };
  window.__sim = sim;
  // Dev-only handles for profiling scripts and debugging from the console.
  if (import.meta.env.DEV) Object.assign(sim, { scene, renderer, camera, labels, minimap });
  let last = performance.now();
  let lastX = camera.position.x;
  let lastY = camera.position.y;
  let lastZ = camera.position.z;
  let speed = 0;
  let fps = 60;

  let lastPersist = 0;

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 0.1);
    // Ignore hitches from tab switches or the map being open.
    if (frameMs < 250 && resolution.sample(frameMs)) renderer.setPixelRatio(resolution.ratio);
    last = now;
    // The fullscreen map covers everything; skip 3D work while it's open.
    if (worldMap.isOpen) return;

    controls().update(dt, input);
    input.endFrame();
    const pos = camera.position;
    if (speedReset) {
      speed = 0;
      speedReset = false;
    } else if (dt > 0) {
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
    // A touch wider field of view at speed when skiing.
    const fov = CAMERA.fov + (mode === 'ski' ? Math.min(ski.speed / 30, 1) * 10 : 0);
    if (Math.abs(fov - camera.fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);

    const here = mode === 'ski' ? ski.feet : pos;
    const { east, north } = worldToEnu(here.x, here.z);
    const { lat, lon } = frame.toLatLon(east, north);
    hud.update({ altitude: here.y, lat, lon, speed: mode === 'ski' ? ski.speed : speed });
    minimap.draw(east, north, controls().heading);
    labels.update(camera);

    if (!debug.hidden) {
      const info = renderer.info.render;
      const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL 2';
      debug.textContent = [
        `${fps.toFixed(0)} fps · ${backend} · render scale ${resolution.ratio.toFixed(2)}`,
        `draw calls ${info.drawCalls} · triangles ${(info.triangles / 1e6).toFixed(2)}M`,
        `E ${east.toFixed(1)}  N ${north.toFixed(1)}  ground ${groundHeight(pos.x, pos.z).toFixed(1)} m`,
        mode === 'ski'
          ? `heading ${ski.heading.toFixed(1)}° · ski ${(ski.speed * 3.6).toFixed(0)} km/h${ski.airborne ? ' (air)' : ''} · ${ski.view}`
          : `heading ${fly.heading.toFixed(1)}° · fly speed ${fly.speed.toFixed(0)} m/s${fly.sprinting ? ' (sprint)' : ''}`,
        `sun az ${environment.sun.azimuth.toFixed(1)}° el ${environment.sun.elevation.toFixed(1)}°`,
      ].join('\n');
    }

    if (now - lastPersist > 1000) {
      persistPose();
      lastPersist = now;
    }

    sim.frames++;
    sim.ready = true;
  });
}

/** A pose from ?at=lat,lon,alt&heading=deg&pitch=deg, if the link has one. */
function poseFromUrl(params: URLSearchParams, frame: LocalFrame, spawn: Pose): Pose | null {
  const at = params.get('at')?.split(',').map(Number);
  if (!at || at.length !== 3 || !at.every(Number.isFinite)) return null;
  const { east, north } = frame.toLocal(at[0]!, at[1]!);
  return {
    east,
    north,
    altitude: at[2]!,
    heading: Number(params.get('heading') ?? spawn.heading),
    pitch: Number(params.get('pitch') ?? spawn.pitch),
  };
}

type Mode = 'fly' | 'ski';
const MODE_KEY = 'mountain-map.mode';

function loadMode(): Mode {
  return localStorage.getItem(MODE_KEY) === 'ski' ? 'ski' : 'fly';
}

const LABEL_PREFS_KEY = 'mountain-map.labels';

function loadLabelPrefs(): Record<LabelKind, boolean> {
  const defaults = { lift: true, peak: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(LABEL_PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

function saveLabelPrefs(prefs: Record<LabelKind, boolean>): void {
  localStorage.setItem(LABEL_PREFS_KEY, JSON.stringify(prefs));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error);
  status.classList.add('error');
  status.textContent = error instanceof Error ? error.message : String(error);
});
