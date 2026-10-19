/**
 * Ski setup: the physical properties of the skis you're on, and how they turn into
 * handling. Pure (no DOM, no globals) so physics and tests can use it directly.
 *
 * The reference is the All-mountain preset: it reproduces the base `SKI` physics
 * exactly, and every other setup scales away from it. Effects follow the usual rules
 * of thumb: longer and stiffer skis are more stable and faster; shorter skis and
 * tighter sidecuts turn quicker; wide, rockered skis float in powder but are slower
 * edge to edge; sharp edges and camber grip on hard snow; wax glides.
 */

export type SkiProfile = 'camber' | 'tip-rocker' | 'hybrid' | 'full-rocker';
export type SkiWax = 'race' | 'all-temp' | 'worn' | 'unwaxed';
export type SkiTune = 'race' | 'sharp' | 'detuned' | 'dull';

export interface SkiSetup {
  /** Ski length (cm). */
  length: number;
  /** Width underfoot (mm). */
  waist: number;
  /** Sidecut radius (m). */
  radius: number;
  /** Flex, 1 (noodle) to 10 (race stiff). */
  flex: number;
  profile: SkiProfile;
  wax: SkiWax;
  tune: SkiTune;
  /** Binding mount relative to the recommended line (cm, + = forward). */
  mount: number;
}

/** Slider ranges (and the clamp applied to anything loaded). */
export const SETUP_RANGES = {
  length: { min: 140, max: 200, step: 1 },
  waist: { min: 64, max: 125, step: 1 },
  radius: { min: 10, max: 32, step: 0.5 },
  flex: { min: 1, max: 10, step: 1 },
  mount: { min: -4, max: 4, step: 0.5 },
} as const;

/** How much each profile is rockered (0 = full camber, 1 = full rocker). */
export const PROFILE_ROCKER: Record<SkiProfile, number> = {
  camber: 0,
  'tip-rocker': 0.25,
  hybrid: 0.5,
  'full-rocker': 1,
};

/** Base-on-snow friction coefficient on groomed snow, by wax. */
export const WAX_FRICTION: Record<SkiWax, number> = {
  race: 0.037,
  'all-temp': 0.045,
  worn: 0.052,
  unwaxed: 0.062,
};

/** Edge bite on hard snow, by tune. */
export const TUNE_GRIP: Record<SkiTune, number> = {
  race: 1.25,
  sharp: 1,
  detuned: 0.72,
  dull: 0.55,
};

export const SKI_PRESETS = {
  slalom: {
    name: 'Slalom race',
    setup: {
      length: 165,
      waist: 66,
      radius: 12.5,
      flex: 9,
      profile: 'camber',
      wax: 'race',
      tune: 'race',
      mount: 0,
    },
  },
  gs: {
    name: 'Giant slalom',
    setup: {
      length: 188,
      waist: 68,
      radius: 23,
      flex: 10,
      profile: 'camber',
      wax: 'race',
      tune: 'race',
      mount: 0,
    },
  },
  'all-mountain': {
    name: 'All-mountain',
    setup: {
      length: 178,
      waist: 88,
      radius: 17,
      flex: 6,
      profile: 'tip-rocker',
      wax: 'all-temp',
      tune: 'sharp',
      mount: 0,
    },
  },
  freeride: {
    name: 'Freeride / powder',
    setup: {
      length: 186,
      waist: 112,
      radius: 22,
      flex: 6,
      profile: 'hybrid',
      wax: 'all-temp',
      tune: 'sharp',
      mount: 0,
    },
  },
  park: {
    name: 'Park',
    setup: {
      length: 156,
      waist: 92,
      radius: 16,
      flex: 3,
      profile: 'hybrid',
      wax: 'all-temp',
      tune: 'detuned',
      mount: 3,
    },
  },
} satisfies Record<string, { name: string; setup: SkiSetup }>;

export type SkiPresetId = keyof typeof SKI_PRESETS;

export const DEFAULT_SETUP: SkiSetup = SKI_PRESETS['all-mountain'].setup;

/** Which preset (if any) a setup is exactly. */
export function matchPreset(setup: SkiSetup): SkiPresetId | null {
  for (const [id, preset] of Object.entries(SKI_PRESETS)) {
    const p: SkiSetup = preset.setup;
    if ((Object.keys(p) as (keyof SkiSetup)[]).every((k) => p[k] === setup[k])) {
      return id as SkiPresetId;
    }
  }
  return null;
}

/** Everything the physics and controls need to know about the skis. */
export interface SkiHandling {
  /** Friction coefficient on groomed snow. */
  snowFriction: number;
  /** Friction coefficient and extra drag (1/m) in ungroomed snow. */
  powderFriction: number;
  powderDrag: number;
  /** How quickly velocity swings toward the skis (1/s) before snow adjustments. */
  carveRate: number;
  /** Edge hold on hard (groomed) snow, 1 = reference. Also widens the grip angle. */
  hardGrip: number;
  /** Turning in deep snow, 1 = reference: narrow skis sink and are hard to steer. */
  powderGrip: number;
  /** Deceleration at a full sideways skid (m/s²). */
  skidDecel: number;
  /** Above this the skis start to chatter and wash out (m/s). */
  stableSpeed: number;
  /** Extra deceleration per m/s over `stableSpeed` (1/s). */
  chatter: number;
  /** Stiff skis need speed to bend into a carve; 0 = no low-speed penalty. */
  stiffness: number;
  /** Speed cap for these skis (m/s). */
  maxSpeed: number;
  /** Multipliers for the controls: A/D turning, S-pivot swing, edge-to-edge speed. */
  turnRate: number;
  pivotRate: number;
  edgeRate: number;
}

