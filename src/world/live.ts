import { dirOf, frameToWorld, worldToFrame, type Vec2 } from './geometry';
import { hash2, slotHash } from './hash';
import {
  CROSSWALK_CENTER,
  EGO_LANE_V,
  LANES_V,
  ROAD_HALF_W,
  STOP_LINE_OFFSET,
  RoadNetwork,
  lightState,
  walkAllowed,
  type Intersection,
  type Leg,
  type Movement,
  type Road,
} from './network';
import type {
  Crosswalk,
  Marking,
  PedestrianState,
  SignState,
  TrafficLightState,
  VehicleState,
  VehicleType,
  WorldState,
} from './types';

const KPH = 1 / 3.6;
const WALK_SPEED = 1.3;
const ACTIVE_BEHIND = 70;
const ACTIVE_AHEAD = 290;
const CROSS_ROAD_EXTENT = 150;
const SPAWN_MIN_DIST = 135; // never create a moving object closer than this to the ego
const CULL_DIST = 175;
const EGO_LENGTH = 4.72;
const SIDEWALK_RIGHT = 8.2;
const SIDEWALK_LEFT = -10.4;
const PARK_LEFT_V = -8.15;
const PARK_RIGHT_V = 11.4;

interface Car {
  id: string;
  type: VehicleType;
  road: Road;
  lane: number; // index into LANES_V
  fromLane: number; // while changing lanes: the lane being left
  dir: 1 | -1;
  u: number;
  v: number;
  vFrom: number;
  vTo: number;
  changeT: number; // 1 = not changing
  speed: number;
  cruise: number;
  length: number;
  tint: number;
  brake: boolean;
  waitTimer: number; // stop-sign dwell
  changeCooldown: number;
}

interface Walker {
  id: string;
  road: Road;
  u: number;
  v: number;
  dir: 1 | -1;
  phase: number;
  mode: 'walk' | 'wait' | 'cross';
  heading: number;
  handled: string;
  cross: { from: Vec2; to: Vec2; t: number; len: number } | null;
  pending: { inter: Intersection; uOnRoad: number; stage: 'own' | 'other' } | null;
  wx: number;
  wz: number;
}

interface Parked extends VehicleState {
  road: Road;
}

const VEHICLE_LENGTH: Record<VehicleType, number> = { sedan: 4.7, crossover: 4.6, van: 5.0 };

function pickType(h: number): VehicleType {
  return h < 0.62 ? 'sedan' : h < 0.88 ? 'crossover' : 'van';
}

/** Intelligent-driver-model style acceleration (m/s²). */
export function idm(speed: number, target: number, gap: number, leaderSpeed: number): number {
  const s0 = 2.2;
  const T = 1.15;
  const a = 1.9;
  const b = 2.6;
  const tgt = Math.max(target, 0.5);
  const sStar = s0 + Math.max(0, speed * T + (speed * (speed - leaderSpeed)) / (2 * Math.sqrt(a * b)));
  const acc = a * (1 - Math.pow(speed / tgt, 4) - (gap > 0.05 ? Math.pow(sStar / gap, 2) : 6));
  return Math.max(-7, Math.min(a, acc));
}

/**
 * The live demo world: the ego drives the generated route while lane traffic, cross traffic,
 * parked rows and pedestrians populate the roads. Deterministic for a given elapsed-time sequence.
 */
export class LiveWorld {
  readonly network = new RoadNetwork();
  time = 0;
  egoS = 0;
  egoSpeed = 42 * KPH;
  egoBrake = false;
  cars: Car[] = [];
  walkers: Walker[] = [];
  parked: Parked[] = [];
  private serial = 0;
  private spawnTimers = new Map<string, number>();
  private spawnedWalkers = new Set<string>();
  private parkedIds = new Set<string>();
  private laneChangeSerial = 0;
  private markingCache = new Map<string, { key: string; markings: Marking[]; crosswalks: Crosswalk[] }>();

