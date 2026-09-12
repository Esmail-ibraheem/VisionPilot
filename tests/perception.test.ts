import { describe, expect, it } from 'vitest';
import { projectDetection, DEFAULT_CAMERA } from '../src/perception/projection';
import { Tracker } from '../src/perception/tracker';
import type { Detection } from '../src/perception/detector';

const W = 512;
const H = 288;
const f = W / 2 / Math.tan((DEFAULT_CAMERA.hfovDeg * Math.PI) / 360);

/** Inverse of the projection: where would a box bottom at distance z, lateral x land? */
function boxFor(label: string, x: number, z: number, w = 60, h = 40): Detection {
  const yBottom = DEFAULT_CAMERA.horizon * H + (DEFAULT_CAMERA.cameraHeight * f) / z;
  const xc = W / 2 + (x * f) / z;
  return { label, score: 0.9, bbox: [xc - w / 2, yBottom - h, w, h] };
}

describe('ground-plane projection', () => {
  it('recovers distance and lateral offset from a box bottom edge', () => {
    for (const [x, z] of [
      [0, 10],
      [-3.5, 25],
      [4, 60],
    ]) {
      const o = projectDetection(boxFor('car', x, z), DEFAULT_CAMERA, W, H)!;
      expect(o).not.toBeNull();
      expect(o.x).toBeCloseTo(x, 3);
      expect(o.z - 2.2).toBeCloseTo(z, 3); // vehicles get a body-centre offset
      expect(o.kind).toBe('sedan');
    }
    const p = projectDetection(boxFor('person', 2, 15), DEFAULT_CAMERA, W, H)!;
    expect(p.kind).toBe('pedestrian');
    expect(p.z).toBeCloseTo(15, 3);
  });

  it('rejects boxes above the horizon and classifies trucks by shape', () => {
    expect(projectDetection({ label: 'car', score: 0.9, bbox: [200, 10, 60, 40] }, DEFAULT_CAMERA, W, H)).toBeNull();
    expect(projectDetection({ label: 'truck', score: 0.9, bbox: [200, 150, 60, 30] }, DEFAULT_CAMERA, W, H)!.kind).toBe('crossover');
    expect(projectDetection({ label: 'truck', score: 0.9, bbox: [200, 150, 40, 50] }, DEFAULT_CAMERA, W, H)!.kind).toBe('van');
    expect(projectDetection({ label: 'bus', score: 0.9, bbox: [200, 150, 80, 60] }, DEFAULT_CAMERA, W, H)!.kind).toBe('van');
  });
});

describe('tracker', () => {
  const obj = (x: number, z: number, kind: 'sedan' | 'pedestrian' = 'sedan') => ({ kind, label: 'car', score: 0.9, x, z, bbox: [0, 0, 1, 1] as [number, number, number, number] });

  it('confirms after two hits, smooths jitter and keeps a stable id', () => {
    const tr = new Tracker();
    expect(tr.update([obj(0, 20)], 0, 0.1)).toHaveLength(0); // tentative
    const t1 = tr.update([obj(0.6, 20.8)], 0.1, 0.1);
    expect(t1).toHaveLength(1);
    const id = t1[0].id;
    const t2 = tr.update([obj(-0.5, 19.7)], 0.2, 0.1);
    expect(t2[0].id).toBe(id);
    // smoothed position moves only part of the way toward the noisy measurement
    expect(Math.abs(t2[0].x - t1[0].x)).toBeLessThan(0.6);
  });

  it('coasts briefly when a detection is missed, then drops the track', () => {
    const tr = new Tracker({ maxAge: 0.5 });
    tr.update([obj(1, 30)], 0, 0.1);
    tr.update([obj(1, 30)], 0.1, 0.1);
    expect(tr.update([], 0.3, 0.2)).toHaveLength(1); // still alive
    expect(tr.update([], 0.9, 0.6)).toHaveLength(0); // aged out
  });

  it('does not merge pedestrians into vehicle tracks', () => {
    const tr = new Tracker();
    tr.update([obj(0, 20)], 0, 0.1);
    const out = tr.update([obj(0, 20, 'pedestrian')], 0.1, 0.1);
    expect(out).toHaveLength(0); // pedestrian is a new tentative track; car track unmatched
    expect(tr.tracks).toHaveLength(2);
  });
});
