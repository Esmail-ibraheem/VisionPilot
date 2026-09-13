import type { Vec2 } from '../geometry';
import { hash2, slotHash } from '../hash';
import { idm } from '../live';
import type { Crosswalk, Marking, PedestrianState, TrafficLightState, VehicleState, VehicleType, WorldState } from '../types';
import {
  armLight,
  armWalk,
  connector,
  exitsFrom,
  incomingLanes,
  outgoingLanes,
  targetLane,
  turnBetween,
  type Arm,
  type Junction,
  type RoadNetworkMap,
  type Segment,
  type Turn,
} from './network';
import type { Polyline } from './polyline';
import { wrap } from './polyline';

const KPH = 1 / 3.6;
const WALK_SPEED = 1.3;
const EGO_LENGTH = 4.72;
const CULL_DIST = 175;
const ACTIVE_RADIUS = 380;
const SPAWN_MIN_DIST = 140;
const MAX_CARS = 70;
const VEHICLE_LENGTH: Record<VehicleType, number> = { sedan: 4.7, crossover: 4.6, van: 5.0 };

type Side = 'fwd' | 'bwd';

interface SegPiece {
  kind: 'seg';
  seg: Segment;
  side: Side;
  lane: number;
}

interface ConnPiece {
  kind: 'conn';
  line: Polyline;
  /** null for a U-turn at the extract boundary */
  junction: Junction | null;
  from: Arm;
  to: Arm;
  toLane: number;
  turn: Turn;
}

type Piece = SegPiece | ConnPiece;

interface Car {
  id: string;
  type: VehicleType;
  piece: Piece;
  /** progress along the piece in the travel direction */
  p: number;
  speed: number;
  cruise: number;
  length: number;
  tint: number;
  brake: boolean;
  next: { from: Arm; arm: Arm; lane: number; turn: Turn; line: Polyline; junction: Junction | null } | null | 'terminal';
  isEgo: boolean;
  waitTimer: number;
  visited: string[];
}

interface Walker {
  id: string;
  seg: Segment;
  u: number;
  v: number;
  dir: 1 | -1;
  phase: number;
  mode: 'walk' | 'wait' | 'cross';
  crossing: { id: string; from: number; to: number; u: number } | null;
  handled: string;
}

interface Parked extends VehicleState {
  seg: Segment;
}

function pieceLength(p: Piece): number {
  return p.kind === 'seg' ? p.seg.line.length : p.line.length;
}

function segU(piece: SegPiece, p: number): number {
  return piece.side === 'fwd' ? p : piece.seg.line.length - p;
}

function pickType(h: number): VehicleType {
  return h < 0.62 ? 'sedan' : h < 0.88 ? 'crossover' : 'van';
}

/**
 * Traffic on a real (OpenStreetMap-derived) road network: cars follow lanes, pick exits at
 * junctions, obey signals and priority, yield when turning left; pedestrians walk the sidewalks and
 * cross at crossings; parked cars fill the mapped parking strips. The ego is a car with a route
 * policy and the same controller.
 */
export class MapWorld {
  readonly net: RoadNetworkMap;
  time = 0;
  cars: Car[] = [];
  walkers: Walker[] = [];
  parked: Parked[] = [];
  ego: Car;
  private serial = 0;
  private spawnTimer = 0;
  private active: Segment[] = [];
  private activeAt = -10;
  private parkedIds = new Set<string>();
  private walkerSlots = new Set<string>();
  private markingCache = new Map<string, { markings: Marking[]; crosswalks: Crosswalk[] }>();

  constructor(net: RoadNetworkMap, opts: { startStreets?: string[] } = {}) {
    this.net = net;
    const start = this.pickStart(opts.startStreets ?? ['Kollwitzstraße', 'Knaackstraße', 'Sredzkistraße', 'Wörther Straße', 'Rykestraße']);
    this.ego = {
      id: 'ego',
      type: 'sedan',
      piece: { kind: 'seg', seg: start.seg, side: start.side, lane: 0 },
      p: start.p,
      speed: 25 * KPH,
      cruise: start.seg.speedLimit,
      length: EGO_LENGTH,
      tint: 0.5,
      brake: false,
      next: null,
      isEgo: true,
      waitTimer: 0,
      visited: [start.seg.id],
    };
    this.refreshActive(true);
    // Pre-populate: parked cars and pedestrians everywhere (static, safe), traffic beyond 60 m.
    this.populateParking(40);
    this.populateWalkers(30);
    for (let i = 0; i < 60; i++) this.trySpawn(true);
  }

