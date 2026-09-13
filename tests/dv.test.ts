import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getDvTemplate } from '../src/render/vehicles/dvTemplate';
import type { BodyKind } from '../src/render/vehicles/specs';

describe('driving-visualization car models (ported)', () => {
  for (const kind of ['sedan', 'crossover', 'van', 'ego'] as BodyKind[]) {
    it(`${kind}: merges into a few parts, faces +Z and sits on the ground`, () => {
      const t = getDvTemplate(kind);
      expect(t.parts.length).toBeGreaterThan(3);
      expect(t.parts.length).toBeLessThan(12);
      expect(t.tail).not.toBeNull();
      const box = new THREE.Box3();
      for (const p of t.parts) {
        const pos = p.geometry.getAttribute('position');
        for (let i = 0; i < pos.count * 3; i++) expect(Number.isFinite(pos.array[i])).toBe(true);
        box.expandByObject(new THREE.Mesh(p.geometry));
      }
      expect(box.max.z - box.min.z).toBeCloseTo(t.length, 0);
      expect(box.max.x - box.min.x).toBeGreaterThan(t.width * 0.95);
      expect(box.min.y).toBeGreaterThan(-0.02);
      expect(box.min.y).toBeLessThan(0.05); // tyres touch the ground
      // Head lamps ended up at the +Z end after the frame flip, tail lamps at −Z.
      const tail = new THREE.Box3().setFromBufferAttribute(t.tail!.geometry.getAttribute('position') as THREE.BufferAttribute);
      expect(tail.max.z).toBeLessThan(0);
    });
  }
});
