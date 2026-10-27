import { uniform } from 'three/tsl';
import {
  ACESFilmicToneMapping,
  Euler,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { BLUEBIRD_DATE, CAMERA, DEFAULT_RESORT, FLY, SIM_DAY, simDate, TERRAIN } from './config';
import { Sound } from './audio/sound';
import {
  AIRCRAFT_OFF,
  aircraftFalloff,
  aircraftSound,
  DRONE_OFF,
  droneFalloff,
  droneSound,
  engineSound,
  liftHumLevel,
  railSound,
  soundLevels,
} from './audio/levels';
import { FlyControls } from './controls/fly-controls';
import { surfaceNormal } from './controls/ski-physics';
import { skidAmount, sprayRate, trailWidth } from './fx/intensity';
import { SnowSpray } from './fx/snow-spray';
import { SLED_TRENCH, SnowTrails } from './fx/snow-trails';
import { GliderControls } from './controls/glider-controls';
import { AircraftControls, type AircraftTerrain, BOARD_RANGE } from './controls/aircraft-controls';
import { H125, PC6 } from './controls/aircraft-types';
import { SkydiveControls } from './controls/skydive-controls';
import type { Surface } from './controls/plane-physics';
import { parkingSpots, pavedAt } from './features/aircraft-parking';
import { CableIndex } from './features/cables';
import { ParkedFleet } from './features/parked-aircraft';
import { SnowmobileControls } from './controls/snowmobile-controls';
import { SLED_LAYOUT } from './controls/snowmobile-model';
import { Input } from './controls/input';
import { TouchControls } from './controls/touch-controls';
import { detectTouch } from './controls/touch-input';
import { cameraSettings, loadCamera, saveCamera } from './controls/camera-settings';
import { SettingsMenu } from './ui/settings-menu';
import { WaypointMarker } from './ui/waypoint-marker';
import { loadWaypoint, saveWaypoint } from './nav/waypoint';
import { EYE_HEIGHT, SkiControls } from './controls/ski-controls';
import { loadSetup, saveSetup, type SkiSetup } from './controls/ski-setup';
import { daylight, Environment } from './env/environment';
import { sunPosition } from './env/sun-position';
import { dayPresets, formatRate, formatTime, loadTime, saveTime } from './env/time-of-day';
import { CLEAR, describe as describeWeather, gustyWind } from './env/weather';
import { WeatherState } from './env/weather-control';
import { CloudDeck } from './env/cloud-layer';
import { sunlitAt, WeatherFx, windVelocity } from './env/weather-fx';
import { planWeatherSites } from './env/weather-field';
import { weatherProvenance } from './env/weather-source';
import { ObstacleIndex } from './features/obstacles';
import { createBuildings } from './features/buildings';
import { airfieldSolids, createAirfields } from './features/airfields';
import { WreckSmoke } from './fx/wreck-smoke';
import { createRestaurants, terraceSolids } from './features/restaurants';
import type { ResortFeatures } from './features/types';
import { Heightmap } from './geo/heightmap';
import { LocalFrame, worldToEnu } from './geo/local-frame';
import { Downloads, formatBytes } from './resort/downloads';
import {
  DATA_URL,
  type HeightmapMeta,
  loadManifest,
  type ResortManifest,
  resortUrl,
} from './resort/manifest';
import { createNormalTexture } from './terrain/normals';
import { AdaptiveResolution } from './render/adaptive-resolution';
import { qualityFor } from './render/quality';
import { Terrain } from './terrain/terrain';
import { createTerrainMaterial } from './terrain/terrain-material';
import { buildPlaces, groundedPose, liftTypeName, type Place } from './nav/places';
import { Forest, FOREST_DRAW_DISTANCE } from './landcover/forest';
import { LandCover } from './landcover/land-cover';
import { LiftSystem } from './lifts/lift-system';
import { RideControls } from './lifts/ride';
import { createLiftSigns } from './lifts/signs';
import { createParkMeshes } from './parks/park-meshes';
import { type RailContact, SnowParks } from './parks/park-shapes';
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
import { showCredits } from './ui/credits';
import { BodyMarker } from './ui/body-marker';
import { DisplayMenu, type WorldToggle } from './ui/display-menu';
import { RulesMenu } from './ui/rules-menu';
import { applyDisplay, loadDisplay, saveDisplay } from './ui/display-settings';
import { Hud } from './ui/hud';
import {
  type GameRules,
  gameRules,
  loadRules,
  type Rule,
  ruleOffMessage,
  saveRules,
} from './game/rules';
import {
  type LabelKind,
  type LabelSpec,
  Labels,
  liftLabel,
  peakLabel,
  restaurantLabel,
  aerodromeLabel,
} from './ui/labels';
import { LAST_RESORT_KEY, MainMenu, type ResortEntry, type StartChoice } from './ui/main-menu';
import { SkiSetupMenu } from './ui/ski-setup-menu';
import { TimeMenu } from './ui/time-menu';
import { WeatherMenu } from './ui/weather-menu';
import { Minimap } from './ui/minimap';
import { WorldMap } from './ui/world-map';
import { SkyTransition } from './nav/sky-transition';
import { addSpirit, sampleAvatar } from './net/local-avatar';
import { Multiplayer } from './net/multiplayer';
import { cleanName, loadName, NAME_KEY, parseRoomCode } from './net/room';
import { MultiplayerMenu } from './ui/multiplayer-menu';
import { polyfillFlags } from './ui/flags';
import { PartyHud } from './ui/party-hud';
import { saveCanvas, screenshotName } from './ui/screenshot';

declare global {
  interface Window {
    /** Exposed for Playwright screenshot tests. */
    __sim?: { ready: boolean; frames: number };
  }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
/** Shows a failed load in the menu (set once the menu exists). */
let failLoad = (message: string) => {
  const status = $('#status');
  status.classList.add('error');
  status.textContent = message;
};

type Fetch = (url: string) => Promise<Response>;

async function loadHeightmap(
  resortId: string,
  meta: HeightmapMeta,
  get: Fetch = fetch,
): Promise<Heightmap> {
  const res = await get(resortUrl(resortId, meta.file));
  if (!res.ok) throw new Error(`Failed to load ${meta.file} (HTTP ${res.status})`);
  return Heightmap.decode(await res.arrayBuffer(), meta);
}

async function loadFeatures(
  resortId: string,
  file: string,
  get: Fetch = fetch,
): Promise<ResortFeatures> {
  const res = await get(resortUrl(resortId, file));
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
  polyfillFlags(); // flag emoji in the menu on Windows
  migrateStorage();
  const params = new URLSearchParams(location.search);
  // Phones and tablets play by touch (on-screen stick and buttons); a mouse or keyboard
  // switches to those as soon as it's used. The menus follow too (`body.touch`).
  const input = new Input($('#scene'));
  let act: (code: string, shift?: boolean) => void = () => {};
  let toggleAllLabels = () => {};
  const touch = new TouchControls(
    $('#touch'),
    input,
    { key: (code) => act(code), labels: () => toggleAllLabels() },
    detectTouch({
      coarse: matchMedia('(pointer: coarse)').matches,
      anyFine: matchMedia('(any-pointer: fine)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
      override: params.get('touch'),
    }),
  );
  // Set once, from the device it started on: phones get lighter rendering.
  const quality = qualityFor(touch.kind === 'touch', window.devicePixelRatio);
  // Ski areas come from the pipeline's index.
  const resorts = await fetchJson<{ resorts: ResortEntry[] }>(`${DATA_URL}resorts.json`)
    .then((r) => r.resorts)
    .catch((): ResortEntry[] => []);
  const known = (id: string | null) => !!id && resorts.some((r) => r.id === id);
  // Nothing heavy loads until you pick a ski area and press Load, unless the link names
  // one (switching areas, an invite, a pose, the tests).
  const auto = params.has('resort') || params.has('join') || params.has('at') || !resorts.length;
  // Highlighted to begin with: the URL's, else the last one played, else the default
  // (if it's been built), else whatever has been built.
  const suggested =
    params.get('resort') ??
    [localStorage.getItem(LAST_RESORT_KEY), DEFAULT_RESORT].find(known) ??
    resorts[0]?.id ??
    DEFAULT_RESORT;

  // Start points come from each area's (small) manifest, fetched when it's highlighted.
  const manifests = new Map<string, Promise<ResortManifest>>();
  const manifestOf = (id: string) => {
    let m = manifests.get(id);
    if (!m) {
      m = loadManifest(id);
      m.catch(() => manifests.delete(id)); // try again next time it's picked
      manifests.set(id, m);
    }
    return m;
  };
  let play: (choice: StartChoice, auto?: boolean) => void = () => {};
  let load: (id: string) => void = () => {};
  const chosen = new Promise<string>((resolve) => (load = resolve));
  let loaded = false;
  // Chose "Host a game" before choosing where: open one once the map's ready.
  let hostAfterLoad = params.get('host') === '1';
  /** Set once multiplayer exists: what changing resort does to your party. */
  let party: {
    note: () => string | null;
    leaving: (resort: string, start: string | null) => void;
  } = { note: () => null, leaving: () => {} };
  const menu: MainMenu = new MainMenu($('#overlay'), {
    onSelect: (id) => {
      manifestOf(id).then(
        (m) =>
          menu.setStarts(
            id,
            m.bases ?? [],
            (id === suggested && params.has('at')) || loadPose(localStorage, id) !== null,
            m.minimap.extent,
            id === suggested ? params.get('start') : null,
          ),
        (e: unknown) => menu.setStartsMessage(id, e instanceof Error ? e.message : String(e)),
      );
    },
    onLoad: (id, _choice, { host }) => {
      if (!loaded) {
        hostAfterLoad ||= host;
        return load(id);
      }
      // Another area: a fresh page that loads it straight away, at the chosen start (a
      // host's party comes too; a guest leaves theirs). A moment for the word to go out.
      party.leaving(id, _choice?.name ?? null);
      setTimeout(() => (location.href = resortLink(id, _choice?.name ?? null, host)), 300);
    },
    onPlay: (choice, auto) => play(choice, auto),
    leaveNote: () => party.note(),
  });
  failLoad = (message) => menu.failed(message);
  menu.setResorts(resorts, suggested);
  // Returning players: Continue (where they left off) leads the title screen.
  const lastPlayed = localStorage.getItem(LAST_RESORT_KEY);
  if (known(lastPlayed)) {
    const pose = loadPose(localStorage, lastPlayed!);
    menu.setContinue(
      lastPlayed,
      pose
        ? `Where you left off · ${Math.round(pose.altitude).toLocaleString('en-GB')} m`
        : 'From the resort start',
    );
  }
  /** A page that loads `id` straight away (at `start`), keeping test/network switches. */
  const resortLink = (id: string, start: string | null, host: boolean) => {
    const url = new URL(location.href);
    url.search = `?resort=${encodeURIComponent(id)}`;
    if (start) url.searchParams.set('start', start);
    if (host) url.searchParams.set('host', '1');
    if (params.get('net')) url.searchParams.set('net', params.get('net')!);
    return url.toString();
  };
  // The Multiplayer screen exists from the start. Until a map's loaded, Host means "choose
  // where first" and Join loads the game's resort; then `Multiplayer` takes it over.
  const multiplayerMenu = new MultiplayerMenu(
    $('#mp-panel'),
    menu.multiplayer,
    loadName(localStorage),
    {
      host: () => menu.hostFromResort(),
      join: (code) => {
        const url = new URL(resortLink(menu.selectedResort ?? suggested, null, false));
        url.searchParams.set('join', code);
        location.href = url.toString();
      },
      leave: () => {},
      goTo: () => {},
      rename: (name) => localStorage.setItem(NAME_KEY, cleanName(name)),
    },
  );
  $('#open-multiplayer').addEventListener('click', () => multiplayerMenu.open());
  let changeSkis: (setup: SkiSetup) => void = () => {};
  const skiSetup = new SkiSetupMenu($('#opt-ski'), loadSetup(localStorage), (setup) => {
    saveSetup(localStorage, setup);
    changeSkis(setup);
  });
  $('#open-ski-setup').addEventListener('click', () => skiSetup.open());
  loadCamera(localStorage);
  const settingsMenu = new SettingsMenu($('#opt-camera'), () => saveCamera(localStorage));
  $('#open-settings').addEventListener('click', () => settingsMenu.open());
  loadDisplay(localStorage, touch.kind === 'touch' ? { glass: 'light' } : {});
  applyDisplay();
  window.addEventListener('resize', () => applyDisplay());
  // World switches (1–4, V, K) do nothing until a map is loaded (they're disabled till then).
  let onWorldToggle: (name: WorldToggle) => void = () => {};
  const displayMenu = new DisplayMenu(
    $('#opt-display'),
    (name) => onWorldToggle(name),
    () => saveDisplay(localStorage),
  );
  // Game rules (Options → Rules): your own until a world (and maybe a party) is loaded.
  let ownRules = loadRules(localStorage);
  Object.assign(gameRules, ownRules);
  let onRulesEdited = (rules: GameRules) => {
    ownRules = rules;
    saveRules(localStorage, rules);
    Object.assign(gameRules, rules);
  };
  const rulesMenu = new RulesMenu($('#opt-rules'), (rules) => onRulesEdited(rules));
  rulesMenu.show(ownRules, null);

  if (auto) load(suggested);
  const resortId = await chosen;
  loaded = true;
  localStorage.setItem(LAST_RESORT_KEY, resortId);
  const manifest = await manifestOf(resortId);
  // A link's start point (switching areas from the menu carries the choice over).
  const linkStart = params.get('start');
  if (linkStart) menu.setLoadChoice(manifest.bases?.find((b) => b.name === linkStart) ?? null);
  menu.loading(resortId);
  document.title = `${manifest.resort.name} · ski-sim`;
  // The data credits live in Options → Data & credits.
  const credits = (day: Parameters<typeof weatherProvenance>[0]) =>
    showCredits($('#opt-credits .modal-body'), [...manifest.provenance, weatherProvenance(day)]);
  credits(null);
  // Downloads are the first 80% of the bar; building the world is the rest.
  const downloads = new Downloads((fraction, bytes) =>
    menu.progress(`Downloading map data · ${formatBytes(bytes)}`, fraction * 0.8),
  );
  const get = downloads.fetch;
  const litMeta = manifest.pistes.lit;
  const [
    near,
    far,
    features,
    pisteData,
    pisteOverlay,
    pisteLookupPixels,
    ungroomedPixels,
    litPixels,
    nearCoverPixels,
    farCoverPixels,
  ] = await Promise.all([
    loadHeightmap(resortId, manifest.terrain.near, get),
    loadHeightmap(resortId, manifest.terrain.far, get),
    loadFeatures(resortId, manifest.features.file, get),
    fetchJson<PisteData>(resortUrl(resortId, manifest.pistes.file), get),
    loadPixels(resortUrl(resortId, manifest.pistes.overlay.file), get),
    loadPixels(resortUrl(resortId, manifest.pistes.lookup.file), get),
    manifest.pistes.ungroomed
      ? loadPixels(resortUrl(resortId, manifest.pistes.ungroomed.file), get)
      : null,
    litMeta ? loadPixels(resortUrl(resortId, litMeta.file), get) : null,
    loadPixels(resortUrl(resortId, manifest.landCover.near.file), get),
    loadPixels(resortUrl(resortId, manifest.landCover.far.file), get),
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
  const railContact: RailContact = { dirX: 0, dirZ: 0, offset: 0, grade: 0 };

  const canvas = $<HTMLCanvasElement>('#scene');
  // WebGPU where there is one, WebGL 2 otherwise (most phones): three picks the backend.
  const renderer = new WebGPURenderer({
    canvas,
    antialias: quality.antialias,
    reversedDepthBuffer: true,
    forceWebGL: params.get('webgl') === '1',
  });
  const resolution = new AdaptiveResolution(quality.maxPixelRatio, quality.minPixelRatio);
  renderer.setPixelRatio(resolution.ratio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;
  renderer.shadowMap.enabled = true;
  await renderer.init();

  const scene = new Scene();
  const camera = new PerspectiveCamera(
    cameraSettings.fovFirst,
    window.innerWidth / window.innerHeight,
    CAMERA.near,
    CAMERA.far,
  );
  // The clock runs at its chosen rate; the time menu (T) sets it and the sun follows.
  if (manifest.timezone) SIM_DAY.utcOffsetHours = manifest.timezone.utcOffsetHours;
  const clock = loadTime(localStorage, SIM_DAY.startTime);
  const { lat: originLat, lon: originLon } = manifest.origin;
  const environment = new Environment(scene, simDate(clock.seconds), originLat, originLon, {
    mapSize: quality.shadowMapSize,
    cascades: quality.shadowCascades,
    distance: quality.shadowDistance,
  });
  const forestDistance = FOREST_DRAW_DISTANCE * quality.forestDistance;
  const presets = () => dayPresets((t) => sunPosition(simDate(t), originLat, originLon).elevation);
  /** The clock was set (time menu, weather menu): move the sun, save, tell a party. */
  const clockSet = () => {
    environment.setTime(simDate(clock.seconds));
    saveTime(localStorage, clock);
    showClock();
    timeMenu.sync(true);
    multiplayer.clockChanged();
  };
  const timeMenu = new TimeMenu(
    $('#opt-time'),
    clock,
    presets(),
    () => environment.sun.elevation,
    clockSet,
  );
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

  // Weather (C): Clear, Live or a past day from Open-Meteo. Picking a day moves the sim's
  // date (the sun's path) too; nothing is fetched until the player turns it on.
  // Where the camera is, in local metres (the weather field is laid out in them).
  const here = () => worldToEnu(camera.position.x, camera.position.z);
  const weatherAt = (seconds: number) => {
    const { east, north } = here();
    weather.update(simDate(seconds).getTime(), east, north, camera.position.y);
  };
  const weather = new WeatherState({
    resort: resortId,
    country: manifest.resort.country,
    // A grid of points over the lifts, each at the ground height there.
    plan: planWeatherSites(features.lifts, near.extent, (e, n) =>
      near.contains(e, n) ? near.sample(e, n) : far.sample(e, n),
    ),
    latLon: (east, north) => frame.toLatLon(east, north),
    zone: manifest.timezone?.name ?? null,
    utcOffsetHours: manifest.timezone?.utcOffsetHours ?? 1,
    defaultDate: BLUEBIRD_DATE,
    setDate: (date, utcOffsetHours) => {
      if (date === SIM_DAY.date && utcOffsetHours === SIM_DAY.utcOffsetHours) return;
      SIM_DAY.date = date;
      SIM_DAY.utcOffsetHours = utcOffsetHours;
      environment.setTime(simDate(clock.seconds));
      timeMenu.setPresets(presets());
      timeMenu.sync(true);
    },
    setTime: (seconds, rate) => {
      clock.set(seconds);
      if (rate !== undefined) clock.rate = rate;
      clockSet();
    },
    changed: () => {
      weatherAt(clock.seconds);
      cloudsChanged = true;
      credits(weather.day);
      weatherMenu.sync(true);
      multiplayer.weatherChanged();
    },
  });
  const weatherMenu = new WeatherMenu(
    $('#opt-weather'),
    weather,
    clock,
    () => ({ ...here(), altitude: camera.position.y }),
    (seconds) => simDate(seconds).getTime(),
    (choice) => weather.choose(choice),
    clockSet,
  );
  const weatherFx = new WeatherFx(scene);
  // The cloud deck, seen from above and below; rebuilt when the field or the camera moves.
  const clouds = new CloudDeck(scene);
  let cloudsChanged = true;
  let cloudField: unknown = null;

  menu.progress('Building terrain…', 0.82);
  await nextFrame();
  const nearTerrain = new Terrain(
    near,
    createTerrainMaterial(near, createNormalTexture(near), undefined, {
      snowDetail: true,
      pistes: {
        overlay: overlayTexture(pisteOverlay),
        ungroomed: ungroomedPixels ? overlayTexture(ungroomedPixels) : undefined,
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
        canopyFade: [forestDistance * 0.55, forestDistance],
      },
    }),
    { ...TERRAIN.near, lodDistance: TERRAIN.near.lodDistance * quality.terrainLod },
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
    {
      ...TERRAIN.far,
      lodDistance: TERRAIN.far.lodDistance * quality.terrainLod,
      skip: near.extent,
    },
  );
  const restaurants = features.restaurants ?? [];
  const airfields = features.airfields
    ? createAirfields(features.airfields, (east, north) => groundHeight(east, -north))
    : null;
  if (airfields) scene.add(airfields.root);
  scene.add(
    nearTerrain.object,
    farTerrain.object,
    createBuildings(features.buildings),
    createRestaurants(restaurants, features.buildings, (east, north) => groundHeight(east, -north)),
    createPisteMarkers(pisteData),
    createParkMeshes(parks.features, (east, north) => groundHeight(east, -north)),
    createFloodlights(pisteData.lights ?? [], environment.floodlights),
  );
  menu.progress('Growing forests…', 0.88);
  await nextFrame();
  // Trees from the land cover's tree cover (none without a tree line: no forest mapped).
  const forest =
    treeMeta.treeLine === null
      ? null
      : new Forest(
          { cover: (e, n) => nearCover.tree(e, n), ground: (e, n) => near.sample(e, n) },
          { treeLine: treeMeta.treeLine, height: treeMeta.height },
          near.extent,
          quality.forestDistance,
        );
  if (forest) scene.add(forest.root);

  const farExtent = far.extent;
  const bounds = {
    minX: farExtent.west + 500,
    maxX: farExtent.east - 500,
    minZ: -farExtent.north + 500,
    maxZ: -farExtent.south - 500,
  };
  const fly = new FlyControls(camera, snowHeight, bounds);
  const ski = new SkiControls(
    camera,
    {
      height: snowHeight,
      normal: (x, z, out) => parks.normal(x, z, groundHeight, out),
      rail: (x, z) => parks.rail(x, z, groundHeight(x, z), railContact),
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
  // Planes and helicopters: cleared runways are tarmac (wheels), groomed runs and runways
  // snow (skis), everything else powder. They hit buildings, towers and lift cables.
  const paved = features.airfields ? pavedAt(features.airfields) : () => false;
  const probe = new Vector3();
  const still = new Vector3();
  const aircraftTerrain: AircraftTerrain = {
    height: groundHeight,
    surface: (x, z): Surface =>
      paved(x, -z) ? 'paved' : (pisteLookup.at(x, -z)?.groomed ?? false) ? 'groomed' : 'powder',
    hits: (p, radius) => {
      probe.set(p.x, p.y - radius, p.z);
      if (obstacles.resolve(probe, still.set(0, 0, 0), radius, 2 * radius)) return 'Hit a building';
      probe.set(p.x, p.y - radius, p.z);
      if (towers.resolve(probe, still.set(0, 0, 0), radius, 2 * radius)) return 'Hit a lift tower';
      if (cables.hit(p, radius)) return 'Hit a lift cable';
      return null;
    },
    clear: (x, z, radius) =>
      !obstacles.resolve(probe.set(x, groundHeight(x, z), z), still.set(0, 0, 0), radius, 4),
  };
  const plane = new AircraftControls(PC6, camera, aircraftTerrain, bounds);
  const wreckSmoke = new WreckSmoke(scene);
  const heli = new AircraftControls(H125, camera, aircraftTerrain, bounds);
  scene.add(plane.root, heli.root);
  // Bailing out of either: freefall, then the canopy.
  const skydiver = new SkydiveControls(camera, groundHeight, bounds);
  scene.add(skydiver.root);
  const aircraftFor = (kind: 'plane' | 'heli') => (kind === 'plane' ? plane : heli);
  // Aircraft waiting at the airfields (a Porter at each runway's top, H125s on helipads).
  const fleet = new ParkedFleet(
    features.airfields
      ? parkingSpots(features.airfields, (east, north) => groundHeight(east, -north))
      : [],
    groundHeight,
  );
  scene.add(fleet.root);
  const trails = new SnowTrails();
  const spray = new SnowSpray();
  scene.add(trails.mesh, spray.mesh);
  const fxLeft = new Vector3();
  const fxRight = new Vector3();
  const fxMid = new Vector3();
  const fxNormal = new Vector3();
  const fxSlide = new Vector3();
  menu.progress('Building lifts…', 0.92);
  await nextFrame();
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
    // Snowbanks, edge markers and windsock masts (hangars are buildings).
    ...(features.airfields
      ? airfieldSolids(features.airfields, (east, north) => groundHeight(east, -north))
      : []),
  ]);
  const towers = new ObstacleIndex(lifts.towerObstacles());
  const cables = new CableIndex(lifts.ropeSegments());
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
            : mode === 'plane'
              ? plane
              : mode === 'heli'
                ? heli
                : mode === 'skydive'
                  ? skydiver
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
            : mode === 'plane' || mode === 'heli'
              ? aircraftFor(mode).position
              : mode === 'skydive'
                ? skydiver.position
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

  const hud = new Hud($('#hud'));
  const partyHud = new PartyHud($('#hud'));
  let partyClock = 0;
  const minimap = await Minimap.load(
    $<HTMLCanvasElement>('#minimap canvas'),
    resortUrl(resortId, manifest.minimap.file),
    manifest.minimap.extent,
  );
  minimap.restaurants = restaurants;
  minimap.borders = features.borders ?? [];
  const buildingsById = new Map(features.buildings.map((b) => [b.id, b]));
  const labels = new Labels(
    $('#labels'),
    [
      ...features.lifts.map(liftLabel).filter((l): l is LabelSpec => l !== null),
      ...features.peaks.map((p) => peakLabel(p, near.extent)),
      ...restaurants.map((r) =>
        restaurantLabel(r, r.building !== null ? buildingsById.get(r.building) : undefined),
      ),
      ...(features.airfields?.aerodromes ?? []).map(aerodromeLabel),
    ],
    groundHeight,
    { lift: prefs.lift, peak: prefs.peak, restaurant: prefs.restaurant },
  );
  const sound = new Sound(!prefs.sound);
  const flash = $('#sky-flash');
  const sky = new SkyTransition(flash, (up) => sound.whoosh(up));
  let screenshotPending = false;
  let hudShown = prefs.hud;
  const savePrefs = () =>
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        lift: labels.isVisible('lift'),
        peak: labels.isVisible('peak'),
        restaurant: labels.isVisible('restaurant'),
        pistes: pisteColours,
        sound: !sound.isMuted,
        hud: hudShown,
      }),
    );
  /** A display toggle changed: the Display tab's switch, and a short message in game. */
  const showToggle = (name: WorldToggle, on: boolean, announce: boolean) => {
    displayMenu.set(name, on);
    hud.setToggle(name, on, announce && input.locked);
  };
  const toggleLabels = (kind: LabelKind) => {
    labels.setVisible(kind, !labels.isVisible(kind));
    showToggle(kind, labels.isVisible(kind), true);
    savePrefs();
  };
  // Piste colours are drawn while chosen (3) and the HUD is shown (H hides them too).
  let pisteColours = prefs.pistes;
  const applyPisteColours = () => (pisteTint.value = pisteColours && hudShown ? 1 : 0);
  // Touch's labels button: lift, peak and restaurant names on or off together.
  toggleAllLabels = () => {
    const kinds = ['lift', 'peak', 'restaurant'] as const;
    const on = !kinds.some((k) => labels.isVisible(k));
    for (const k of kinds) {
      labels.setVisible(k, on);
      showToggle(k, on, true);
    }
    savePrefs();
  };
  const togglePisteColours = () => {
    pisteColours = !pisteColours;
    applyPisteColours();
    showToggle('pistes', pisteColours, true);
    savePrefs();
  };
  /** H: full immersion. Every overlay goes: HUD, labels, markers, piste colours. */
  const toggleHud = () => {
    hudShown = !hudShown;
    showToggle('hud', hudShown, true);
    applyPisteColours();
    waypoint.setHidden(!hudShown);
    savePrefs();
  };
  const toggleSound = () => {
    sound.setMuted(!sound.isMuted);
    showToggle('sound', !sound.isMuted, true);
    savePrefs();
  };
  showToggle('lift', labels.isVisible('lift'), false);
  showToggle('peak', labels.isVisible('peak'), false);
  showToggle('restaurant', labels.isVisible('restaurant'), false);
  showToggle('pistes', pisteColours, false);
  showToggle('sound', !sound.isMuted, false);
  showToggle('hud', hudShown, false);
  applyPisteColours();
  const debug = $('#debug');
  /** The rules in force changed: set when the world exists (below). */
  let applyRules = () => {};
  const multiplayer = new Multiplayer(
    {
      scene,
      resort: resortId,
      tags: $('#labels'),
      groundHeight,
      carrierFrame: (line, carrier, out) => {
        const l = lifts.lines[line];
        if (!l || carrier >= l.op.carriers) return false;
        lifts.carrierMatrix(line, carrier, out);
        return true;
      },
      sample: (out) => {
        const avatar = body ?? (mode === 'skydive' ? skydiver.avatarMode : mode);
        sampleAvatar(avatar, { fly, ski, glider, ride, sled, plane, heli, skydiver }, out);
        if (body) addSpirit(out, fly);
      },
      lifts,
      clock,
      timeChanged: () => {
        environment.setTime(simDate(clock.seconds));
        timeMenu.sync(true);
        showClock();
      },
      weather: () => weather.shared(),
      followWeather: (w) => weather.follow(w),
      goTo: (at) => {
        if (!allowed('teleport')) return;
        // On the snow a few metres from them, looking their way.
        if (mode === 'ride' || mode === 'fly') setMode('ski'); // your skier lands there
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
      notify: (text) => {
        // A countdown updates one notice rather than stacking ten.
        partyHud.notify(text, text.includes('following in') ? 'follow' : text);
      },
      setJacket: (colour) => {
        for (const model of [
          ski.model,
          glider.pilot,
          sled.rider,
          plane.pilot,
          heli.pilot,
          skydiver.pilot,
        ]) {
          model.setJacket(colour);
        }
      },
      roomChanged: () => {
        timeMenu.setLocked(
          multiplayer.isGuest ? 'In a multiplayer game the host sets the time of day.' : null,
        );
        weatherMenu.setLocked(
          multiplayer.isGuest ? 'In a multiplayer game the host sets the weather.' : null,
        );
        if (!multiplayer.isGuest) weather.stopFollowing(); // your own weather again
        applyRules(); // a party's rules, or your own again
      },
      ownRules: () => ownRules,
      rulesChanged: () => applyRules(),
    },
    multiplayerMenu,
    params.get('net') === 'loopback' ? 'loopback' : 'webrtc',
    parseRoomCode(params.get('join') ?? ''),
    hostAfterLoad,
  );

  ride.others = (line, carrier) => multiplayer.ridersOn(line, carrier);
  // The saved weather for this resort (a guest gets the host's instead, once connected).
  weather.restore();

  party = {
    note: () =>
      multiplayer.inPartyAsGuest
        ? `You'll leave ${multiplayer.hostName ?? 'the host'}'s party.`
        : multiplayer.active
          ? 'Your party comes with you.'
          : null,
    leaving: (resort, start) => {
      if (multiplayer.inPartyAsGuest) multiplayer.leave();
      else multiplayer.moveParty(resort, start);
    },
  };

  /** Whether the game's rules allow it; if not, say so (a notice under the compass). */
  const allowed = (rule: Rule) => {
    if (gameRules[rule]) return true;
    partyHud.notify(ruleOffMessage(rule, multiplayer.active));
    return false;
  };

  // Teleports reset the speed readout so the jump doesn't register as motion.
  let speedReset = true;
  // Map teleports (and J, to the guide marker) land you on the ground there.
  const teleport = (target: Pose, lookAt?: Place['lookAt']) => {
    if (!allowed('teleport')) return;
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
      baseUrl: manifest.minimap.base && resortUrl(resortId, manifest.minimap.base),
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
        features.airfields,
      ),
      pistes: pisteData.pistes,
      airfields: features.airfields,
      restaurants,
      buildings: features.buildings,
      mapPlaces:
        features.places ??
        (manifest.bases ?? []).map((b) => ({
          name: b.name,
          kind: 'village' as const,
          east: b.east,
          north: b.north,
        })),
      borders: features.borders ?? [],
      groundHeight: (east, north) => groundHeight(east, -north),
      toLatLon: (east, north) => frame.toLatLon(east, north),
    },
    teleport,
    () => closeMap(false),
    (marker) => setWaypoint(marker),
  );
  // The guide marker placed on the map (left click): a beam and an on-screen pin.
  const bodyMarker = new BodyMarker($('#labels'));
  const waypoint = new WaypointMarker(scene, $('#labels'), groundHeight, $('#marker-hint'));
  const setWaypoint = (w: { east: number; north: number } | null) => {
    waypoint.set(w);
    worldMap.marker = w;
    minimap.waypoint = w;
    saveWaypoint(localStorage, resortId, w);
  };
  setWaypoint(loadWaypoint(localStorage, resortId));
  waypoint.setHidden(!hudShown);
  // Third person unless you've chosen first (V).
  let view: 'first-person' | 'chase' =
    localStorage.getItem(VIEW_KEY) === 'first-person' ? 'first-person' : 'chase';
  const setView = (next: typeof view, announce = false) => {
    view = next;
    ski.setView(view);
    glider.setView(view);
    sled.setView(view);
    plane.setView(view);
    heli.setView(view);
    skydiver.setView(view);
    document.body.classList.toggle('chase', view === 'chase');
    showToggle('view', view === 'first-person', announce);
    localStorage.setItem(VIEW_KEY, view);
  };
  setView(view);
  onWorldToggle = (name) => {
    if (name === 'view') setView(view === 'first-person' ? 'chase' : 'first-person');
    else if (name === 'pistes') togglePisteColours();
    else if (name === 'sound') toggleSound();
    else if (name === 'hud') toggleHud();
    else toggleLabels(name);
  };
  /**
   * Out of body: flying (F) leaves the skier you were (on skis, a paraglider or the
   * snowmobile) frozen where it was, and you fly about without one. F puts you back in it,
   * moving as it was; R (or any other way out of fly mode) brings it to you instead.
   */
  let body: 'ski' | 'glide' | 'sled' | 'plane' | 'heli' | null = null;
  /** Your frozen skier's head (world), for its tag and map dot. */
  const bodyHead = new Vector3();
  const bodyPosition = () =>
    body === 'ski'
      ? ski.skier.position
      : body === 'glide'
        ? glider.position
        : body === 'sled'
          ? sled.parts.root.position
          : body === 'plane' || body === 'heli'
            ? aircraftFor(body).position
            : null;
  /** Leave the frozen skier behind for good (it's coming to you instead). */
  const dropBody = () => {
    if (body === 'sled') sled.setActive(false); // parked where it was
    if (body === 'plane' || body === 'heli') {
      // Parked where it stood; left in mid-air, it goes away (it would hang in the sky).
      const ctl = aircraftFor(body);
      if (ctl.onGround) ctl.setActive(false);
      else {
        ctl.stow();
        fleet.take(null, ctl.type.id); // back at its airfield spot
      }
    }
    body = null;
  };
  /** Show the modes' models: the active one, plus your frozen skier while flying. */
  const activate = () => {
    ski.setActive(mode === 'ski' || mode === 'ride');
    glider.setActive(mode === 'glide');
    if (body !== 'sled') sled.setActive(mode === 'sled');
    for (const kind of ['plane', 'heli'] as const) {
      const ctl = aircraftFor(kind);
      if (body !== kind && (ctl.status === 'riding' || ctl.status === 'parked')) {
        ctl.setActive(mode === kind);
      }
    }
    skydiver.setActive(mode === 'skydive');
    if (body === 'ski') ski.showFrozen();
    else if (body === 'glide') glider.showFrozen();
    else if (body === 'sled') sled.showFrozen();
    else if (body === 'plane' || body === 'heli') aircraftFor(body).showFrozen();
    trails.break(); // don't join this mode's tracks to the last one's
    hud.setMode(mode);
    hud.setFlyKeys(mode === 'fly' ? (body ? 'body' : 'free') : null);
    document.body.classList.toggle('skiing', mode !== 'fly');
    speedReset = true;
    localStorage.setItem(MODE_KEY, mode);
  };
  /** F while flying: back into your skier, as and where you left it. */
  const returnToBody = () => {
    if (!body) return;
    // Left on a snowmobile or paraglider the rules have since taken away: land instead.
    if (
      (body === 'sled' && !allowed('snowmobile')) ||
      (body === 'glide' && !allowed('paraglider')) ||
      ((body === 'plane' || body === 'heli') && !allowed('aircraft'))
    ) {
      setMode('ski');
      return;
    }
    mode = body;
    body = null;
    activate();
    persistPose();
  };
  /** How the next switch into a plane or helicopter puts you in one (see `boardNearby`). */
  let boardAircraft: (() => void) | null = null;
  const setMode = (next: Mode) => {
    if (mode === 'fly') dropBody();
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
              : mode === 'plane' || mode === 'heli'
                ? aircraftFor(mode).velocity
                : mode === 'skydive'
                  ? skydiver.velocity
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
    if ((mode === 'plane' || mode === 'heli') && next !== 'fly') {
      // Climb out beside it; it stays parked where it is.
      const off = aircraftFor(mode).dismount();
      eye.east = off.feet.x;
      eye.north = -off.feet.z;
      eye.altitude = off.feet.y + EYE_HEIGHT;
      velocity.copy(off.velocity);
    }
    const look = controls().look;
    const previous = mode;
    if (
      next === 'fly' &&
      (previous === 'ski' ||
        previous === 'glide' ||
        previous === 'sled' ||
        previous === 'plane' ||
        previous === 'heli')
    ) {
      // Out of body: float up out of where the camera is (behind and above you in
      // third person; just back from your head in first person).
      body = previous;
      const cam = camera.position;
      const back = view === 'first-person' ? 2.5 : 0;
      eye.east = cam.x + Math.sin(look.yaw) * back;
      eye.north = -(cam.z + Math.cos(look.yaw) * back);
      eye.altitude = cam.y + (view === 'first-person' ? 0.8 : 0);
    }
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
    } else if (mode === 'plane' || mode === 'heli') {
      const put = boardAircraft;
      boardAircraft = null;
      if (put) put();
      else {
        const feet = new Vector3(eye.east, eye.altitude - EYE_HEIGHT, -eye.north);
        aircraftFor(mode).mount(feet, velocity, look.yaw, true);
      }
    }
    activate();
  };
  /**
   * Out of the door in the air: freefall with the aircraft's speed (and a push sideways).
   * The empty aircraft flies on a few seconds and goes; its airfield spot is free again.
   */
  const bailOut = (kind: 'plane' | 'heli') => {
    const ctl = aircraftFor(kind);
    const out = ctl.abandon();
    abandoned = kind;
    mode = 'skydive';
    skydiver.jump(out.at, out.velocity, out.heading);
    activate();
    partyHud.notify(
      input.touch
        ? 'Open your canopy when you like · stick forward to track, back to flare'
        : 'Space to open your canopy · W track · S flare · E head down',
    );
  };
  /** The aircraft left flying on empty, if any (its airfield spot frees once it's gone). */
  let abandoned: 'plane' | 'heli' | null = null;
  /** A parked plane or helicopter within reach (yours, or one at the airfield), if any. */
  const nearbyAircraft = (p: Vector3, pressed = false): 'plane' | 'heli' | null => {
    // With aircraft off, E beside one says so (the prompt just doesn't offer it).
    if (!gameRules.aircraft && !pressed) return null;
    for (const kind of ['plane', 'heli'] as const) {
      const ctl = aircraftFor(kind);
      if (ctl.canBoard(p) || fleet.nearest(p, BOARD_RANGE, ctl.type.id) !== null) return kind;
    }
    return null;
  };
  /**
   * Into a plane or helicopter: only one parked at an airfield (a Porter at a runway's top,
   * an H125 on a helipad), or yours where you left it, and only beside it (E, or tap the
   * "Fly the …" prompt). Nothing comes to you.
   */
  const boardNearby = (kind: 'plane' | 'heli') => {
    const ctl = aircraftFor(kind);
    if (!allowed('aircraft')) return;
    const p = whereAmI();
    if (ctl.canBoard(p)) {
      boardAircraft = () => ctl.board();
    } else {
      const spot = fleet.nearest(p, BOARD_RANGE, ctl.type.id);
      if (spot === null) return;
      boardAircraft = () => {
        fleet.take(spot, ctl.type.id);
        ctl.boardAt(fleet.spots[spot]!);
      };
    }
    setMode(kind);
    persistPose();
  };
  /**
   * U, in either aircraft, always gets you out: stopped on the ground, beside it (it stays
   * parked); rolling, onto your skis at its speed (it brakes to a stop and stays parked);
   * in the air, a skydive (it flies on and goes back to its airfield spot).
   */
  const getOut = (kind: 'plane' | 'heli') => {
    const ctl = aircraftFor(kind);
    if (ctl.crashing) return;
    if (ctl.canLeaveOnGround) setMode('ski');
    else bailOut(kind);
  };
  hud.setMode(mode);
  hud.setFlyKeys(mode === 'fly' ? 'free' : null);
  document.body.classList.toggle('skiing', mode !== 'fly');
  applyRules = () => {
    const rules = multiplayer.rules ?? ownRules;
    Object.assign(gameRules, rules);
    rulesMenu.show(
      rules,
      multiplayer.rulesLocked ? 'In a multiplayer game the host sets the rules.' : null,
    );
    // What a rule takes away goes from the hints and touch buttons too (style.css).
    const classes = document.body.classList;
    classes.toggle('rules-no-teleport', !rules.teleport);
    classes.toggle('rules-no-snowmobile', !rules.snowmobile);
    classes.toggle('rules-no-paraglider', !rules.paraglider);
    classes.toggle('rules-no-lift-skip', !rules.liftSkip);
    classes.toggle('rules-no-aircraft', !rules.aircraft);
    const teleportOff = rules.teleport ? null : ruleOffMessage('teleport', multiplayer.active);
    worldMap.teleportOff = teleportOff;
    menu.setTeleport(teleportOff);
    ride.canSkip = rules.liftSkip;
    ride.fastForward = rules.liftSkip && !multiplayer.active; // a party's lift clock is shared
    // On something the rules have just taken away: back on your skis.
    if (
      (mode === 'sled' && !rules.snowmobile) ||
      (mode === 'glide' && !rules.paraglider) ||
      ((mode === 'plane' || mode === 'heli') && !rules.aircraft)
    ) {
      setMode('ski');
    }
  };
  // Your own rules settle in when the world's ready (a party's arrive with the host).
  onRulesEdited = (rules) => {
    if (multiplayer.rules === null) {
      ownRules = rules;
      saveRules(localStorage, rules);
    }
    multiplayer.rulesEdited(rules);
    applyRules();
  };
  applyRules();
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
    input.unlock();
    worldMap.open(currentPose());
    document.body.classList.add('map-open');
  };
  const closeMap = (resumeFlying: boolean) => {
    worldMap.close();
    document.body.classList.remove('map-open');
    // Closing from a click or key press counts as a user gesture, so pointer lock (and
    // audio, if the map was opened from the main menu before pressing Start) is allowed.
    // On a touchscreen ✕ goes straight back to the game too: there's no Esc to pause with.
    if (resumeFlying || input.touch) {
      sound.start();
      void input.lock();
    }
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  document.addEventListener('pointerlockchange', () => {
    document.body.classList.toggle('flying', input.locked);
    if (input.locked) document.body.classList.remove('entering');
    if (input.locked) menu.resumed();
  });
  $('#pause-map').addEventListener('click', openMap);
  $('#pause-options').addEventListener('click', () => settingsMenu.open());
  $('#pause-multiplayer').addEventListener('click', () => multiplayer.menu.open());
  // On the pause menu: the game you're in, if any.
  document.addEventListener('pointerlockchange', () => {
    if (input.locked) return;
    const d = multiplayer.debug;
    menu.setPauseNote(
      d.code
        ? `${d.role === 'host' ? 'Hosting' : 'In'} game ${d.code} · ${d.players.length} ${d.players.length === 1 ? 'player' : 'players'}`
        : null,
    );
  });
  // Ctrl tucks, but Ctrl+W closes the tab on Windows/Linux and can't be intercepted.
  // Ask before leaving instead. (On macOS Ctrl+W does nothing, so skip the prompt.)
  if (!/Mac|iPhone|iPad/.test(navigator.userAgent)) {
    window.addEventListener('beforeunload', (e) => {
      if (input.locked && !input.touch) e.preventDefault();
    });
  }
  window.addEventListener('pagehide', persistPose);
  document.addEventListener('visibilitychange', persistPose);
  const hubKeys: Record<string, { toggle(): void }> = {
    KeyG: skiSetup,
    KeyT: timeMenu,
    KeyC: weatherMenu,
    KeyO: settingsMenu,
    KeyN: multiplayer.menu,
  };
  document.addEventListener('keydown', (e) => {
    // Typing in the map search box or a name field (a focused checkbox or slider isn't).
    // Esc still closes the map from its search box.
    const typing = e.target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(e.target.type);
    if (typing && !(e.code === 'Escape' && worldMap.isOpen)) return;
    if (e.code === 'F3') {
      e.preventDefault();
      debug.hidden = !debug.hidden;
      return;
    }
    if (e.code === 'F2') {
      e.preventDefault();
      screenshotPending = true; // taken right after the next render
      return;
    }
    if (!e.repeat) act(e.code, e.shiftKey);
  });
  /** What a key does in game; the touch buttons and tappable prompts call it too. */
  act = (code, shift = false) => {
    // G / T / C / O / N open their Options tab (or close the hub if it's already on it).
    const tab = !worldMap.isOpen ? hubKeys[code] : undefined;
    if (tab) {
      input.unlock();
      tab.toggle();
      return;
    }
    if (document.querySelector('dialog[open]')) return; // a menu dialog has the keyboard
    if (code === 'KeyM' && shift && !worldMap.isOpen) {
      // Shift+M: mark where you are now (e.g. to come back to it with J).
      const { east, north } = currentPose();
      setWaypoint({ east, north });
    } else if (code === 'KeyM') {
      if (worldMap.isOpen) closeMap(true);
      else openMap();
    } else if (code === 'Escape' && worldMap.isOpen) {
      closeMap(false);
    } else if (code === 'KeyL' && multiplayer.stayBehind()) {
      // The party's moving resort: stay here instead (and leave it).
    } else if (code === 'KeyJ' && !worldMap.isOpen && waypoint.current) {
      // Jump to the guide marker, facing the way you were going.
      const w = waypoint.current;
      teleport({ ...w, altitude: 0, heading: currentPose().heading, pitch: 0 });
    } else if (code === 'KeyE' && !worldMap.isOpen) {
      if (mode === 'ride') {
        setMode('ski'); // step off (or jump!) where you are
      } else if (mode === 'ski' || mode === 'fly') {
        const p = whereAmI();
        const near = lifts.boardingNear(p.x, p.z);
        if (near) boardLift(near.line, near.down);
        else if (mode === 'ski') {
          // Beside a parked plane or helicopter: climb in.
          const kind = nearbyAircraft(p, true);
          if (kind) boardNearby(kind);
        }
      }
    } else if (code === 'KeyF' && !worldMap.isOpen) {
      // F: out of your body to fly, and back into it; with no body to go back to, land.
      if (mode === 'fly') {
        if (body) returnToBody();
        else setMode('ski');
      } else if (mode !== 'ride' && mode !== 'skydive') {
        // Not off a lift (you'd leave your body hanging on the chair) or in freefall.
        setMode('fly');
      }
    } else if (code === 'KeyR' && !worldMap.isOpen && mode === 'fly') {
      setMode('ski'); // your skier comes to the ground below you
    } else if (code === 'KeyU' && !worldMap.isOpen && (mode === 'plane' || mode === 'heli')) {
      // U: out of the plane or helicopter, whatever it's doing.
      getOut(mode);
    } else if (code === 'KeyP' && !worldMap.isOpen && mode !== 'plane' && mode !== 'heli') {
      // Deploy the paraglider (keeping your momentum), or drop it and ski.
      if (mode === 'glide') setMode('ski');
      else if (allowed('paraglider')) setMode('glide');
    } else if (
      code === 'KeyB' &&
      !worldMap.isOpen &&
      mode !== 'ride' &&
      mode !== 'plane' &&
      mode !== 'heli'
    ) {
      // Get on a snowmobile (keeping your momentum), or step off it onto your skis.
      if (mode === 'sled') setMode('ski');
      else if (allowed('snowmobile')) setMode('sled');
    } else if (code === 'KeyV' && mode !== 'fly') {
      // Flying is always a free camera: there's no first or third person.
      setView(view === 'first-person' ? 'chase' : 'first-person', true);
    } else if (code === 'Digit1' || code === 'Numpad1') {
      toggleLabels('lift');
    } else if (code === 'Digit2' || code === 'Numpad2') {
      toggleLabels('peak');
    } else if (code === 'Digit3' || code === 'Numpad3') {
      togglePisteColours();
    } else if (code === 'Digit4' || code === 'Numpad4') {
      toggleLabels('restaurant');
    } else if (code === 'KeyH') {
      toggleHud();
    } else if (code === 'KeyK') {
      toggleSound();
    }
  };
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
  /** In the world already: a start point is then a teleport (the first one never is). */
  let entered = false;
  play = (choice, auto = false) => {
    sound.start(); // audio may only start from a user gesture
    if (choice && (!entered || allowed('teleport'))) startAt(choice);
    entered = true;
    // Straight from loading there's no click to capture the mouse with: the world shows,
    // with "Click to play" until the first click (or Enter). On a touchscreen, "Tap to
    // play" unless this came from a tap (Resume, a start point), so sound can start.
    // An invite link and no name yet: ask for it first (the screen sits over the world).
    if (multiplayer.askForName()) return;
    if (!input.locked) document.body.classList.add('entering');
    if (!input.touch || !auto) void input.lock();
  };
  const enter = () => {
    sound.start();
    void input.lock();
  };
  $('#click-to-play').addEventListener('click', enter);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.body.classList.contains('entering') && !input.locked) {
      if (document.querySelector('dialog[open]') || worldMap.isOpen) return;
      enter();
    }
  });
  // Ready once the first frames are on screen: the first ones compile the shaders.
  menu.progress('Preparing graphics…', 0.97);

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
      ride,
      sled,
      plane,
      heli,
      skydiver,
      fleet,
      fly,
      environment,
      clock,
      weather,
      multiplayer,
      forest,
      parks,
      groundHeight,
      input,
    });
  let last = performance.now();
  /** Seconds of play, for gusts and passing clouds; when the weather was last worked out. */
  let weatherClock = 0;
  const cloudWindV = new Vector3();
  let cloudsBuilt = -1;
  let weatherChecked = -1;
  let weatherWind = 0;
  let lastX = fly.position.x;
  let lastY = fly.position.y;
  let lastZ = fly.position.z;
  let speed = 0;
  let fps = 60;

  let lastPersist = 0;
  let crashNoted = false;
  const airWind = new Vector3();
  let wasGrinding = false;
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
  // On a touchscreen the prompts name no keys: the ride and step-off are buttons (the
  // prompt itself, or the lift's context buttons).
  const updatePrompt = () => {
    let text = '';
    /** The key the prompt offers: shown as a keycap, or (touch) tap the prompt for it. */
    let key: string | null = null;
    const tap = input.touch;
    if (mode === 'ride') {
      if (ride.phase === 'waiting') {
        const ff = ride.fastForward && !tap ? ' · hold W to fast-forward' : '';
        const away = tap ? '' : ' · E to step away';
        text = `Waiting for ${ride.name} · ${formatWait(ride.departsIn)}${ff}${away}`;
      } else {
        const ff = ride.fastForward ? ' · hold W to fast-forward' : '';
        const skip = ride.canSkip ? ` · S to skip to the ${ride.down ? 'bottom' : 'top'}` : '';
        text = tap ? ride.name : `${ride.name}${ff}${skip} · E to jump off`;
      }
    } else if (mode === 'ski' || mode === 'fly') {
      const p = whereAmI();
      const near = lifts.boardingNear(p.x, p.z);
      if (near) {
        const l = lifts.lines[near.line]!;
        const vertical = `${Math.round(l.lift.vertical)} m ${near.down ? 'down' : 'up'}`;
        if (!near.down && l.inLoadingZone(p) && lifts.steppedOff !== near.line) {
          text = tap
            ? `${l.name} loading point · wait here, or tap to board`
            : `${l.name} loading point · wait here to be picked up (or press E)`;
          if (tap) key = 'KeyE';
        } else {
          key = 'KeyE';
          text = `${tap ? 'Ride' : 'ride'} ${l.name}${near.down ? ' down' : ''} (${liftTypeName(l.lift.type)}, ${vertical})`;
        }
      } else if (mode === 'ski' && gameRules.snowmobile && sled.canRemount(p)) {
        key = 'KeyB';
        text = `${tap ? 'Get' : 'get'} back on the snowmobile`;
      } else if (mode === 'ski' && nearbyAircraft(p)) {
        const kind = nearbyAircraft(p)!;
        key = 'KeyE';
        text = `${tap ? 'Fly' : 'fly'} the ${aircraftFor(kind).type.name}`;
      }
    } else if (mode === 'plane' || mode === 'heli') {
      const ctl = aircraftFor(mode);
      if (ctl.canExit) {
        key = 'KeyU';
        text = `${tap ? 'Get' : 'get'} out`;
      } else if (ctl.onGround && !ctl.crashing && !tap) {
        key = 'KeyU';
        text = 'jump out (onto your skis)';
      } else if (!ctl.onGround && !ctl.crashing && !tap) {
        key = 'KeyU';
        text = 'jump out (skydive)';
      } else if (mode === 'plane' && ctl.onGround && ctl.speed < 3 && !tap) {
        text = 'W power · pull back (mouse down) to lift off · X flaps · Space brakes';
      } else if (mode === 'heli' && ctl.onGround && !tap) {
        text = 'Hold W to lift off · S down · mouse cyclic · Q / E pedals';
      }
    }
    const shown = `${key}|${text}`;
    if (shown !== promptText) {
      promptText = shown;
      prompt.dataset.key = key ?? '';
      if (!key) delete prompt.dataset.key;
      // "E — ride …" shows its key as a keycap; on a touchscreen the prompt is the button.
      if (key && !tap) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key.slice(3);
        prompt.replaceChildren(kbd, text);
      } else {
        prompt.textContent = text;
      }
      prompt.hidden = !text;
    }
  };
  // Tappable HUD: the prompt, fly mode's ways out and the minimap do what their key does.
  $('#hud').addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
    if (el?.dataset.key && input.touch) act(el.dataset.key);
  });

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
    const levels = soundLevels(airSpeed, contact, weatherWind);
    if (mode === 'fly') levels.wind = 0; // the drone's camera hears its props, not the wind
    // In a cockpit the slipstream is a muffled hiss under the engine.
    if ((mode === 'plane' || mode === 'heli') && view === 'first-person') levels.wind *= 0.35;
    // Freefall roars: louder still with speed (head down at 290 km/h).
    if (mode === 'skydive' && !skydiver.canopyOut) {
      levels.wind = Math.min(1, 0.55 + 0.45 * Math.min(1, skydiver.airspeed / 80));
    }
    sound.update(levels);
    sound.setEngine(engineSound(sled.rpm, sled.throttle, mode === 'sled'));
    sound.setDrone('own', mode === 'fly' ? droneSound(fly.currentVelocity.length()) : DRONE_OFF);
    const otherDrone = multiplayer.nearestDrone(camera.position);
    if (otherDrone) {
      const buzz = droneSound(otherDrone.speed);
      sound.setDrone('other', { ...buzz, level: buzz.level * droneFalloff(otherDrone.distance) });
    } else sound.setDrone('other', DRONE_OFF);
    const flying = mode === 'plane' || mode === 'heli' ? aircraftFor(mode) : null;
    sound.setAircraft(
      'own',
      flying ? aircraftSound(flying.kind, flying.rpm, flying.load) : AIRCRAFT_OFF,
    );
    const otherAircraft = multiplayer.nearestAircraft(camera.position);
    if (otherAircraft) {
      const s = aircraftSound(otherAircraft.kind, otherAircraft.rpm, otherAircraft.load);
      sound.setAircraft('other', {
        ...s,
        level: s.level * aircraftFalloff(otherAircraft.distance),
      });
    } else sound.setAircraft('other', AIRCRAFT_OFF);
    if (flying && flying.impact > 0) sound.thump(flying.impact * 2);
    if (mode === 'sled' && sled.impact > 0) sound.thump(sled.impact);
    if (mode === 'ski' && ski.landingImpact > 0 && !ski.onRail) sound.thump(ski.landingImpact);
    // Rails: a clank as you get on (harder dropping onto it), then the grind.
    const grinding = mode === 'ski' && ski.onRail;
    if (grinding && !wasGrinding) sound.railHit(ski.landingImpact / 5 + ski.contact.speed / 20);
    if (!grinding && wasGrinding && ski.airborne) sound.railHit(0); // a tick off the end
    wasGrinding = grinding;
    sound.setRail(railSound(ski.contact.speed, ski.contact.sideslip, grinding));
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
      // On a lift with skipping off: S (or W, unless the party's shared clock already
      // stops it) says why nothing happens.
      if (mode === 'ride' && !gameRules.liftSkip) {
        if (input.wasPressed('KeyS') || (!multiplayer.active && input.wasPressed('KeyW')))
          allowed('liftSkip');
      }
      const landed = controls().update(dt, input);
      if (mode === 'glide' && landed) setMode('ski');
      if (mode === 'skydive') {
        const touch = skydiver.state.landed;
        if (touch?.crash) {
          // Into the ground: a crash, then on your feet where you hit, at rest.
          partyHud.notify(touch.sink > 30 ? 'Crashed · no canopy' : 'Crashed · hard landing');
          sound.thump(8);
          skydiver.velocity.set(0, 0, 0);
          setMode('ski');
        } else if (touch) {
          sound.thump(touch.sink);
          setMode('ski'); // running on, with the canopy's momentum
        }
      }
      if (mode === 'ride' && landed) unload();
      if (mode === 'ski' && !ski.airborne) {
        const hit = lifts.scoop(ski.feet);
        if (hit) scooped(hit.line, hit.carrier);
      }
      sky.settleCamera(dt, camera);
    }
    if (mode !== 'sled') sled.idle(dt); // a parked sled settles where you left it
    if (mode !== 'plane' && body !== 'plane') plane.idle(dt); // props run down when parked
    if (mode !== 'heli' && body !== 'heli') heli.idle(dt);
    if (abandoned && aircraftFor(abandoned).status === 'away') {
      fleet.take(null, aircraftFor(abandoned).type.id); // its airfield's one is back
      abandoned = null;
    }
    if (mode === 'plane' || mode === 'heli') {
      const ctl = aircraftFor(mode);
      if (ctl.crashed && !crashNoted) {
        crashNoted = true;
        partyHud.notify(`Crashed · ${ctl.crashed}`);
        sound.thump(8);
      }
      if (ctl.wrecked) {
        // Thrown clear onto your skis where it came to rest, standing; the wreck stays
        // there, smoking, and its airfield has another.
        ctl.wrecked = false;
        crashNoted = false;
        setMode('ski');
        ctl.leaveWreck(); // smoking where it stopped, never to fly again
        fleet.take(null, ctl.type.id); // its airfield has one again
        persistPose();
      }
    }
    fleet.update(camera.position);
    updateLiftSound();
    if (mode === 'fly') ski.skier.visible = body === 'ski'; // no body of your own in fly mode
    hud.setFlySpeed(
      mode === 'fly' ? fly.speed : null,
      Math.log(fly.speed / FLY.minSpeed) / Math.log(FLY.maxSpeed / FLY.minSpeed),
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
    // The weather where the camera is: refreshed a few times a second, gusting every frame.
    weatherClock += dt;
    if (weather.day && weatherClock - weatherChecked > 0.25) {
      weatherChecked = weatherClock;
      weatherAt(clock.seconds);
      weatherMenu.sync();
    }
    const conditions = weather.day ? weather.conditions : CLEAR;
    weatherWind = gustyWind(conditions, weatherClock);
    if (weather.field !== cloudField) {
      cloudField = weather.field;
      cloudsChanged = true;
    }
    // At most five rebuilds a second, however fast the drone flies.
    if (cloudsChanged || weatherClock - cloudsBuilt > 0.2) {
      cloudsBuilt = weatherClock;
      clouds.update(
        camera.position,
        weather.day && weather.field ? (e, n) => weather.layerAt(e, n) : null,
        groundHeight,
        cloudsChanged,
      );
      cloudsChanged = false;
    }
    const cloudWind = windVelocity(conditions.wind, conditions.windFrom, cloudWindV);
    clouds.blow(dt, cloudWind.x, cloudWind.z);
    airfields?.update(weatherWind, conditions.windFrom, weatherClock);
    // Planes and helicopters fly through the weather's (gusting) wind and its air.
    const air = {
      wind: windVelocity(weatherWind, conditions.windFrom, airWind),
      temperature: weather.day ? conditions.temperature : null,
    };
    plane.air = air;
    heli.air = air;
    // Smoke off a wreck; the wreck goes once you're well away from it.
    let smokeFrom: Vector3 | null = null;
    for (const ctl of [plane, heli]) {
      const at = ctl.smokeFrom;
      if (at && at.distanceTo(camera.position) > WRECK_GONE) ctl.stow();
      else if (at) smokeFrom = at;
    }
    wreckSmoke.update(dt, smokeFrom, air.wind);
    skydiver.air = air;
    environment.setWeather(conditions, sunlitAt(conditions.cloud, weatherClock));
    const light = daylight(environment.sun.elevation);
    weatherFx.update(
      dt,
      camera.position,
      conditions,
      weatherWind,
      groundHeight(camera.position.x, camera.position.z),
      (0.3 + 1.4 * light.day) * (1 + 0.3 * conditions.whiteout),
      mode === 'ride' && ride.sheltered && view === 'first-person',
    );
    sled.setDarkness(light.dark); // headlights at dusk
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
    partyClock += dt;
    if (partyClock > 0.25) {
      partyClock = 0;
      partyHud.setParty(
        multiplayer.partyMembers(whereAmI(), (at) => {
          const p = pisteLookup.at(at.x, -at.z);
          return p?.name ? runLabel(p) : null;
        }),
      );
    }
    renderer.render(scene, camera);
    if (screenshotPending) {
      screenshotPending = false;
      const pose = currentPose();
      const { lat, lon } = frame.toLatLon(pose.east, pose.north);
      const name = screenshotName({ resort: resortId, lat, lon, ...pose }, new Date());
      void saveCanvas(canvas, name).then(
        () => {
          flash.classList.remove('flash');
          void flash.offsetWidth; // restart the animation
          flash.classList.add('flash');
        },
        (error: unknown) => console.warn(error),
      );
    }

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
              : mode === 'plane' || mode === 'heli'
                ? aircraftFor(mode).speed
                : mode === 'skydive'
                  ? skydiver.speed
                  : speed;
    updateSnowFx(dt, mode === 'skydive' ? skydiver.airspeed : ownSpeed);
    const heading = controls().heading;
    const ground = groundHeight(here.x, here.z);
    // Slope underfoot from the ground either side (2 m), only near the snow.
    const slope =
      here.y - ground < 60
        ? (Math.atan(
            Math.hypot(
              groundHeight(here.x + 2, here.z) - groundHeight(here.x - 2, here.z),
              groundHeight(here.x, here.z + 2) - groundHeight(here.x, here.z - 2),
            ) / 4,
          ) *
            180) /
          Math.PI
        : null;
    const w = waypoint.current;
    hud.setMarker(w ? (Math.atan2(w.east - east, w.north - north) * 180) / Math.PI : null);
    hud.update({ altitude: here.y, lat, lon, speed: ownSpeed, heading, slope });
    const pilotOf = mode === 'plane' || mode === 'heli' ? aircraftFor(mode) : null;
    if (mode === 'skydive') {
      hud.setMode(skydiver.avatarMode);
      const agl = skydiver.agl;
      hud.setFlight({
        kind: 'skydive',
        airspeed: skydiver.airspeed,
        vertical: skydiver.velocity.y,
        power: 0,
        flaps: 0,
        stall: false,
        onGround: false,
        agl,
        warning: skydiver.canopyOut ? null : agl < 600 ? 'PULL' : agl < 1000 ? 'LOW' : null,
      });
    } else
      hud.setFlight(
        pilotOf
          ? {
              kind: pilotOf.kind,
              airspeed: pilotOf.airspeed,
              vertical: pilotOf.velocity.y,
              power: pilotOf.kind === 'plane' ? pilotOf.lever : pilotOf.load,
              flaps: pilotOf.flapSetting,
              stall: pilotOf.stallWarning,
              onGround: pilotOf.onGround,
            }
          : null,
      );
    // Which run is underfoot (only meaningful near the snow).
    const nearSnow = here.y - ground < 60;
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
    // Out of body: your frozen skier gets a tag, and a white dot on the maps.
    const left = bodyPosition();
    if (left) bodyHead.set(left.x, left.y + 2.2, left.z);
    bodyMarker.update(camera, left ? bodyHead : null, here);
    const dots = left
      ? [
          ...multiplayer.dots,
          { east: left.x, north: -left.z, colour: '#ffffff', name: 'Your skier' },
        ]
      : multiplayer.dots;
    minimap.players = dots;
    worldMap.setPlayers(dots);
    minimap.draw(east, north, controls().heading);
    updatePrompt();
    touch.update({
      mode,
      airborne: mode === 'ski' && ski.airborne,
      tucked: mode === 'ski' && ski.tucked,
      fastForward: ride.fastForward,
      names: labels.isVisible('lift') || labels.isVisible('peak') || labels.isVisible('restaurant'),
      pistes: pisteColours,
      flying: (mode === 'plane' || mode === 'heli') && !aircraftFor(mode).onGround,
      canopy: mode === 'skydive' && skydiver.canopyOut,
    });
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
          : mode === 'plane' || mode === 'heli'
            ? `heading ${aircraftFor(mode).heading.toFixed(1)}° · airspeed ${(aircraftFor(mode).airspeed * 3.6).toFixed(0)} km/h · rpm ${(aircraftFor(mode).rpm * 100).toFixed(0)}% · load ${(aircraftFor(mode).load * 100).toFixed(0)}%${aircraftFor(mode).onGround ? ' (ground)' : ''}${aircraftFor(mode).stalled ? ' STALL' : ''}`
            : mode === 'sled'
              ? `heading ${sled.sledHeading.toFixed(1)}° · sled ${(sled.speed * 3.6).toFixed(0)} km/h · ${Math.round(sled.rpm)} rpm${sled.airborne ? ' (air)' : ''}${sled.inPowder ? ' · powder' : ''}`
              : mode === 'ski'
                ? `heading ${ski.heading.toFixed(1)}° · ski ${(ski.speed * 3.6).toFixed(0)} km/h${ski.airborne ? ' (air)' : ''} · ${ski.view}`
                : `heading ${fly.heading.toFixed(1)}° · drone speed ${fly.speed.toFixed(0)} m/s`,
        `sun az ${environment.sun.azimuth.toFixed(1)}° el ${environment.sun.elevation.toFixed(1)}° · ${SIM_DAY.date}`,
        `weather ${weather.day ? describeWeather(weather.conditions) : 'off'}`,
      ].join('\n');
    }

    if (now - lastPersist > 1000) {
      persistPose();
      if (!multiplayer.isGuest) saveTime(localStorage, clock);
      lastPersist = now;
    }

    sim.frames++;
    if (!sim.ready) menu.ready();
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

