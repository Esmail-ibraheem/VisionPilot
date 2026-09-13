import type { Vec2 } from '../geometry';

/** Arc-length parameterised polyline with lateral offsets (u along, v to the right). */
export class Polyline {
  readonly points: Vec2[];
  readonly cum: number[];
  readonly length: number;
  private headings: number[];

  constructor(points: Vec2[]) {
    // drop duplicate consecutive points
    const pts: Vec2[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 1e-3) pts.push({ x: p.x, z: p.z });
    }
    if (pts.length === 1) pts.push({ x: pts[0].x, z: pts[0].z + 0.01 });
    this.points = pts;
    this.cum = [0];
    this.headings = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      this.cum.push(this.cum[i] + Math.hypot(dx, dz));
      this.headings.push(Math.atan2(dx, dz));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  private segmentIndex(u: number): number {
    const n = this.points.length - 1;
    if (u <= 0) return 0;
    if (u >= this.length) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= u) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pointAt(u: number): Vec2 {
    const i = this.segmentIndex(u);
    const a = this.points[i];
    const b = this.points[i + 1];
    const len = this.cum[i + 1] - this.cum[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (u - this.cum[i]) / len)) : 0;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }

  headingAt(u: number): number {
    return this.headings[this.segmentIndex(u)];
  }

  /** Point at arc length u, offset v to the right of the travel direction. */
  offsetPoint(u: number, v: number): Vec2 {
    const p = this.pointAt(u);
    const h = this.headingAt(u);
    return { x: p.x + v * Math.cos(h), z: p.z - v * Math.sin(h) };
  }

  /** Parallel curve at lateral offset v (vertex-normal offsets; ends stay perpendicular). */
  offsetPolyline(v: number): Vec2[] {
    const n = this.points.length;
    const out: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const hPrev = this.headings[Math.max(0, i - 1)];
      const hNext = this.headings[Math.min(this.headings.length - 1, i)];
      // average direction at the vertex, scaled so the offset stays v at the mitre
      let h = Math.atan2(Math.sin(hPrev) + Math.sin(hNext), Math.cos(hPrev) + Math.cos(hNext));
      const half = Math.abs(wrap(hNext - hPrev)) / 2;
      const scale = Math.min(2, 1 / Math.max(Math.cos(half), 0.5));
      if (i === 0) h = hNext;
      if (i === n - 1) h = hPrev;
      const p = this.points[i];
      out.push({ x: p.x + v * scale * Math.cos(h), z: p.z - v * scale * Math.sin(h) });
    }
    return out;
  }

  /** Closest point: arc length u, signed lateral v (right positive), and distance. */
  project(p: Vec2): { u: number; v: number; dist: number } {
    let best = { u: 0, v: 0, dist: Infinity };
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
      const qx = a.x + dx * t;
      const qz = a.z + dz * t;
      const dist = Math.hypot(p.x - qx, p.z - qz);
      if (dist < best.dist) {
        const h = this.headings[i];
        const rx = Math.cos(h);
        const rz = -Math.sin(h);
        const v = (p.x - qx) * rx + (p.z - qz) * rz;
        best = { u: this.cum[i] + Math.sqrt(len2) * t, v, dist };
      }
    }
    return best;
  }

  slice(u0: number, u1: number): Polyline {
    const a = Math.max(0, Math.min(u0, u1));
    const b = Math.min(this.length, Math.max(u0, u1));
    const pts: Vec2[] = [this.pointAt(a)];
    for (let i = 0; i < this.points.length; i++) if (this.cum[i] > a && this.cum[i] < b) pts.push(this.points[i]);
    pts.push(this.pointAt(b));
    return new Polyline(pts);
  }

  reversed(): Polyline {
    return new Polyline([...this.points].reverse());
  }

  /** Cubic Hermite blend between two poses, sampled at ~1 m. */
  static hermite(p0: Vec2, h0: number, p1: Vec2, h1: number, tangentScale = 0.55): Polyline {
    const d = Math.max(3, Math.hypot(p1.x - p0.x, p1.z - p0.z));
    const m0 = { x: Math.sin(h0) * d * tangentScale, z: Math.cos(h0) * d * tangentScale };
    const m1 = { x: Math.sin(h1) * d * tangentScale, z: Math.cos(h1) * d * tangentScale };
    const n = Math.max(6, Math.ceil(d * 1.2));
    const pts: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const t2 = t * t;
      const t3 = t2 * t;
      const a = 2 * t3 - 3 * t2 + 1;
      const b = t3 - 2 * t2 + t;
      const c = -2 * t3 + 3 * t2;
      const e = t3 - t2;
      pts.push({ x: a * p0.x + b * m0.x + c * p1.x + e * m1.x, z: a * p0.z + b * m0.z + c * p1.z + e * m1.z });
    }
    return new Polyline(pts);
  }
}

export function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
