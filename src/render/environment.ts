import * as THREE from 'three';

/**
 * A smooth vertical-gradient environment (bright overcast sky → mid-gray ground) used only for
 * reflections on the ego car. Generated in memory and pre-filtered with PMREM.
 */
export function createGradientEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const w = 128;
  const h = 128;
  const data = new Uint8Array(w * h * 4);
  const top = new THREE.Color(0xffffff);
  const horizon = new THREE.Color(0xd8d8d8);
  const bottom = new THREE.Color(0x707070);
  const c = new THREE.Color();
  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = top of the sphere
    // smoothstep blends avoid visible bands in glossy reflections
    const t = v < 0.5 ? v / 0.5 : (v - 0.5) / 0.5;
    const st = t * t * (3 - 2 * t);
    if (v < 0.5) c.copy(top).lerp(horizon, st);
    else c.copy(horizon).lerp(bottom, st);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = Math.round(c.r * 255);
      data[i + 1] = Math.round(c.g * 255);
      data[i + 2] = Math.round(c.b * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return rt.texture;
}
