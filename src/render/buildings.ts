import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { toSceneX } from './frame';

export interface BuildingFootprint {
  id: string;
  polygon: Array<{ x: number; z: number }>;
  height: number;
}

/**
 * Buildings as pale extruded footprints, merged into one mesh per map. They give the real-map
 * world its street layout without competing with the perception objects.
 */
export class BuildingsLayer {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private mapId: string | null = null;
  private material = new THREE.MeshStandardMaterial({ color: 0xe3e3e1, roughness: 0.95, metalness: 0 });

  update(mapId: string | undefined, buildings: BuildingFootprint[] | undefined): void {
    const id = mapId ?? null;
    if (id === this.mapId) return;
    this.clear();
    this.mapId = id;
    if (!id || !buildings || buildings.length === 0) return;
    const parts: THREE.BufferGeometry[] = [];
    for (const b of buildings) {
      if (b.polygon.length < 3) continue;
      // Shape lives in XY; after rotateX(-90°) shape (sx, sy) → scene (sx, height, -sy).
      const shape = new THREE.Shape(b.polygon.map((p) => new THREE.Vector2(toSceneX(p.x), -p.z)));
      let geo: THREE.ExtrudeGeometry;
      try {
        // Low slabs: real heights would wall in the elevated chase camera; the footprint is what
        // conveys the street layout.
        geo = new THREE.ExtrudeGeometry(shape, { depth: Math.min(b.height, 4.5), bevelEnabled: false, curveSegments: 1 });
      } catch {
        continue;
      }
      geo.rotateX(-Math.PI / 2);
      for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
      parts.push(geo.index ? geo.toNonIndexed() : geo);
    }
    const merged = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!merged) return;
    merged.computeBoundingSphere();
    this.mesh = new THREE.Mesh(merged, this.material);
    this.mesh.renderOrder = -2;
    this.group.add(this.mesh);
  }

  private clear(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}