  constructor(initial: WorldState) {
    this.network.ensureAhead(0, 600);
    const road0 = this.network.legs[0].road;
    for (const v of initial.vehicles) {
      if (v.parked) {
        this.parked.push({ ...v, road: road0 });
        this.parkedIds.add(v.id);
        continue;
      }
      const { u, v: lat } = worldToFrame(road0.frame, { x: v.x, z: v.z });
      const lane = Math.abs(lat - LANES_V[0]) < Math.abs(lat - LANES_V[1]) ? 0 : 1;
      const car = this.makeCar(v.type, road0, lane, u, v.id.startsWith('q') ? 36 * KPH : 42 * KPH, v.tint);
      car.id = v.id;
      car.v = lat;
      car.vFrom = lat;
      car.vTo = LANES_V[lane];
      car.changeT = Math.abs(lat - LANES_V[lane]) > 0.25 ? 0 : 1;
      car.brake = v.brake;
      this.cars.push(car);
    }
    for (const p of initial.pedestrians) {
      const { u, v: lat } = worldToFrame(road0.frame, { x: p.x, z: p.z });
      this.walkers.push(this.makeWalker(road0, u, lat, 1, p.id));
    }
  }

  private makeCar(type: VehicleType, road: Road, lane: number, u: number, cruise: number, tint: number): Car {
    const v = LANES_V[lane];
    return {
      id: `c${this.serial++}`,
      type,
      road,
      lane,
      fromLane: lane,
      dir: v > 0 ? 1 : -1,
      u,
      v,
      vFrom: v,
      vTo: v,
      changeT: 1,
      speed: cruise,
      cruise,
      length: VEHICLE_LENGTH[type],
      tint,
      brake: false,
      waitTimer: 0,
      changeCooldown: 0,
    };
  }