  private pickStart(names: string[]): { seg: Segment; side: Side; p: number } {
    for (const name of names) {
      const cands = this.net.segments.filter((s) => s.name === name && s.line.length > 70 && s.fwd.length > 0);
      if (cands.length) {
        const seg = cands.sort((a, b) => b.line.length - a.line.length)[0];
        return { seg, side: 'fwd', p: Math.min(12, seg.line.length / 3) };
      }
    }
    const seg = [...this.net.segments].sort((a, b) => b.line.length - a.line.length).find((s) => s.fwd.length > 0)!;
    return { seg, side: 'fwd', p: 10 };
  }

  // ─── geometry helpers ───────────────────────────────────────────────────────

  private pose(c: Car): { x: number; z: number; heading: number } {
    if (c.piece.kind === 'seg') {
      const { seg, side, lane } = c.piece;
      const u = segU(c.piece, c.p);
      const v = (side === 'fwd' ? seg.fwd : seg.bwd)[lane];
      const pt = seg.line.offsetPoint(u, v);
      const h = seg.line.headingAt(u);
      return { x: pt.x, z: pt.z, heading: side === 'fwd' ? h : wrap(h + Math.PI) };
    }
    const pt = c.piece.line.pointAt(c.p);
    return { x: pt.x, z: pt.z, heading: c.piece.line.headingAt(Math.min(c.p, c.piece.line.length - 0.01)) };
  }

  egoPose(): { x: number; z: number; heading: number } {
    return this.pose(this.ego);
  }

  private endArm(piece: SegPiece): Arm | null {
    const j = piece.side === 'fwd' ? piece.seg.endJunction : piece.seg.startJunction;
    if (!j) return null;
    const end = piece.side === 'fwd' ? 'end' : 'start';
    return j.arms.find((a) => a.seg === piece.seg && a.end === end) ?? null;
  }

  private refreshActive(force = false): void {
    if (!force && this.time - this.activeAt < 1) return;
    this.activeAt = this.time;
    const e = this.egoPose();
    this.active = this.net.segments.filter((s) => {
      const pr = s.line.project(e);
      return pr.dist < ACTIVE_RADIUS;
    });
  }

  // ─── stepping ───────────────────────────────────────────────────────────────

