import { uniform } from 'three/tsl';
import {
  ACESFilmicToneMapping,
  Euler,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { CAMERA, DEFAULT_RESORT, FLY, SIM_DAY, simDate, TERRAIN } from './config';
import { Sound } from './audio/sound';
import { engineSound, liftHumLevel, soundLevels } from './audio/levels';
import { FlyControls } from './controls/fly-controls';
import { surfaceNormal } from './controls/ski-physics';
import { skidAmount, sprayRate, trailWidth } from './fx/intensity';
import { SnowSpray } from './fx/snow-spray';
import { SLED_TRENCH, SnowTrails } from './fx/snow-trails';
import { GliderControls } from './controls/glider-controls';
import { SnowmobileControls } from './controls/snowmobile-controls';
import { SLED_LAYOUT } from './controls/snowmobile-model';
import { Input } from './controls/input';
import { cameraSettings, loadCamera, saveCamera } from './controls/camera-settings';
import { SettingsMenu } from './ui/settings-menu';
import { WaypointMarker } from './ui/waypoint-marker';
import { loadWaypoint, saveWaypoint } from './nav/waypoint';
import { EYE_HEIGHT, SkiControls } from './controls/ski-controls';
import { loadSetup, saveSetup, type SkiSetup } from './controls/ski-setup';
import { daylight, Environment } from './env/environment';
import { sunPosition } from './env/sun-position';
import { dayPresets, formatRate, formatTime, loadTime, saveTime } from './env/time-of-day';
import { ObstacleIndex } from './features/obstacles';
import { createBuildings } from './features/buildings';
import { createRestaurants, terraceSolids } from './features/restaurants';
import type { ResortFeatures } from './features/types';
import { Heightmap } from './geo/heightmap';
import { LocalFrame, worldToEnu } from './geo/local-frame';
import { DATA_URL, type HeightmapMeta, loadManifest, resortUrl } from './resort/manifest';
import { createNormalTexture } from './terrain/normals';
import { AdaptiveResolution } from './render/adaptive-resolution';
import { Terrain } from './terrain/terrain';
import { createTerrainMaterial } from './terrain/terrain-material';
import { buildPlaces, groundedPose, liftTypeName, type Place } from './nav/places';
import { Forest, FOREST_DRAW_DISTANCE } from './landcover/forest';
import { LandCover } from './landcover/land-cover';
import { LiftSystem } from './lifts/lift-system';
import { RideControls } from './lifts/ride';
import { createLiftSigns } from './lifts/signs';
import { createParkMeshes } from './parks/park-meshes';
import { SnowParks } from './parks/park-shapes';
import { createFloodlights, FLOODLIGHT_COLOUR } from './pistes/floodlights';
import { createPisteMarkers } from './pistes/markers';
import {
  loadPixels,
  overlayTexture,
  type PisteData,
  PisteLookup,
  pisteColour,
  runLabel,
} from './pistes/pistes';
import { loadPose, type Pose, savePose } from './nav/pose';
import { Hud } from './ui/hud';
import {
  type LabelKind,
  type LabelSpec,
  Labels,
  liftLabel,
  peakLabel,
  restaurantLabel,
} from './ui/labels';
import { LAST_RESORT_KEY, MainMenu, type ResortEntry, type StartChoice } from './ui/main-menu';
import { SkiSetupMenu } from './ui/ski-setup-menu';
import { TimeMenu } from './ui/time-menu';
import { Minimap } from './ui/minimap';
import { WorldMap } from './ui/world-map';
import { Pegman } from './controls/pegman';
import { SkyTransition } from './nav/sky-transition';
import { sampleAvatar } from './net/local-avatar';
import { Multiplayer } from './net/multiplayer';
import { parseRoomCode } from './net/room';

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
  // Ski areas come from the pipeline's index; pick the URL's, else the last one played,
  // else the default (if it's been built).
  const resorts = await fetchJson<{ resorts: ResortEntry[] }>(`${DATA_URL}resorts.json`)
    .then((r) => r.resorts)
    .catch((): ResortEntry[] => []);
  const known = (id: string | null) => !!id && resorts.some((r) => r.id === id);
  const lastResort = localStorage.getItem(LAST_RESORT_KEY);
  // Last played, else the configured default, else whatever has been built.
  const resortId =
    params.get('resort') ??
    [lastResort, DEFAULT_RESORT].find(known) ??
    resorts[0]?.id ??
    DEFAULT_RESORT;
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
  const litMeta = manifest.pistes.lit;
  const [
    near,
    far,
    features,
    pisteData,
    pisteOverlay,
    pisteLookupPixels,
    litPixels,
    nearCoverPixels,
    farCoverPixels,
  ] = await Promise.all([
    loadHeightmap(resortId, manifest.terrain.near),
    loadHeightmap(resortId, manifest.terrain.far),
    loadFeatures(resortId, manifest.features.file),
    fetchJson<PisteData>(resortUrl(resortId, manifest.pistes.file)),
    loadPixels(resortUrl(resortId, manifest.pistes.overlay.file)),
    loadPixels(resortUrl(resortId, manifest.pistes.lookup.file)),
    litMeta ? loadPixels(resortUrl(resortId, litMeta.file)) : null,
    loadPixels(resortUrl(resortId, manifest.landCover.near.file)),
    loadPixels(resortUrl(resortId, manifest.landCover.far.file)),
  ]);
  const { near: nearCoverMeta, far: farCoverMeta, trees: treeMeta } = manifest.landCover;
  const nearCover = new LandCover(nearCoverPixels, nearCoverMeta.cellSize, nearCoverMeta.extent);
  const farCover = new LandCover(farCoverPixels, farCoverMeta.cellSize, farCoverMeta.extent);
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
  // The snow you ski, fly and land on: the ground plus snow park features.
  const parks = new SnowParks(pisteData.parks ?? []);
  const snowHeight = (x: number, z: number) => parks.height(x, z, groundHeight(x, z));

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
  loadCamera(localStorage);
  const camera = new PerspectiveCamera(
    cameraSettings.fovFirst,
    window.innerWidth / window.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  // The clock runs at its chosen rate; the time menu (T) sets it and the sun follows.
  const clock = loadTime(localStorage, SIM_DAY.startTime);
  const { lat: originLat, lon: originLon } = manifest.origin;
  const environment = new Environment(scene, simDate(clock.seconds), originLat, originLon);
  const timeMenu = new TimeMenu(
    $('#time-modal'),
    clock,
    dayPresets((t) => sunPosition(simDate(t), originLat, originLon).elevation),
    () => environment.sun.elevation,
    () => {
      environment.setTime(simDate(clock.seconds));
      saveTime(localStorage, clock);
      showClock();
      multiplayer.clockChanged();
    },
  );
  $('#open-time').addEventListener('click', () => timeMenu.open());
  const settingsMenu = new SettingsMenu($('#settings-modal'), () => saveCamera(localStorage));
  $('#open-settings').addEventListener('click', () => settingsMenu.open());
  // The time above the minimap (with the clock speed unless it's real time).
  const clockTime = $('#clock [data-time]');
  const clockRate = $('#clock [data-rate]');
  const showClock = () => {
    const time = formatTime(clock.seconds);
    const rate = clock.rate === 1 ? '' : formatRate(clock.rate);
    if (clockTime.textContent !== time) clockTime.textContent = time;
    if (clockRate.textContent !== rate) clockRate.textContent = rate;
  };
  showClock();
  // A guest's clock is the host's; keep their own for when they play alone again.
  window.addEventListener('pagehide', () => !multiplayer.isGuest && saveTime(localStorage, clock));

  status.textContent = 'Building terrain…';
  await nextFrame();
  const nearTerrain = new Terrain(
    near,
    createTerrainMaterial(near, createNormalTexture(near), undefined, {
      snowDetail: true,
      pistes: {
        overlay: overlayTexture(pisteOverlay),
        tint: pisteTint,
        floodlit:
          litMeta && litPixels
            ? {
                mask: overlayTexture(litPixels),
                extent: litMeta.extent,
                cellSize: litMeta.cellSize,
                colour: FLOODLIGHT_COLOUR,
                on: environment.floodlights,
              }
            : undefined,
      },
      landCover: {
        texture: nearCover.texture(),
        extent: nearCover.extent,
        cellSize: nearCover.cellSize,
        width: nearCover.width,
        height: nearCover.height,
        canopyFade: [FOREST_DRAW_DISTANCE * 0.55, FOREST_DRAW_DISTANCE],
      },
    }),
    TERRAIN.near,
  );
  const farTerrain = new Terrain(
    far,
    createTerrainMaterial(far, createNormalTexture(far), near.extent, {
      landCover: {
        texture: farCover.texture(),
        extent: farCover.extent,
        cellSize: farCover.cellSize,
        width: farCover.width,
        height: farCover.height,
      },
    }),
    { ...TERRAIN.far, skip: near.extent },
  );
  const restaurants = features.restaurants ?? [];
  scene.add(
    nearTerrain.object,
    farTerrain.object,
    createBuildings(features.buildings),
    createRestaurants(restaurants, features.buildings, (east, north) => groundHeight(east, -north)),
    createPisteMarkers(pisteData),
    createParkMeshes(parks.features, (east, north) => groundHeight(east, -north)),
    createFloodlights(pisteData.lights ?? [], environment.floodlights),
  );
  // Trees from the land cover's tree cover (none without a tree line: no forest mapped).
  const forest =
    treeMeta.treeLine === null
      ? null
      : new Forest(
          { cover: (e, n) => nearCover.tree(e, n), ground: (e, n) => near.sample(e, n) },
          { treeLine: treeMeta.treeLine, height: treeMeta.height },
          near.extent,
        );
  if (forest) scene.add(forest.root);

  const farExtent = far.extent;
  const bounds = {
    minX: farExtent.west + 500,
    maxX: farExtent.east - 500,
    minZ: -farExtent.north + 500,
    maxZ: -farExtent.south - 500,
  };
  const input = new Input(canvas);
  const fly = new FlyControls(camera, snowHeight, bounds);
  const ski = new SkiControls(
    camera,
    {
      height: snowHeight,
      normal: (x, z, out) => parks.normal(x, z, groundHeight, out),
      // World z is -north.
      groomed: (x, z) => pisteLookup.at(x, -z)?.groomed ?? false,
      collide: (p, v) => {
        const building = obstacles.resolve(p, v);
        return (forest?.resolve(p, v) ?? false) || building;
      },
    },
    bounds,
  );
  ski.setSetup(skiSetup.current);
  changeSkis = (setup) => ski.setSetup(setup);
  scene.add(ski.skier);
  const glider = new GliderControls(camera, snowHeight, bounds);
  scene.add(glider.root);
  const sled = new SnowmobileControls(
    camera,
    {
      height: groundHeight,
      groomed: (x, z) => pisteLookup.at(x, -z)?.groomed ?? false,
      // Buildings and terminals like the skier, and lift towers too.
      collideSled: (p, v, radius) => {
        const hitBuilding = obstacles.resolve(p, v, radius, 1.2);
        return towers.resolve(p, v, radius, 1.2) || hitBuilding;
      },
    },
    bounds,
  );
  scene.add(sled.root, sled.headlight, sled.headlight.target);
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
    ...terraceSolids(restaurants, (east, north) => groundHeight(east, -north)),
  ]);
  const towers = new ObstacleIndex(lifts.towerObstacles());
  scene.add(lifts.root, createLiftSigns(lifts.lines, lifts.signMounts));
  const ride = new RideControls(camera, lifts, ski);
  let mode: Mode = loadMode();
  const controls = () =>
    mode === 'ski'
      ? ski
      : mode === 'glide'
        ? glider
        : mode === 'ride'
          ? ride
          : mode === 'sled'
            ? sled
            : fly;
  /** Where you are: fly eye, or skier's / pilot's / rider's feet, or the sled's track. */
  const whereAmI = () =>
    mode === 'ski'
      ? ski.feet
      : mode === 'glide'
        ? glider.position
        : mode === 'ride'
          ? ride.position
          : mode === 'sled'
            ? sled.position
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
  forest?.update(camera);

  const hud = new Hud($('#hud'), $('#run'), $('#toggles'), $('#fly-speed'));
  const minimap = await Minimap.load(
    $<HTMLCanvasElement>('#minimap canvas'),
    resortUrl(resortId, manifest.minimap.file),
    manifest.minimap.extent,
  );
  minimap.restaurants = restaurants;
  const buildingsById = new Map(features.buildings.map((b) => [b.id, b]));
  const labels = new Labels(
    $('#labels'),
    [
      ...features.lifts.map(liftLabel).filter((l): l is LabelSpec => l !== null),
      ...features.peaks.map((p) => peakLabel(p, near.extent)),
      ...restaurants.map((r) =>
        restaurantLabel(r, r.building !== null ? buildingsById.get(r.building) : undefined),
      ),
    ],
    groundHeight,
    { lift: prefs.lift, peak: prefs.peak, restaurant: prefs.restaurant },
  );
  const sound = new Sound(!prefs.sound);
  const sky = new SkyTransition($('#sky-flash'), (up) => sound.whoosh(up));
  const pegman = new Pegman();
  scene.add(pegman.root);
  const savePrefs = () =>
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        lift: labels.isVisible('lift'),
        peak: labels.isVisible('peak'),
        restaurant: labels.isVisible('restaurant'),
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
    savePrefs();
  };
  hud.setToggle('lift', labels.isVisible('lift'));
  hud.setToggle('peak', labels.isVisible('peak'));
  hud.setToggle('restaurant', labels.isVisible('restaurant'));
  hud.setToggle('pistes', pisteTint.value > 0);
  const debug = $('#debug');
  const multiplayer = new Multiplayer(
    {
      scene,
      resort: resortId,
      tags: $('#labels'),
      groundHeight,
      sample: (out) => sampleAvatar(mode, { fly, ski, glider, ride, sled }, out),
      lifts,
      clock,
      timeChanged: () => {
        environment.setTime(simDate(clock.seconds));
        timeMenu.sync(true);
        showClock();
      },
      goTo: (at) => {
        // On the snow a few metres from them, looking their way.
        if (mode === 'ride') setMode('ski');
        const pose = groundedPose(
          { east: at.x - 4, north: -at.z, altitude: at.y, heading: 90, pitch: 0 },
          (east, north) => groundHeight(east, -north),
          Math.max(EYE_HEIGHT, FLY.minHeightAboveGround) + 0.1,
          { east: at.x, north: -at.z, altitude: at.y + 1 },
        );
        controls().place(pose);
        speedReset = true;
        persistPose();
      },
      roomChanged: () => {
        timeMenu.setLocked(
          multiplayer.isGuest ? 'In a multiplayer game the host sets the time of day.' : null,
        );
        ride.fastForward = !multiplayer.active; // the lift clock is shared
      },
    },
    $('#multiplayer-modal'),
    params.get('net') === 'loopback' ? 'loopback' : 'webrtc',
    parseRoomCode(params.get('join') ?? ''),
  );
  $('#open-multiplayer').addEventListener('click', () => multiplayer.menu.open());

  // Teleports reset the speed readout so the jump doesn't register as motion.
  let speedReset = true;
  // Map teleports (and J, to the guide marker) land you on the ground there.
  const teleport = (target: Pose, lookAt?: Place['lookAt']) => {
    if (mode === 'ride') setMode('ski');
    // The cuts' heights are above the highest ground nearby, so the low ones can't end
    // up inside a hillside.
    const skyGround = (x: number, z: number) => {
      let top = groundHeight(x, z);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        top = Math.max(top, groundHeight(x + Math.cos(a) * 150, z + Math.sin(a) * 150));
      }
      return top;
    };
    // GTA-style: up into the sky from where the camera is now...
    const from = {
      x: camera.position.x,
      z: camera.position.z,
      ground: skyGround(camera.position.x, camera.position.z),
      yaw: new Euler().setFromQuaternion(camera.quaternion, 'YXZ').y,
    };
    // ...and down to you, already standing on the ground there (so the terrain loads
    // round the destination while the camera is in the air).
    const pose = groundedPose(
      target,
      (east, north) => groundHeight(east, -north),
      Math.max(EYE_HEIGHT, FLY.minHeightAboveGround) + 0.1,
      lookAt,
    );
    controls().place(pose);
    sky.start(from, {
      x: pose.east,
      z: -pose.north,
      ground: skyGround(pose.east, -pose.north),
      yaw: controls().look.yaw,
    });
    speedReset = true;
    persistPose();
    closeMap(true);
  };
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
        restaurants,
        features.buildings,
      ),
      pistes: pisteData.pistes,
      restaurants,
      groundHeight: (east, north) => groundHeight(east, -north),
      toLatLon: (east, north) => frame.toLatLon(east, north),
    },
    teleport,
    () => closeMap(false),
    (marker) => setWaypoint(marker),
  );
  // The guide marker placed on the map (left click): a beam and an on-screen pin.
  const waypoint = new WaypointMarker(scene, $('#labels'), groundHeight, $('#marker-hint'));
  const setWaypoint = (w: { east: number; north: number } | null) => {
    waypoint.set(w);
    worldMap.marker = w;
    minimap.waypoint = w;
    saveWaypoint(localStorage, resortId, w);
  };
  setWaypoint(loadWaypoint(localStorage, resortId));
  let view: 'first-person' | 'chase' =
    localStorage.getItem(VIEW_KEY) === 'chase' ? 'chase' : 'first-person';
  const setView = (next: typeof view) => {
    view = next;
    fly.view = view;
    ski.setView(view);
    glider.setView(view);
    sled.setView(view);
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
            : mode === 'sled'
              ? sled.velocity
              : fly.currentVelocity
    ).clone();
    if (mode === 'ride') ride.leave();
    if (mode === 'sled') {
      // Step off beside the sled (it stays parked there), keeping most of its momentum.
      const off = sled.dismount();
      eye.east = off.feet.x;
      eye.north = -off.feet.z;
      eye.altitude = off.feet.y + EYE_HEIGHT;
      velocity.copy(off.velocity);
    }
    const look = controls().look;
    const previous = mode;
    mode = next;
    if (mode === 'ski') {
      if (previous === 'fly') {
        // From flying: straight down onto the snow, standing still.
        eye.altitude = groundHeight(eye.east, -eye.north) + EYE_HEIGHT;
        velocity.set(0, 0, 0);
      }
      ski.place(eye, velocity);
    } else if (mode === 'glide') {
      const feet = eye.altitude - EYE_HEIGHT;
      glider.launch(new Vector3(eye.east, feet, -eye.north), velocity, look.yaw, look.pitch);
    } else if (mode === 'fly') {
      fly.place(eye);
    } else if (mode === 'sled') {
      // Back on the parked sled if it's right here; otherwise one comes to you.
      const feet = new Vector3(eye.east, eye.altitude - EYE_HEIGHT, -eye.north);
      if (sled.canRemount(feet)) sled.remount(look.pitch);
      else sled.mount(feet, velocity, look.yaw, look.pitch);
    }
    ski.setActive(mode === 'ski' || mode === 'ride');
    glider.setActive(mode === 'glide');
    sled.setActive(mode === 'sled');
    trails.break(); // don't join this mode's tracks to the last one's
    hud.setMode(mode);
    document.body.classList.toggle('skiing', mode !== 'fly');
    speedReset = true;
    localStorage.setItem(MODE_KEY, mode);
  };
  hud.setMode(mode);
  document.body.classList.toggle('skiing', mode !== 'fly');
  let nearTower = false;
  /** E: straight onto the loading point, to wait for the next carrier. */
  const boardLift = (line: number, down: boolean) => {
    setMode('ride');
    ride.approach(line, down);
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
    lifts.steppedOff = ride.line;
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
    if (
      e.code === 'KeyN' &&
      !e.repeat &&
      !worldMap.isOpen &&
      !skiSetup.isOpen &&
      !timeMenu.isOpen &&
      !settingsMenu.isOpen
    ) {
      if (document.pointerLockElement) document.exitPointerLock();
      multiplayer.menu.toggle();
      return;
    }
    if (document.querySelector('#multiplayer-modal[open]')) return;
    if (
      e.code === 'KeyG' &&
      !e.repeat &&
      !worldMap.isOpen &&
      !timeMenu.isOpen &&
      !settingsMenu.isOpen
    ) {
      if (document.pointerLockElement) document.exitPointerLock();
      skiSetup.toggle();
      return;
    }
    if (
      e.code === 'KeyT' &&
      !e.repeat &&
      !worldMap.isOpen &&
      !skiSetup.isOpen &&
      !settingsMenu.isOpen
    ) {
      if (document.pointerLockElement) document.exitPointerLock();
      timeMenu.toggle();
      return;
    }
    if (
      e.code === 'KeyO' &&
      !e.repeat &&
      !worldMap.isOpen &&
      !skiSetup.isOpen &&
      !timeMenu.isOpen
    ) {
      if (document.pointerLockElement) document.exitPointerLock();
      settingsMenu.toggle();
      return;
    }
    if (document.querySelector('dialog[open]')) return; // a menu dialog has the keyboard
    if (e.code === 'KeyM' && e.shiftKey && !e.repeat && !worldMap.isOpen) {
      // Shift+M: mark where you are now (e.g. to come back to it with J).
      const { east, north } = currentPose();
      setWaypoint({ east, north });
    } else if (e.code === 'KeyM' && !e.repeat) {
      if (worldMap.isOpen) closeMap(true);
      else openMap();
    } else if (e.code === 'Escape' && worldMap.isOpen) {
      closeMap(false);
    } else if (e.code === 'KeyJ' && !e.repeat && !worldMap.isOpen && waypoint.current) {
      // Jump to the guide marker, facing the way you were going.
      const w = waypoint.current;
      teleport({ ...w, altitude: 0, heading: currentPose().heading, pitch: 0 });
    } else if (e.code === 'KeyE' && !e.repeat && !worldMap.isOpen) {
      if (mode === 'ride') {
        setMode('ski'); // step off (or jump!) where you are
      } else if (mode !== 'glide' && mode !== 'sled') {
        const p = whereAmI();
        const near = lifts.boardingNear(p.x, p.z);
        if (near) boardLift(near.line, near.down);
      }
    } else if (e.code === 'KeyF' && !e.repeat && !worldMap.isOpen) {
      setMode(mode === 'fly' ? 'ski' : 'fly');
    } else if (e.code === 'KeyP' && !e.repeat && !worldMap.isOpen) {
      // Deploy the paraglider (keeping your momentum), or drop it and ski.
      setMode(mode === 'glide' ? 'ski' : 'glide');
    } else if (e.code === 'KeyB' && !e.repeat && !worldMap.isOpen && mode !== 'ride') {
      // Get on a snowmobile (keeping your momentum), or step off it onto your skis.
      setMode(mode === 'sled' ? 'ski' : 'sled');
    } else if (e.code === 'KeyV' && !e.repeat) {
      setView(view === 'first-person' ? 'chase' : 'first-person');
    } else if (e.code === 'F3') {
      e.preventDefault();
      debug.hidden = !debug.hidden;
    } else if ((e.code === 'Digit1' || e.code === 'Numpad1') && !e.repeat) {
      toggleLabels('lift');
    } else if ((e.code === 'Digit2' || e.code === 'Numpad2') && !e.repeat) {
      toggleLabels('peak');
    } else if ((e.code === 'Digit3' || e.code === 'Numpad3') && !e.repeat) {
      togglePisteColours();
    } else if ((e.code === 'Digit4' || e.code === 'Numpad4') && !e.repeat) {
      toggleLabels('restaurant');
    } else if (e.code === 'KeyK' && !e.repeat) {
      toggleSound();
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
  if (import.meta.env.DEV)
    Object.assign(sim, {
      scene,
      renderer,
      camera,
      labels,
      minimap,
      waypoint,
      lifts,
      ski,
      sled,
      environment,
      clock,
      multiplayer,
      forest,
    });
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
      if (ride.phase === 'waiting') {
        const ff = ride.fastForward ? ' · hold W to fast-forward' : '';
        text = `Waiting for ${ride.name} · ${formatWait(ride.departsIn)}${ff} · E to step away`;
      } else {
        const ff = ride.fastForward ? ' · hold W to fast-forward' : '';
        const end = ride.down ? 'bottom' : 'top';
        text = `${ride.name}${ff} · S to skip to the ${end} · E to jump off`;
      }
    } else if (mode !== 'glide' && mode !== 'sled') {
      const p = whereAmI();
      const near = lifts.boardingNear(p.x, p.z);
      if (near) {
        const l = lifts.lines[near.line]!;
        const vertical = `${Math.round(l.lift.vertical)} m ${near.down ? 'down' : 'up'}`;
        text =
          !near.down && l.inLoadingZone(p) && lifts.steppedOff !== near.line
            ? `${l.name} loading point · wait here to be picked up (or press E)`
            : `E — ride ${l.name}${near.down ? ' down' : ''} (${liftTypeName(l.lift.type)}, ${vertical})`;
      } else if (mode === 'ski' && sled.canRemount(p)) {
        text = 'B — get back on the snowmobile';
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
    const contact = mode === 'ski' ? ski.contact : mode === 'sled' ? sled.contact : null;
    const tracking = contact && contact.onSnow && contact.speed > 0.5;
    if (mode === 'sled' && contact?.onSnow) {
      // One wide track print, and roost thrown back when the track spins (more in powder,
      // and most of all when it's dug in and going nowhere).
      sled.snowMarks(fxMid, fxLeft, fxRight);
      if (tracking) {
        const skid = skidAmount(contact);
        surfaceNormal({ height: groundHeight }, fxLeft.x, fxLeft.z, fxNormal);
        trails.extend('sledLeftSki', fxLeft, fxNormal, SLED_SKI_GROOVE, skid);
        surfaceNormal({ height: groundHeight }, fxRight.x, fxRight.z, fxNormal);
        trails.extend('sledRightSki', fxRight, fxNormal, SLED_SKI_GROOVE, skid);
        surfaceNormal({ height: groundHeight }, fxMid.x, fxMid.z, fxNormal);
        trails.extend('sled', fxMid, fxNormal, SLED_LAYOUT.trackWidth, skid * 0.5, SLED_TRENCH);
      } else {
        surfaceNormal({ height: groundHeight }, fxMid.x, fxMid.z, fxNormal);
        trails.break();
      }
      sled.forward(fxSlide).negate();
      const powder = contact.groomed ? 0 : 160 * Math.min(1, contact.speed / 10);
      spray.emit(fxMid, fxSlide, sled.velocity, 700 * sled.slip + powder + sprayRate(contact), dt);
    } else if (tracking) {
      ski.skiPositions(fxLeft, fxRight);
      fxMid.copy(fxLeft).add(fxRight).multiplyScalar(0.5);
      surfaceNormal({ height: snowHeight }, fxMid.x, fxMid.z, fxNormal);
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
    spray.update(dt, snowHeight);
    trails.flush();
    const levels = soundLevels(airSpeed, contact);
    if (mode === 'fly') levels.wind = 0; // flying around is silent
    sound.update(levels);
    sound.setEngine(engineSound(sled.rpm, sled.throttle, mode === 'sled'));
    if (mode === 'sled' && sled.impact > 0) sound.thump(sled.impact);
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
    if (sky.active) {
      // Map teleport: the camera's in the sky and you wait, frozen, at the destination.
      sky.update(dt, camera);
    } else {
      const landed = controls().update(dt, input);
      if (mode === 'glide' && landed) setMode('ski');
      if (mode === 'ride' && landed) unload();
      if (mode === 'ski' && !ski.airborne) {
        const hit = lifts.scoop(ski.feet);
        if (hit) scooped(hit.line, hit.carrier);
      }
      sky.settleCamera(dt, camera);
    }
    if (mode !== 'sled') sled.idle(dt); // a parked sled settles where you left it
    updateLiftSound();
    if (mode === 'fly') {
      // Third-person flying shows the yellow Street View man where you are.
      ski.skier.visible = false;
      if (view === 'chase') {
        const top = fly.speed * FLY.sprintMultiplier;
        pegman.update(dt, fly.position, fly.look.yaw, fly.currentVelocity, top);
      } else {
        pegman.hide();
      }
    } else {
      pegman.hide();
    }
    hud.setFlySpeed(
      mode === 'fly' ? fly.speed * (fly.sprinting ? FLY.sprintMultiplier : 1) : null,
      Math.log(fly.speed / FLY.minSpeed) / Math.log(FLY.maxSpeed / FLY.minSpeed),
      fly.sprinting,
    );
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
    forest?.update(camera);
    if (clock.rate !== 0) {
      clock.advance(dt);
      environment.setTime(simDate(clock.seconds));
      timeMenu.sync();
      showClock();
    }
    environment.update(camera);
    sled.setDarkness(daylight(environment.sun.elevation).dark); // headlights at dusk
    // A touch wider field of view at speed when skiing or sledding (settings: O).
    const fov =
      (view === 'first-person' ? cameraSettings.fovFirst : cameraSettings.fovThird) +
      cameraSettings.speedFov *
        (mode === 'ski'
          ? Math.min(ski.speed / 30, 1)
          : mode === 'sled'
            ? Math.min(sled.speed / 35, 1)
            : 0);
    if (Math.abs(fov - camera.fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 3);
      camera.updateProjectionMatrix();
    }
    multiplayer.update(dt, camera);
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
            : mode === 'sled'
              ? sled.speed
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
            ? { name: runLabel(piste), colour: pisteColour(piste) }
            : { name: 'Off-piste', colour: null },
    );
    minimap.players = multiplayer.dots;
    minimap.draw(east, north, controls().heading);
    updatePrompt();
    labels.update(camera);
    waypoint.update(camera, here);

    if (!debug.hidden) {
      const info = renderer.info.render;
      const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL 2';
      debug.textContent = [
        `${fps.toFixed(0)} fps · ${backend} · render scale ${resolution.ratio.toFixed(2)}`,
        `draw calls ${info.drawCalls} · triangles ${(info.triangles / 1e6).toFixed(2)}M` +
          (forest ? ` · trees ${forest.counts.join(' / ')}` : ''),
        `E ${east.toFixed(1)}  N ${north.toFixed(1)}  ground ${groundHeight(pos.x, pos.z).toFixed(1)} m`,
        mode === 'glide'
          ? `heading ${glider.heading.toFixed(1)}° · glide ${(glider.speed * 3.6).toFixed(0)} km/h · vario ${glider.velocity.y.toFixed(1)} m/s`
          : mode === 'sled'
            ? `heading ${sled.sledHeading.toFixed(1)}° · sled ${(sled.speed * 3.6).toFixed(0)} km/h · ${Math.round(sled.rpm)} rpm${sled.airborne ? ' (air)' : ''}${sled.inPowder ? ' · powder' : ''}`
            : mode === 'ski'
              ? `heading ${ski.heading.toFixed(1)}° · ski ${(ski.speed * 3.6).toFixed(0)} km/h${ski.airborne ? ' (air)' : ''} · ${ski.view}`
              : `heading ${fly.heading.toFixed(1)}° · fly speed ${fly.speed.toFixed(0)} m/s${fly.sprinting ? ' (sprint)' : ''}`,
        `sun az ${environment.sun.azimuth.toFixed(1)}° el ${environment.sun.elevation.toFixed(1)}°`,
      ].join('\n');
    }

    if (now - lastPersist > 1000) {
      persistPose();
      if (!multiplayer.isGuest) saveTime(localStorage, clock);
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

type Mode = 'fly' | 'ski' | 'glide' | 'ride' | 'sled';
const MODE_KEY = 'ski-sim.mode';
/** Width of the groove each snowmobile ski's keel cuts (m). */
const SLED_SKI_GROOVE = 0.1;
const VIEW_KEY = 'ski-sim.view';

function loadMode(): Mode {
  // A reload mid-flight drops you into ski mode (you fall and land); sledders keep the sled.
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === 'sled') return 'sled';
  return saved === 'ski' || saved === 'glide' || saved === 'ride' ? 'ski' : 'fly';
}

const PREFS_KEY = 'ski-sim.labels';

interface Prefs {
  lift: boolean;
  peak: boolean;
  restaurant: boolean;
  pistes: boolean;
  sound: boolean;
}

function loadPrefs(): Prefs {
  const defaults = { lift: true, peak: true, restaurant: true, pistes: true, sound: true };
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