  private makeWalker(road: Road, u: number, v: number, dir: 1 | -1, id?: string): Walker {
    const p = frameToWorld(road.frame, u, v);
    return {
      id: id ?? `w${this.serial++}`,
      road,
      u,
      v,
      dir,
      phase: slotHash(this.serial, 41) * 6,
      mode: 'walk',
      heading: road.frame.heading + (dir > 0 ? 0 : Math.PI),
      handled: '',
      cross: null,
      pending: null,
      wx: p.x,
      wz: p.z,
    };
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  currentLeg(): Leg {
    return this.network.legAt(this.egoS);
  }

  /** Ego expressed on its leg road: u along the road; `inArc` while turning at the leg's end. */
  private egoRoadPos(): { leg: Leg; u: number; inArc: boolean } {
    const leg = this.currentLeg();
    if (this.egoS > leg.sTurn && leg.turnIntersection) {
      return { leg, u: leg.turnIntersection.uA - EGO_LANE_V - 1, inArc: true };
    }
    return { leg, u: this.network.legStartU(leg) + (this.egoS - leg.sStart), inArc: false };
  }

  private egoWorld(): Vec2 {
    const p = this.network.route.poseAt(this.egoS);
    return { x: p.x, z: p.z };
  }

  private movementFor(car: Car, entry: Road['intersections'][number]): Movement {
    if (!entry.asA) return 'B';
    if (car.dir < 0) return 'A-';
    return car.lane === 0 ? 'A+in' : 'A+';
  }

  private nextIntersection(road: Road, u: number, dir: 1 | -1): Road['intersections'][number] | null {
    let best: Road['intersections'][number] | null = null;
    for (const e of road.intersections) {
      const d = dir * (e.u - u);
      if (d > -STOP_LINE_OFFSET && (best === null || d < dir * (best.u - u))) best = e;
    }
    return best;
  }

  /** No moving vehicle (or the ego) within `radius` metres of u = `uAt` on `road`. */
  private roadClearAt(road: Road, uAt: number, radius: number): boolean {
    for (const c of this.cars) {
      if (c.road === road && Math.abs(c.u - uAt) < radius && c.speed > 0.4) return false;
    }
    const e = this.egoRoadPos();
    if (e.leg.road === road && Math.abs(e.u - uAt) < radius) return false;
    const p = frameToWorld(road.frame, uAt, 0);
    const ego = this.egoWorld();
    if (Math.hypot(p.x - ego.x, p.z - ego.z) < radius * 0.8) return false;
    return true;
  }

  private activeRoads(): Road[] {
    const { leg, u: egoU } = this.egoRoadPos();
    const roads: Road[] = [leg.road];
    const prev = this.network.legs[leg.index - 1];
    if (prev && this.egoS - leg.sStart < 90) roads.push(prev.road);
    for (const e of leg.road.intersections) {
      if (!e.asA) continue;
      const d = e.u - egoU;
      if (d > -50 && d < ACTIVE_AHEAD - 40) roads.push(e.intersection.roadB);
    }
    return Array.from(new Set(roads));
  }

  /** Active u-window on a road: around the ego on the leg road, around the crossing on side roads. */
  private roadWindow(road: Road): [number, number] {
    const { leg, u } = this.egoRoadPos();
    if (road === leg.road) return [Math.max(road.uMin, u - ACTIVE_BEHIND), Math.min(road.uMax, u + ACTIVE_AHEAD)];
    const prev = this.network.legs[leg.index - 1];
    if (prev && road === prev.road) {
      const uTurn = prev.turnIntersection!.uA;
      return [Math.max(road.uMin, uTurn - ACTIVE_BEHIND - 40), Math.min(road.uMax, uTurn + 140)];
    }
    return [-CROSS_ROAD_EXTENT, CROSS_ROAD_EXTENT];
  }

  // ─── stepping ───────────────────────────────────────────────────────────────

  step(dt: number): void {
    this.time += dt;
    this.network.ensureAhead(this.egoS, 500);
    const active = this.activeRoads();
    const activeSet = new Set(active);
    for (const w of this.walkers) {
      const p = frameToWorld(w.road.frame, w.u, w.v);
      w.wx = p.x;
      w.wz = p.z;
    }
    this.stepEgo(dt);
    this.stepCars(dt, activeSet);
    this.stepWalkers(dt);
    this.spawn(active, dt);
    this.cull(activeSet);
  }

  /** Gap to the nearest pedestrian crossing the lane ahead (in the road frame), or Infinity. */
  private pedestrianGap(road: Road, u: number, vLane: number, dir: 1 | -1, halfLen: number): number {
    let gap = Infinity;
    for (const w of this.walkers) {
      if (w.mode !== 'cross') continue;
      const { u: wu, v: wv } = worldToFrame(road.frame, { x: w.wx, z: w.wz });
      const d = dir * (wu - u) - halfLen;
      if (d < -1 || d > 28) continue;
      const dv = wv - vLane;
      // walker's lateral velocity in this road frame
      const wd = dirOf(w.heading);
      const rr = { x: Math.cos(road.frame.heading), z: -Math.sin(road.frame.heading) };
      const lateralVel = (wd.x * rr.x + wd.z * rr.z) * WALK_SPEED;
      const approaching = Math.sign(lateralVel) === -Math.sign(dv);
      if (Math.abs(dv) < 2.4 || (Math.abs(dv) < 6.5 && approaching)) gap = Math.min(gap, d - 2.5);
    }
    return gap;
  }

  private stepEgo(dt: number): void {
    const { leg, u, inArc } = this.egoRoadPos();
    const limit = leg.road.speedLimit;
    let target = limit >= 50 ? 42 * KPH : 30 * KPH;
    let gap = Infinity;
    let leaderSpeed = 0;
    const arcSpeed = leg.turn === 'right' ? 19 * KPH : 25 * KPH;
    if (this.egoS > leg.sTurn - 30) target = Math.min(target, arcSpeed);

    if (!inArc) {
      const road = leg.road;
      for (const c of this.cars) {
        if (c.road !== road || c.dir !== 1) continue;
        const inLane = c.lane === 1 || (c.changeT < 1 && c.fromLane === 1);
        if (!inLane) continue;
        const g = c.u - u - c.length / 2 - EGO_LENGTH / 2;
        if (g > -1 && g < gap) {
          gap = g;
          leaderSpeed = c.speed;
        }
      }
      const entry = this.nextIntersection(road, u, 1);
      if (entry && entry.asA) {
        const dStop = entry.u - STOP_LINE_OFFSET - u - EGO_LENGTH / 2;
        const state = lightState(entry.intersection, 'A+', this.time);
        if (state !== 'green' && dStop > -0.5) {
          const canStop = state === 'red' || dStop > (this.egoSpeed * this.egoSpeed) / (2 * 3.2);
          if (canStop && dStop < gap) {
            gap = dStop;
            leaderSpeed = 0;
          }
        }
      }
      const pg = this.pedestrianGap(road, u, EGO_LANE_V, 1, EGO_LENGTH / 2);
      if (pg < gap) {
        gap = pg;
        leaderSpeed = 0;
      }
    } else {
      target = arcSpeed;
    }
    const acc = idm(this.egoSpeed, target, gap, leaderSpeed);
    const prev = this.egoSpeed;
    this.egoSpeed = Math.max(0, this.egoSpeed + acc * dt);
    this.egoBrake = acc < -0.6 || (this.egoSpeed < 0.3 && gap < 15);
    this.egoS += this.egoSpeed * dt;
    void prev;
  }

  private stepCars(dt: number, active: Set<Road>): void {
    const ego = this.egoRoadPos();
    const egoRoad = ego.leg.road;
    const egoU = ego.u;
    const egoLeaderSpeed = ego.inArc ? 0 : this.egoSpeed;

    const byLane = new Map<string, Car[]>();
    for (const c of this.cars) {
      const keys = [`${c.road.id}:${c.lane}`];
      if (c.changeT < 1 && c.fromLane !== c.lane) keys.push(`${c.road.id}:${c.fromLane}`);
      for (const k of keys) {
        let list = byLane.get(k);
        if (!list) byLane.set(k, (list = []));
        list.push(c);
      }
    }

    for (const c of this.cars) {
      if (!active.has(c.road)) continue;
      const p = c.dir * c.u;
      let gap = Infinity;
      let leaderSpeed = 0;
      const list = byLane.get(`${c.road.id}:${c.lane}`) ?? [];
      for (const o of list) {
        if (o === c || o.dir !== c.dir) continue;
        const g = c.dir * o.u - p - (o.length + c.length) / 2;
        if (g > -1.5 && g < gap) {
          gap = g;
          leaderSpeed = o.speed;
        }
      }
      if (egoRoad === c.road && c.dir === 1 && (c.lane === 1 || (c.changeT < 1 && c.fromLane === 1))) {
        const g = egoU - c.u - (c.length + EGO_LENGTH) / 2;
        if (g > -1.5 && g < gap) {
          gap = g;
          leaderSpeed = egoLeaderSpeed;
        }
      }
      const entry = this.nextIntersection(c.road, c.u, c.dir);
      if (entry) {
        const inter = entry.intersection;
        const mv = this.movementFor(c, entry);
        const dStop = c.dir * entry.u - STOP_LINE_OFFSET - p - c.length / 2;
        if (dStop > -0.6) {
          if (inter.control === 'stop' && mv === 'B') {
            if (dStop < 1.5 && c.speed < 0.3) c.waitTimer += dt;
            const mayGo = c.waitTimer > 1.4 && this.roadClearAt(inter.roadA, inter.uA, 40);
            if (!mayGo && dStop < gap) {
              gap = dStop;
              leaderSpeed = 0;
            }
          } else if (inter.control === 'lights') {
            const state = lightState(inter, mv, this.time);
            if (state !== 'green') {
              const canStop = state === 'red' || dStop > (c.speed * c.speed) / (2 * 3.2);
              if (canStop && dStop < gap) {
                gap = dStop;
                leaderSpeed = 0;
              }
            }
          }
        } else {
          c.waitTimer = 0;
        }
      }
      const pg = this.pedestrianGap(c.road, c.u, c.v, c.dir, c.length / 2);
      if (pg < gap) {
        gap = pg;
        leaderSpeed = 0;
      }

      const acc = idm(c.speed, c.cruise, gap, leaderSpeed);
      c.speed = Math.max(0, c.speed + acc * dt);
      c.brake = acc < -0.6 || (c.speed < 0.3 && gap < 12);
      c.u += c.dir * c.speed * dt;

      if (c.changeT < 1) {
        c.changeT = Math.min(1, c.changeT + dt / 3.2);
        const t = c.changeT;
        c.v = c.vFrom + (c.vTo - c.vFrom) * (t * t * (3 - 2 * t));
        if (c.changeT >= 1) {
          c.fromLane = c.lane;
          c.v = c.vTo;
          c.changeCooldown = 9;
        }
      } else {
        c.changeCooldown = Math.max(0, c.changeCooldown - dt);
        this.maybeChangeLane(c, gap, leaderSpeed, byLane, egoRoad, egoU);
      }
    }
  }

  private maybeChangeLane(c: Car, gap: number, leaderSpeed: number, byLane: Map<string, Car[]>, egoRoad: Road, egoU: number): void {
    if (c.changeCooldown > 0 || c.speed < 3) return;
    if (!(gap < 32 && leaderSpeed < c.cruise - 2.5)) return;
    const target = c.lane === 0 ? 1 : c.lane === 1 ? 0 : c.lane === 2 ? 3 : 2;
    const entry = this.nextIntersection(c.road, c.u, c.dir);
    if (entry && Math.abs(entry.u - c.u) < 45) return;
    const p = c.dir * c.u;
    for (const o of byLane.get(`${c.road.id}:${target}`) ?? []) {
      const d = c.dir * o.u - p;
      if (d > -16 && d < 26) return;
    }
    if (egoRoad === c.road && target === 1 && c.dir === 1) {
      const d = egoU - c.u;
      if (d > -22 && d < 32) return;
    }
    if (slotHash(this.laneChangeSerial++, 61) < 0.35) return;
    c.fromLane = c.lane;
    c.lane = target;
    c.vFrom = c.v;
    c.vTo = LANES_V[target];
    c.changeT = 0;
  }

  private stepWalkers(dt: number): void {
    for (const w of this.walkers) {
      if (w.mode === 'cross' && w.cross) {
        w.cross.t += (WALK_SPEED * dt) / w.cross.len;
        w.phase += dt * 6.5;
        const t = Math.min(1, w.cross.t);
        w.u = w.cross.from.x + (w.cross.to.x - w.cross.from.x) * t;
        w.v = w.cross.from.z + (w.cross.to.z - w.cross.from.z) * t;
        if (t >= 1) {
          w.cross = null;
          w.heading = w.road.frame.heading + (w.dir > 0 ? 0 : Math.PI);
          if (w.pending && w.pending.stage === 'own') {
            w.pending.stage = 'other';
            w.mode = 'wait';
          } else {
            w.pending = null;
            w.mode = 'walk';
          }
        }
        continue;
      }
      if (w.mode === 'wait' && w.pending) {
        w.phase = Math.round(w.phase / Math.PI) * Math.PI;
        const { inter, uOnRoad, stage } = w.pending;
        const onA = w.road === inter.roadA;
        let allowed: boolean;
        if (stage === 'own') {
          allowed = onA ? walkAllowed(inter, 'A', this.time) : inter.crossings ? walkAllowed(inter, 'B', this.time) : this.roadClearAt(inter.roadB, 0, 26);
        } else {
          allowed = onA
            ? inter.crossings
              ? walkAllowed(inter, 'B', this.time)
              : this.roadClearAt(inter.roadB, 0, 26)
            : inter.crossings
              ? walkAllowed(inter, 'A', this.time)
              : this.roadClearAt(inter.roadA, inter.uA, 26);
        }
        if (allowed) {
          const cornerU = uOnRoad - w.dir * CROSSWALK_CENTER;
          const from = { x: cornerU, z: w.v };
          const otherSide = w.v > 0 ? SIDEWALK_LEFT : SIDEWALK_RIGHT;
          const to = stage === 'own' ? { x: cornerU, z: otherSide } : { x: uOnRoad + w.dir * CROSSWALK_CENTER, z: w.v };
          w.cross = { from, to, t: 0, len: Math.hypot(to.x - from.x, to.z - from.z) };
          w.mode = 'cross';
          w.heading = w.road.frame.heading + Math.atan2(to.z - from.z, to.x - from.x);
        }
        continue;
      }
      // walking along the sidewalk
      w.phase += dt * 6.5;
      w.u += w.dir * WALK_SPEED * dt;
      const entry = this.nextIntersection(w.road, w.u, w.dir);
      if (!entry) continue;
      const cornerU = entry.u - w.dir * CROSSWALK_CENTER;
      if (w.handled !== entry.intersection.id && w.dir * (w.u - cornerU) >= 0) {
        w.handled = entry.intersection.id;
        w.u = cornerU;
        const inter = entry.intersection;
        const mayCrossOwn = inter.crossings && w.road === inter.roadA;
        const wantsOwn = mayCrossOwn && hash2(Math.round(w.u), this.serial++, 71) < 0.5;
        w.pending = { inter, uOnRoad: entry.u, stage: wantsOwn ? 'own' : 'other' };
        w.mode = 'wait';
      }
    }
  }

  // ─── population ─────────────────────────────────────────────────────────────

  private spawn(active: Road[], dt: number): void {
    const ego = this.egoWorld();
    const leg = this.currentLeg();
    for (const road of active) {
      const [wMin, wMax] = this.roadWindow(road);
      for (let lane = 0; lane < LANES_V.length; lane++) {
        const v = LANES_V[lane];
        const dir: 1 | -1 = v > 0 ? 1 : -1;
        const ends: number[] = [];
        if (road === leg.road) {
          if (dir > 0) ends.push(wMin, wMax);
          else ends.push(wMax);
        } else {
          ends.push(dir > 0 ? wMin : wMax);
        }
        for (const uEnd of ends) {
          const key = `${road.id}:${lane}:${uEnd > (wMin + wMax) / 2 ? 'hi' : 'lo'}`;
          const timer = (this.spawnTimers.get(key) ?? 1.5) - dt;
          if (timer > 0) {
            this.spawnTimers.set(key, timer);
            continue;
          }
          const p = frameToWorld(road.frame, uEnd, v);
          if (Math.hypot(p.x - ego.x, p.z - ego.z) < SPAWN_MIN_DIST) {
            this.spawnTimers.set(key, 1);
            continue;
          }
          let clear = true;
          for (const c of this.cars) {
            if (c.road === road && (c.lane === lane || c.fromLane === lane) && Math.abs(c.u - uEnd) < 24) clear = false;
          }
          if (!clear) {
            this.spawnTimers.set(key, 0.8);
            continue;
          }
          const n = this.serial;
          const h = slotHash(n, 51);
          const aheadSameDir = dir > 0 && road === leg.road && uEnd === wMax;
          const cruiseKph = (road.speedLimit >= 50 ? 34 + h * 18 : 24 + h * 10) * (aheadSameDir ? 0.82 : 1);
          const car = this.makeCar(pickType(slotHash(n, 52)), road, lane, uEnd, cruiseKph * KPH, 0.35 + 0.4 * slotHash(n, 53));
          car.speed = car.cruise * 0.9;
          this.cars.push(car);
          const density = road.kind === 'main' ? 1 : 1.7;
          this.spawnTimers.set(key, (5 + slotHash(n, 54) * 9) * density);
        }
      }
      this.populateParking(road, wMin, wMax, ego);
      this.populateWalkers(road, wMin, wMax, ego);
    }
  }

  private populateParking(road: Road, wMin: number, wMax: number, ego: Vec2): void {
    const roadIdx = Number(road.id.slice(4));
    const existing = this.parkedIds;
    const nearInter = (u: number) => road.intersections.some((e) => Math.abs(e.u - u) < 24);
    const startU = roadIdx === 0 ? 62 : road.uMin;
    const rows: Array<{ key: string; on: boolean; period: number; v: number; headingDeg: number; fill: number; jitter: number }> = [
      { key: 'pr', on: road.parkingRight, period: 5.3, v: PARK_RIGHT_V, headingDeg: 38, fill: 0.55, jitter: 0.6 },
      { key: 'pl', on: road.parkingLeft, period: 7.4, v: PARK_LEFT_V, headingDeg: 180, fill: 0.42, jitter: 0.15 },
    ];
    for (const row of rows) {
      if (!row.on) continue;
      const kMin = Math.ceil((Math.max(wMin, startU) - startU) / row.period);
      const kMax = Math.floor((wMax - startU) / row.period);
      const salt = row.key === 'pr' ? 80 : 90;
      for (let k = kMin; k <= kMax; k++) {
        const id = `${road.id}:${row.key}${k}`;
        if (existing.has(id) || hash2(roadIdx, k, salt + 1) > row.fill) continue;
        const u = startU + k * row.period;
        if (nearInter(u)) continue;
        const p = frameToWorld(road.frame, u, row.v + (hash2(roadIdx, k, salt + 2) - 0.5) * row.jitter);
        if (Math.hypot(p.x - ego.x, p.z - ego.z) < SPAWN_MIN_DIST) continue;
        const headingJitter = row.key === 'pr' ? (hash2(roadIdx, k, salt + 4) - 0.5) * 6 : 0;
        this.parked.push({
          id,
          type: pickType(hash2(roadIdx, k, salt + 3)),
          x: p.x,
          z: p.z,
          heading: road.frame.heading + ((row.headingDeg + headingJitter) * Math.PI) / 180,
          parked: true,
          brake: false,
          tint: 0.35 + 0.4 * hash2(roadIdx, k, salt + 5),
          road,
        });
        existing.add(id);
      }
    }
  }

  private populateWalkers(road: Road, wMin: number, wMax: number, ego: Vec2): void {
    const roadIdx = Number(road.id.slice(4));
    const period = 48;
    const kMin = Math.ceil(wMin / period);
    const kMax = Math.floor(wMax / period);
    for (let k = kMin; k <= kMax; k++) {
      for (const side of [1, -1] as const) {
        const id = `${road.id}:w${k}:${side}`;
        if (this.spawnedWalkers.has(id)) continue;
        const u = k * period + hash2(roadIdx, k, 91) * 20;
        const v = side > 0 ? SIDEWALK_RIGHT : SIDEWALK_LEFT;
        const p = frameToWorld(road.frame, u, v);
        if (Math.hypot(p.x - ego.x, p.z - ego.z) < SPAWN_MIN_DIST) continue;
        this.spawnedWalkers.add(id);
        if (hash2(roadIdx, k + side * 1000, 92) > (road.kind === 'main' ? 0.45 : 0.3)) continue;
        const dir: 1 | -1 = hash2(roadIdx, k + side * 1000, 93) < 0.5 ? 1 : -1;
        this.walkers.push(this.makeWalker(road, u, v, dir, id));
      }
    }
  }

  private cull(active: Set<Road>): void {
    const ego = this.egoWorld();
    const far = (x: number, z: number, limit: number) => Math.hypot(x - ego.x, z - ego.z) > limit;
    this.cars = this.cars.filter((c) => {
      if (!active.has(c.road)) return false;
      const [wMin, wMax] = this.roadWindow(c.road);
      return c.u > wMin - 30 && c.u < wMax + 30;
    });
    this.parked = this.parked.filter((p) => {
      const keep = active.has(p.road) && !far(p.x, p.z, 420);
      if (!keep) this.parkedIds.delete(p.id);
      return keep;
    });
    this.walkers = this.walkers.filter((w) => active.has(w.road) && !far(w.wx, w.wz, 380));
    const leg = this.currentLeg();
    if (leg.index >= 2) this.network.retireBefore(leg.index);
  }

  // ─── state output ───────────────────────────────────────────────────────────

  toState(base: WorldState): WorldState {
    const route = this.network.route;
    const pose = route.poseAt(this.egoS);
    const ego = { x: pose.x, z: pose.z };
    const leg = this.currentLeg();
    const near = (x: number, z: number, limit = CULL_DIST) => Math.hypot(x - ego.x, z - ego.z) <= limit;

    const vehicles: VehicleState[] = [];
    for (const c of this.cars) {
      const p = frameToWorld(c.road.frame, c.u, c.v);
      if (!near(p.x, p.z)) continue;
      let heading = c.road.frame.heading + (c.dir > 0 ? 0 : Math.PI);
      if (c.changeT < 1) heading += Math.sin(c.changeT * Math.PI) * 0.09 * Math.sign(c.vTo - c.vFrom) * c.dir;
      vehicles.push({ id: c.id, type: c.type, x: p.x, z: p.z, heading, parked: false, brake: c.brake, tint: c.tint });
    }
    for (const p of this.parked) {
      if (!near(p.x, p.z)) continue;
      vehicles.push({ id: p.id, type: p.type, x: p.x, z: p.z, heading: p.heading, parked: true, brake: false, tint: p.tint });
    }
    const pedestrians: PedestrianState[] = [];
    for (const w of this.walkers) {
      const p = frameToWorld(w.road.frame, w.u, w.v);
      if (!near(p.x, p.z)) continue;
      pedestrians.push({ id: w.id, x: p.x, z: p.z, heading: w.heading, phase: w.phase });
    }

    const markings: Marking[] = [];
    const crosswalks: Crosswalk[] = [];
    const trafficLights: TrafficLightState[] = [];
    const signs: SignState[] = [];
    const active = this.activeRoads();
    for (const road of active) {
      const key = `${road.intersections.length}:${road.uMin}:${road.uMax}`;
      let cached = this.markingCache.get(road.id);
      if (!cached || cached.key !== key) {
        cached = { key, markings: [], crosswalks: [] };
        this.roadMarkings(road, cached.markings, cached.crosswalks);
        this.markingCache.set(road.id, cached);
      }
      markings.push(...cached.markings);
      crosswalks.push(...cached.crosswalks);
    }
    for (const inter of this.network.intersections) {
      if (!active.includes(inter.roadA) && !active.includes(inter.roadB)) continue;
      if (!near(inter.center.x, inter.center.z, CULL_DIST + 40)) continue;
      this.intersectionProps(inter, trafficLights, signs);
    }
    const pathPts = route.sample(this.egoS, Math.min(route.length, this.egoS + 46), 1.5);
    return {
      ...base,
      time: this.time,
      ego: { x: pose.x, z: pose.z, heading: pose.heading, speedKph: this.egoSpeed * 3.6 },
      egoBrake: this.egoBrake,
      speedLimit: leg.road.speedLimit,
      vehicles,
      pedestrians,
      lanes: { ...base.lanes, markings, crosswalks, arrows: this.laneArrows(leg) },
      props: { trafficLights, signs },
      route: { points: pathPts.map((p) => ({ x: p.x, z: p.z })) },
    };
  }

  private laneArrows(leg: Leg): WorldState['lanes']['arrows'] {
    const out: WorldState['lanes']['arrows'] = [];
    const road = leg.road;
    for (const e of road.intersections) {
      if (!e.asA) continue;
      for (const v of [LANES_V[0], LANES_V[1]]) {
        const p = frameToWorld(road.frame, e.u - 36, v);
        out.push({ id: `${road.id}:${e.intersection.id}:${v}`, x: p.x, z: p.z, heading: road.frame.heading });
      }
    }
    return out;
  }

  /** Static markings for a whole road (cached; ids are stable so the renderer keeps its meshes). */
  private roadMarkings(road: Road, out: Marking[], crosswalks: Crosswalk[]): void {
    const uMin = road.uMin;
    const uMax = road.uMax;
    const cuts = road.intersections.map((e) => e.u).sort((a, b) => a - b);
    const pieces: Array<[number, number]> = [];
    let start = uMin;
    for (const cu of cuts) {
      const a = cu - STOP_LINE_OFFSET;
      const b = cu + STOP_LINE_OFFSET;
      if (a > start) pieces.push([start, a]);
      start = Math.max(start, b);
    }
    if (uMax > start) pieces.push([start, uMax]);
    const line = (id: string, v: number, kind: Marking['kind'], dashed: boolean, width: number) => {
      pieces.forEach(([a, b], i) => {
        out.push({
          id: `${road.id}:${id}:${i}`,
          kind,
          dashed,
          width,
          points: [frameToWorld(road.frame, a, v), frameToWorld(road.frame, b, v)],
        });
      });
    };
    line('l+', 3.5, 'lane', true, 0.13);
    line('l-', -3.5, 'lane', true, 0.13);
    line('c', 0, 'center', false, 0.13);
    line('e+', ROAD_HALF_W, 'edge', false, 0.1);
    line('e-', -ROAD_HALF_W, 'edge', false, 0.1);
    for (const e of road.intersections) {
      const inter = e.intersection;
      const stopLines = inter.control === 'lights' || !e.asA;
      const walk = inter.control === 'lights' || !e.asA;
      for (const dir of [1, -1] as const) {
        if (stopLines) {
          const u = e.u - dir * STOP_LINE_OFFSET;
          out.push({
            id: `${road.id}:${inter.id}:stop${dir}`,
            kind: 'stop',
            dashed: false,
            width: 0.4,
            points: [frameToWorld(road.frame, u, dir > 0 ? 0 : -ROAD_HALF_W), frameToWorld(road.frame, u, dir > 0 ? ROAD_HALF_W : 0)],
          });
        }
        if (walk) {
          const c = frameToWorld(road.frame, e.u - dir * CROSSWALK_CENTER, 0);
          crosswalks.push({ id: `${road.id}:${inter.id}:cw${dir}`, x: c.x, z: c.z, heading: road.frame.heading, length: ROAD_HALF_W * 2, depth: 3 });
        }
      }
    }
  }

  private intersectionProps(inter: Intersection, lights: TrafficLightState[], signs: SignState[]): void {
    const A = inter.roadA;
    const B = inter.roadB;
    if (inter.control === 'lights') {
      const place = (road: Road, uI: number, dir: 1 | -1, mv: Movement) => {
        const p = frameToWorld(road.frame, uI + dir * (ROAD_HALF_W + 1.6), dir * (ROAD_HALF_W + 1.4));
        lights.push({
          id: `${inter.id}:${road.id}:${dir}`,
          x: p.x,
          z: p.z,
          heading: road.frame.heading + (dir > 0 ? Math.PI : 0),
          state: lightState(inter, mv, this.time),
        });
      };
      place(A, inter.uA, 1, 'A+');
      place(A, inter.uA, -1, 'A-');
      place(B, 0, 1, 'B');
      place(B, 0, -1, 'B');
    } else {
      for (const dir of [1, -1] as const) {
        const p = frameToWorld(B.frame, -dir * (ROAD_HALF_W + 2.2), dir * (ROAD_HALF_W + 1.4));
        signs.push({ id: `${inter.id}:stop:${dir}`, kind: 'stop', x: p.x, z: p.z, heading: B.frame.heading + (dir > 0 ? Math.PI : 0) });
      }
    }
  }
}
