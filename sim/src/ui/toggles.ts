import type { LabelKind } from './labels';
import type { Entry } from './registry';

/** The game's mode, as far as the registry cares (main.ts's `Mode`). */
export type PlayMode = 'fly' | 'ski' | 'glide' | 'ride' | 'sled' | 'plane' | 'heli' | 'skydive';

/** Options tabs the menu entries open (each toggles its tab, as its hotkey always has). */
export type TabName =
  | 'camera'
  | 'display'
  | 'controls'
  | 'ski'
  | 'rules'
  | 'time'
  | 'weather'
  | 'multiplayer'
  | 'credits';

/**
 * What the entries need from the running game (main.ts). Each toggle is a getter and a
 * setter (the setter does everything a change involves: apply, save, announce); actions
 * are plain calls, and the getters tell the entries when they apply.
 */
export interface ToggleDeps {
  label(kind: LabelKind): boolean;
  setLabel(kind: LabelKind, on: boolean): void;
  pistes(): boolean;
  setPistes(on: boolean): void;
  hud(): boolean;
  setHud(on: boolean): void;
  sound(): boolean;
  setSound(on: boolean): void;
  firstPerson(): boolean;
  setFirstPerson(on: boolean): void;
  snowboard(): boolean;
  setSnowboard(on: boolean): void;
  signReadout(): boolean;
  setSignReadout(on: boolean): void;
  debug(): boolean;
  setDebug(on: boolean): void;
  fullscreen(): boolean;
  fullscreenEnabled(): boolean;
  toggleFullscreen(): void;
  mode(): PlayMode;
  /** The world map (M) is open. */
  mapOpen(): boolean;
  /** A guide marker is set. */
  hasMarker(): boolean;
  /** Flying the drone with your skier waiting where you left it. */
  hasBody(): boolean;
  toggleMap(): void;
  /** F: out of your body to fly the drone, back into it, or (no body) land. */
  drone(): void;
  /** R: ski from where the drone is. */
  skiHere(): void;
  paraglider(): void;
  snowmobile(): void;
  dropMarker(): void;
  goToMarker(): void;
  screenshot(): void;
  openTab(tab: TabName): void;
}

const MAP_OPEN = 'Close the map first';

/** The touch tools row, left to right (entries' `tool.id`s): getting around, then the view. */
export const TOOL_ORDER = [
  'map',
  'fly',
  'glider',
  'sled',
  'view',
  'labels',
  'pistes',
  'fullscreen',
];

/** The entries with a touch tool, in the row's order. */
export function touchTools(entries: readonly Entry[]): Entry[] {
  const at = (e: Entry) => TOOL_ORDER.indexOf(e.tool!.id);
  return entries.filter((e) => e.tool).sort((a, b) => at(a) - at(b));
}
const LABEL_KINDS = ['lift', 'peak', 'restaurant'] as const;

/**
 * Every toggle and action in the game, in the order the panel and palette list them.
 * Keys are the single-key shortcuts players already know; nothing here is rebindable yet.
 */
