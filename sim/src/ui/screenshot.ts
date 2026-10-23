/**
 * F2 screenshots: the rendered scene saved as a PNG, named so the shot can be found
 * again (`?resort=<id>&at=<lat,lon,alt>&heading=&pitch=` reproduces the view).
 */

export interface ShotPlace {
  resort: string;
  lat: number;
  lon: number;
  altitude: number;
  heading: number;
  pitch: number;
}

/** e.g. `ski-sim_les-3-vallees_45.29512,6.57749,2256_h108_p-5_2026-10-24_10-31-02.png`. */
export function screenshotName(place: ShotPlace, when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_` +
    `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  const at = `${place.lat.toFixed(5)},${place.lon.toFixed(5)},${Math.round(place.altitude)}`;
  const view = `h${Math.round(place.heading)}_p${Math.round(place.pitch)}`;
  return `ski-sim_${place.resort}_${at}_${view}_${stamp}.png`;
}

/**
 * Save the canvas as a PNG. Call it straight after a render, in the same task: a WebGPU
 * canvas is only readable until the frame is presented.
 */
export function saveCanvas(canvas: HTMLCanvasElement, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Screenshot failed: the canvas gave no image'));
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
      resolve();
    }, 'image/png');
  });
}
