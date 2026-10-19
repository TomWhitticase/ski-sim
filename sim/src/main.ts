import { uniform } from 'three/tsl';
import {
  ACESFilmicToneMapping,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { CAMERA, DEFAULT_RESORT, FLY, SIM_TIME, TERRAIN } from './config';
import { Sound } from './audio/sound';
import { liftHumLevel, soundLevels } from './audio/levels';
import { FlyControls } from './controls/fly-controls';
import { surfaceNormal } from './controls/ski-physics';
import { skidAmount, sprayRate, trailWidth } from './fx/intensity';
import { SnowSpray } from './fx/snow-spray';
import { SnowTrails } from './fx/snow-trails';
import { GliderControls } from './controls/glider-controls';
import { Input } from './controls/input';
import { EYE_HEIGHT, SkiControls } from './controls/ski-controls';
import { loadSetup, saveSetup, type SkiSetup } from './controls/ski-setup';
import { Environment } from './env/environment';
import { ObstacleIndex } from './features/obstacles';
import { createBuildings } from './features/buildings';
import type { ResortFeatures } from './features/types';
import { Heightmap } from './geo/heightmap';
import { LocalFrame, worldToEnu } from './geo/local-frame';
import { type HeightmapMeta, loadManifest, resortUrl } from './resort/manifest';
import { createNormalTexture } from './terrain/normals';
import { AdaptiveResolution } from './render/adaptive-resolution';
import { Terrain } from './terrain/terrain';
import { createTerrainMaterial } from './terrain/terrain-material';
import { buildPlaces, groundedPose, liftTypeName } from './nav/places';
import { LiftSystem } from './lifts/lift-system';
import { RideControls } from './lifts/ride';
import { createLiftSigns } from './lifts/signs';
import { createPisteMarkers } from './pistes/markers';
import {
  DIFFICULTY,
  loadPixels,
  overlayTexture,
  type PisteData,
  PisteLookup,
  pisteTitle,
} from './pistes/pistes';
import { loadPose, type Pose, savePose } from './nav/pose';
import { Hud } from './ui/hud';
import { type LabelKind, type LabelSpec, Labels, liftLabel, peakLabel } from './ui/labels';
import { LAST_RESORT_KEY, MainMenu, type ResortEntry, type StartChoice } from './ui/main-menu';
import { SkiSetupMenu } from './ui/ski-setup-menu';
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

/** One-time carry-over of settings and saved positions from before the ski-sim rename. */
function migrateStorage(): void {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith('mountain-map.')) continue;
    const renamed = `ski-sim.${key.slice('mountain-map.'.length)}`;
    if (localStorage.getItem(renamed) === null) {
      localStorage.setItem(renamed, localStorage.getItem(key)!);
    }
  }
}

