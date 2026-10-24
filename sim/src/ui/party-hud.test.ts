import { describe, expect, it } from 'vitest';

import { activity, distanceLabel } from './party-hud';

describe('party card', () => {
  it('says how far away a friend is', () => {
    expect(distanceLabel(842)).toBe('840 m');
    expect(distanceLabel(1234)).toBe('1.2 km');
  });

  it('says what a friend is doing', () => {
    expect(activity('ski', 'Cascades')).toBe('skiing Cascades');
    expect(activity('ski', null)).toBe('skiing');
    expect(activity('ride', 'Cascades')).toBe('on a lift');
    expect(activity('glide', null)).toBe('paragliding');
  });
});
