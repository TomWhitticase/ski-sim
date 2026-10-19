import type { EngineSound, SoundLevels } from './levels';

const SMOOTHING = 0.08; // s: time constant for level changes (avoids zipper noise)

/**
 * Procedural sound: everything is shaped noise, so there are no audio files to load.
 * - wind: low-passed noise, opening up with speed
 * - glide: band-passed hiss of skis running on snow
 * - skid: brighter, gritty scrape, gated by a fast random flutter
 * - thump: a short low burst on landing
 * - engine: a snowmobile's twin two-stroke, sawtooth harmonics at the firing frequency
 *   through a low-pass, with a warble at idle and exhaust rasp from band-passed noise
 * Browsers only allow audio after a user gesture, so start() is called from a click.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private wind!: { gain: GainNode; filter: BiquadFilterNode };
  private glide!: { gain: GainNode; filter: BiquadFilterNode };
  private skid!: { gain: GainNode; filter: BiquadFilterNode };
  private noise!: AudioBuffer;
  private hum!: GainNode;
  private engine!: {
    gain: GainNode;
    filter: BiquadFilterNode;
    oscillators: { osc: OscillatorNode; ratio: number }[];
    warble: OscillatorNode;
    warbleDepth: GainNode;
    rasp: BiquadFilterNode;
  };
  private muted: boolean;

  constructor(muted = false) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Create the audio graph (must run inside a user gesture). Safe to call repeatedly. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(ctx.destination);

    // Two seconds of white noise, looped, feeds every voice.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;

    const voice = (type: BiquadFilterType, frequency: number, q: number) => {
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(this.master);
      return { gain, filter };
    };
    this.wind = voice('lowpass', 300, 0.7);
    this.glide = voice('bandpass', 1200, 0.9);
    this.skid = voice('highpass', 1800, 0.6);

    // Grit: a fast flutter on its own gain stage ahead of the skid level, so the skid
    // is still silent at level 0.
    const grit = ctx.createGain();
    grit.gain.value = 0.75;
    this.skid.filter.disconnect();
    this.skid.filter.connect(grit).connect(this.skid.gain);
    const flutter = ctx.createOscillator();
    flutter.type = 'sawtooth';
    flutter.frequency.value = 23;
    const depth = ctx.createGain();
    depth.gain.value = 0.25;
    flutter.connect(depth).connect(grit.gain);
    flutter.start();
    source.start();

    // Lift drive: low motor harmonics, a little noisy, through a low-pass.
    this.hum = ctx.createGain();
    this.hum.gain.value = 0;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 260;
    humFilter.connect(this.hum).connect(this.master);
    for (const [freq, level] of [
      [49, 0.6],
      [98, 0.35],
      [147, 0.15],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(humFilter);
      osc.start();
    }

    // Snowmobile engine: firing-frequency sawtooth plus a sub-harmonic and the 2nd
    // harmonic (a little detuned, for the beat between two cylinders), through a
    // low-pass. The warble modulates the level at idle; the rasp is noise around the
    // exhaust note.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 400;
    engineFilter.Q.value = 2;
    const pulse = ctx.createGain(); // the warble swings this around 1
    engineFilter.connect(pulse).connect(engineGain).connect(this.master);
    const oscillators = (
      [
        [1, 'sawtooth', 0.5],
        [0.5, 'square', 0.25],
        [2.01, 'sawtooth', 0.18],
      ] as const
    ).map(([ratio, type, level]) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 50 * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(engineFilter);
      osc.start();
      return { osc, ratio };
    });
    const warble = ctx.createOscillator();
    warble.type = 'square';
    warble.frequency.value = 12;
    const warbleDepth = ctx.createGain();
    warbleDepth.gain.value = 0;
    warble.connect(warbleDepth).connect(pulse.gain);
    warble.start();
    const rasp = ctx.createBiquadFilter();
    rasp.type = 'bandpass';
    rasp.Q.value = 1.2;
    const raspGain = ctx.createGain();
    raspGain.gain.value = 0.35;
    source.connect(rasp).connect(raspGain).connect(engineFilter);
    this.engine = {
      gain: engineGain,
      filter: engineFilter,
      oscillators,
      warble,
      warbleDepth,
      rasp,
    };
  }

  /** The snowmobile's engine (level 0 when you're not on one). */
  setEngine(engine: EngineSound): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const e = this.engine;
    e.gain.gain.setTargetAtTime(engine.level, t, SMOOTHING);
    e.filter.frequency.setTargetAtTime(engine.cutoff, t, SMOOTHING);
    for (const { osc, ratio } of e.oscillators) {
      osc.frequency.setTargetAtTime(engine.frequency * ratio, t, 0.04);
    }
    e.warble.frequency.setTargetAtTime(engine.frequency / 4, t, 0.04);
    e.warbleDepth.gain.setTargetAtTime(engine.warble, t, SMOOTHING);
    e.rasp.frequency.setTargetAtTime(engine.frequency * 3, t, 0.04);
  }

  setLiftHum(level: number): void {
    if (this.ctx) this.hum.gain.setTargetAtTime(level, this.ctx.currentTime, 0.15);
  }

  /** A short burst of the noise buffer through a filter, with a fast decay. */
  private burst(
    type: BiquadFilterType,
    frequency: number,
    q: number,
    peak: number,
    decay: number,
    delay = 0,
  ): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 0.85 + Math.random() * 0.3;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(t, Math.random() * 1.5);
    source.stop(t + decay + 0.05);
  }

  /** A boot-and-ski step in snow: a soft thud with a crunchy, squeaky top. */
  step(): void {
    if (!this.ctx) return;
    const v = 0.8 + Math.random() * 0.4;
    this.burst('lowpass', 220, 0.7, 0.35 * v, 0.12);
    this.burst('bandpass', 1300 + Math.random() * 500, 1.2, 0.22 * v, 0.16, 0.01);
    this.burst('bandpass', 3200, 2, 0.06 * v, 0.09, 0.03); // snow squeak
  }

  /** Both poles planting: a sharp tick of the tips, then a short scrape. */
  polePlant(): void {
    if (!this.ctx) return;
    this.burst('bandpass', 2600, 4, 0.18, 0.04);
    this.burst('bandpass', 2300, 4, 0.14, 0.04, 0.025); // second pole a moment later
    this.burst('highpass', 1500, 0.7, 0.08, 0.22, 0.03);
  }

  /** A carrier's grip rolling over a tower's sheave train: a quick run of clacks. */
  clack(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const t = t0 + i * 0.075;
      const source = ctx.createBufferSource();
      source.buffer = this.noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 650 + i * 40;
      filter.Q.value = 3;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.5, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      source.connect(filter).connect(gain).connect(this.master);
      source.start(t, Math.random());
      source.stop(t + 0.06);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  update(levels: SoundLevels): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.wind.gain.gain.setTargetAtTime(levels.wind, t, SMOOTHING);
    this.wind.filter.frequency.setTargetAtTime(250 + levels.wind * 2200, t, SMOOTHING);
    this.glide.gain.gain.setTargetAtTime(levels.glide, t, SMOOTHING);
    this.glide.filter.frequency.setTargetAtTime(levels.glidePitch, t, SMOOTHING);
    this.skid.gain.gain.setTargetAtTime(levels.skid, t, SMOOTHING * 0.6);
  }

  /** Landing thump; `impact` in m/s of vertical speed. */
  /** The map teleport's camera cut (GTA-style): a filtered noise swoosh and a low hit.
   *  `up` sweeps the swoosh upward (leaving), otherwise downward (arriving). */
  whoosh(up: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(up ? 400 : 2600, t);
    filter.frequency.exponentialRampToValueAtTime(up ? 2600 : 400, t + 0.3);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(t, Math.random());
    source.stop(t + 0.4);
    const hit = ctx.createOscillator();
    hit.frequency.setValueAtTime(90, t);
    hit.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const hitGain = ctx.createGain();
    hitGain.gain.setValueAtTime(0.4, t);
    hitGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    hit.connect(hitGain).connect(this.master);
    hit.start(t);
    hit.stop(t + 0.26);
  }

  thump(impact: number): void {
    const ctx = this.ctx;
    if (!ctx || impact < 1.5) return;
    const t = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 180;
    const gain = ctx.createGain();
    const peak = Math.min(1, impact / 8);
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(t, Math.random());
    source.stop(t + 0.4);
  }
}
