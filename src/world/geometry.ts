/**
 * 2D geometry for the road world: frames, and a piecewise path (lines + circular arcs) the ego
 * follows. Frame: x right, z forward; heading 0 = +z, positive heading turns toward +x.
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** Unit direction for a heading. */
export function dirOf(heading: number): Vec2 {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

/** Unit right-hand normal for a heading (direction rotated +90°). */
export function rightOf(heading: number): Vec2 {
  return { x: Math.cos(heading), z: -Math.sin(heading) };
}

export interface Frame {
  origin: Vec2;
  heading: number;
}

/** (u along the frame heading, v to the right) → world. */
export function frameToWorld(f: Frame, u: number, v: number): Vec2 {
  const d = dirOf(f.heading);
  const r = rightOf(f.heading);
  return { x: f.origin.x + u * d.x + v * r.x, z: f.origin.z + u * d.z + v * r.z };
}

export function worldToFrame(f: Frame, p: Vec2): { u: number; v: number } {
  const d = dirOf(f.heading);
  const r = rightOf(f.heading);
  const dx = p.x - f.origin.x;
  const dz = p.z - f.origin.z;
  return { u: dx * d.x + dz * d.z, v: dx * r.x + dz * r.z };
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

interface LinePiece {
  kind: 'line';
  start: Vec2;
  heading: number;
  length: number;
}

interface ArcPiece {
  kind: 'arc';
  center: Vec2;
  radius: number;
  startHeading: number;
  /** signed: positive = right turn */
  sweep: number;
  length: number;
}

export type PathPiece = LinePiece | ArcPiece;

/**
 * A G1-continuous path made of straight lines and circular arcs, parameterised by arc length.
 * The last line piece may be extended (the route generator lengthens it as the world grows).
 */
export class Path {
  readonly pieces: PathPiece[] = [];
  private cumulative: number[] = [];

  get length(): number {
    return this.cumulative.length ? this.cumulative[this.cumulative.length - 1] : 0;
  }

  startLine(start: Vec2, heading: number, length: number): void {
    this.pieces.push({ kind: 'line', start, heading, length });
    this.cumulative.push(length);
  }

  /** Current end pose of the path. */
  endPose(): Pose {
    const last = this.pieces[this.pieces.length - 1];
    if (!last) return { x: 0, z: 0, heading: 0 };
    return this.poseOnPiece(last, last.length);
  }

  /** Change the length of the final line piece (only lines can be extended/trimmed). */
  setLastLineLength(length: number): void {
    const last = this.pieces[this.pieces.length - 1];
    if (!last || last.kind !== 'line') throw new Error('last piece is not a line');
    last.length = length;
    const prev = this.cumulative.length > 1 ? this.cumulative[this.cumulative.length - 2] : 0;
    this.cumulative[this.cumulative.length - 1] = prev + length;
  }

  /** Append an arc tangent to the current end, turning by `sweep` (positive = right) with `radius`. */
  appendArc(radius: number, sweep: number): void {
    const end = this.endPose();
    const sign = Math.sign(sweep) || 1;
    const r = rightOf(end.heading);
    const center = { x: end.x + sign * radius * r.x, z: end.z + sign * radius * r.z };
    const length = radius * Math.abs(sweep);
    this.pieces.push({ kind: 'arc', center, radius, startHeading: end.heading, sweep, length });
    this.cumulative.push(this.length + length);
  }

  /** Append a straight line tangent to the current end. */
  appendLine(length: number): void {
    const end = this.endPose();
    this.pieces.push({ kind: 'line', start: { x: end.x, z: end.z }, heading: end.heading, length });
    this.cumulative.push(this.length + length);
  }

  poseAt(s: number): Pose {
    if (this.pieces.length === 0) return { x: 0, z: 0, heading: 0 };
    const sc = Math.max(0, Math.min(s, this.length));
    let i = 0;
    while (i < this.pieces.length - 1 && sc > this.cumulative[i]) i++;
    const pieceStart = i === 0 ? 0 : this.cumulative[i - 1];
    return this.poseOnPiece(this.pieces[i], sc - pieceStart);
  }

  /** Index of the piece containing arc length `s`. */
  pieceIndexAt(s: number): number {
    let i = 0;
    while (i < this.pieces.length - 1 && s > this.cumulative[i]) i++;
    return i;
  }

  pieceStart(index: number): number {
    return index === 0 ? 0 : this.cumulative[index - 1];
  }

  private poseOnPiece(piece: PathPiece, t: number): Pose {
    if (piece.kind === 'line') {
      const d = dirOf(piece.heading);
      return { x: piece.start.x + d.x * t, z: piece.start.z + d.z * t, heading: piece.heading };
    }
    const sign = Math.sign(piece.sweep) || 1;
    const heading = piece.startHeading + sign * (t / piece.radius);
    const r = rightOf(heading);
    return {
      x: piece.center.x - sign * piece.radius * r.x,
      z: piece.center.z - sign * piece.radius * r.z,
      heading,
    };
  }

  /** Sample poses from s0 to s1 every `step` metres (inclusive of both ends). */
  sample(s0: number, s1: number, step: number): Pose[] {
    const out: Pose[] = [];
    const n = Math.max(1, Math.ceil((s1 - s0) / step));
    for (let i = 0; i <= n; i++) out.push(this.poseAt(s0 + ((s1 - s0) * i) / n));
    return out;
  }
}
