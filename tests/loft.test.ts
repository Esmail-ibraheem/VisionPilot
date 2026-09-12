import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBodyGeometry, monotoneCurve } from '../src/render/vehicles/loft';
import { BODY_SPECS, type BodyKind } from '../src/render/vehicles/specs';

describe('monotoneCurve', () => {
  it('passes through keyframes and does not overshoot', () => {
    const f = monotoneCurve([
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 0.2],
    ]);
    expect(f(0)).toBeCloseTo(0);
    expect(f(1)).toBeCloseTo(1);
    expect(f(2)).toBeCloseTo(1);
    for (let x = 0; x <= 3; x += 0.01) {
      expect(f(x)).toBeLessThanOrEqual(1.0000001);
      expect(f(x)).toBeGreaterThanOrEqual(-0.0000001);
    }
    expect(f(-5)).toBe(0);
    expect(f(9)).toBeCloseTo(0.2);
  });
});

describe('body loft', () => {
  const kinds = Object.keys(BODY_SPECS) as BodyKind[];

  for (const kind of kinds) {
    it(`${kind}: builds a closed, outward-facing body with glass`, () => {
      const spec = BODY_SPECS[kind];
      const { geometry, stats } = buildBodyGeometry(spec);
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
      const idx = geometry.getIndex()!;
      expect(stats.faces).toBeGreaterThan(2000);
      expect(stats.glassFaces).toBeGreaterThan(100);

      for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
      const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
      for (let i = 0; i < nrm.count * 3; i++) expect(Number.isFinite(nrm.array[i])).toBe(true);

      // Extents match the spec.
      const bb = geometry.boundingBox!;
      expect(bb.max.z - bb.min.z).toBeCloseTo(spec.length, 3);
      expect(bb.max.x - bb.min.x).toBeCloseTo(spec.width, 1);
      expect(bb.min.y).toBeGreaterThan(0.1);
      expect(bb.max.y).toBeGreaterThan(1.3);

      // Face normals point away from the body centreline (outward), for the large majority.
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const n = new THREE.Vector3();
      const centroid = new THREE.Vector3();
      let outward = 0;
      let total = 0;
      for (let i = 0; i < idx.count; i += 3) {
        a.fromBufferAttribute(pos, idx.getX(i));
        b.fromBufferAttribute(pos, idx.getX(i + 1));
        c.fromBufferAttribute(pos, idx.getX(i + 2));
        n.subVectors(b, a).cross(c.clone().sub(a));
        if (n.lengthSq() < 1e-12) continue;
        centroid.addVectors(a, b).add(c).multiplyScalar(1 / 3);
        // Reference point on the centreline: mid-height, but below upward-facing faces (low hoods).
        const midY = (bb.min.y + bb.max.y) / 2;
        const refY = n.y > 0.3 * n.length() ? Math.min(midY, centroid.y - 0.05) : midY;
        const ref = new THREE.Vector3(0, refY, THREE.MathUtils.clamp(centroid.z, bb.min.z + 0.4, bb.max.z - 0.4));
        const out = centroid.sub(ref);
        if (n.dot(out) > 0) outward++;
        total++;
      }
      expect(outward / total).toBeGreaterThan(0.97);

      // Material groups: body, glass (and trim when the spec has one).
      const groupMaterials = geometry.groups.map((g) => g.materialIndex);
      expect(groupMaterials).toContain(0);
      expect(groupMaterials).toContain(1);
      if (spec.trimHeight > 0) expect(groupMaterials).toContain(2);
    });
  }

  it('wheel arches cut the underside around the axles', () => {
    const spec = BODY_SPECS.sedan;
    const { geometry } = buildBodyGeometry(spec);
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    let minYAtAxle = Infinity;
    let minYMid = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const y = pos.getY(i);
      if (Math.abs(z - spec.wheels.frontZ) < 0.03) minYAtAxle = Math.min(minYAtAxle, y);
      if (Math.abs(z) < 0.05) minYMid = Math.min(minYMid, y);
    }
    expect(minYAtAxle).toBeGreaterThan(spec.wheels.radius + spec.wheels.archGap - 0.02);
    expect(minYMid).toBeLessThan(0.3);
  });
});
