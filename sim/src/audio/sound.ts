import type { SoundLevels } from './levels';

const SMOOTHING = 0.08; // s: time constant for level changes (avoids zipper noise)

/**
 * Procedural sound: everything is shaped noise, so there are no audio files to load.
 * - wind: low-passed noise, opening up with speed
 * - glide: band-passed hiss of skis running on snow
 * - skid: brighter, gritty scrape, gated by a fast random flutter
 * - thump: a short low burst on landing
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
  }

  setLiftHum(level: number): void {
    if (this.ctx) this.hum.gain.setTargetAtTime(level, this.ctx.currentTime, 0.15);
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
