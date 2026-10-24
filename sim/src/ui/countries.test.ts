import { describe, expect, it } from 'vitest';

import { countriesLabel, countriesOf, flag } from './main-menu';

describe('countries', () => {
  it('makes a flag from two regional-indicator letters', () => {
    expect(flag('fr')).toBe('🇫🇷');
    expect(flag('CH')).toBe('🇨🇭');
    expect(flag('')).toBe('');
  });

  it('lists every country an area spans, main first, falling back to `country`', () => {
    expect(countriesOf({ country: 'FR', countries: ['FR', 'CH'] })).toEqual(['FR', 'CH']);
    expect(countriesOf({ country: 'AT' })).toEqual(['AT']);
    expect(countriesLabel({ country: 'FR', countries: ['FR', 'CH'] })).toBe(
      '🇫🇷 🇨🇭 France · Switzerland',
    );
  });
});
