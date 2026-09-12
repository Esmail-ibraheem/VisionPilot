import * as THREE from 'three';

/**
 * Cross-section loft builder for car bodies.
 *
 * Local frame of a vehicle: +z forward (nose), +x right, +y up, origin on the ground at the
 * body centre. A body is described by profile curves along the length (`s` = local z):
 *   top(s)      roof / hood / trunk height
 *   belt(s)     shoulder (belt line) height — widest point of the cross-section
 *   halfWidth(s) plan-view half width at the shoulder
 *   topRatio(s) roof half width / shoulder half width (tumblehome)
 *   bottom(s)   underside height (ground clearance, raised by wheel arches)
 * Each station produces a closed ring in the (x, y) plane with rounded corners; rings are stitched
 * into a smooth-shaded surface with flat end caps. Faces are bucketed into material groups:
 * 0 = body, 1 = glass, 2 = lower trim.
 */

export type Keyframes = Array<[number, number]>;

/** Monotone cubic (Fritsch–Carlson) interpolation through keyframes; clamped outside the range. */
export function monotoneCurve(points: Keyframes): (x: number) => number {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n === 1) return () => pts[0][1];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h[i] * m[i] + h01 * ys[i + 1] + h11 * h[i] * m[i + 1];
  };
}

export interface WheelSpec {
  radius: number;
  width: number;
  /** distance between wheel centres across the car */
  track: number;
  /** local z of the front and rear axles */
  frontZ: number;
  rearZ: number;
  /** gap between tyre and arch edge */
  archGap: number;
}

export interface GlassSpec {
  /** local z range of the greenhouse (rear window base → windshield base) */
  zRear: number;
  zFront: number;
  /** if true the whole greenhouse incl. roof is glass (Tesla glass roof) */
  roofIsGlass: boolean;
  /** faces whose normal has an up component above this are roof (body) unless roofIsGlass */
  roofNormalY: number;
  /** local z of pillars; faces with a sideways normal near these become body */
  pillars: number[];
  pillarWidth: number;
}

export interface BodySpec {
  length: number;
  width: number;
  top: Keyframes;
  belt: Keyframes;
  /** plan-view half width along z (before end rounding) */
  halfWidth: Keyframes;
  topRatio: Keyframes;
  /** underside height along z (without arches) */
  bottom: Keyframes;
  /** plan-view corner radius of the nose / tail */
  noseRadius: number;
  tailRadius: number;
  /** vertical edge rounding at nose / tail (hood-to-bumper, trunk-to-bumper) */
  noseEdge: number;
  tailEdge: number;
  /** cross-section shape controls */
  bottomRatio: number;
  crown: number;
  shoulderRound: number;
  /** below this height faces belong to the lower-trim group */
  trimHeight: number;
  wheels: WheelSpec;
  glass: GlassSpec;
  /** loft resolution along the length (metres) */
  stationSpacing?: number;
}

export interface LoftResult {
  geometry: THREE.BufferGeometry;
  stats: { stations: number; ringPoints: number; faces: number; glassFaces: number; trimFaces: number };
}

export interface RingParams {
  halfWidth: number;
  bottomHalfWidth: number;
  topHalfWidth: number;
  bottom: number;
  belt: number;
  top: number;
  crown: number;
  shoulderRound: number;
}

/** Sample counts for the three ring segments (lower body, greenhouse side, roof). */
export const RING_LOWER = 10;
export const RING_UPPER = 7;
export const RING_TOP = 5;

/**
 * Right half of the ring, bottom centre → top centre. Returned as RING_LOWER + RING_UPPER + RING_TOP + 1
 * points; index RING_LOWER is exactly the shoulder and RING_LOWER + RING_UPPER exactly the roof edge,
 * which lets faces be bucketed into body / glass by ring segment rather than by geometry tests.
 */
