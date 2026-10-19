/** Player camera preferences, adjusted in the settings menu (O) and kept in localStorage. */
export interface CameraSettings {
  /** Vertical field of view in first person (degrees): wider, as you're the camera. */
  fovFirst: number;
  /** Vertical field of view in third person (degrees). */
  fovThird: number;
  /** Extra field of view at full speed when skiing or sledding (degrees; 0 = off). */
  speedFov: number;
  /** Mouse look sensitivity (× the default). */
  sensitivity: number;
  invertY: boolean;
  /** Third-person camera distance (× each mode's default). */
  chaseDistance: number;
}

export const DEFAULT_CAMERA: Readonly<CameraSettings> = {
  fovFirst: 85,
  fovThird: 70,
  speedFov: 10,
  sensitivity: 1,
  invertY: false,
  chaseDistance: 1,
};

type NumericKey = Exclude<keyof CameraSettings, 'invertY'>;

export const CAMERA_RANGES: Record<NumericKey, { min: number; max: number; step: number }> = {
  fovFirst: { min: 50, max: 120, step: 1 },
  fovThird: { min: 50, max: 110, step: 1 },
  speedFov: { min: 0, max: 20, step: 1 },
  sensitivity: { min: 0.2, max: 3, step: 0.05 },
  chaseDistance: { min: 0.6, max: 2.5, step: 0.05 },
};

const KEY = 'ski-sim.camera';

/** The live settings every controller reads (mutated in place by the menu). */
export const cameraSettings: CameraSettings = { ...DEFAULT_CAMERA };

/** Keep numbers within range and fall back to defaults for anything missing or invalid. */
export function sanitizeCamera(raw: unknown): CameraSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CAMERA };
  for (const key of Object.keys(CAMERA_RANGES) as NumericKey[]) {
    const v = r[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      const { min, max } = CAMERA_RANGES[key];
      out[key] = Math.min(max, Math.max(min, v));
    }
  }
  if (typeof r.invertY === 'boolean') out.invertY = r.invertY;
  return out;
}

export function loadCamera(storage: Pick<Storage, 'getItem'>): CameraSettings {
  try {
    return Object.assign(
      cameraSettings,
      sanitizeCamera(JSON.parse(storage.getItem(KEY) ?? 'null')),
    );
  } catch {
    return Object.assign(cameraSettings, DEFAULT_CAMERA);
  }
}

export function saveCamera(storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(KEY, JSON.stringify(cameraSettings));
}