export function createEntries(d: ToggleDeps): Entry[] {
  const mode = () => d.mode();
  const toggle = (
    get: () => boolean,
    set: (on: boolean) => void,
  ): Pick<Entry, 'kind' | 'get' | 'set' | 'run'> => ({
    kind: 'toggle',
    get,
    set,
    run: () => set(!get()),
  });
  const label = (kind: LabelKind) =>
    toggle(
      () => d.label(kind),
      (on) => d.setLabel(kind, on),
    );
  const notOnMap = () => (d.mapOpen() ? MAP_OPEN : null);
  const tab = (name: TabName) => ({
    kind: 'action' as const,
    group: 'menus' as const,
    overDialogs: true,
    run: () => d.openTab(name),
    unavailable: notOnMap,
  });
  return [
    // ---- Labels: name tags in the world ----
    {
      id: 'lift',
      label: 'Lift & airfield names',
      short: 'Lifts',
      display: true,
      hint: 'Name tags over the lifts, airfields and heliports',
      group: 'labels',
      key: { code: 'Digit1', also: ['Numpad1'], glyph: '1' },
      icon: 'lift',
      synonyms: ['labels', 'tags', 'chairlift', 'gondola', 'airport', 'runway'],
      panel: true,
      ...label('lift'),
    },
    {
      id: 'peak',
      label: 'Peak names',
      short: 'Peaks',
      display: true,
      hint: 'Summits, the big ones out to the horizon',
      group: 'labels',
      key: { code: 'Digit2', also: ['Numpad2'], glyph: '2' },
      icon: 'peak',
      synonyms: ['labels', 'tags', 'summits', 'mountains'],
      panel: true,
      ...label('peak'),
    },
    {
      id: 'restaurant',
      label: 'Restaurant names',
      short: 'Restaurants',
      display: true,
      hint: 'Mountain restaurants, bars and huts',
      group: 'labels',
      key: { code: 'Digit4', also: ['Numpad4'], glyph: '4' },
      icon: 'restaurant',
      synonyms: ['labels', 'tags', 'food', 'cafe', 'bar', 'huts'],
      panel: true,
      ...label('restaurant'),
    },
    {
      // Touch's single labels button: every kind on or off together.
      id: 'names',
      label: 'All names',
      hint: 'Lift, peak and restaurant names together',
      group: 'labels',
      icon: 'labels',
      synonyms: ['labels', 'tags'],
      tool: { id: 'labels', label: 'Labels' },
      ...toggle(
        () => LABEL_KINDS.some((k) => d.label(k)),
        (on) => {
          for (const k of LABEL_KINDS) d.setLabel(k, on);
        },
      ),
    },
    // ---- On the snow ----
    {
      id: 'pistes',
      label: 'Piste colours',
      short: 'Pistes',
      display: true,
      hint: 'Each run outlined in its difficulty colour',
      group: 'map',
      key: { code: 'Digit3', also: ['Numpad3'], glyph: '3' },
      icon: 'pistes',
      synonyms: ['runs', 'trails', 'slopes', 'difficulty', 'overlay'],
      panel: true,
      tool: { id: 'pistes', label: 'Piste colours' },
      ...toggle(
        () => d.pistes(),
        (on) => d.setPistes(on),
      ),
    },
    // ---- View & sound ----
    {
      id: 'view',
      label: 'First person',
      short: '1st person',
      display: true,
      hint: 'Through your own eyes, instead of the chase camera',
      group: 'view',
      key: { code: 'KeyV', glyph: 'V' },
      icon: 'view',
      synonyms: ['camera', 'third person', 'chase', 'cockpit', 'pov'],
      panel: true,
      tool: { id: 'view', label: 'View' },
      unavailable: () => (mode() === 'fly' ? 'The drone has no first person' : null),
      ...toggle(
        () => d.firstPerson(),
        (on) => d.setFirstPerson(on),
      ),
    },
    {
      id: 'sound',
      label: 'Sound',
      display: true,
      hint: 'Wind, snow, lifts and engines',
      group: 'view',
      key: { code: 'KeyK', glyph: 'K' },
      icon: 'sound',
      synonyms: ['mute', 'audio', 'volume'],
      panel: true,
      ...toggle(
        () => d.sound(),
        (on) => d.setSound(on),
      ),
    },
    {
      id: 'discipline',
      label: 'Snowboard',
      hint: 'Ride a snowboard instead of skis',
      group: 'view',
      key: { code: 'KeyY', glyph: 'Y' },
      icon: 'snowboard',
      synonyms: ['board', 'skis', 'discipline'],
      panel: true,
      ...toggle(
        () => d.snowboard(),
        (on) => d.setSnowboard(on),
      ),
    },
    // ---- Interface ----
    {
      id: 'hud',
      label: 'HUD',
      display: true,
      hint: 'Off for full immersion: nothing but the world',
      group: 'interface',
      key: { code: 'KeyH', glyph: 'H' },
      icon: 'hud',
      synonyms: ['interface', 'immersion', 'hide', 'overlay'],
      panel: true,
      ...toggle(
        () => d.hud(),
        (on) => d.setHud(on),
      ),
    },
    {
      id: 'sign-readout',
      label: 'Sign readout',
      hint: 'The signpost ahead, as text under the compass',
      group: 'interface',
      icon: 'sign',
      synonyms: ['signposts', 'signs', 'directions'],
      panel: true,
      ...toggle(
        () => d.signReadout(),
        (on) => d.setSignReadout(on),
      ),
    },
    {
      id: 'debug',
      label: 'Debug info',
      hint: 'Frame rate, draw calls, position and sun angle',
      group: 'interface',
      key: { code: 'F3', glyph: 'F3' },
      icon: 'debug',
      synonyms: ['fps', 'performance', 'stats'],
      touch: false,
      ...toggle(
        () => d.debug(),
        (on) => d.setDebug(on),
      ),
    },
    {
      id: 'fullscreen',
      label: 'Fullscreen',
      hint: 'Fill the screen',
      group: 'interface',
      icon: 'fullscreen',
      tool: { id: 'fullscreen', label: 'Fullscreen' },
      unavailable: () => (d.fullscreenEnabled() ? null : 'Not available in this browser'),
      ...toggle(
        () => d.fullscreen(),
        () => d.toggleFullscreen(),
      ),
    },
    // ---- Go: getting around ----
    {
      id: 'map',
      label: 'Map',
      kind: 'action',
      hint: 'The whole area: find places, drop a marker, teleport',
      group: 'go',
      key: { code: 'KeyM', glyph: 'M' },
      icon: 'map',
      synonyms: ['world map', 'trail map', 'piste map'],
      panel: true,
      tool: { id: 'map', label: 'Map' },
      get: () => d.mapOpen(),
      run: () => d.toggleMap(),
    },
    {
      id: 'drone',
      label: 'Fly the drone',
      kind: 'action',
      hint: 'Your skier waits where you left them; again to go back',
      group: 'go',
      key: { code: 'KeyF', glyph: 'F' },
      icon: 'fly',
      synonyms: ['fly', 'camera', 'free cam', 'spectate'],
      panel: true,
      tool: { id: 'fly', label: 'Drone' },
      get: () => mode() === 'fly',
      run: () => d.drone(),
      unavailable: () =>
        d.mapOpen()
          ? MAP_OPEN
          : mode() === 'ride'
            ? 'Not on a lift'
            : mode() === 'skydive'
              ? 'Not while skydiving'
              : null,
    },
    {
      id: 'ski-here',
      label: 'Ski from here',
      kind: 'action',
      hint: 'Down onto the snow below the drone',
      group: 'go',
      key: { code: 'KeyR', glyph: 'R' },
      icon: 'ski',
      synonyms: ['land', 'drop'],
      unavailable: () =>
        d.mapOpen() ? MAP_OPEN : mode() !== 'fly' ? 'Only flying the drone' : null,
      run: () => d.skiHere(),
    },
    {
      id: 'paraglider',
      label: 'Paraglider',
      kind: 'action',
      hint: 'Open a wing and fly on, keeping your speed',
      group: 'go',
      key: { code: 'KeyP', glyph: 'P' },
      icon: 'glider',
      synonyms: ['glide', 'wing', 'paragliding'],
      panel: true,
      rule: 'paraglider',
      tool: { id: 'glider', label: 'Paraglider' },
      get: () => mode() === 'glide',
      run: () => d.paraglider(),
      unavailable: () =>
        d.mapOpen()
          ? MAP_OPEN
          : mode() === 'plane' || mode() === 'heli'
            ? 'Not in an aircraft'
            : null,
    },
    {
      id: 'snowmobile',
      label: 'Snowmobile',
      kind: 'action',
      hint: 'Get on a sled, or step off it onto your skis',
      group: 'go',
      key: { code: 'KeyB', glyph: 'B' },
      icon: 'sled',
      synonyms: ['sled', 'skidoo', 'snowmachine', 'drive'],
      panel: true,
      rule: 'snowmobile',
      tool: { id: 'sled', label: 'Snowmobile', hidden: () => mode() === 'skydive' },
      get: () => mode() === 'sled',
      run: () => d.snowmobile(),
      unavailable: () =>
        d.mapOpen()
          ? MAP_OPEN
          : mode() === 'ride'
            ? 'Not on a lift'
            : mode() === 'plane' || mode() === 'heli'
              ? 'Not in an aircraft'
              : null,
    },
    {
      id: 'drop-marker',
      label: 'Drop a guide marker here',
      kind: 'action',
      hint: 'Mark where you are, to come back to it',
      group: 'go',
      key: { code: 'KeyM', shift: true, glyph: 'M' },
      icon: 'marker',
      synonyms: ['waypoint', 'pin', 'bookmark'],
      run: () => d.dropMarker(),
      unavailable: notOnMap,
    },
    {
      id: 'go-to-marker',
      label: 'Go to the guide marker',
      kind: 'action',
      hint: 'Teleport to the marker you dropped',
      group: 'go',
      key: { code: 'KeyJ', glyph: 'J' },
      icon: 'teleport',
      synonyms: ['teleport', 'waypoint', 'jump'],
      rule: 'teleport',
      run: () => d.goToMarker(),
      unavailable: () => (d.mapOpen() ? MAP_OPEN : d.hasMarker() ? null : 'No guide marker set'),
    },
    // ---- Menus: Options tabs and the rest ----
    {
      id: 'tab-camera',
      label: 'Camera options',
      hint: 'Field of view, mouse sensitivity, chase distance',
      key: { code: 'KeyO', glyph: 'O' },
      icon: 'camera',
      synonyms: ['options', 'settings', 'fov', 'sensitivity', 'invert'],
      ...tab('camera'),
    },
    {
      id: 'tab-display',
      label: 'Display options',
      hint: 'Glass strength, interface size, the world switches',
      icon: 'options',
      synonyms: ['options', 'settings', 'graphics', 'glass', 'scale'],
      ...tab('display'),
    },
    {
      id: 'tab-controls',
      label: 'Controls',
      hint: 'Every key, and flying with mouse or arrow keys',
      icon: 'controls',
      synonyms: ['keys', 'keyboard', 'help', 'bindings'],
      ...tab('controls'),
    },
    {
      id: 'tab-ski',
      label: 'Ski setup',
      hint: 'Skis or board: length, sidecut, flex, wax',
      key: { code: 'KeyG', glyph: 'G' },
      icon: 'ski',
      synonyms: ['equipment', 'gear', 'snowboard setup', 'skis'],
      ...tab('ski'),
    },
    {
      id: 'tab-rules',
      label: 'Rules',
      hint: 'Teleporting, snowmobile, paraglider, aircraft',
      icon: 'rules',
      synonyms: ['realistic', 'game rules'],
      ...tab('rules'),
    },
    {
      id: 'tab-time',
      label: 'Time of day',
      hint: 'The clock and its speed',
      key: { code: 'KeyT', glyph: 'T' },
      icon: 'time',
      synonyms: ['clock', 'night', 'sunset', 'sunrise'],
      ...tab('time'),
    },
    {
      id: 'tab-weather',
      label: 'Weather',
      hint: 'Clear, live, or any past day',
      key: { code: 'KeyC', glyph: 'C' },
      icon: 'weather',
      synonyms: ['snow', 'cloud', 'fog', 'forecast'],
      ...tab('weather'),
    },
    {
      id: 'tab-multiplayer',
      label: 'Multiplayer',
      hint: 'Host or join a game with friends',
      key: { code: 'KeyN', glyph: 'N' },
      icon: 'multiplayer',
      synonyms: ['party', 'friends', 'host', 'join', 'online'],
      ...tab('multiplayer'),
    },
    {
      id: 'tab-credits',
      label: 'Data & credits',
      hint: 'Where the terrain, runs and weather come from',
      icon: 'rules',
      synonyms: ['licences', 'sources', 'attribution', 'about'],
      ...tab('credits'),
    },
    {
      id: 'screenshot',
      label: 'Screenshot',
      kind: 'action',
      hint: 'Save the view without the HUD to Downloads',
      group: 'menus',
      key: { code: 'F2', glyph: 'F2' },
      icon: 'screenshot',
      synonyms: ['photo', 'picture', 'capture'],
      touch: false,
      run: () => d.screenshot(),
    },
  ];
}
