import { describe, expect, it } from 'vitest';

import { headingOf, LocalFrame } from './local-frame';

const PROJECTION =
  '+proj=tmerc +lat_0=45.2981 +lon_0=6.5803 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs';

describe('LocalFrame', () => {
  const frame = new LocalFrame(PROJECTION);

  it('maps the origin to the resort origin', () => {
    const { lat, lon } = frame.toLatLon(0, 0);
    expect(lat).toBeCloseTo(45.2981, 9);
    expect(lon).toBeCloseTo(6.5803, 9);
  });

  it('agrees with the pipeline projection (Aiguille de Péclet)', () => {
    // Reference from pipeline LocalFrame.to_local(6.6240193, 45.2813645).
    const { east, north } = frame.toLocal(45.2813645, 6.6240193);
    expect(east).toBeCloseTo(3430.2156, 3);
    expect(north).toBeCloseTo(-1859.0107, 3);
    const back = frame.toLatLon(east, north);
    expect(back.lat).toBeCloseTo(45.2813645, 9);
    expect(back.lon).toBeCloseTo(6.6240193, 9);
  });
});

describe('headingOf', () => {
  it('measures clockwise from north (world -z)', () => {
    expect(headingOf(0, -1)).toBeCloseTo(0);
    expect(headingOf(1, 0)).toBeCloseTo(90);
    expect(headingOf(0, 1)).toBeCloseTo(180);
    expect(headingOf(-1, 0)).toBeCloseTo(270);
  });
});
