/**
 * Aircraft you can fly, as data: one row per type, so another plane or helicopter is a new
 * row (and a model), not new physics. Figures are the manufacturers' published ones where
 * there are any; the aerodynamic coefficients are fitted to them (`plane-physics.test.ts`,
 * `heli-physics.test.ts` check the fit).
 */

export interface PlaneType {
  kind: 'plane';
  id: string;
  name: string;
  /** Overall span, length and height on its wheels (m). */
  span: number;
  length: number;
  height: number;
  wingArea: number;
  /** Operating mass (pilot, some fuel and load) and the maximum take-off mass (kg). */
  mass: number;
  maxMass: number;
  engine: {
    /** Shaft power it's flat-rated to (W), and its thermodynamic rating (W): the rated power holds until the thin air drops the thermodynamic one below it. */
    rated: number;
    thermodynamic: number;
    /** Static thrust at full power at sea level (N) and the propeller's best efficiency. */
    staticThrust: number;
    propEfficiency: number;
    /** Share of full power at idle; reverse thrust (beta) as a share of static thrust. */
    idle: number;
    reverse: number;
    /** Propeller: diameter (m), blades and its governed revs (rpm). */
    propDiameter: number;
    blades: number;
    rpm: number;
  };
  aero: {
    /** Lift at zero angle of attack and the lift slope (per rad), clean. */
    cl0: number;
    clAlpha: number;
    /** Per flap setting (up, take-off, landing): extra lift, maximum lift, extra drag. */
    flapLift: readonly number[];
    clMax: readonly number[];
    flapDrag: readonly number[];
    /** Parasite drag (fixed gear, struts) and induced drag factor 1/(π·e·AR). */
    cd0: number;
    k: number;
    /** Past the stall, lift sags to this share of its maximum (a gentle break). */
    stallLift: number;
    /** Side force per radian of sideslip (fuselage and fin). */
    sideForce: number;
  };
  /** Angle of attack the trimmed aircraft flies at hands off (rad). */
  trimAlpha: number;
  /** Never-exceed speed (m/s, indicated). */
  vne: number;
  /** Body points (m, from the main gear's contact; level attitude): propeller hub (y, z) and wing height. */
  geometry: { propHub: [number, number]; wingY: number };
  ground: {
    /** Main gear to tailwheel (m), and the tail-down (three-point) attitude (rad). */
    tailArm: number;
    threePoint: number;
    /** Track of the main gear (m). */
    track: number;
    /** Rolling resistance: wheels on a cleared runway, skis on groomed snow, skis in powder. */
    rollingPaved: number;
    rollingGroomed: number;
    rollingPowder: number;
    /** Wheel brakes on tarmac; the skis' drag brakes on snow (fraction of load). */
    brakePaved: number;
    brakeSnow: number;
    /** Hardest touchdown the gear takes (m/s down). */
    maxSink: number;
  };
}

export interface HeliType {
  kind: 'heli';
  id: string;
  name: string;
  /** Main rotor radius (m), blades and governed revs (rpm). */
  rotorRadius: number;
  blades: number;
  rpm: number;
  /** Tail rotor radius (m), blades and revs. */
  tailRadius: number;
  tailBlades: number;
  tailRpm: number;
  /** Length with the rotors turning, height to the top of the rotor head (m). */
  length: number;
  height: number;
  mass: number;
  maxMass: number;
  engine: {
    /** Take-off power at sea level (W), and the gearbox's limit (W). */
    takeoff: number;
    transmission: number;
  };
  /** Induced-power factor (1 / figure of merit, with tip losses), profile power at sea level (W), tail rotor's share. */
  inducedFactor: number;
  profilePower: number;
  tailShare: number;
  /** Share of excess power that becomes climb (the rest goes in losses a hover doesn't show). */
  climbEfficiency: number;
  /** Fuselage flat-plate drag area (m²) and vertical drag area (m²). */
  dragArea: number;
  verticalDragArea: number;
  /** Fastest cruise (m/s) and never-exceed speed (m/s). */
  cruise: number;
  vne: number;
  ground: {
    /** Skids: half the track, and fore / aft reach from the centre (m). */
    skidHalf: number;
    skidFront: number;
    skidBack: number;
    /** Steepest slope the skids hold on (rad); past `tipSlope` it rolls over. */
    maxSlope: number;
    tipSlope: number;
    /** Rotor hub above the skids (m). */
    hub: number;
    /** Hardest touchdown the skids take (m/s down), and the fastest slide-on (m/s). */
    maxSink: number;
    maxSlide: number;
  };
}