async function main(): Promise<void> {
  migrateStorage();
  const params = new URLSearchParams(location.search);
  // Ski areas come from the pipeline's index; pick the URL's, else the last one played.
  const resorts = await fetchJson<{ resorts: ResortEntry[] }>('/resorts.json')
    .then((r) => r.resorts)
    .catch((): ResortEntry[] => []);
  const known = (id: string | null) => !!id && resorts.some((r) => r.id === id);
  const lastResort = localStorage.getItem(LAST_RESORT_KEY);
  const resortId =
    params.get('resort') ?? (known(lastResort) ? lastResort! : (resorts[0]?.id ?? DEFAULT_RESORT));
  localStorage.setItem(LAST_RESORT_KEY, resortId);

  let play: (choice: StartChoice) => void = () => {};
  const menu = new MainMenu($('#overlay'), (choice) => play(choice));
  menu.setResorts(resorts, resortId);
  let changeSkis: (setup: SkiSetup) => void = () => {};
  const skiSetup = new SkiSetupMenu($('#ski-setup-modal'), loadSetup(localStorage), (setup) => {
    saveSetup(localStorage, setup);
    changeSkis(setup);
  });
  $('#open-ski-setup').addEventListener('click', () => skiSetup.open());

  const manifest = await loadManifest(resortId);
  menu.setStarts(
    manifest.bases ?? [],
    params.has('at') || loadPose(localStorage, resortId) !== null,
  );
  document.title = `${manifest.resort.name} · ski-sim`;
  $('#attribution').textContent =
    'Terrain: ' + manifest.provenance.map((p) => p.attribution).join(' · ');
  status.textContent = 'Loading terrain…';
  const [near, far, features, pisteData, pisteOverlay, pisteLookupPixels] = await Promise.all([
    loadHeightmap(resortId, manifest.terrain.near),
    loadHeightmap(resortId, manifest.terrain.far),
    loadFeatures(resortId, manifest.features.file),
    fetchJson<PisteData>(resortUrl(resortId, manifest.pistes.file)),
    loadPixels(resortUrl(resortId, manifest.pistes.overlay.file)),
    loadPixels(resortUrl(resortId, manifest.pistes.lookup.file)),
  ]);
  const pisteLookup = new PisteLookup(
    pisteLookupPixels,
    manifest.pistes.lookup.cellSize,
    manifest.pistes.extent,
    pisteData.pistes,
  );
  const prefs = loadPrefs();
  const pisteTint = uniform(prefs.pistes ? 1 : 0);
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
    createTerrainMaterial(near, createNormalTexture(near), undefined, {
      snowDetail: true,
      pistes: { overlay: overlayTexture(pisteOverlay), tint: pisteTint },
    }),
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
    createBuildings(features.buildings),
    createPisteMarkers(pisteData),
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
  const ski = new SkiControls(
    camera,
    {
      height: groundHeight,
      // World z is -north.
      groomed: (x, z) => pisteLookup.at(x, -z)?.groomed ?? false,
      collide: (p, v) => obstacles.resolve(p, v),
    },
    bounds,
  );
  ski.setSetup(skiSetup.current);
  changeSkis = (setup) => ski.setSetup(setup);
  scene.add(ski.skier);
  const glider = new GliderControls(camera, groundHeight, bounds);
  scene.add(glider.root);
  const trails = new SnowTrails();
  const spray = new SnowSpray();
  scene.add(trails.mesh, spray.mesh);
  const fxLeft = new Vector3();
  const fxRight = new Vector3();
  const fxMid = new Vector3();
  const fxNormal = new Vector3();
  const fxSlide = new Vector3();
  const lifts = new LiftSystem(features.lifts, groundHeight);
  // Solid things you can't ski through: buildings and the lift terminals' walls and huts.
  const obstacles = new ObstacleIndex([
    ...features.buildings.map((b) => ({
      ring: b.footprint,
      base: b.base,
      top: b.top + (b.roof?.rise ?? 0),
    })),
    ...lifts.obstacles,
  ]);
  scene.add(lifts.root, createLiftSigns(lifts.lines, lifts.signMounts));
  const ride = new RideControls(camera, lifts, ski);
  let mode: Mode = loadMode();
  const controls = () =>
    mode === 'ski' ? ski : mode === 'glide' ? glider : mode === 'ride' ? ride : fly;
  /** Where you are: fly eye, or skier's / pilot's / rider's feet. */
  const whereAmI = () =>
    mode === 'ski'
      ? ski.feet
      : mode === 'glide'
        ? glider.position
        : mode === 'ride'
          ? ride.position
          : fly.position;
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
    const at = whereAmI();
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
    { lift: prefs.lift, peak: prefs.peak },
  );
  const sound = new Sound(!prefs.sound);
  const savePrefs = () =>
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        lift: labels.isVisible('lift'),
        peak: labels.isVisible('peak'),
        pistes: pisteTint.value > 0,
        sound: !sound.isMuted,
      }),
    );
  const toggleLabels = (kind: LabelKind) => {
    labels.setVisible(kind, !labels.isVisible(kind));
    hud.setToggle(kind, labels.isVisible(kind));
    savePrefs();
  };
  const togglePisteColours = () => {
    pisteTint.value = pisteTint.value > 0 ? 0 : 1;
    hud.setToggle('pistes', pisteTint.value > 0);
    savePrefs();
  };
  const toggleSound = () => {
    sound.setMuted(!sound.isMuted);
    hud.setToggle('sound', !sound.isMuted);
    savePrefs();
  };
  hud.setToggle('sound', !sound.isMuted);
  hud.setToggle('lift', labels.isVisible('lift'));
  hud.setToggle('peak', labels.isVisible('peak'));
  hud.setToggle('pistes', pisteTint.value > 0);
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
      places: buildPlaces(
        manifest.resort.name,
        spawn,
        features.lifts,
        features.peaks,
        near.extent,
        pisteData.pistes,
      ),
      pistes: pisteData.pistes,
      groundHeight: (east, north) => groundHeight(east, -north),
      toLatLon: (east, north) => frame.toLatLon(east, north),
    },
    (target, lookAt) => {
      if (mode === 'ride') setMode('ski');
      // Arrive standing on the ground, not hovering above it.
      const pose = groundedPose(
        target,
        (east, north) => groundHeight(east, -north),
        Math.max(EYE_HEIGHT, FLY.minHeightAboveGround) + 0.1,
        lookAt,
      );
      controls().place(pose);
      speedReset = true;
      persistPose();
      closeMap(true);
    },
    () => closeMap(false),
  );
  let view: 'first-person' | 'chase' =
    localStorage.getItem(VIEW_KEY) === 'chase' ? 'chase' : 'first-person';
  const setView = (next: typeof view) => {
    view = next;
    fly.view = view;
    ski.setView(view);
    glider.setView(view);
    document.body.classList.toggle('chase', view === 'chase');
    localStorage.setItem(VIEW_KEY, view);
  };
  setView(view);
  const setMode = (next: Mode) => {
    const pose = currentPose();
    // Ski and glide poses track the feet; fly mode's is the eye.
    const eye = mode === 'fly' ? pose : { ...pose, altitude: pose.altitude + EYE_HEIGHT };
    // Momentum carries across every switch (fly → glide, ski → glide, glide → ski...).
    const velocity = (
      mode === 'ski'
        ? ski.velocity
        : mode === 'glide'
          ? glider.velocity
          : mode === 'ride'
            ? ride.velocity
            : fly.currentVelocity
    ).clone();
    if (mode === 'ride') ride.leave();
    const look = controls().look;
    mode = next;
    if (mode === 'ski') {
      ski.place(eye, velocity);
    } else if (mode === 'glide') {
      const feet = eye.altitude - EYE_HEIGHT;
      glider.launch(new Vector3(eye.east, feet, -eye.north), velocity, look.yaw, look.pitch);
    } else if (mode === 'fly') {
      fly.place(eye);
    }
    ski.setActive(mode === 'ski' || mode === 'ride');
    glider.setActive(mode === 'glide');
    hud.setMode(mode);
    document.body.classList.toggle('skiing', mode !== 'fly');
    speedReset = true;
    localStorage.setItem(MODE_KEY, mode);
  };
  hud.setMode(mode);
  document.body.classList.toggle('skiing', mode !== 'fly');
  let nearTower = false;
  /** E: walk to the loading point and wait for the next carrier. */
  const boardLift = (line: number) => {
    const from = whereAmI().clone();
    const yaw = controls().look.yaw;
    setMode('ride');
    ride.approach(line, from, yaw);
  };
  /** Skied into a loading zone just as a carrier arrived: on you get. */
  const scooped = (line: number, carrier: number) => {
    const from = ski.feet.clone();
    const yaw = ski.look.yaw;
    setMode('ride');
    ride.boardFrom(line, carrier, from, yaw);
    sound.thump(3); // grip / seat taking your weight
  };
  /** Released at the unloading point, moving: off the chair and down the ramp. */
  const unload = () => {
    const { feet, velocity, heading } = ride.release();
    ride.leave();
    sound.thump(2.5);
    mode = 'ski';
    ski.place(
      { east: feet.x, north: -feet.z, altitude: feet.y + EYE_HEIGHT, heading, pitch: -5 },
      velocity,
    );
    ski.setActive(true);
    hud.setMode(mode);
    speedReset = true;
    localStorage.setItem(MODE_KEY, mode);
  };
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
    if (e.code === 'KeyG' && !e.repeat && !worldMap.isOpen) {
      if (document.pointerLockElement) document.exitPointerLock();
      skiSetup.toggle();
      return;
    }
    if (document.querySelector('dialog[open]')) return; // a menu dialog has the keyboard
    if (e.code === 'KeyM' && !e.repeat) {
      if (worldMap.isOpen) closeMap(true);
      else openMap();
    } else if (e.code === 'Escape' && worldMap.isOpen) {
      closeMap(false);
    } else if (e.code === 'KeyE' && !e.repeat && !worldMap.isOpen) {
      if (mode === 'ride') {
        setMode('ski'); // step off (or jump!) where you are
      } else if (mode !== 'glide') {
        const p = whereAmI();
        const line = lifts.boardingNear(p.x, p.z);
        if (line !== null) boardLift(line);
      }
    } else if (e.code === 'KeyF' && !e.repeat && !worldMap.isOpen) {
      setMode(mode === 'fly' ? 'ski' : 'fly');
    } else if (e.code === 'KeyP' && !e.repeat && !worldMap.isOpen) {
      // Deploy the paraglider (keeping your momentum), or drop it and ski.
      setMode(mode === 'glide' ? 'ski' : 'glide');
    } else if (e.code === 'KeyV' && !e.repeat) {
      setView(view === 'first-person' ? 'chase' : 'first-person');
    } else if (e.code === 'F3') {
      e.preventDefault();
      debug.hidden = !debug.hidden;
    } else if (e.code === 'KeyL' && !e.repeat) {
      toggleLabels('lift');
    } else if (e.code === 'KeyK' && !e.repeat) {
      toggleSound();
    } else if (e.code === 'KeyO' && !e.repeat) {
      togglePisteColours();
    } else if (e.code === 'KeyN' && !e.repeat) {
      toggleLabels('peak');
    }
  });
  /** Start (or restart) at a ski village: on your skis in front of its main lift. */
  const startAt = (base: NonNullable<StartChoice>) => {
    if (mode !== 'ski') setMode('ski');
    const pose = groundedPose(
      {
        east: base.east,
        north: base.north,
        altitude: base.ground,
        heading: base.heading,
        pitch: -5,
      },
      (east, north) => groundHeight(east, -north),
      EYE_HEIGHT + 0.1,
    );
    ski.place(pose);
    speedReset = true;
    persistPose();
  };
  play = (choice) => {
    sound.start(); // audio may only start from a user gesture
    if (choice) startAt(choice);
    void input.lock();
  };
  menu.setStatus(manifest.resort.name);
  menu.ready();

  const sim = { ready: false, frames: 0 };
  window.__sim = sim;
  // Dev-only handles for profiling scripts and debugging from the console.
  if (import.meta.env.DEV) Object.assign(sim, { scene, renderer, camera, labels, minimap, lifts });
  let last = performance.now();
  let lastX = fly.position.x;
  let lastY = fly.position.y;
  let lastZ = fly.position.z;
  let speed = 0;
  let fps = 60;

  let lastPersist = 0;
  /** Motor hum near stations; sheave clacks as your carrier rolls over each tower. */
  const updateLiftSound = () => {
    const p = whereAmI();
    sound.setLiftHum(liftHumLevel(lifts.nearestStation(p.x, p.z), mode === 'ride'));
    if (mode !== 'ride' || ride.phase !== 'riding') return;
    // Clack as your carrier rolls over a tower's sheaves.
    const p2 = ride.position;
    const close = lifts
      .towerPoints(ride.line)
      .some((t) => Math.hypot(t.x - p2.x, t.z - p2.z) < 3.5);
    if (close && !nearTower) sound.clack();
    nearTower = close;
  };
  const prompt = $('#prompt');
  let promptText = '';
  const updatePrompt = () => {
    let text = '';
    if (mode === 'ride') {
      if (ride.phase === 'approach')
        text = `Heading to the ${ride.name} loading point… · S to skip to the top`;
      else if (ride.phase === 'waiting') {
        text = `Waiting for ${ride.name} · ${formatWait(ride.departsIn)} · hold W to fast-forward · E to step away`;
      } else {
        text = `${ride.name} · hold W to fast-forward · S to skip to the top · E to jump off`;
      }
    } else if (mode !== 'glide') {
      const p = whereAmI();
      const line = lifts.boardingNear(p.x, p.z);
      if (line !== null) {
        const l = lifts.lines[line]!;
        text = l.inLoadingZone(p)
          ? `${l.name} loading point · wait here to be picked up (or press E)`
          : `E — ride ${l.name} (${liftTypeName(l.lift.type)}, ${Math.round(l.lift.vertical)} m up)`;
      }
    }
    if (text !== promptText) {
      promptText = text;
      prompt.textContent = text;
      prompt.hidden = !text;
    }
  };

  /** Tracks, spray and sound from what the skis are doing this frame. */
  const updateSnowFx = (dt: number, airSpeed: number) => {
    const contact = mode === 'ski' ? ski.contact : null;
    if (contact && contact.onSnow && contact.speed > 0.5) {
      ski.skiPositions(fxLeft, fxRight);
      fxMid.copy(fxLeft).add(fxRight).multiplyScalar(0.5);
      surfaceNormal({ height: groundHeight }, fxMid.x, fxMid.z, fxNormal);
      const width = trailWidth(contact);
      const skid = skidAmount(contact);
      trails.extend('left', fxLeft, fxNormal, width, skid);
      trails.extend('right', fxRight, fxNormal, width, skid);
      // Snow flies the way you're travelling (forward in a hockey stop).
      fxSlide.set(ski.velocity.x, 0, ski.velocity.z).normalize();
      spray.emit(fxMid, fxSlide, ski.velocity, sprayRate(contact), dt);
    } else {
      trails.break();
    }
    spray.update(dt, groundHeight);
    trails.flush();
    sound.update(soundLevels(airSpeed, contact));
    if (mode === 'ski' && ski.landingImpact > 0) sound.thump(ski.landingImpact);
    if (mode === 'ski' && ski.footstep) sound.step();
    if (mode === 'ski' && ski.polePlant) sound.polePlant();
  };

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frameMs = now - last;
    const dt = Math.min(frameMs / 1000, 0.1);
    // Ignore hitches from tab switches or the map being open.
    if (frameMs < 250 && resolution.sample(frameMs)) renderer.setPixelRatio(resolution.ratio);
    last = now;
    // The fullscreen map covers everything; skip 3D work while it's open.
    if (worldMap.isOpen) return;

    lifts.update(dt, camera.position);
    const landed = controls().update(dt, input);
    if (mode === 'glide' && landed) setMode('ski');
    if (mode === 'ride' && landed) unload();
    if (mode === 'ski' && !ski.airborne) {
      const hit = lifts.scoop(ski.feet);
      if (hit) scooped(hit.line, hit.carrier);
    }
    updateLiftSound();
    if (mode === 'fly') {
      // Third-person flying shows your skier hovering where you are.
      if (view === 'chase') ski.showFlying(fly.position, fly.look.yaw);
      else ski.skier.visible = false;
    }
    input.endFrame();
    // Your position (fly eye or skier's feet), not the camera, which may be behind you.
    const pos = whereAmI();
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

    const here = pos;
    const { east, north } = worldToEnu(here.x, here.z);
    const { lat, lon } = frame.toLatLon(east, north);
    const ownSpeed =
      mode === 'ski'
        ? ski.speed
        : mode === 'glide'
          ? glider.speed
          : mode === 'ride'
            ? ride.velocity.length()
            : speed;
    updateSnowFx(dt, ownSpeed);
    hud.update({ altitude: here.y, lat, lon, speed: ownSpeed });
    // Which run is underfoot (only meaningful near the snow).
    const nearSnow = here.y - groundHeight(here.x, here.z) < 60;
    const piste = nearSnow ? pisteLookup.at(east, north) : null;
    hud.setPiste(
      mode === 'ride'
        ? { name: ride.name, colour: null }
        : !nearSnow
          ? null
          : piste
            ? { name: pisteTitle(piste), colour: DIFFICULTY[piste.difficulty].colour }
            : { name: 'Off-piste', colour: null },
    );
    minimap.draw(east, north, controls().heading);
    updatePrompt();
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
        mode === 'glide'
          ? `heading ${glider.heading.toFixed(1)}° · glide ${(glider.speed * 3.6).toFixed(0)} km/h · vario ${glider.velocity.y.toFixed(1)} m/s`
          : mode === 'ski'
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

type Mode = 'fly' | 'ski' | 'glide' | 'ride';
const MODE_KEY = 'ski-sim.mode';
const VIEW_KEY = 'ski-sim.view';

function loadMode(): Mode {
  // A reload mid-flight drops you into ski mode (you fall and land).
  const saved = localStorage.getItem(MODE_KEY);
  return saved === 'ski' || saved === 'glide' || saved === 'ride' ? 'ski' : 'fly';
}

const PREFS_KEY = 'ski-sim.labels';

interface Prefs {
  lift: boolean;
  peak: boolean;
  pistes: boolean;
  sound: boolean;
}

function loadPrefs(): Prefs {
  const defaults = { lift: true, peak: true, pistes: true, sound: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

function formatWait(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  return (await res.json()) as T;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error);
  status.classList.add('error');
  status.textContent = error instanceof Error ? error.message : String(error);
});
