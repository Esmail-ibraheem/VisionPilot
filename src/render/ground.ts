import * as THREE from 'three';
import type { Crosswalk, LaneArrow, LaneGeometry, Marking } from '../world/types';
import { toSceneHeading, toSceneX } from './frame';

const COLORS: Record<Marking['kind'], number> = { lane: 0xc9c9c9, center: 0xc6c6c6, edge: 0xd9d9d9, stop: 0xc2c2c2 };
const CROSSWALK_COLOR = 0xd4d4d4;
const Y_MARK = 0.004;

/** Shared flat unit quad (1 × 1 m on the ground), scaled per instance. */
function unitQuad(): THREE.PlaneGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

function segmentHeading(p0: { x: number; z: number }, p1: { x: number; z: number }): number {
  return Math.atan2(p1.x - p0.x, p1.z - p0.z);
}

/**
 * Road markings driven by WorldState.lanes: dashed/solid polylines, zebra crossings and lane
 * arrows. Objects are pooled by id; a marking's geometry is only rebuilt when its points change.
 */
export class LaneMarkings {
  readonly group = new THREE.Group();
  private quad = unitQuad();
  private arrowGeometry = createArrowGeometry();
  private materials = new Map<number, THREE.MeshBasicMaterial>();
  private markings = new Map<string, { mesh: THREE.InstancedMesh; key: string }>();
  private crosswalks = new Map<string, { mesh: THREE.InstancedMesh; key: string }>();
  private arrows = new Map<string, THREE.Mesh>();
  private dummy = new THREE.Object3D();

