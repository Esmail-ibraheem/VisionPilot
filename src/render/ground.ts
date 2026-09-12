import * as THREE from 'three';
import type { LaneGeometry, LaneLine } from '../world/types';
import { toSceneX } from './frame';

const MARK_COLOR = 0xc9c9c9;
const WINDOW_BEHIND = 120;
const WINDOW_AHEAD = 380;

/**
 * Lane markings tiled seamlessly around the ego. Dashes are instanced planes positioned at
 * `zStart + k * period` so forward travel never shows a seam or a respawn.
 */
export class LaneMarkings {
  readonly group = new THREE.Group();
  private material = new THREE.MeshBasicMaterial({ color: MARK_COLOR });
  private dashGeometry: THREE.PlaneGeometry | null = null;
  private lines = new Map<string, { mesh: THREE.InstancedMesh; line: LaneLine }>();
  private arrows = new Map<string, THREE.Mesh>();
  private arrowGeometry: THREE.ShapeGeometry;
  private dummy = new THREE.Object3D();

  constructor() {
    this.arrowGeometry = createArrowGeometry();
  }

  update(lanes: LaneGeometry, egoZ: number): void {
    if (!this.dashGeometry) {
      this.dashGeometry = new THREE.PlaneGeometry(lanes.width, lanes.dashLength);
      this.dashGeometry.rotateX(-Math.PI / 2);
    }
    const maxDashes = Math.ceil((WINDOW_BEHIND + WINDOW_AHEAD) / lanes.dashPeriod) + 2;
    const seen = new Set<string>();
    for (const line of lanes.lines) {
      seen.add(line.id);
      let entry = this.lines.get(line.id);
      if (!entry) {
        const mesh = new THREE.InstancedMesh(this.dashGeometry, this.material, maxDashes);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        entry = { mesh, line };
        this.lines.set(line.id, entry);
      }
      entry.line = line;
      const { mesh } = entry;
      const zMin = Math.max(line.zStart, egoZ - WINDOW_BEHIND);
      const zMax = Math.min(line.zEnd, egoZ + WINDOW_AHEAD);
      let count = 0;
      if (line.dashed) {
        const kStart = Math.ceil((zMin - line.zStart) / lanes.dashPeriod);
        for (let k = kStart; count < maxDashes; k++) {
          const z = line.zStart + k * lanes.dashPeriod + lanes.dashLength / 2;
          if (z - lanes.dashLength / 2 > zMax) break;
          this.dummy.position.set(toSceneX(line.x), 0.004, z);
          this.dummy.scale.set(1, 1, 1);
          this.dummy.updateMatrix();
          mesh.setMatrixAt(count++, this.dummy.matrix);
        }
      } else if (zMax > zMin) {
        this.dummy.position.set(toSceneX(line.x), 0.004, (zMin + zMax) / 2);
        this.dummy.scale.set(1, 1, (zMax - zMin) / lanes.dashLength);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(count++, this.dummy.matrix);
      }
      mesh.count = count;
      mesh.instanceMatrix.needsUpdate = true;
    }
    for (const [id, entry] of this.lines) {
      if (!seen.has(id)) {
        this.group.remove(entry.mesh);
        entry.mesh.dispose();
        this.lines.delete(id);
      }
    }

    const arrowSeen = new Set<string>();
    for (const arrow of lanes.arrows) {
      arrowSeen.add(arrow.id);
      let mesh = this.arrows.get(arrow.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.arrowGeometry, this.material);
        this.group.add(mesh);
        this.arrows.set(arrow.id, mesh);
      }
      mesh.position.set(toSceneX(arrow.x), 0.004, arrow.z);
    }
    for (const [id, mesh] of this.arrows) {
      if (!arrowSeen.has(id)) {
        this.group.remove(mesh);
        this.arrows.delete(id);
      }
    }
  }

  dispose(): void {
    this.material.dispose();
    this.dashGeometry?.dispose();
    this.arrowGeometry.dispose();
    for (const e of this.lines.values()) e.mesh.dispose();
  }
}

/** A thin straight-ahead lane arrow (≈ 2.6 m long) lying flat on the ground, pointing +z. */
function createArrowGeometry(): THREE.ShapeGeometry {
  // Drawn in the XY plane with -y as "forward"; rotateX(-90°) maps -y → +z and keeps the face up.
  const s = new THREE.Shape();
  const shaftW = 0.11;
  const headW = 0.42;
  const len = 2.6;
  const headLen = 0.75;
  s.moveTo(-shaftW, 0);
  s.lineTo(shaftW, 0);
  s.lineTo(shaftW, -(len - headLen));
  s.lineTo(headW, -(len - headLen));
  s.lineTo(0, -len);
  s.lineTo(-headW, -(len - headLen));
  s.lineTo(-shaftW, -(len - headLen));
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -len / 2);
  return g;
}

export function createGround(color: number): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(4000, 4000);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Translucent planned-path corridor (off by default, developer toggle). */
export function createTrajectoryRibbon(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(1, 1, 1, 16);
  geo.rotateX(-Math.PI / 2);
  const size = 64;
  const data = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    // v = 1 is the near end after the rotation; fade toward the far end.
    const a = t * t * (3 - 2 * t);
    data[i * 4] = 60;
    data[i * 4 + 1] = 130;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.round(a * 255);
  }
  const tex = new THREE.DataTexture(data, 1, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.45, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.006;
  mesh.visible = false;
  return mesh;
}
