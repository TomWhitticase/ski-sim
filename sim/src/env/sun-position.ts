// Low-precision solar position (accurate to ~0.1°), after the Astronomical Almanac
// algorithm. Good enough to light a resort for a given date and time.

const RAD = Math.PI / 180;

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
}

export function sunPosition(date: Date, lat: number, lon: number): SunPosition {
  const d = date.getTime() / 86_400_000 + 2_440_587.5 - 2_451_545.0; // days since J2000.0

  const meanAnomaly = (357.529 + 0.98560028 * d) * RAD;
  const meanLongitude = 280.459 + 0.98564736 * d;
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = (23.439 - 0.00000036 * d) * RAD;

  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  const gmstDegrees = (18.697374558 + 24.06570982441908 * d) * 15;
  const hourAngle = (gmstDegrees + lon) * RAD - rightAscension;

  const phi = lat * RAD;
  const elevation = Math.asin(
    Math.sin(phi) * Math.sin(declination) +
      Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle),
  );
  const azimuth = Math.atan2(
    -Math.sin(hourAngle) * Math.cos(declination),
    Math.sin(declination) * Math.cos(phi) -
      Math.cos(declination) * Math.sin(phi) * Math.cos(hourAngle),
  );

  return {
    azimuth: (((azimuth / RAD) % 360) + 360) % 360,
    elevation: elevation / RAD,
  };
}