export function buildHalfRing(p: RingParams): THREE.Vector2[] {
  const wb = Math.min(p.bottomHalfWidth, p.halfWidth);
  const w = Math.max(p.halfWidth, 0.002);
  const wt = Math.min(p.topHalfWidth, w);
  const zb = p.bottom;
  const zs = Math.min(p.belt, p.top - 0.01);
  const zt = p.top;
  const rb = Math.max(0.005, Math.min(0.1, wb * 0.35, (zs - zb) * 0.35));

  const lower = new THREE.Path();
  lower.moveTo(0, zb);
  lower.lineTo(Math.max(wb - rb, 0), zb);
  lower.quadraticCurveTo(wb, zb, wb, zb + rb);
  // lower side: bulges outward to the shoulder
  lower.bezierCurveTo(wb + (w - wb) * 0.85, zb + (zs - zb) * 0.35, w, zs - (zs - zb) * 0.25, w, zs);

  const upper = new THREE.Path();
  upper.moveTo(w, zs);
  const dz = Math.max(zt - zs, 0.01);
  const sr = THREE.MathUtils.clamp(p.shoulderRound, 0.05, 0.95);
  upper.bezierCurveTo(w, zs + dz * sr * 0.7, wt + (w - wt) * sr * 0.55, zt, wt, zt);

  const top = new THREE.Path();
  top.moveTo(wt, zt);
  top.quadraticCurveTo(wt * 0.45, zt + p.crown, 0, zt + p.crown);

  const a = lower.getSpacedPoints(RING_LOWER);
  const b = upper.getSpacedPoints(RING_UPPER);
  const c = top.getSpacedPoints(RING_TOP);
  return [...a, ...b.slice(1), ...c.slice(1)];
}

function endFactor(distFromEnd: number, radius: number, exponent: number): number {
  if (radius <= 0 || distFromEnd >= radius) return 1;
  const t = THREE.MathUtils.clamp((radius - distFromEnd) / radius, 0, 1);
  return Math.pow(Math.max(0, 1 - Math.pow(t, exponent)), 1 / exponent);
}

