import * as THREE from 'three';
import { toSceneX } from './frame';

/** Pale low-poly trees in the perception palette: instanced trunk + canopy, rebuilt per map id. */
export class TreesLayer {
  readonly group = new THREE.Group();
  private mapId: string | null = null;
  private trunk = new THREE.CylinderGeometry(0.16, 0.22, 1, 8);
  private canopy = new THREE.SphereGeometry(1, 10, 8);
  private trunkMat = new THREE.MeshStandardMaterial({ color: 0xb9b9b5, roughness: 0.9 });
  private canopyMat = new THREE.MeshStandardMaterial({ color: 0xd6d6d2, roughness: 0.9 });
  private meshes: THREE.InstancedMesh[] = [];

  update(mapId: string | undefined, trees: Array<{ x: number; z: number; size: number }> | undefined): void {
    const id = mapId ?? null;
    if (id === this.mapId) return;
    this.clear();
    this.mapId = id;
    if (!id || !trees || trees.length === 0) return;
    const trunks = new THREE.InstancedMesh(this.trunk, this.trunkMat, trees.length);
    const canopies = new THREE.InstancedMesh(this.canopy, this.canopyMat, trees.length);
    const m = new THREE.Object3D();
    trees.forEach((t, i) => {
      const r = Math.max(1.2, t.size * 0.28);
      const h = r * 2.2;
      m.position.set(toSceneX(t.x), h * 0.35, t.z);
      m.scale.set(1, h * 0.7, 1);
      m.updateMatrix();
      trunks.setMatrixAt(i, m.matrix);
      m.position.set(toSceneX(t.x), h * 0.7 + r * 0.6, t.z);
      m.scale.set(r, r * 1.15, r);
      m.updateMatrix();
      canopies.setMatrixAt(i, m.matrix);
    });
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;
    this.meshes = [trunks, canopies];
    this.group.add(trunks, canopies);
  }

  private clear(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.meshes = [];
  }

  dispose(): void {
    this.clear();
    this.trunk.dispose();
    this.canopy.dispose();
    this.trunkMat.dispose();
    this.canopyMat.dispose();
  }
}

/** Sensor rays of the ego (virtual-world AI car), drawn slightly above the ground. */
export class RaysLayer {
  readonly lines: THREE.LineSegments;
  private positions = new Float32Array(64 * 6);
  private colors = new Float32Array(64 * 6);
  private geometry = new THREE.BufferGeometry();

  constructor() {
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false });
    this.lines = new THREE.LineSegments(this.geometry, mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
  }

  update(rays: Array<{ x0: number; z0: number; x1: number; z1: number; hit: boolean }> | undefined): void {
    const n = Math.min(rays?.length ?? 0, 32);
    for (let i = 0; i < n; i++) {
      const r = rays![i];
      const b = i * 6;
      this.positions[b] = toSceneX(r.x0);
      this.positions[b + 1] = 0.5;
      this.positions[b + 2] = r.z0;
      this.positions[b + 3] = toSceneX(r.x1);
      this.positions[b + 4] = 0.5;
      this.positions[b + 5] = r.z1;
      const c = r.hit ? [1.0, 0.45, 0.25] : [0.31, 0.65, 1.0];
      for (let k = 0; k < 2; k++) {
        this.colors[b + k * 3] = c[0];
        this.colors[b + k * 3 + 1] = c[1];
        this.colors[b + k * 3 + 2] = c[2];
      }
    }
    this.geometry.setDrawRange(0, n * 2);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.lines.visible = n > 0;
  }
}
