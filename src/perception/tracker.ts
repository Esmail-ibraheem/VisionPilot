import type { ObjectKind, ProjectedObject } from './projection';

/**
 * Lightweight multi-object tracker: nearest-neighbour association per object class, exponential
 * position smoothing, a short confirmation period before an object is shown, and a grace period
 * before a lost object is dropped. This is what turns per-frame detections into the stable,
 * smoothly moving objects the visualization shows.
 */
export interface Track {
  id: string;
  kind: ObjectKind;
  x: number;
  z: number;
  /** smoothed velocity estimate, m/s (relative to the camera) */
  vx: number;
  vz: number;
  hits: number;
  lastSeen: number;
  confirmed: boolean;
  bbox: ProjectedObject['bbox'];
  score: number;
}

export interface TrackerOptions {
  /** seconds a track survives without a matching detection */
  maxAge?: number;
  /** detections needed before a track is displayed */
  minHits?: number;
  /** smoothing factor for new measurements (0..1) */
  alpha?: number;
}

export class Tracker {
  tracks: Track[] = [];
  private serial = 0;
  private maxAge: number;
  private minHits: number;
  private alpha: number;

  constructor(opts: TrackerOptions = {}) {
    this.maxAge = opts.maxAge ?? 0.7;
    this.minHits = opts.minHits ?? 2;
    this.alpha = opts.alpha ?? 0.4;
  }

  update(objects: ProjectedObject[], time: number, dt: number): Track[] {
    const unmatched = new Set(this.tracks);
    const used = new Set<ProjectedObject>();
    // Greedy nearest matching, closest pairs first.
    const pairs: Array<{ t: Track; o: ProjectedObject; d: number }> = [];
    for (const t of this.tracks) {
      const px = t.x + t.vx * dt;
      const pz = t.z + t.vz * dt;
      for (const o of objects) {
        if (sameGroup(t.kind, o.kind)) {
          const d = Math.hypot(o.x - px, o.z - pz);
          const limit = Math.max(3, 0.18 * o.z);
          if (d < limit) pairs.push({ t, o, d });
        }
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    for (const { t, o } of pairs) {
      if (!unmatched.has(t) || used.has(o)) continue;
      unmatched.delete(t);
      used.add(o);
      const a = this.alpha;
      const nx = t.x + (o.x - t.x) * a;
      const nz = t.z + (o.z - t.z) * a;
      if (dt > 0) {
        t.vx = t.vx * 0.7 + ((nx - t.x) / dt) * 0.3;
        t.vz = t.vz * 0.7 + ((nz - t.z) / dt) * 0.3;
      }
      t.x = nx;
      t.z = nz;
      t.kind = o.kind;
      t.bbox = o.bbox;
      t.score = o.score;
      t.hits++;
      t.lastSeen = time;
      if (t.hits >= this.minHits) t.confirmed = true;
    }
    for (const o of objects) {
      if (used.has(o)) continue;
      this.tracks.push({
        id: `p${this.serial++}`,
        kind: o.kind,
        x: o.x,
        z: o.z,
        vx: 0,
        vz: 0,
        hits: 1,
        lastSeen: time,
        confirmed: this.minHits <= 1,
        bbox: o.bbox,
        score: o.score,
      });
    }
    // Coast unmatched tracks briefly, then drop them.
    for (const t of unmatched) {
      t.x += t.vx * dt * 0.5;
      t.z += t.vz * dt * 0.5;
    }
    this.tracks = this.tracks.filter((t) => time - t.lastSeen <= this.maxAge);
    return this.tracks.filter((t) => t.confirmed);
  }

  reset(): void {
    this.tracks = [];
  }
}

function sameGroup(a: ObjectKind, b: ObjectKind): boolean {
  return (a === 'pedestrian') === (b === 'pedestrian');
}
