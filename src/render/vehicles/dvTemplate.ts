import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createVehicle as createDvVehicle, disposeVehicleCache } from './dv/vehicles';
import type { BodyKind } from './specs';

/**
 * Adapts the `driving-visualization` car models to this app: rotates them into the +Z-forward
 * vehicle frame and merges their ~60 small meshes per material (≈ 8 draw calls per car). Tail lamps
 * are kept as their own mesh so brake lights can be switched per instance.
 */
export interface DvTemplate {
  /** merged meshes sharing the original materials */
  parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>;
  /** merged tail-lamp geometry and the original (unlit) material */
  tail: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } | null;
  length: number;
  width: number;
}

const templates = new Map<BodyKind, DvTemplate>();
const flip = new THREE.Matrix4().makeRotationY(Math.PI);

function prepared(mesh: THREE.Mesh, parentInverse: THREE.Matrix4): THREE.BufferGeometry {
  let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const m = new THREE.Matrix4().multiplyMatrices(parentInverse, mesh.matrixWorld);
  m.premultiply(flip);
  g.applyMatrix4(m);
  return g;
}

export function getDvTemplate(kind: BodyKind): DvTemplate {
  let t = templates.get(kind);
  if (t) return t;
  const group = createDvVehicle(kind);
  group.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const tails: THREE.BufferGeometry[] = [];
  let tailMaterial: THREE.MeshStandardMaterial | null = null;
  group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geometry = prepared(o, rootInverse);
    if (o.name === 'tail') {
      tails.push(geometry);
      tailMaterial = o.material as THREE.MeshStandardMaterial;
      return;
    }
    const mat = o.material as THREE.Material;
    let list = byMaterial.get(mat);
    if (!list) byMaterial.set(mat, (list = []));
    list.push(geometry);
  });
  const parts: DvTemplate['parts'] = [];
  for (const [material, list] of byMaterial) {
    const merged = mergeGeometries(list, false);
    for (const g of list) g.dispose();
    if (!merged) continue;
    merged.computeBoundingBox();
    parts.push({ geometry: merged, material });
  }
  let tail: DvTemplate['tail'] = null;
  if (tails.length && tailMaterial) {
    const merged = mergeGeometries(tails, false);
    for (const g of tails) g.dispose();
    if (merged) tail = { geometry: merged, material: tailMaterial };
  }
  const dims = group.userData.dimensions as { length: number; width: number };
  t = { parts, tail, length: dims.length, width: dims.width };
  templates.set(kind, t);
  return t;
}

export function disposeDvTemplates(): void {
  for (const t of templates.values()) {
    for (const p of t.parts) p.geometry.dispose();
    t.tail?.geometry.dispose();
  }
  templates.clear();
  disposeVehicleCache();
}
