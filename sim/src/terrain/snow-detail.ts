import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping } from 'three/webgpu';

/**
 * A small tileable "snow surface" normal map: wind ripples and soft bumps, used to add
 * close-range detail below the 4 m lidar resolution. Built from sine waves with integer
 * frequencies, so it tiles seamlessly. RG = surface slope (east, south) * 0.5 + 0.5.
 */
export function createSnowDetailTexture(size = 256, seed = 7): DataTexture {
  let s = seed;
  const random = () => (s = (s * 16807) % 2147483647) / 2147483647;

  // Random waves: integer frequencies keep the pattern periodic over one tile.
  const waves = Array.from({ length: 24 }, (_, i) => {
    const f = 1 + Math.floor(random() * (i < 8 ? 4 : 14));
    const angle = random() * Math.PI * 2;
    return {
      fx: Math.round(Math.cos(angle) * f),
      fy: Math.round(Math.sin(angle) * f),
      phase: random() * Math.PI * 2,
      amplitude: 1 / (1 + f),
    };
  });

  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const t = (2 * Math.PI * (w.fx * x + w.fy * y)) / size + w.phase;
        const c = Math.cos(t) * w.amplitude;
        dx += c * w.fx;
        dy += c * w.fy;
      }
      const p = (y * size + x) * 4;
      pixels[p] = Math.max(0, Math.min(255, (dx * 0.08 * 0.5 + 0.5) * 255));
      pixels[p + 1] = Math.max(0, Math.min(255, (dy * 0.08 * 0.5 + 0.5) * 255));
      pixels[p + 2] = 255;
      pixels[p + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
