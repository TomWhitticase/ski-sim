// Types for station-checks.mjs, so the sim's unit tests can check it against the sim.
export interface CarrierEnvelope {
  kind: 'chair' | 'gondola' | 'cabin';
  depth: number;
  halfLength: number;
  halfWidth: number;
}
export const CARRIER_MARGIN: Record<'chair' | 'gondola' | 'cabin', number>;
export function carrierEnvelope(lift: {
  type: string;
  occupancy?: number | null;
}): CarrierEnvelope | null;
export function ropeAlong(
  a: { east: number; north: number; top: number; exit?: [number, number] },
  b: { east: number; north: number; top: number; exit?: [number, number] },
  d: number,
  catenary: number | null | undefined,
): number;
export function carrierShortfalls(
  lift: unknown,
  ground: (east: number, north: number) => number | null,
): { along: number; side: number; shortfall: number; outside: number; end: 'bottom' | 'top' }[];
export function staticChecks(lift: unknown, terminal: unknown, context?: unknown): string[];
