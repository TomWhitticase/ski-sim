/**
 * Rendering budgets. Desktop keeps the full settings; phones and tablets (touch mode at
 * start-up) get a lighter set for their GPUs and battery: a lower render scale that may
 * drop further, smaller shadow maps over fewer cascades, trees and terrain detail pulled
 * in closer, and no MSAA.
 */
export interface Quality {
  /** Highest render pixel ratio (the adaptive resolution starts here)... */
  maxPixelRatio: number;
  /** ...and the lowest it may drop to. */
  minPixelRatio: number;
  antialias: boolean;
  /** Shadow map size per cascade (px). */
  shadowMapSize: number;
  shadowCascades: number;
  /** How far shadows reach (m). */
  shadowDistance: number;
  /** × each tree detail level's distance. */
  forestDistance: number;
  /** × each terrain layer's LOD distance (lower: coarser chunks sooner). */
  terrainLod: number;
  /** Close-up procedural terrain detail (see `config.TERRAIN_DETAIL`). */
  terrainDetail: TerrainDetailTier;
}

/**
 * How much of the procedural close-up terrain detail this device runs. Desktop gets the
 * full combo; phones get fewer fBm octaves (the sensitive, GPU-bound cost), a shorter fade
 * and less strength. Set `enabled` false for none.
 */
export interface TerrainDetailTier {
  enabled: boolean;
  /** × `TERRAIN_DETAIL.strength` (the detail-normal ease). */
  strength: number;
  /** Max fBm octaves any one detail noise uses (the base counts are capped to this). */
  octaves: number;
  /** × every detail fade distance (phones pull the detail in closer). */
  fadeScale: number;
}

export const DESKTOP_QUALITY: Readonly<Quality> = {
  maxPixelRatio: 2,
  minPixelRatio: 1,
  antialias: true,
  shadowMapSize: 2048,
  shadowCascades: 3,
  shadowDistance: 30_000,
  forestDistance: 1,
  terrainLod: 1,
  terrainDetail: { enabled: true, strength: 1, octaves: 4, fadeScale: 1 },
};

export const MOBILE_QUALITY: Readonly<Quality> = {
  maxPixelRatio: 1.5,
  minPixelRatio: 0.75,
  antialias: false,
  shadowMapSize: 1024,
  shadowCascades: 2,
  shadowDistance: 12_000,
  forestDistance: 0.6,
  terrainLod: 0.6,
  terrainDetail: { enabled: true, strength: 0.6, octaves: 2, fadeScale: 0.6 },
};

/** The budget for this device, given its pixel ratio. */
export function qualityFor(mobile: boolean, devicePixelRatio: number): Quality {
  const q = { ...(mobile ? MOBILE_QUALITY : DESKTOP_QUALITY) };
  q.maxPixelRatio = Math.min(devicePixelRatio || 1, q.maxPixelRatio);
  q.minPixelRatio = Math.min(q.minPixelRatio, q.maxPixelRatio);
  return q;
}