  private material(color: number): THREE.MeshBasicMaterial {
    let m = this.materials.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color });
      this.materials.set(color, m);
    }
    return m;
  }

  update(lanes: LaneGeometry): void {
    const seen = new Set<string>();
    for (const m of lanes.markings) {
      seen.add(m.id);
      const key = m.points.map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join('|') + `|${m.dashed}|${m.width}`;
      const existing = this.markings.get(m.id);
      if (existing && existing.key === key) continue;
      if (existing) {
        this.group.remove(existing.mesh);
        existing.mesh.dispose();
      }
      const mesh = this.buildMarking(m, lanes);
      this.group.add(mesh);
      this.markings.set(m.id, { mesh, key });
    }
    for (const [id, e] of this.markings) {
      if (!seen.has(id)) {
        this.group.remove(e.mesh);
        e.mesh.dispose();
        this.markings.delete(id);
      }
    }

    const seenCw = new Set<string>();
    for (const c of lanes.crosswalks) {
      seenCw.add(c.id);
      const key = `${c.x.toFixed(2)},${c.z.toFixed(2)},${c.heading.toFixed(3)},${c.length},${c.depth}`;
      const existing = this.crosswalks.get(c.id);
      if (existing && existing.key === key) continue;
      if (existing) {
        this.group.remove(existing.mesh);
        existing.mesh.dispose();
      }
      const mesh = this.buildCrosswalk(c);
      this.group.add(mesh);
      this.crosswalks.set(c.id, { mesh, key });
    }
    for (const [id, e] of this.crosswalks) {
      if (!seenCw.has(id)) {
        this.group.remove(e.mesh);
        e.mesh.dispose();
        this.crosswalks.delete(id);
      }
    }

    const seenArrows = new Set<string>();
    for (const a of lanes.arrows) {
      seenArrows.add(a.id);
      let mesh = this.arrows.get(a.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.arrowGeometry, this.material(COLORS.lane));
        this.group.add(mesh);
        this.arrows.set(a.id, mesh);
      }
      this.placeArrow(mesh, a);
    }
    for (const [id, mesh] of this.arrows) {
      if (!seenArrows.has(id)) {
        this.group.remove(mesh);
        this.arrows.delete(id);
      }
    }
  }

  private placeArrow(mesh: THREE.Mesh, a: LaneArrow): void {
    mesh.position.set(toSceneX(a.x), Y_MARK, a.z);
    mesh.rotation.y = toSceneHeading(a.heading);
  }

  private buildMarking(m: Marking, lanes: LaneGeometry): THREE.InstancedMesh {
    const segments: Array<{ p0: Marking['points'][number]; p1: Marking['points'][number]; len: number; heading: number }> = [];
    let total = 0;
    const step = m.segments ? 2 : 1;
    for (let i = 0; i < m.points.length - 1; i += step) {
      const p0 = m.points[i];
      const p1 = m.points[i + 1];
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      if (len < 1e-3) continue;
      segments.push({ p0, p1, len, heading: segmentHeading(p0, p1) });
      total += len;
    }
    const count = m.dashed ? Math.ceil(total / lanes.dashPeriod) + segments.length : segments.length;
    const mesh = new THREE.InstancedMesh(this.quad, this.material(COLORS[m.kind]), Math.max(1, count));
    mesh.frustumCulled = false;
    let n = 0;
    let travelled = 0;
    for (const s of segments) {
      const d = { x: (s.p1.x - s.p0.x) / s.len, z: (s.p1.z - s.p0.z) / s.len };
      if (m.segments) travelled = 0; // independent segments: dashes start at each segment
      if (m.dashed) {
        // Dashes are anchored to the polyline start so they never slide.
        let k = Math.ceil((travelled - lanes.dashLength / 2) / lanes.dashPeriod);
        for (; ; k++) {
          const startAlong = k * lanes.dashPeriod - travelled;
          if (startAlong >= s.len) break;
          const a = Math.max(0, startAlong);
          const b = Math.min(s.len, startAlong + lanes.dashLength);
          if (b - a < 0.2) continue;
          const mid = (a + b) / 2;
          this.dummy.position.set(toSceneX(s.p0.x + d.x * mid), Y_MARK, s.p0.z + d.z * mid);
          this.dummy.rotation.set(0, toSceneHeading(s.heading), 0);
          this.dummy.scale.set(m.width, 1, b - a);
          this.dummy.updateMatrix();
          if (n < mesh.count) mesh.setMatrixAt(n++, this.dummy.matrix);
        }
      } else {
        this.dummy.position.set(toSceneX((s.p0.x + s.p1.x) / 2), Y_MARK, (s.p0.z + s.p1.z) / 2);
        this.dummy.rotation.set(0, toSceneHeading(s.heading), 0);
        this.dummy.scale.set(m.width, 1, s.len);
        this.dummy.updateMatrix();
        mesh.setMatrixAt(n++, this.dummy.matrix);
      }
      travelled += s.len;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildCrosswalk(c: Crosswalk): THREE.InstancedMesh {
    const stripeW = 0.5;
    const pitch = 1.0;
    const count = Math.floor(c.length / pitch);
    const mesh = new THREE.InstancedMesh(this.quad, this.material(CROSSWALK_COLOR), Math.max(1, count));
    mesh.frustumCulled = false;
    const heading = c.heading;
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);
    for (let k = 0; k < count; k++) {
      const v = -c.length / 2 + pitch * (k + 0.5);
      this.dummy.position.set(toSceneX(c.x + rx * v), Y_MARK + 0.0005, c.z + rz * v);
      this.dummy.rotation.set(0, toSceneHeading(heading), 0);
      this.dummy.scale.set(stripeW, 1, c.depth);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(k, this.dummy.matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  dispose(): void {
    for (const m of this.materials.values()) m.dispose();
    this.quad.dispose();
    this.arrowGeometry.dispose();
    for (const e of this.markings.values()) e.mesh.dispose();
    for (const e of this.crosswalks.values()) e.mesh.dispose();
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
  const geo = new THREE.PlaneGeometry(6000, 6000);
  geo.rotateX(-Math.PI / 2);
  // Push the ground back in depth so road decals a few millimetres above it never z-fight,
  // even on 16-bit depth buffers (software renderers, some mobile GPUs).
  const mat = new THREE.MeshBasicMaterial({ color, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 8 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  return mesh;
}

/**
 * Translucent planned-path ribbon following a polyline of world points. Vertices are rewritten
 * each frame; the alpha gradient fades toward the far end.
 */
export class PathRibbon {
  readonly mesh: THREE.Mesh;
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private uvs: Float32Array;
  private maxPoints = 96;

  constructor() {
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(this.maxPoints * 2 * 3);
    this.uvs = new Float32Array(this.maxPoints * 2 * 2);
    const index: number[] = [];
    for (let i = 0; i < this.maxPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2));
    this.geometry.setIndex(index);
    this.geometry.setDrawRange(0, 0);

    const size = 64;
    const data = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      const a = 1 - t * t;
      data[i * 4] = 60;
      data[i * 4 + 1] = 130;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = Math.round(a * 255);
    }
    const tex = new THREE.DataTexture(data, 1, size, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  update(points: Array<{ x: number; z: number }>, halfWidth: number): void {
    const n = Math.min(points.length, this.maxPoints);
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(n - 1, i + 1)];
      const dx = toSceneX(next.x) - toSceneX(prev.x);
      const dz = next.z - prev.z;
      const len = Math.hypot(dx, dz) || 1;
      // right-hand normal in scene space
      const nx = dz / len;
      const nz = -dx / len;
      const x = toSceneX(p.x);
      const base = i * 6;
      this.positions[base] = x + nx * halfWidth;
      this.positions[base + 1] = 0.006;
      this.positions[base + 2] = p.z + nz * halfWidth;
      this.positions[base + 3] = x - nx * halfWidth;
      this.positions[base + 4] = 0.006;
      this.positions[base + 5] = p.z - nz * halfWidth;
      const t = i / (n - 1);
      this.uvs[i * 4] = 0;
      this.uvs[i * 4 + 1] = t;
      this.uvs[i * 4 + 2] = 1;
      this.uvs[i * 4 + 3] = t;
    }
    this.geometry.setDrawRange(0, (n - 1) * 6);
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('uv') as THREE.BufferAttribute).needsUpdate = true;
  }
}
