/**
 * Picks a render pixel ratio that keeps frame times near the display's refresh.
 * Steps down quickly when frames are slow and back up cautiously when there's headroom;
 * a ratio that proved too slow is avoided for a while so it doesn't oscillate.
 */
export class AdaptiveResolution {
  ratio: number;

  private frames = 0;
  private elapsed = 0;
  private ceiling: number;
  private ceilingUntil = 0;
  private clock = 0;

  constructor(
    private readonly max: number,
    private readonly min = Math.min(1, max),
    private readonly step = 0.25,
    /** Slower than this average frame time (ms) steps resolution down. */
    private readonly slowMs = 22,
    /** Faster than this steps it back up (vsync at 60 Hz is ~16.7 ms). */
    private readonly fastMs = 17.5,
    private readonly windowMs = 1000,
    private readonly holdMs = 20_000,
  ) {
    this.ratio = max;
    this.ceiling = max;
  }

  /** Feed one frame's duration (ms). Returns true when `ratio` changed. */
  sample(frameMs: number): boolean {
    this.frames++;
    this.elapsed += frameMs;
    this.clock += frameMs;
    if (this.elapsed < this.windowMs) return false;

    const average = this.elapsed / this.frames;
    this.frames = 0;
    this.elapsed = 0;
    if (this.clock > this.ceilingUntil) this.ceiling = this.max;

    if (average > this.slowMs && this.ratio > this.min) {
      // This ratio is too expensive; don't climb back to it for a while.
      this.ceiling = this.ratio - this.step;
      this.ceilingUntil = this.clock + this.holdMs;
      this.ratio = Math.max(this.min, this.ratio - this.step);
      return true;
    }
    if (average < this.fastMs && this.ratio < this.ceiling) {
      this.ratio = Math.min(this.ceiling, this.ratio + this.step);
      return true;
    }
    return false;
  }
}
