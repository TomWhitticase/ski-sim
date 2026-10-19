import { describe, expect, it } from 'vitest';

import type { Terminal } from '../features/types';
import { createTerminals, GROUND_GAP } from './terminals';

const terminal = (kind: Terminal['kind'], extra: Partial<Terminal> = {}): Terminal => ({
  end: 'bottom',
  kind,
  detachable: kind !== 'drag',
  east: 0,
  north: 0,
  dir: [0, 1],
  across: [1, 0],
  gauge: 6,
  length: 20,
  back: 5,
  width: 13,
  load: 9,
  unload: 11,
  pad: 2000,
  ramp: null,
  roofTop: 6.2,
  hut: kind === 'chair' || kind === 'drag',
  entrance: 'side',
  walk: 5,
  ...extra,
});

describe('createTerminals', () => {
  it('never puts a face level with the snow on the pad (no z-fighting)', () => {
    const terminals = [
      terminal('chair'),
      terminal('chair', { detachable: false, end: 'top', entrance: 'ramp' }),
      terminal('gondola'),
      terminal('gondola', { entrance: 'back' }),
      terminal('cabin'),
      terminal('drag'),
    ].map((t) => ({ terminal: t, rail: 4 }));
    const { mesh } = createTerminals(terminals, () => 2000);
    const y = mesh.geometry.getAttribute('position');
    for (let i = 0; i < y.count; i++) {
      expect(Math.abs(y.getY(i) - 2000)).toBeGreaterThanOrEqual(GROUND_GAP - 1e-4);
    }
  });
});