  step(dt: number): void {
    this.time += dt;
    this.refreshActive();
    const all = [this.ego, ...this.cars];
    for (const c of all) this.stepCar(c, dt, all);
    this.stepWalkers(dt);
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.6;
      this.trySpawn(false);
      this.populateParking();
      this.populateWalkers();
    }
    this.cull();
  }

  /** Choose where a car continues after its current segment. */
  private chooseExit(c: Car): void {
    if (c.piece.kind !== 'seg') return;
    const arm = this.endArm(c.piece);
    const seg = c.piece.seg;
    if (!arm) {
      // boundary of the extract: the ego turns around on two-way streets, others leave
      const other: Side = c.piece.side === 'fwd' ? 'bwd' : 'fwd';
      const otherLanes = other === 'fwd' ? seg.fwd : seg.bwd;
      if (c.isEgo && otherLanes.length > 0) {
        const fake: Arm = { seg, end: c.piece.side === 'fwd' ? 'end' : 'start', headingIn: 0, phase: 0, priority: true };
        const line = connector(fake, c.piece.lane, fake, 0);
        c.next = { from: fake, arm: fake, lane: 0, turn: 'uturn', line, junction: null };
        return;
      }
      c.next = 'terminal';
      return;
    }
    const j = c.piece.side === 'fwd' ? seg.endJunction! : seg.startJunction!;
    const inLanes = incomingLanes(arm);
    let exits = exitsFrom(j, arm);
    if (exits.length === 0) {
      const back = j.arms.find((a) => a.seg === arm.seg && outgoingLanes(a).lanes.length > 0);
      if (back) exits = [back];
    }
    if (exits.length === 0) {
      c.next = 'terminal';
      return;
    }
    const scored = exits.map((to) => {
      const turn = turnBetween(arm, to);
      let w = turn === 'straight' ? 3 : turn === 'right' ? 1.2 : turn === 'left' ? 1 : 0.1;
      if (c.isEgo) {
        // prefer roads that continue, avoid recently visited streets and the extract boundary
        const nextJ = to.end === 'start' ? to.seg.endJunction : to.seg.startJunction;
        if (!nextJ) w *= 0.25;
        if (c.visited.slice(-6).includes(to.seg.id)) w *= 0.3;
        if (to.seg.cls === 'living') w *= 0.6;
      }
      return { to, turn, w };
    });
    const total = scored.reduce((a, s) => a + s.w, 0);
    const salt = c.isEgo ? c.visited.length : Number(c.id.slice(1));
    let r = hash2(j.nodeId % 100000, salt, 17) * total;
    let pick = scored[scored.length - 1];
    for (const s of scored) {
      r -= s.w;
      if (r <= 0) {
        pick = s;
        break;
      }
    }
    const lane = targetLane(pick.turn, c.piece.lane, inLanes.lanes.length, outgoingLanes(pick.to).lanes.length);
    c.next = { from: arm, arm: pick.to, lane, turn: pick.turn, line: connector(arm, c.piece.lane, pick.to, lane), junction: j };
  }

  /** Distance to the nearest car ahead along this car's path (same lane, then the chosen connector and target lane). */
  private leaderGap(c: Car, all: Car[]): { gap: number; speed: number } {
    let gap = Infinity;
    let speed = 0;
    const L = pieceLength(c.piece);
    const consider = (o: Car, dist: number) => {
      const g = dist - (o.length + c.length) / 2;
      if (g > -1.5 && g < gap) {
        gap = g;
        speed = o.speed;
      }
    };
    for (const o of all) {
      if (o === c) continue;
      if (samePiece(o.piece, c.piece)) {
        if (o.p > c.p) consider(o, o.p - c.p);
        continue;
      }
      const remaining = L - c.p;
      if (remaining > 70) continue;
      // cars on the connector we are about to take, on the target lane, or merging into it from
      // another connector of the same junction
      if (c.piece.kind === 'seg' && c.next && c.next !== 'terminal') {
        const n = c.next;
        if (o.piece.kind === 'conn' && o.piece.line === n.line) consider(o, remaining + o.p);
        else if (o.piece.kind === 'seg' && onTargetLane(o.piece, n.arm, n.lane) && o.p < 50) consider(o, remaining + n.line.length + o.p);
        else if (o.piece.kind === 'conn' && o.piece.junction === n.junction && o.piece.to === n.arm && o.piece.toLane === n.lane) {
          const mine = remaining + n.line.length; // distance until I reach the lane start
          const theirs = o.piece.line.length - o.p;
          if (theirs < mine) consider(o, mine - theirs);
        }
      } else if (c.piece.kind === 'conn') {
        const me = c.piece;
        if (o.piece.kind === 'seg' && onTargetLane(o.piece, me.to, me.toLane) && o.p < 60) consider(o, remaining + o.p);
        else if (o.piece.kind === 'conn' && o.piece.line !== me.line && o.piece.junction === me.junction && o.piece.to === me.to && o.piece.toLane === me.toLane) {
          const theirs = o.piece.line.length - o.p;
          if (theirs < remaining) consider(o, remaining - theirs);
        }
      }
    }
    return { gap, speed };
  }

  private stepCar(c: Car, dt: number, all: Car[]): void {
    const L = pieceLength(c.piece);
    if (c.piece.kind === 'seg' && c.next === null && L - c.p < 90) this.chooseExit(c);

    let target = c.cruise;
    let { gap, speed: leaderSpeed } = this.leaderGap(c, all);

    if (c.piece.kind === 'seg') {
      const arm = this.endArm(c.piece);
      const remaining = L - c.p;
      const dStop = remaining - 1.2 - c.length / 2;
      const next = c.next;
      const turn = next && next !== 'terminal' ? next.turn : 'straight';
      if (turn !== 'straight' && remaining < 28) target = Math.min(target, (turn === 'right' ? 20 : turn === 'uturn' ? 12 : 24) * KPH);
      if (arm && dStop > -0.6) {
        const j = c.piece.side === 'fwd' ? c.piece.seg.endJunction! : c.piece.seg.startJunction!;
        let mustStop = false;
        if (j.control === 'lights') {
          const state = armLight(j, arm, this.time);
          if (state === 'red') mustStop = true;
          else if (state === 'yellow') mustStop = dStop > (c.speed * c.speed) / (2 * 3.2);
        }
        if (!mustStop && next && next !== 'terminal' && dStop < 14) {
          if (j.control === 'priority' && !arm.priority) {
            mustStop = !this.majorClear(j, arm, all, c);
          } else if (j.control === 'priority' && j.arms.every((a) => a.priority)) {
            // equal streets: right before left, yield to anyone already in the box
            mustStop = !this.rightBeforeLeftClear(j, arm, all, c) && c.waitTimer < 4;
          }
          if (turn === 'left' && j.control !== 'none') {
            mustStop = mustStop || !this.oncomingClear(j, arm, all, c);
          }
          if (mustStop) {
            // stop-sign style dwell: wait, then re-check each step
            if (c.speed < 0.3) c.waitTimer += dt;
          }
        }
        if (mustStop && dStop < gap) {
          gap = dStop;
          leaderSpeed = 0;
        }
      }
      // pedestrians crossing this segment ahead
      const pg = this.pedestrianGap(c);
      if (pg < gap) {
        gap = pg;
        leaderSpeed = 0;
      }
    } else {
      const turn = c.piece.turn;
      target = Math.min(target, (turn === 'right' ? 20 : turn === 'uturn' ? 12 : turn === 'left' ? 24 : 40) * KPH);
    }

    const acc = idm(c.speed, target, gap, leaderSpeed);
    c.speed = Math.max(0, c.speed + acc * dt);
    c.brake = acc < -0.6 || (c.speed < 0.3 && gap < 12);
    c.p += c.speed * dt;

    if (c.p >= L) {
      const over = c.p - L;
      if (c.piece.kind === 'seg') {
        if (c.next && c.next !== 'terminal') {
          const piece: ConnPiece = { kind: 'conn', line: c.next.line, junction: c.next.junction, from: c.next.from, to: c.next.arm, toLane: c.next.lane, turn: c.next.turn };
          c.piece = piece;
          c.p = over;
          c.next = null;
          c.waitTimer = 0;
        } else {
          c.p = L; // terminal: culled below (the ego restarts instead)
          c.next = 'terminal';
          if (c.isEgo) this.restartEgo();
        }
      } else {
        const to = c.piece.to;
        const side = outgoingLanes(to).side;
        c.piece = { kind: 'seg', seg: to.seg, side, lane: c.piece.toLane };
        c.p = over;
        c.cruise = c.isEgo ? to.seg.speedLimit : Math.min(c.cruise, to.seg.speedLimit * 1.05);
        if (c.isEgo) {
          c.visited.push(to.seg.id);
          if (c.visited.length > 30) c.visited.shift();
        }
      }
    }
  }

  /** One-way dead end at the extract boundary: put the ego back on its start street. */
  private restartEgo(): void {
    const start = this.pickStart(['Kollwitzstraße', 'Knaackstraße', 'Sredzkistraße', 'Wörther Straße', 'Rykestraße']);
    this.ego.piece = { kind: 'seg', seg: start.seg, side: start.side, lane: 0 };
    this.ego.p = start.p;
    this.ego.next = null;
    this.ego.speed = 20 * KPH;
  }

  /** No car on priority arms about to enter, and nobody inside the junction. */
  private majorClear(j: Junction, myArm: Arm, all: Car[], me: Car): boolean {
    for (const o of all) {
      if (o === me) continue;
      if (o.piece.kind === 'conn' && o.piece.junction === j) return false;
      if (o.piece.kind !== 'seg') continue;
      const arm = this.endArm(o.piece);
      if (!arm || arm === myArm || !arm.priority) continue;
      if (j.arms.includes(arm) && pieceLength(o.piece) - o.p < 28 && o.speed > 0.3) return false;
    }
    return true;
  }

  /** Nobody in the box and nobody about to enter from the right (German "rechts vor links"). */
  private rightBeforeLeftClear(j: Junction, myArm: Arm, all: Car[], me: Car): boolean {
    for (const o of all) {
      if (o === me) continue;
      if (o.piece.kind === 'conn' && o.piece.junction === j && o.piece.from !== myArm) return false;
      if (o.piece.kind !== 'seg') continue;
      const arm = this.endArm(o.piece);
      if (!arm || arm === myArm || !j.arms.includes(arm)) continue;
      const rel = wrap(arm.headingIn - myArm.headingIn);
      const fromRight = rel < -Math.PI / 4 && rel > (-3 * Math.PI) / 4;
      const remaining = pieceLength(o.piece) - o.p;
      if (fromRight && remaining < 16 && (o.speed > 0.4 || remaining < 4)) return false;
    }
    return true;
  }

  /** Oncoming traffic (opposite arm of the same axis) is neither approaching nor in the junction. */
  private oncomingClear(j: Junction, myArm: Arm, all: Car[], me: Car): boolean {
    for (const o of all) {
      if (o === me) continue;
      if (o.piece.kind === 'conn' && o.piece.junction === j && o.piece.turn !== 'right' && o.piece.from !== myArm) {
        const d = Math.abs(wrap(o.piece.from.headingIn - myArm.headingIn));
        if (d > 2.4) return false;
      }
      if (o.piece.kind !== 'seg') continue;
      const arm = this.endArm(o.piece);
      if (!arm || !j.arms.includes(arm) || arm === myArm) continue;
      const d = Math.abs(wrap(arm.headingIn - myArm.headingIn));
      if (d < 2.4) continue; // not oncoming
      const remaining = pieceLength(o.piece) - o.p;
      if (remaining < 32 && o.speed > 0.4) return false;
    }
    return true;
  }

  private pedestrianGap(c: Car): number {
    if (c.piece.kind !== 'seg') return Infinity;
    const { seg, side, lane } = c.piece;
    const vLane = (side === 'fwd' ? seg.fwd : seg.bwd)[lane];
    const myU = segU(c.piece, c.p);
    let gap = Infinity;
    for (const w of this.walkers) {
      if (w.mode !== 'cross' || w.seg !== seg || !w.crossing) continue;
      const ahead = side === 'fwd' ? w.u - myU : myU - w.u;
      const d = ahead - c.length / 2;
      if (d < -1 || d > 26) continue;
      const dv = w.v - vLane;
      const towards = Math.sign(w.crossing.to - w.crossing.from) === -Math.sign(dv);
      if (Math.abs(dv) < 2.4 || (Math.abs(dv) < 6.5 && towards)) gap = Math.min(gap, d - 2.5);
    }
    return gap;
  }

  // ─── pedestrians ────────────────────────────────────────────────────────────

  private stepWalkers(dt: number): void {
    for (const w of this.walkers) {
      if (w.mode === 'cross' && w.crossing) {
        const dir = Math.sign(w.crossing.to - w.crossing.from);
        w.v += dir * WALK_SPEED * dt;
        w.phase += dt * 6.5;
        if ((dir > 0 && w.v >= w.crossing.to) || (dir < 0 && w.v <= w.crossing.to)) {
          w.v = w.crossing.to;
          w.mode = 'walk';
          w.crossing = null;
        }
        continue;
      }
      if (w.mode === 'wait' && w.crossing) {
        if (this.crossingAllowed(w)) w.mode = 'cross';
        continue;
      }
      w.phase += dt * 6.5;
      w.u += w.dir * WALK_SPEED * dt;
      const L = w.seg.line.length;
      if (w.u < 2) {
        w.u = 2;
        w.dir = 1;
      } else if (w.u > L - 2) {
        w.u = L - 2;
        w.dir = -1;
      }
      for (const cr of w.seg.crossings) {
        if (w.handled === cr.id || Math.abs(w.u - cr.u) > 0.7) continue;
        w.handled = cr.id;
        if (hash2(Math.round(w.u * 10), Number(w.id.slice(1)) || 1, 71) < 0.55) {
          const to = w.v > 0 ? w.seg.sidewalkLeft : w.seg.sidewalkRight;
          w.crossing = { id: cr.id, from: w.v, to, u: cr.u };
          w.u = cr.u;
          w.mode = 'wait';
        }
      }
    }
  }

  private crossingAllowed(w: Walker): boolean {
    const cr = w.seg.crossings.find((c) => c.id === w.crossing!.id);
    if (!cr) return true;
    const L = w.seg.line.length;
    if (cr.kind === 'signals') {
      const nearEnd = cr.u > L / 2;
      const j = nearEnd ? w.seg.endJunction : w.seg.startJunction;
      const arm = j?.arms.find((a) => a.seg === w.seg && a.end === (nearEnd ? 'end' : 'start'));
      if (j && arm && j.control === 'lights') return armWalk(j, arm, this.time);
    }
    // otherwise: cross when no moving car is within 22 m on this segment
    for (const c of [this.ego, ...this.cars]) {
      if (c.piece.kind !== 'seg' || c.piece.seg !== w.seg) continue;
      const u = segU(c.piece, c.p);
      if (Math.abs(u - cr.u) < 22 && c.speed > 0.4) return false;
    }
    return true;
  }

  // ─── population ─────────────────────────────────────────────────────────────

  private trySpawn(initial: boolean): void {
    if (this.cars.length >= MAX_CARS) return;
    const e = this.egoPose();
    const n = this.serial++;
    const seg = this.active[Math.floor(slotHash(n, 51) * this.active.length)];
    if (!seg) return;
    const sides: Side[] = [];
    if (seg.fwd.length) sides.push('fwd');
    if (seg.bwd.length) sides.push('bwd');
    const side = sides[Math.floor(slotHash(n, 52) * sides.length)];
    const lanes = side === 'fwd' ? seg.fwd : seg.bwd;
    const lane = Math.floor(slotHash(n, 53) * lanes.length);
    const piece: SegPiece = { kind: 'seg', seg, side, lane };
    const L = seg.line.length;
    const p = initial ? slotHash(n, 54) * Math.max(0, L - 12) + 6 : 3;
    const pt = seg.line.offsetPoint(segU(piece, p), lanes[lane]);
    if (Math.hypot(pt.x - e.x, pt.z - e.z) < (initial ? 60 : SPAWN_MIN_DIST)) return;
    for (const o of this.cars) {
      if (samePiece(o.piece, piece) && Math.abs(o.p - p) < 26) return;
      const op = this.pose(o);
      if (Math.hypot(op.x - pt.x, op.z - pt.z) < 9) return;
    }
    const h = slotHash(n, 55);
    const car: Car = {
      id: `c${n}`,
      type: pickType(slotHash(n, 56)),
      piece,
      p,
      speed: seg.speedLimit * 0.8,
      cruise: seg.speedLimit * (0.8 + 0.3 * h),
      length: 4.7,
      tint: 0.35 + 0.4 * slotHash(n, 57),
      brake: false,
      next: null,
      isEgo: false,
      waitTimer: 0,
      visited: [],
    };
    car.length = VEHICLE_LENGTH[car.type];
    this.cars.push(car);
  }

  private populateParking(minDist = SPAWN_MIN_DIST): void {
    const e = this.egoPose();
    for (const seg of this.active) {
      const mid = seg.line.pointAt(seg.line.length / 2);
      if (Math.hypot(mid.x - e.x, mid.z - e.z) > 320) continue;
      const segIdx = Number(seg.id.slice(1));
      for (const sideSign of [1, -1] as const) {
        const park = sideSign > 0 ? seg.parkingRight : seg.parkingLeft;
        if (!park) continue;
        const half = sideSign > 0 ? seg.halfRight : seg.halfLeft;
        const v = sideSign * (half + park.width / 2 + 0.2);
        const period = park.orientation === 'parallel' ? 6.3 : park.orientation === 'diagonal' ? 3.6 : 2.7;
        const fill = park.orientation === 'parallel' ? 0.68 : 0.62;
        const L = seg.line.length;
        for (let k = 0; ; k++) {
          const u = 9 + k * period;
          if (u > L - 9) break;
          const id = `${seg.id}:p${sideSign > 0 ? 'r' : 'l'}${k}`;
          if (this.parkedIds.has(id)) continue;
          if (hash2(segIdx, k * 2 + (sideSign > 0 ? 0 : 1), 81) > fill) continue;
          if (seg.crossings.some((c) => Math.abs(c.u - u) < 4.5)) continue;
          const pt = seg.line.offsetPoint(u, v);
          if (Math.hypot(pt.x - e.x, pt.z - e.z) < minDist) continue;
          const roadHeading = seg.line.headingAt(u);
          // parallel: face the travel direction of that side; angled: nose toward the kerb
          let heading: number;
          if (park.orientation === 'parallel') heading = sideSign > 0 || seg.oneway ? roadHeading : wrap(roadHeading + Math.PI);
          else if (park.orientation === 'perpendicular') heading = wrap(roadHeading + (sideSign * Math.PI) / 2);
          else heading = sideSign > 0 || seg.oneway ? wrap(roadHeading + (sideSign * Math.PI) / 4) : wrap(roadHeading + Math.PI - Math.PI / 4);
          this.parkedIds.add(id);
          this.parked.push({
            id,
            type: pickType(hash2(segIdx, k, 83)),
            x: pt.x,
            z: pt.z,
            heading,
            parked: true,
            brake: false,
            tint: 0.35 + 0.4 * hash2(segIdx, k, 85),
            seg,
          });
        }
      }
    }
  }

  private populateWalkers(minDist = SPAWN_MIN_DIST): void {
    const e = this.egoPose();
    const period = 46;
    for (const seg of this.active) {
      const segIdx = Number(seg.id.slice(1));
      for (let k = 0; k * period + 8 < seg.line.length; k++) {
        for (const side of [1, -1] as const) {
          const id = `${seg.id}:w${k}${side > 0 ? 'r' : 'l'}`;
          if (this.walkerSlots.has(id)) continue;
          const u = 8 + k * period + hash2(segIdx, k, 91) * Math.min(20, seg.line.length - 16);
          const v = side > 0 ? seg.sidewalkRight : seg.sidewalkLeft;
          const pt = seg.line.offsetPoint(u, v);
          if (Math.hypot(pt.x - e.x, pt.z - e.z) < minDist) continue;
          this.walkerSlots.add(id);
          if (hash2(segIdx, k * 2 + (side > 0 ? 0 : 1), 92) > 0.32) continue;
          this.walkers.push({
            id,
            seg,
            u,
            v,
            dir: hash2(segIdx, k, 93) < 0.5 ? 1 : -1,
            phase: hash2(segIdx, k, 94) * 6,
            mode: 'walk',
            crossing: null,
            handled: '',
          });
        }
      }
    }
  }

  private cull(): void {
    const e = this.egoPose();
    const far = (p: Vec2, limit: number) => Math.hypot(p.x - e.x, p.z - e.z) > limit;
    this.cars = this.cars.filter((c) => {
      if (c.next === 'terminal' && c.p >= pieceLength(c.piece) - 0.01) return false;
      return !far(this.pose(c), 430);
    });
    this.parked = this.parked.filter((p) => {
      const keep = !far(p, 460);
      if (!keep) this.parkedIds.delete(p.id);
      return keep;
    });
    this.walkers = this.walkers.filter((w) => !far(w.seg.line.offsetPoint(w.u, w.v), 430));
  }

  // ─── state output ───────────────────────────────────────────────────────────

  toState(base: WorldState): WorldState {
    const egoPose = this.egoPose();
    const near = (x: number, z: number, limit = CULL_DIST) => Math.hypot(x - egoPose.x, z - egoPose.z) <= limit;
    const vehicles: VehicleState[] = [];
    for (const c of this.cars) {
      const p = this.pose(c);
      if (!near(p.x, p.z)) continue;
      vehicles.push({ id: c.id, type: c.type, x: p.x, z: p.z, heading: p.heading, parked: false, brake: c.brake, tint: c.tint });
    }
    for (const p of this.parked) {
      if (!near(p.x, p.z)) continue;
      vehicles.push({ id: p.id, type: p.type, x: p.x, z: p.z, heading: p.heading, parked: true, brake: false, tint: p.tint });
    }
    const pedestrians: PedestrianState[] = [];
    for (const w of this.walkers) {
      const pt = w.seg.line.offsetPoint(w.u, w.v);
      if (!near(pt.x, pt.z)) continue;
      const roadH = w.seg.line.headingAt(w.u);
      let heading: number;
      if (w.mode === 'cross' && w.crossing) heading = wrap(roadH + (Math.sign(w.crossing.to - w.crossing.from) > 0 ? Math.PI / 2 : -Math.PI / 2));
      else heading = w.dir > 0 ? roadH : wrap(roadH + Math.PI);
      pedestrians.push({ id: w.id, x: pt.x, z: pt.z, heading, phase: w.mode === 'wait' ? Math.round(w.phase / Math.PI) * Math.PI : w.phase });
    }
    const markings: Marking[] = [];
    const crosswalks: Crosswalk[] = [];
    for (const seg of this.active) {
      const mid = seg.line.pointAt(seg.line.length / 2);
      if (!near(mid.x, mid.z, CULL_DIST + seg.line.length / 2 + 30)) continue;
      let cached = this.markingCache.get(seg.id);
      if (!cached) {
        cached = { markings: [], crosswalks: [] };
        this.segmentMarkings(seg, cached.markings, cached.crosswalks);
        this.markingCache.set(seg.id, cached);
      }
      markings.push(...cached.markings);
      crosswalks.push(...cached.crosswalks);
    }
    const trafficLights: TrafficLightState[] = [];
    for (const j of this.net.junctions) {
      if (j.control !== 'lights' || !near(j.center.x, j.center.z, CULL_DIST + 30)) continue;
      for (const arm of j.arms) {
        if (incomingLanes(arm).lanes.length === 0) continue;
        const seg = arm.seg;
        const u = arm.end === 'end' ? seg.line.length : 0;
        const side = arm.end === 'end' ? seg.halfRight + 1.3 : -(seg.halfLeft + 1.3);
        const pt = seg.line.offsetPoint(u, side);
        trafficLights.push({ id: `${j.id}:${seg.id}:${arm.end}`, x: pt.x, z: pt.z, heading: wrap(arm.headingIn + Math.PI), state: armLight(j, arm, this.time) });
      }
    }
    const route = this.routeAhead(46);
    const cruiseSeg = this.ego.piece.kind === 'seg' ? this.ego.piece.seg : this.ego.piece.to.seg;
    return {
      ...base,
      time: this.time,
      ego: { x: egoPose.x, z: egoPose.z, heading: egoPose.heading, speedKph: this.ego.speed * 3.6 },
      egoBrake: this.ego.brake,
      speedLimit: Math.round(cruiseSeg.speedLimit / KPH),
      streetName: cruiseSeg.name,
      vehicles,
      pedestrians,
      lanes: { ...base.lanes, markings, crosswalks, arrows: [] },
      props: { trafficLights, signs: [] },
      route: { points: route },
      buildings: this.net.buildings,
      mapId: this.net.name,
    };
  }

  /** Points along the ego's path for the planned-path ribbon. */
  private routeAhead(length: number): Vec2[] {
    const pts: Vec2[] = [];
    let piece: Piece = this.ego.piece;
    let p = this.ego.p;
    let next = this.ego.next;
    let budget = length;
    let guard = 0;
    while (budget > 0 && guard++ < 4) {
      const L = pieceLength(piece);
      const step = 1.5;
      for (let s = p; s <= Math.min(L, p + budget); s += step) {
        pts.push(piece.kind === 'seg' ? piece.seg.line.offsetPoint(segU(piece, s), (piece.side === 'fwd' ? piece.seg.fwd : piece.seg.bwd)[piece.lane]) : piece.line.pointAt(s));
      }
      budget -= L - p;
      if (budget <= 0) break;
      if (piece.kind === 'seg') {
        if (!next || next === 'terminal') break;
        piece = { kind: 'conn', line: next.line, junction: next.junction, from: next.from, to: next.arm, toLane: next.lane, turn: next.turn };
        p = 0;
      } else {
        const to = piece.to;
        piece = { kind: 'seg', seg: to.seg, side: outgoingLanes(to).side, lane: piece.toLane };
        p = 0;
        next = null;
      }
    }
    return pts;
  }

  private segmentMarkings(seg: Segment, out: Marking[], crosswalks: Crosswalk[]): void {
    const w = seg.laneWidth;
    const line = (id: string, v: number, kind: Marking['kind'], dashed: boolean, width: number) => {
      out.push({ id: `${seg.id}:${id}`, kind, dashed, width, points: seg.line.offsetPolyline(v) });
    };
    if (!seg.oneway) line('c', 0, 'center', false, 0.12);
    for (let i = 1; i < seg.fwd.length; i++) line(`f${i}`, seg.oneway ? seg.fwd[i] - w / 2 : i * w, 'lane', true, 0.12);
    for (let i = 1; i < seg.bwd.length; i++) line(`b${i}`, -i * w, 'lane', true, 0.12);
    line('e+', seg.halfRight, 'edge', false, 0.1);
    line('e-', -seg.halfLeft, 'edge', false, 0.1);
    // kerbs: outer edge of the parking strip (where the sidewalk starts)
    line('k+', seg.sidewalkRight - 1.6, 'edge', false, 0.14);
    line('k-', seg.sidewalkLeft + 1.6, 'edge', false, 0.14);
    // stop lines at junction ends for the approaching lanes
    if (seg.endJunction && seg.endJunction.control !== 'none' && seg.fwd.length) {
      const u = seg.line.length - 1.0;
      out.push({ id: `${seg.id}:stopE`, kind: 'stop', dashed: false, width: 0.4, points: [seg.line.offsetPoint(u, seg.oneway ? -seg.halfLeft : 0), seg.line.offsetPoint(u, seg.halfRight)] });
    }
    if (seg.startJunction && seg.startJunction.control !== 'none' && seg.bwd.length) {
      const u = 1.0;
      out.push({ id: `${seg.id}:stopS`, kind: 'stop', dashed: false, width: 0.4, points: [seg.line.offsetPoint(u, -seg.halfLeft), seg.line.offsetPoint(u, 0)] });
    }
    for (const c of seg.crossings) {
      if (c.kind === 'unmarked') continue;
      const pt = seg.line.pointAt(c.u);
      crosswalks.push({ id: c.id, x: pt.x, z: pt.z, heading: seg.line.headingAt(c.u), length: seg.halfLeft + seg.halfRight, depth: 3 });
    }
  }
}

function samePiece(a: Piece, b: Piece): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'seg' && b.kind === 'seg') return a.seg === b.seg && a.side === b.side && a.lane === b.lane;
  if (a.kind === 'conn' && b.kind === 'conn') return a.line === b.line;
  return false;
}

function onTargetLane(piece: SegPiece, arm: Arm, lane: number): boolean {
  return piece.seg === arm.seg && piece.side === outgoingLanes(arm).side && piece.lane === lane;
}
