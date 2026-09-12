import * as THREE from 'three';

/**
 * Procedural soft contact-shadow texture: a rounded rectangle whose alpha falls off smoothly toward
 * the edges. Generated in memory, so no image asset has to be served.
 */
export function createBlobShadowTexture(size = 256, falloff = 0.3): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const half = size / 2;
  const inner = half * (1 - falloff);
  const radius = inner * 0.55;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = Math.abs(x + 0.5 - half);
      const py = Math.abs(y + 0.5 - half);
      // signed distance to a rounded rectangle of half-size `inner`
      const qx = px - (inner - radius);
      const qy = py - (inner - radius);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const insideD = Math.min(Math.max(qx, qy), 0);
      const d = outside + insideD - radius;
      const t = THREE.MathUtils.clamp(1 - d / (half * falloff), 0, 1);
      const a = t * t * (3 - 2 * t);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