type Mode = 'fly' | 'ski' | 'glide' | 'ride' | 'sled' | 'plane' | 'heli' | 'skydive';
const MODE_KEY = 'ski-sim.mode';
/** A crashed aircraft's wreck is cleared away once you're this far from it (m). */
const WRECK_GONE = 2500;
/** Width of the groove each snowmobile ski's keel cuts (m). */
const SLED_SKI_GROOVE = 0.1;
const VIEW_KEY = 'ski-sim.view';
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range']);

function loadMode(): Mode {
  // A reload mid-flight drops you into ski mode (you fall and land); sledders keep the sled.
  const saved = localStorage.getItem(MODE_KEY);
  if (saved === 'sled') return 'sled';
  // In a plane or helicopter (or under a canopy): it's back at its airfield, you on skis.
  if (saved === 'plane' || saved === 'heli' || saved === 'skydive') return 'ski';
  return saved === 'ski' || saved === 'glide' || saved === 'ride' ? 'ski' : 'fly';
}

const PREFS_KEY = 'ski-sim.labels';

interface Prefs {
  lift: boolean;
  peak: boolean;
  restaurant: boolean;
  pistes: boolean;
  sound: boolean;
  hud: boolean;
}

function loadPrefs(): Prefs {
  // Markers start off: a clean view until you turn them on (1-4).
  const defaults = {
    lift: false,
    peak: false,
    restaurant: false,
    pistes: false,
    sound: true,
    hud: true,
  };
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

async function fetchJson<T>(url: string, get: Fetch = fetch): Promise<T> {
  const res = await get(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (HTTP ${res.status})`);
  return (await res.json()) as T;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

main().catch((error: unknown) => {
  console.error(error);
  failLoad(error instanceof Error ? error.message : String(error));
});