/** Reference values: the All-mountain preset maps exactly onto these. */
export const BASE_HANDLING = {
  powderExtraFriction: 0.035,
  powderDrag: 0.0015,
  carveRate: 2.8,
  skidDecel: 8,
  stableSpeed: 28,
  chatter: 0.2,
  /** Speed cap is this far above the stable speed, but never past the absolute cap. */
  maxSpeedMargin: 10,
  maxSpeed: 40,
};

const REF = DEFAULT_SETUP;
const flexUnit = (flex: number) => (flex - 1) / 9;

export function skiHandling(s: SkiSetup): SkiHandling {
  const B = BASE_HANDLING;
  const length = s.length / REF.length;
  const waist = s.waist / REF.waist;
  const radius = s.radius / REF.radius;
  const stiff = flexUnit(s.flex) - flexUnit(REF.flex);
  const rocker = PROFILE_ROCKER[s.profile];
  const rockerDelta = rocker - PROFILE_ROCKER[REF.profile];
  const wax = WAX_FRICTION[s.wax];

  // Float: surface area, plus rocker lifting the tips; mounting back helps a little.
  const float = length * waist * (1 + 0.6 * rockerDelta) * (1 - 0.02 * s.mount);
  // Edge hold on hard snow: tune, and camber (rocker lifts edge off the snow).
  const hardGrip = Math.max(0.5, TUNE_GRIP[s.tune] * (1 - 0.3 * rockerDelta));
  const stableSpeed =
    B.stableSpeed *
    length ** 1.5 *
    (1 + 0.9 * stiff) *
    (1 - 0.03 * s.mount) *
    (1 - 0.1 * rockerDelta);

  return {
    snowFriction: wax,
    powderFriction: wax + B.powderExtraFriction / float ** 1.2,
    powderDrag: B.powderDrag / float,
    carveRate: B.carveRate * radius ** -0.5 * length ** -0.4,
    hardGrip,
    powderGrip: Math.min(1.3, Math.max(0.6, Math.sqrt(float))),
    skidDecel: B.skidDecel * (1 + 0.3 * stiff),
    stableSpeed,
    chatter: B.chatter,
    stiffness: Math.max(0, stiff) / (1 - flexUnit(REF.flex)),
    maxSpeed: Math.min(B.maxSpeed, stableSpeed + B.maxSpeedMargin),
    turnRate: length ** -0.8 * radius ** -0.3 * (1 + 0.3 * rockerDelta) * (1 + 0.03 * s.mount),
    pivotRate: length ** -1 * waist ** -0.2 * (1 + 0.5 * rockerDelta) * (1 + 0.04 * s.mount),
    edgeRate: waist ** -0.8 * (1 + 0.15 * stiff),
  };
}

export const DEFAULT_HANDLING: SkiHandling = skiHandling(DEFAULT_SETUP);

/** Visible ski shape for the model (metres). */
export interface SkiDimensions {
  length: number;
  tipWidth: number;
  waistWidth: number;
  tailWidth: number;
  /** Boot centre to the tail end: a little behind the middle of the ski. */
  tail: number;
  tipRise: number;
  tailRise: number;
  /** Where the tip rocker starts (fraction of the length from the tail). */
  rockerStart: number;
}

export function skiDimensions(s: SkiSetup): SkiDimensions {
  const length = s.length / 100;
  const waist = s.waist / 1000;
  // Sidecut depth from the radius: a circle through the contact points and the waist,
  // depth ≈ c²/(8R) for contact length c. The tip is a bit wider than the tail.
  const contact = 0.8 * length;
  const depth = (contact * contact) / (8 * s.radius);
  const rocker = PROFILE_ROCKER[s.profile];
  return {
    length,
    waistWidth: waist,
    tipWidth: waist + 2.3 * depth,
    tailWidth: waist + 1.7 * depth,
    // Recommended line ~3.5% of the length behind centre.
    tail: length * 0.465 + s.mount / 100,
    tipRise: 0.05 + 0.05 * rocker,
    tailRise: 0.02 + 0.045 * rocker,
    rockerStart: 0.82 - 0.14 * rocker,
  };
}

export const SETUP_KEY = 'ski-sim.ski-setup';

const oneOf = <T extends string>(value: unknown, options: Record<T, unknown>, fallback: T): T =>
  typeof value === 'string' && value in options ? (value as T) : fallback;

/** A valid setup from anything (missing or out-of-range fields fall back / clamp). */
export function parseSetup(raw: unknown): SkiSetup {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (key: keyof typeof SETUP_RANGES) => {
    const v = o[key];
    const { min, max } = SETUP_RANGES[key];
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.min(max, Math.max(min, v))
      : DEFAULT_SETUP[key];
  };
  return {
    length: num('length'),
    waist: num('waist'),
    radius: num('radius'),
    flex: num('flex'),
    profile: oneOf(o.profile, PROFILE_ROCKER, DEFAULT_SETUP.profile),
    wax: oneOf(o.wax, WAX_FRICTION, DEFAULT_SETUP.wax),
    tune: oneOf(o.tune, TUNE_GRIP, DEFAULT_SETUP.tune),
    mount: num('mount'),
  };
}

export function loadSetup(storage: Pick<Storage, 'getItem'>): SkiSetup {
  try {
    const raw = storage.getItem(SETUP_KEY);
    return raw ? parseSetup(JSON.parse(raw)) : { ...DEFAULT_SETUP };
  } catch {
    return { ...DEFAULT_SETUP };
  }
}

export function saveSetup(storage: Pick<Storage, 'setItem'>, setup: SkiSetup): void {
  storage.setItem(SETUP_KEY, JSON.stringify(setup));
}