export function buildBodyGeometry(spec: BodySpec): LoftResult {
  const L = spec.length;
  const half = L / 2;
  const spacing = spec.stationSpacing ?? 0.06;
  const halfSamples = RING_LOWER + RING_UPPER + RING_TOP;

  const top = monotoneCurve(spec.top);
  const belt = monotoneCurve(spec.belt);
  const halfWidth = monotoneCurve(spec.halfWidth);
  const topRatio = monotoneCurve(spec.topRatio);
  const bottom = monotoneCurve(spec.bottom);
  const { wheels } = spec;
  const archR = wheels.radius + wheels.archGap;

  // Stations: uniform, plus extra density at both ends where rounding happens.
  const stations: number[] = [];
  const nUniform = Math.max(8, Math.round(L / spacing));
  for (let i = 0; i <= nUniform; i++) stations.push(-half + (i / nUniform) * L);
  const endSpan = Math.max(spec.noseRadius, spec.tailRadius, 0.3);
  for (let i = 1; i <= 6; i++) {
    const d = (endSpan * i * i) / 36; // quadratic density toward the tip
    stations.push(half - d, -half + d);
  }
  stations.sort((a, b) => a - b);
  // Dedupe near-identical stations.
  const uniq: number[] = [];
  for (const s of stations) if (uniq.length === 0 || s - uniq[uniq.length - 1] > 1e-4) uniq.push(s);

  const rings: THREE.Vector2[][] = [];
  const ringStation: number[] = [];
  for (const s of uniq) {
    const dNose = half - s;
    const dTail = s + half;
    const wPlan = halfWidth(s);
    const fPlan = Math.min(endFactor(dNose, spec.noseRadius, 2.6), endFactor(dTail, spec.tailRadius, 2.6));
    // Keep a flat bumper face: plan rounding only removes the corner radius, not the full width.
    const cornerNose = Math.min(spec.noseRadius, wPlan * 0.95);
    const cornerTail = Math.min(spec.tailRadius, wPlan * 0.95);
    const corner = dNose < dTail ? cornerNose : cornerTail;
    const w = wPlan - corner + corner * fPlan;

    let zb = bottom(s);
    for (const zw of [wheels.frontZ, wheels.rearZ]) {
      const dx = s - zw;
      if (Math.abs(dx) < archR) zb = Math.max(zb, wheels.radius + Math.sqrt(archR * archR - dx * dx));
    }
    let zt = top(s);
    const fEdge = Math.min(endFactor(dNose, spec.noseEdge, 2.2), endFactor(dTail, spec.tailEdge, 2.2));
    const edge = dNose < dTail ? spec.noseEdge : spec.tailEdge;
    zt = zt - edge + edge * fEdge;
    zt = Math.max(zt, zb + 0.05);
    const zs = Math.min(belt(s), zt - 0.02);

    const ring = buildHalfRing({
      halfWidth: w,
      bottomHalfWidth: w * spec.bottomRatio,
      topHalfWidth: w * topRatio(s),
      bottom: zb,
      belt: Math.max(zs, zb + 0.03),
      top: zt,
      crown: spec.crown,
      shoulderRound: spec.shoulderRound,
    });
    rings.push(ring);
    ringStation.push(s);
  }

  // Assemble vertex positions: full ring = right half (bottom→top) + mirrored left half (top→bottom).
  const halfCount = halfSamples + 1;
  const ringCount = halfCount * 2 - 2;
  const nStations = rings.length;
  const positions: number[] = [];
  const ringVertex = (ri: number, k: number): number => ri * ringCount + k;
  for (let ri = 0; ri < nStations; ri++) {
    const s = ringStation[ri];
    const r = rings[ri];
    for (let k = 0; k < halfCount; k++) positions.push(r[k].x, r[k].y, s);
    for (let k = halfCount - 2; k >= 1; k--) positions.push(-r[k].x, r[k].y, s);
  }

  // Faces by group. Ring index k maps to a segment: lower body (k < RING_LOWER), greenhouse side
  // (RING_LOWER ≤ k < RING_LOWER + RING_UPPER), roof (rest) — mirrored on the left half.
  const groups: number[][] = [[], [], []];
  const px = (i: number) => positions[i * 3];
  const py = (i: number) => positions[i * 3 + 1];
  const pz = (i: number) => positions[i * 3 + 2];
  const segmentOf = (k: number): 'lower' | 'upper' | 'top' => {
    const kk = k < halfCount ? k : ringCount - k; // mirror index for the left half
    if (kk < RING_LOWER) return 'lower';
    if (kk < RING_LOWER + RING_UPPER) return 'upper';
    return 'top';
  };
  const g = spec.glass;
  const classifyQuad = (ri: number, k: number, a: number, b: number, c: number): number => {
    void b;
    const zMid = (ringStation[ri] + ringStation[ri + 1]) / 2;
    const seg = segmentOf(k);
    const inCabin = zMid >= g.zRear && zMid <= g.zFront;
    if (inCabin && seg !== 'lower') {
      const nearPillar = g.pillars.some((pz0) => Math.abs(zMid - pz0) < g.pillarWidth / 2);
      if (seg === 'upper' && !nearPillar) return 1;
      if (seg === 'top') {
        if (g.roofIsGlass) return 1;
        // Windshield / rear window: the roof profile slopes more steeply than the roof threshold.
        const z1 = ringStation[ri];
        const z2 = ringStation[ri + 1];
        const slope = Math.abs((top(z2) - top(z1)) / Math.max(z2 - z1, 1e-4));
        const upComponent = 1 / Math.sqrt(1 + slope * slope);
        if (upComponent < g.roofNormalY) return 1;
      }
    }
    if (seg === 'lower') {
      const cy = (py(a) + py(b) + py(c)) / 3;
      if (cy < spec.trimHeight) return 2;
    }
    return 0;
  };
  for (let ri = 0; ri < nStations - 1; ri++) {
    for (let k = 0; k < ringCount; k++) {
      const k2 = (k + 1) % ringCount;
      const a = ringVertex(ri, k);
      const b = ringVertex(ri, k2);
      const c = ringVertex(ri + 1, k2);
      const d = ringVertex(ri + 1, k);
      // Both triangles of a quad share a group so boundaries follow the mesh grid.
      const group = classifyQuad(ri, k, a, b, c);
      groups[group].push(a, b, c, a, c, d);
    }
  }

  // Flat end caps with their own vertices so the edge stays crisp.
  const capIndices: number[] = [];
  const addCap = (ri: number, front: boolean) => {
    const base = positions.length / 3;
    const r = rings[ri];
    const s = ringStation[ri];
    const cy = (r[0].y + r[halfCount - 1].y) / 2;
    positions.push(0, cy, s);
    for (let k = 0; k < ringCount; k++) {
      const src = ringVertex(ri, k);
      positions.push(px(src), py(src), pz(src));
    }
    for (let k = 0; k < ringCount; k++) {
      const k2 = (k + 1) % ringCount;
      if (front) capIndices.push(base, base + 1 + k, base + 1 + k2);
      else capIndices.push(base, base + 1 + k2, base + 1 + k);
    }
  };
  addCap(0, false);
  addCap(nStations - 1, true);

  const index: number[] = [];
  const geometry = new THREE.BufferGeometry();
  let offset = 0;
  const groupOrder = [0, 1, 2];
  for (const gi of groupOrder) {
    const list = gi === 0 ? [...groups[0], ...capIndices] : groups[gi];
    if (list.length === 0) continue;
    index.push(...list);
    geometry.addGroup(offset, list.length, gi);
    offset += list.length;
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    stats: {
      stations: nStations,
      ringPoints: ringCount,
      faces: index.length / 3,
      glassFaces: groups[1].length / 3,
      trimFaces: groups[2].length / 3,
    },
  };
}
