import proj4, { type Converter } from 'proj4';

/**
 * Converts between the resort's local ENU frame and WGS84, using the same projection
 * the pipeline resampled data onto (see pipeline/frame.py).
 *
 * World (three.js) axes: x = east, y = up (metres above sea level), z = -north.
 */
export class LocalFrame {
  private readonly converter: Converter;

  constructor(projection: string) {
    this.converter = proj4('WGS84', projection);
  }

  toLatLon(east: number, north: number): { lat: number; lon: number } {
    const [lon, lat] = this.converter.inverse([east, north]) as [number, number];
    return { lat, lon };
  }

  toLocal(lat: number, lon: number): { east: number; north: number } {
    const [east, north] = this.converter.forward([lon, lat]) as [number, number];
    return { east, north };
  }
}

export function worldToEnu(x: number, z: number): { east: number; north: number } {
  return { east: x, north: -z };
}

/** Compass heading (degrees clockwise from north) of a world-space horizontal direction. */
export function headingOf(dirX: number, dirZ: number): number {
  const deg = (Math.atan2(dirX, -dirZ) * 180) / Math.PI;
  return (deg + 360) % 360;
}