export type AircraftType = PlaneType | HeliType;

const KT = 0.514444;

/**
 * Pilatus PC-6/B2-H4 Turbo Porter on wheel-skis, the altiport and glacier STOL plane:
 * 15.87 m span, 10.90 m long, 3.20 m high, 30.15 m² of wing, 2,800 kg MTOW, a PT6A-27
 * flat-rated to 550 shp (410 kW, 680 shp thermodynamic) on a 2.67 m three-blade
 * reversible propeller. Stalls at 58 KEAS clean and 52 with full flap at MTOW; take-off
 * ground roll 197 m (440 m to 15 m), landing roll 127 m with reverse, climbs at 5.1 m/s
 * (Pilatus fact sheet and brochure).
 */
export const PC6: PlaneType = {
  kind: 'plane',
  id: 'pc6',
  name: 'Pilatus PC-6 Porter',
  span: 15.87,
  length: 10.9,
  height: 3.2,
  wingArea: 30.15,
  mass: 2200,
  maxMass: 2800,
  engine: {
    rated: 410_000,
    thermodynamic: 507_000,
    staticThrust: 9_800,
    propEfficiency: 0.68,
    idle: 0.06,
    reverse: 0.35,
    propDiameter: 2.67,
    blades: 3,
    rpm: 2200,
  },
  aero: {
    cl0: 0.3,
    clAlpha: 5.0,
    flapLift: [0, 0.3, 0.55],
    clMax: [1.68, 1.88, 2.09],
    flapDrag: [0, 0.025, 0.07],
    cd0: 0.065,
    k: 0.06,
    stallLift: 0.72,
    sideForce: 1.2,
  },
  trimAlpha: (3 * Math.PI) / 180,
  vne: 151 * KT,
  geometry: { propHub: [1.72, -3.3], wingY: 2.85 },
  ground: {
    tailArm: 7.2,
    threePoint: (10 * Math.PI) / 180,
    track: 3.0,
    rollingPaved: 0.03,
    rollingGroomed: 0.05,
    rollingPowder: 0.15,
    brakePaved: 0.4,
    brakeSnow: 0.15,
    maxSink: 4.5,
  },
};

/**
 * Airbus H125 (AS350 B3e Écureuil), the Alpine workhorse for heliski and rescue: 10.69 m
 * three-blade main rotor at 390 rpm, a conventional two-blade tail rotor (1.86 m) on the
 * left, 12.94 m long with the rotors turning, 2,250 kg MTOW, an Arriel 2D (~710 kW
 * take-off), 245 km/h fast cruise, 287 km/h VNE (Airbus Helicopters).
 */
export const H125: HeliType = {
  kind: 'heli',
  id: 'h125',
  name: 'Airbus H125',
  rotorRadius: 10.69 / 2,
  blades: 3,
  rpm: 390,
  tailRadius: 1.86 / 2,
  tailBlades: 2,
  tailRpm: 2086,
  length: 12.94,
  height: 3.34,
  mass: 1900,
  maxMass: 2250,
  engine: { takeoff: 710_000, transmission: 590_000 },
  inducedFactor: 1.6,
  profilePower: 60_000,
  tailShare: 0.1,
  climbEfficiency: 0.55,
  dragArea: 1.5,
  verticalDragArea: 6,
  cruise: 245 / 3.6,
  vne: 287 / 3.6,
  ground: {
    skidHalf: 1.1,
    skidFront: 1.5,
    skidBack: 1.3,
    maxSlope: (12 * Math.PI) / 180,
    tipSlope: (20 * Math.PI) / 180,
    hub: 3.05,
    maxSink: 3.5,
    maxSlide: 12,
  },
};

export const AIRCRAFT_TYPES: readonly AircraftType[] = [PC6, H125];

/** A type by id (the codec sends its index in this table). */
export function aircraftType(id: string): AircraftType | undefined {
  return AIRCRAFT_TYPES.find((t) => t.id === id);
}

/** Sea-level standard density (kg/m³). */
export const RHO0 = 1.225;

/**
 * Air density (kg/m³) at `altitude` (m): ISA pressure for the height, and the weather's
 * temperature there if there is one (°C; a warm day is "high density altitude"), else
 * ISA's (15 °C at sea level, -6.5 °C/km).
 */
export function airDensity(altitude: number, temperature: number | null = null): number {
  const h = Math.max(-500, Math.min(11_000, altitude));
  const pressure = 101_325 * (1 - 2.25577e-5 * h) ** 5.25588;
  const t = temperature ?? 15 - 0.0065 * h;
  return pressure / (287.05 * (t + 273.15));
}
