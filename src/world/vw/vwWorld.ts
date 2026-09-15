import * as vw from '../../vw/virtual-world';
import type { VwCar, VwMarking, VwSegment, VwWorld, VwNetwork } from '../../vw/virtual-world';
import { hash2, slotHash } from '../hash';
import type { Crosswalk, Marking, SignState, TrafficLightState, VehicleState, VehicleType, WorldState } from '../types';

/** The upstream car is 50 px long; ours is 4.7 m. */
export const PX_TO_M = 4.7 / 50;
const FPS = 60;
const CAR_W = 30;
const CAR_L = 50;
const RAY_LENGTH = 150;
/** Parked cars sit this far from the lane guide toward the kerb (px) so traffic can pass in-lane. */
const KERB_OFFSET = 20;
/** Traffic shifts this far toward the road centre (px) when passing a parked car. */
const PASS_OFFSET = 16;

export type VwControlMode = 'ai' | 'manual';

export interface VwOptions {
  populationSize?: number;
  mutation?: number;
  /** seconds before a generation is cut short */
  maxGenerationSeconds?: number;
  trafficCount?: number;
}

export interface VwStats {
  generation: number;
  alive: number;
  total: number;
  bestFitness: number;
  savedFitness: number;
  mode: VwControlMode;
  damaged: boolean;
}

interface TrafficCar {
  id: string;
  car: VwCar;
  loop: Loop;
  /** index of the loop segment the car currently follows */
  i: number;
  type: VehicleType;
  tint: number;
  stopTimer: number;
  passedStop: string | null;
  /** seconds spent standing still (deadlocked cars are recycled) */
  stuckTimer: number;
  /** the last move was undone because it would have overlapped another body */
  touching: boolean;
  /** seconds left of backing away from a contact */
  backTimer: number;
}

interface Loop {
  segs: VwSegment[]; // oriented p1 → p2 in travel direction
  length: number;
}

const toWorld = (p: { x: number; y: number }) => ({ x: p.x * PX_TO_M, z: -p.y * PX_TO_M });
const headingOf = (d: { x: number; y: number }) => Math.atan2(d.x, -d.y);
/**
 * Upstream convention: traffic moves AGAINST a marking's directionVector — the stop line is the
 * −dir edge, "STOP" reads for a driver heading −dir, and a start marking launches cars toward −dir.
 */
const travelHeading = (d: { x: number; y: number }) => headingOf({ x: -d.x, y: -d.y });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const BRAIN_KEY = 'vw.bestBrain';

/** Uniform grid over road borders so each car only tests nearby segments (upstream tests all). */
class BorderIndex {
  private cell = 200;
  private grid = new Map<string, Array<[{ x: number; y: number }, { x: number; y: number }]>>();
  constructor(borders: VwSegment[]) {
    for (const s of borders) {
      const seg: [{ x: number; y: number }, { x: number; y: number }] = [s.p1, s.p2];
      const x0 = Math.floor(Math.min(s.p1.x, s.p2.x) / this.cell);
      const x1 = Math.floor(Math.max(s.p1.x, s.p2.x) / this.cell);
      const y0 = Math.floor(Math.min(s.p1.y, s.p2.y) / this.cell);
      const y1 = Math.floor(Math.max(s.p1.y, s.p2.y) / this.cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(seg);
      }
    }
  }
  near(x: number, y: number, r: number): Array<[{ x: number; y: number }, { x: number; y: number }]> {
    const out: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
    const seen = new Set<unknown>();
    for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++) {
      for (let cy = Math.floor((y - r) / this.cell); cy <= Math.floor((y + r) / this.cell); cy++) {
        for (const s of this.grid.get(`${cx},${cy}`) ?? []) {
          if (!seen.has(s)) {
            seen.add(s);
            out.push(s);
          }
        }
      }
    }
    return out;
  }
}

/**
 * Runs the virtual-world simulation: the AI car population (upstream Car/Sensor/NeuralNetwork,
 * self-training across generations), lane-guide traffic driven by the upstream car physics, the
 * signal controller, and produces this app's WorldState from the upstream world data.
 */
export class VirtualWorldSim {
  world: VwWorld;
  cars: VwCar[] = [];
  bestCar: VwCar | null = null;
  manualCar: VwCar | null = null;
  traffic: TrafficCar[] = [];
  generation = 1;
  time = 0;
  frame = 0;
  mode: VwControlMode = 'ai';
  showPopulation = false;
  /** Sensor rays are hidden by default; the blue path ribbon shows the lane ahead instead. */
  showSensors = false;
  /** True when the manual car hit something since the last reset (shown in the HUD). */
  bumped = false;
  /** Solid obstacles besides moving traffic (parked cars) — sensors and collisions see them. */
  private staticObstacles: Array<{ polygon: Array<{ x: number; y: number }> }> = [];
  /** Low-passed ego pose used for display so the AI's on/off steering does not jitter the view. */
  private smooth: { x: number; y: number; angle: number; speed: number } | null = null;
  /** seconds the ego has been standing still — traffic passes it like a parked car after a while */
  private egoStillTime = 0;
  private opts: Required<VwOptions>;
  private index!: BorderIndex;
  private loops: Loop[] = [];
  private staticState!: {
    markings: Marking[];
    crosswalks: Crosswalk[];
    signs: SignState[];
    buildings: WorldState['buildings'];
    trees: WorldState['trees'];
    parked: VehicleState[];
    lights: Array<{ marking: VwMarking; pos: { x: number; z: number }; heading: number }>;
    intersections: Array<{ x: number; y: number; lights: VwMarking[] }>;
    start: { x: number; y: number; angle: number };
    id: string;
  };
  private generationStart = 0;
  private stallTime = 0;
  private savedFitness = 0;
  private serial = 0;

  constructor(world: VwWorld, opts: VwOptions = {}) {
    this.opts = {
      populationSize: opts.populationSize ?? 100,
      mutation: opts.mutation ?? 0.1,
      maxGenerationSeconds: opts.maxGenerationSeconds ?? 60,
      trafficCount: opts.trafficCount ?? 12,
    };
    this.world = world;
    this.rebuild();
    this.spawnGeneration(true);
  }

  /** Re-derive everything after the world changed (editor edits, file load). */
  rebuild(): void {
    this.index = new BorderIndex(this.world.roadBorders);
    this.loops = buildLoops(this.world);
    this.staticState = this.buildStatic();
    this.staticObstacles = this.world.markings
      .filter((m) => m.type === 'parking')
      .map((m) => ({ polygon: carPolygon({ ...this.parkedPose(m), width: CAR_W, height: CAR_L }) }));
    this.traffic = [];
    this.spawnTraffic();
  }

  setWorld(world: VwWorld): void {
    this.world = world;
    this.rebuild();
    this.spawnGeneration(true);
  }

  // ─── population ─────────────────────────────────────────────────────────────

  private savedBrain(): { brain: VwNetwork; fitness: number } | null {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BRAIN_KEY) : null;
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.levels) return { brain: parsed, fitness: 0 };
      return parsed;
    } catch {
      return null;
    }
  }

  private spawnGeneration(fresh: boolean): void {
    const s = this.staticState.start;
    const N = this.opts.populationSize;
    this.cars = [];
    const saved = this.savedBrain();
    this.savedFitness = saved?.fitness ?? 0;
    for (let i = 0; i < N; i++) {
      const car = new vw.Car(s.x, s.y, CAR_W, CAR_L, 'AI', s.angle);
      if (saved) {
        car.brain = JSON.parse(JSON.stringify(saved.brain));
        if (i !== 0) vw.NeuralNetwork.mutate(car.brain!, this.opts.mutation);
      }
      this.cars.push(car);
    }
    this.bestCar = this.cars[0];
    this.generationStart = this.time;
    this.stallTime = 0;
    if (!fresh) this.generation++;
  }

  private spawnManual(): void {
    const s = this.staticState.start;
    this.manualCar = new vw.Car(s.x, s.y, CAR_W, CAR_L, 'KEYS', s.angle, 3.5);
  }

  setMode(mode: VwControlMode): void {
    this.mode = mode;
    if (mode === 'manual' && !this.manualCar) this.spawnManual();
  }

  /** Persist the best brain (upstream "save"), keeping the better fitness. */
  saveBrain(): void {
    if (!this.bestCar?.brain || typeof localStorage === 'undefined') return;
    const prev = this.savedBrain();
    if (prev && prev.fitness > this.bestCar.fittness) return;
    localStorage.setItem(BRAIN_KEY, JSON.stringify({ brain: this.bestCar.brain, fitness: this.bestCar.fittness }));
    this.savedFitness = this.bestCar.fittness;
  }

  /** Upstream "discard": forget the saved brain; the next generation starts random. */
  discardBrain(): void {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(BRAIN_KEY);
    this.savedFitness = 0;
  }

  nextGeneration(): void {
    this.saveBrain();
    this.spawnGeneration(false);
    this.smooth = null;
  }

  resetManual(): void {
    this.spawnManual();
    this.bumped = false;
    this.smooth = null;
  }

  stats(): VwStats {
    const alive = this.cars.filter((c) => !c.damaged).length;
    return {
      generation: this.generation,
      alive,
      total: this.cars.length,
      bestFitness: this.bestCar?.fittness ?? 0,
      savedFitness: this.savedFitness,
      mode: this.mode,
      damaged: !!this.egoCar()?.damaged,
    };
  }

  egoCar(): VwCar | null {
    return this.mode === 'manual' ? this.manualCar : this.bestCar;
  }

  // ─── stepping ───────────────────────────────────────────────────────────────

  /** Advance by wall-clock seconds; the upstream simulation is frame-based at 60 fps. */
  step(dt: number): void {
    const n = Math.max(1, Math.min(4, Math.round(dt * FPS)));
    for (let i = 0; i < n; i++) this.tick();
    this.time += n / FPS;
  }

  private tick(): void {
    this.frame++;
    this.updateLights();
    const trafficCars = this.traffic.map((t) => t.car);
    // what sensors and the upstream damage test treat as obstacles: moving traffic and parked cars
    const obstacles = [...trafficCars, ...this.staticObstacles] as VwCar[];
    const ego = this.egoCar();
    for (const t of this.traffic) this.driveTraffic(t);
    for (const t of this.traffic) {
      const prev = { x: t.car.x, y: t.car.y, angle: t.car.angle };
      t.car.update(this.index.near(t.car.x, t.car.y, 120), []);
      // solid bodies: a traffic car never overlaps another car, the ego or a parked car — undo + stop
      const others = obstacles.filter((o) => o !== t.car);
      if (ego && this.egoSolid(ego)) others.push(ego);
      t.touching = this.overlaps(t.car, others);
      if (t.touching) {
        Object.assign(t.car, prev);
        t.car.speed = 0;
        t.car.polygon = carPolygon(t.car);
      }
    }
    if (this.mode === 'manual' && this.manualCar) {
      const m = this.manualCar;
      const prev = { x: m.x, y: m.y, angle: m.angle };
      m.update(this.index.near(m.x, m.y, RAY_LENGTH + 40), obstacles);
      if (m.damaged) {
        // bump and stop instead of freezing: the move is undone and the driver can back away
        Object.assign(m, prev);
        m.speed = 0;
        m.damaged = false;
        m.polygon = carPolygon(m);
        this.bumped = true;
      }
    }
    // the AI population only evolves in AI mode: manual driving never restarts it (or the manual car)
    if (this.mode === 'ai') {
      // the followed car is the fittest one still driving (a wreck only if every car has crashed)
      let best: VwCar | null = null;
      for (const car of this.cars) {
        if (!car.damaged) car.update(this.index.near(car.x, car.y, RAY_LENGTH + 40), obstacles);
        if (!best || (best.damaged && !car.damaged) || (best.damaged === car.damaged && car.fittness > best.fittness)) best = car;
      }
      if (!best) best = this.cars[0];
      this.bestCar = best;
      this.world.cars = this.cars;
      this.world.bestCar = best;
      // generation bookkeeping (upstream saves manually; here the loop is automatic)
      const alive = this.cars.some((c) => !c.damaged);
      if (best.speed < 0.05) this.stallTime += 1 / FPS;
      else this.stallTime = 0;
      const elapsed = this.time - this.generationStart;
      if (!alive || elapsed > this.opts.maxGenerationSeconds || this.stallTime > 6) this.nextGeneration();
    }
    this.maintainTraffic();
    this.updateSmooth();
    const e = this.egoCar();
    this.egoStillTime = e && Math.abs(e.speed) < 0.05 ? this.egoStillTime + 1 / FPS : 0;
  }

  /**
   * Where a parked car actually stands: the parking marking sits on the lane guide, so the car is
   * pushed toward the kerb (away from the nearest road centre line) to leave room for traffic.
   */
  private parkedPose(m: VwMarking): { x: number; y: number; angle: number } {
    const c = m.center;
    const centre = vw.getNearestSegment(c, this.world.graph.segments, this.world.roadWidth);
    let kx = 0;
    let ky = 0;
    if (centre) {
      const proj = centre.projectPoint(c).point;
      const len = Math.hypot(c.x - proj.x, c.y - proj.y);
      if (len > 1) {
        kx = (c.x - proj.x) / len;
        ky = (c.y - proj.y) / len;
      }
    }
    return { x: c.x + kx * KERB_OFFSET, y: c.y + ky * KERB_OFFSET, angle: -travelHeading(m.directionVector) };
  }

  /** Traffic treats the ego as a solid body unless it is a crashed/stalled AI car (which it passes through). */
  private egoSolid(ego: VwCar): boolean {
    return this.mode === 'manual' || (!ego.damaged && this.egoStillTime < 3);
  }

  private overlaps(car: VwCar, others: Array<{ polygon?: Array<{ x: number; y: number }> }>): boolean {
    if (!car.polygon) return false;
    for (const o of others) {
      const c = o.polygon;
      if (!c) continue;
      // cheap reject first: rectangles whose centres are > 80 px apart cannot touch (diagonal ≈ 58)
      if (Math.hypot((c[0].x + c[2].x) / 2 - car.x, (c[0].y + c[2].y) / 2 - car.y) > 80) continue;
      if (vw.polysIntersect(car.polygon, c)) return true;
    }
    return false;
  }

  /** Exponential smoothing of the displayed ego pose (snaps when the followed car changes). */
  private updateSmooth(): void {
    const ego = this.egoCar();
    if (!ego) {
      this.smooth = null;
      return;
    }
    const s = this.smooth;
    if (!s || Math.hypot(ego.x - s.x, ego.y - s.y) > 200) {
      this.smooth = { x: ego.x, y: ego.y, angle: ego.angle, speed: ego.speed };
      return;
    }
    const k = 0.18; // per 60 Hz tick -> about 90 ms time constant
    s.x += (ego.x - s.x) * k;
    s.y += (ego.y - s.y) * k;
    s.angle += wrap(ego.angle - s.angle) * k;
    s.speed += (ego.speed - s.speed) * k;
  }

  /**
   * Points for the path ribbon: the centre of our lane along the road graph for `metres` ahead —
   * straight through intersections where possible, otherwise the gentlest turn — starting at the
   * car and merging into the lane over the first ~10 m (straight ahead off the network).
   */
  private laneAhead(from: { x: number; y: number; angle: number }, metres: number): Array<{ x: number; z: number }> {
    const fx = -Math.sin(from.angle);
    const fy = -Math.cos(from.angle);
    const here = new vw.Point(from.x, from.y);
    const lane = this.world.roadWidth / 4; // lane centre offset from the road centre line (px)
    const stepPx = 1.5 / PX_TO_M;
    const totalPx = metres / PX_TO_M;
    const pts: Array<{ x: number; z: number }> = [];
    // nearest road segment, oriented the way we are heading
    let seg: VwSegment | null = null;
    let bestDist = this.world.roadWidth;
    for (const g of this.world.graph.segments) {
      const dist = g.distanceToPoint(here);
      if (dist >= bestDist) continue;
      const d = g.directionVector();
      const dot = d.x * fx + d.y * fy;
      if (Math.abs(dot) < 0.3) continue;
      bestDist = dist;
      seg = dot > 0 ? g : new vw.Segment(g.p2, g.p1);
    }
    if (!seg) {
      for (let t = 0; t <= totalPx; t += stepPx) pts.push(toWorld({ x: from.x + fx * t, y: from.y + fy * t }));
      return pts;
    }
    // lane centre sample `along` px into `seg` (right of travel: the loops keep the centre on the left)
    const laneAt = (sg: VwSegment, along: number) => {
      const d = sg.directionVector();
      return { x: sg.p1.x + d.x * along - d.y * lane, y: sg.p1.y + d.y * along + d.x * lane };
    };
    const proj = seg.projectPoint(here);
    let along = Math.max(0, Math.min(1, proj.offset)) * seg.length();
    const l0 = laneAt(seg, along);
    const ox = from.x - l0.x;
    const oy = from.y - l0.y;
    const mergePx = 10 / PX_TO_M;
    let travelled = 0;
    let guard = 0;
    const visited = new Set<VwSegment>();
    while (travelled <= totalPx && guard++ < 400) {
      const w = Math.max(0, 1 - travelled / mergePx);
      const l = laneAt(seg, along);
      pts.push(toWorld({ x: l.x + ox * w, y: l.y + oy * w }));
      along += stepPx;
      travelled += stepPx;
      if (along > seg.length()) {
        // continue on the segment leaving this point with the smallest heading change
        const cur: VwSegment = seg;
        visited.add(cur);
        const d = cur.directionVector();
        const end: { x: number; y: number } = cur.p2;
        let next: VwSegment | null = null;
        let bestTurn = 1.75; // no U-turns / sharper than ~100°
        for (const g of this.world.graph.segments) {
          if (visited.has(g)) continue;
          const touchesP1 = Math.hypot(g.p1.x - end.x, g.p1.y - end.y) < 0.5;
          const touchesP2 = Math.hypot(g.p2.x - end.x, g.p2.y - end.y) < 0.5;
          if (!touchesP1 && !touchesP2) continue;
          const cand = touchesP1 ? g : new vw.Segment(g.p2, g.p1);
          const cd = cand.directionVector();
          const turn = Math.abs(wrap(Math.atan2(cd.y, cd.x) - Math.atan2(d.y, d.x)));
          if (turn < bestTurn) {
            bestTurn = turn;
            next = cand;
          }
        }
        if (!next) break;
        along -= cur.length();
        seg = next;
      }
    }
    return pts;
  }

  /** Same algorithm as the upstream World.#updateLights (private there), driven by our frame counter. */
  private updateLights(): void {
    const greenDuration = 2;
    const yellowDuration = 1;
    const tick = Math.floor(this.frame / FPS);
    for (const center of this.staticState.intersections) {
      const ticks = center.lights.length * (greenDuration + yellowDuration);
      const cTick = tick % ticks;
      const idx = Math.floor(cTick / (greenDuration + yellowDuration));
      const gy = cTick % (greenDuration + yellowDuration) < greenDuration ? 'green' : 'yellow';
      center.lights.forEach((l, i) => {
        l.state = i === idx ? gy : 'red';
      });
    }
  }

  // ─── traffic on lane guides ─────────────────────────────────────────────────

  private spawnTraffic(): void {
    const s = this.staticState.start;
    const want = Math.min(this.opts.trafficCount, Math.floor(this.loops.reduce((a, l) => a + l.length, 0) / 350));
    let guard = 0;
    while (this.traffic.length < want && guard++ < 400) {
      const n = this.serial++;
      const loop = this.loops[Math.floor(slotHash(n, 11) * this.loops.length)];
      if (!loop) break;
      const i = Math.floor(slotHash(n, 12) * loop.segs.length);
      const seg = loop.segs[i];
      const t = slotHash(n, 13);
      const x = seg.p1.x + (seg.p2.x - seg.p1.x) * t;
      const y = seg.p1.y + (seg.p2.y - seg.p1.y) * t;
      if (Math.hypot(x - s.x, y - s.y) < 350) continue;
      if (this.traffic.some((o) => Math.hypot(o.car.x - x, o.car.y - y) < 120)) continue;
      const d = seg.directionVector();
      const car = new vw.Car(x, y, CAR_W, CAR_L, 'DUMMY', Math.atan2(-d.x, -d.y), 2.1);
      car.speed = 1.5;
      car.polygon = carPolygon(car); // upstream only builds it on the first update
      this.traffic.push({ id: `traffic-${n}`, car, loop, i, type: slotHash(n, 14) < 0.7 ? 'sedan' : slotHash(n, 14) < 0.9 ? 'crossover' : 'van', tint: 0.35 + 0.4 * slotHash(n, 15), stopTimer: 0, passedStop: null, stuckTimer: 0, touching: false, backTimer: 0 });
    }
  }

  private maintainTraffic(): void {
    const ego = this.egoCar();
    for (const t of this.traffic) t.stuckTimer = Math.abs(t.car.speed) < 0.05 ? t.stuckTimer + 1 / FPS : 0;
    this.traffic = this.traffic.filter((t) => {
      if (t.car.damaged) return false;
      const dist = ego ? Math.hypot(t.car.x - ego.x, t.car.y - ego.y) : 0;
      // a car boxed in for a long time (deadlock) is recycled — sooner when it is out of view
      if (t.stuckTimer > (dist > 400 ? 20 : 45)) return false;
      return dist < 2500;
    });
    if (this.frame % 30 === 0) this.spawnTraffic();
  }

  /** Pure-pursuit follower on the lane-guide loop using the upstream car controls/physics. */
  private driveTraffic(t: TrafficCar): void {
    const { car, loop } = t;
    // advance the segment index while the car has passed the segment end
    for (let k = 0; k < 3; k++) {
      const seg = loop.segs[t.i];
      const d = seg.directionVector();
      const toEnd = (seg.p2.x - car.x) * d.x + (seg.p2.y - car.y) * d.y;
      if (toEnd < 10) t.i = (t.i + 1) % loop.segs.length;
      else break;
    }
    // upcoming curvature: a sharp turn within ~80 px → look closer and slow down (the steering rate is
    // fixed, so the turning radius is proportional to speed: corners are only makeable at low speed)
    const seg0 = loop.segs[t.i];
    const d0 = seg0.directionVector();
    const along0 = (car.x - seg0.p1.x) * d0.x + (car.y - seg0.p1.y) * d0.y;
    const d45 = loopPoint(loop, t.i, along0, 45).dir;
    const d85 = loopPoint(loop, t.i, along0, 85).dir;
    const heading = Math.atan2(-Math.cos(car.angle), -Math.sin(car.angle)); // in the pixel frame
    const turn = Math.max(
      Math.abs(wrap(Math.atan2(d0.y, d0.x) - Math.atan2(d45.y, d45.x))),
      Math.abs(wrap(Math.atan2(d0.y, d0.x) - Math.atan2(d85.y, d85.x))),
      Math.abs(wrap(heading - Math.atan2(d45.y, d45.x))), // still turning out of a corner
    );
    const sharp = turn > 0.6;
    const speedCap = turn > 1.2 ? 0.8 : sharp ? 1.1 : car.maxSpeed;
    const lp = loopPoint(loop, t.i, along0, turn > 1.2 ? 24 : sharp ? 32 : 55);
    let target = lp.point;
    if (turn > 1.2) {
      // swing a little wide (toward the road centre) so the body clears the inside of the corner
      target = { x: target.x + lp.dir.y * 12, y: target.y - lp.dir.x * 12 };
    }
    const fx = -Math.sin(car.angle);
    const fy = -Math.cos(car.angle);
    let blocked = false;
    // a parked car beside our lane: shift toward the road centre while passing it (stays in our half)
    let passing = false;
    const laneDir = loop.segs[t.i].directionVector();
    const ego = this.egoCar();
    const passables: Array<{ x: number; y: number }> = this.staticObstacles.map((o) => ({ x: (o.polygon[0].x + o.polygon[2].x) / 2, y: (o.polygon[0].y + o.polygon[2].y) / 2 }));
    for (const o of passables) {
      const ox = o.x - car.x;
      const oy = o.y - car.y;
      const along = ox * laneDir.x + oy * laneDir.y;
      const lateral = Math.abs(ox * laneDir.y - oy * laneDir.x);
      if (lateral < KERB_OFFSET + 30 && along > -70 && along < 160) passing = true;
    }
    if (passing) {
      // road centre lies on the (d.y, −d.x) side of every loop (see buildLoops)
      target = { x: target.x + laneDir.y * PASS_OFFSET, y: target.y - laneDir.x * PASS_OFFSET };
    }
    const desired = Math.atan2(-(target.x - car.x), -(target.y - car.y));
    const err = wrap(desired - car.angle);
    car.controls.left = err > 0.02;
    car.controls.right = err < -0.02;
    // car-following: anything ahead in our path within 75 px → coast (except what we are passing)
    const others: Array<{ x: number; y: number }> = this.traffic.map((o) => o.car);
    if (ego && this.egoSolid(ego)) others.push(ego);
    if (!passing) others.push(...passables);
    for (const o of others) {
      if (o === car) continue;
      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const along = dx * fx + dy * fy;
      const lateral = Math.abs(dx * fy - dy * fx);
      if (along <= 0 || along > 75 || lateral > 26) continue; // not in our path (beside us, oncoming lane)
      // a stationary car off to the side stops holding us after a while — solid bodies keep us apart
      const stationary = Math.abs((o as VwCar).speed ?? 0) < 0.05;
      if (stationary && lateral > 12 && t.stuckTimer > 3) continue;
      blocked = true;
    }
    // signals and stop signs on our lane ahead
    for (const m of this.world.markings) {
      if (m.type !== 'light' && m.type !== 'stop' && m.type !== 'yield') continue;
      const dx = m.center.x - car.x;
      const dy = m.center.y - car.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 70) continue;
      const alongDir = (dx * fx + dy * fy) / Math.max(dist, 1e-6);
      // markings address traffic heading −directionVector
      const sameDir = -(m.directionVector.x * fx + m.directionVector.y * fy);
      if (alongDir < 0.6 || sameDir < 0.7) continue;
      if (m.type === 'light' && m.state !== 'green') blocked = true;
      if (m.type === 'stop' || m.type === 'yield') {
        const key = `${m.center.x},${m.center.y}`;
        if (t.passedStop !== key) {
          // the wait starts at the line, or wherever the car came to rest short of it
          if (dist < 30 || (dist < 55 && Math.abs(car.speed) < 0.3)) {
            t.stopTimer += 1 / FPS;
            if (t.stopTimer < (m.type === 'stop' ? 1.2 : 0.4)) blocked = true;
            else t.passedStop = key;
          } else blocked = blocked || dist < 55;
        }
      }
    }
    if (!blocked) t.stopTimer = 0;
    // nose-to-nose contact that does not clear: back away for a moment, then try again
    if (t.touching && t.stuckTimer > 4 && t.backTimer <= 0) t.backTimer = 0.7;
    if (t.backTimer > 0) {
      t.backTimer -= 1 / FPS;
      car.controls.forward = false;
      car.controls.reverse = true;
      car.controls.left = false;
      car.controls.right = false;
      return;
    }
    car.controls.forward = !blocked && car.speed < speedCap;
    car.controls.reverse = false;
  }

  // ─── static conversion ──────────────────────────────────────────────────────

  private buildStatic(): VirtualWorldSim['staticState'] {
    const w = this.world;
    const markings: Marking[] = [];
    const crosswalks: Crosswalk[] = [];
    const signs: SignState[] = [];
    const parked: VehicleState[] = [];
    const lights: VirtualWorldSim['staticState']['lights'] = [];
    const id = `vw-${w.graph.hash().length}-${w.markings.length}-${Date.now()}`;
    const segPts = (s: VwSegment) => [toWorld(s.p1), toWorld(s.p2)];

    // all centre lines in one batched marking, all borders in another (thousands in big worlds)
    markings.push({ id: 'centres', kind: 'lane', dashed: true, width: 0.14, segments: true, points: w.graph.segments.flatMap(segPts) });
    markings.push({ id: 'borders', kind: 'edge', dashed: false, width: 0.14, segments: true, points: w.roadBorders.flatMap(segPts) });

    const rightOf = (h: number, dist: number) => ({ x: Math.cos(h) * dist, z: -Math.sin(h) * dist });
    w.markings.forEach((m, i) => {
      const c = toWorld(m.center);
      const h = travelHeading(m.directionVector); // direction of the traffic this marking addresses
      const halfW = (m.width / 2) * PX_TO_M;
      const halfH = (m.height / 2) * PX_TO_M;
      switch (m.type) {
        case 'crossing':
          crosswalks.push({ id: `cw${i}`, x: c.x, z: c.z, heading: h, length: m.width * PX_TO_M, depth: m.height * PX_TO_M });
          break;
        case 'stop':
        case 'yield': {
          // the line is the far edge in travel direction; the sign stands beside it, facing the driver
          if (m.border) markings.push({ id: `sl${i}`, kind: 'stop', dashed: false, width: m.type === 'stop' ? 0.4 : 0.25, points: segPts(m.border) });
          const r = rightOf(h, halfW + 1.0);
          const fwd = { x: Math.sin(h) * halfH, z: Math.cos(h) * halfH };
          signs.push({ id: `sg${i}`, kind: m.type, x: c.x + r.x + fwd.x, z: c.z + r.z + fwd.z, heading: wrap(h + Math.PI) });
          break;
        }
        case 'light': {
          // stop line at the near edge, signal head at the bar (centre), right of the lane, facing the driver
          if (m.border) markings.push({ id: `ll${i}`, kind: 'stop', dashed: false, width: 0.35, points: segPts(m.border) });
          const r = rightOf(h, halfW + 1.0);
          lights.push({ marking: m, pos: { x: c.x + r.x, z: c.z + r.z }, heading: wrap(h + Math.PI) });
          break;
        }
        case 'parking': {
          // the bay lines move to the kerb with the car (see parkedPose)
          const pose = this.parkedPose(m);
          const shift = { x: pose.x - m.center.x, y: pose.y - m.center.y };
          for (const b of m.borders ?? []) {
            const pts = [b.p1, b.p2].map((q) => toWorld({ x: q.x + shift.x, y: q.y + shift.y }));
            markings.push({ id: `pk${i}${b === m.borders![0] ? 'a' : 'b'}`, kind: 'edge', dashed: false, width: 0.12, points: pts });
          }
          const pp = toWorld(pose);
          parked.push({ id: `parked${i}`, type: hash2(i, 1, 5) < 0.75 ? 'sedan' : 'crossover', x: pp.x, z: pp.z, heading: h, parked: true, brake: false, tint: 0.35 + 0.4 * hash2(i, 2, 5) });
          break;
        }
        case 'target': {
          const ring: Array<{ x: number; z: number }> = [];
          for (let k = 0; k <= 20; k++) {
            const a = (k / 20) * Math.PI * 2;
            ring.push({ x: c.x + Math.cos(a) * 2.6, z: c.z + Math.sin(a) * 2.6 });
          }
          markings.push({ id: `tg${i}`, kind: 'stop', dashed: false, width: 0.45, points: ring });
          break;
        }
        default:
          break;
      }
    });

    // signal groups: nearest graph intersection (degree > 2), as upstream
    const inter: Array<{ x: number; y: number; lights: VwMarking[] }> = [];
    const degree = (p: { x: number; y: number }) => w.graph.segments.filter((s) => s.includes(p as never)).length;
    const nodes = w.graph.points.filter((p) => degree(p) > 2);
    for (const l of w.markings) {
      if (l.type !== 'light') continue;
      let best: { x: number; y: number } | null = null;
      let bd = Infinity;
      for (const p of nodes) {
        const d = Math.hypot(p.x - l.center.x, p.y - l.center.y);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best) continue;
      let g = inter.find((c) => c.x === best!.x && c.y === best!.y);
      if (!g) inter.push((g = { x: best.x, y: best.y, lights: [] }));
      g.lights.push(l);
    }

    const buildings = w.buildings.map((b, i) => ({ id: `bld${i}`, polygon: b.base.points.map(toWorld), height: b.height * PX_TO_M }));
    const trees = w.trees.map((t, i) => ({ id: `tree${i}`, x: t.center.x * PX_TO_M, z: -t.center.y * PX_TO_M, size: t.size * PX_TO_M }));

    const startM = w.markings.find((m) => m.type === 'start');
    const start = startM
      ? { x: startM.center.x, y: startM.center.y, angle: -vw.angle(startM.directionVector) + Math.PI / 2 }
      : { x: 100, y: 100, angle: 0 };
    return { markings, crosswalks, signs, buildings, trees, parked, lights, intersections: inter, start, id };
  }

  // ─── state output ───────────────────────────────────────────────────────────

  toState(base: WorldState): WorldState {
    const st = this.staticState;
    const ego = this.egoCar();
    const sm = this.smooth;
    const pose = sm ? carPose(sm) : ego ? carPose(ego) : { x: 0, z: 0, heading: 0, speedKph: 0 };
    const route = sm ? this.laneAhead(sm, 46) : ego ? this.laneAhead(ego, 46) : [];
    const vehicles: VehicleState[] = [...st.parked];
    this.traffic.forEach((t) => {
      const p = carPose(t.car);
      vehicles.push({ id: t.id, type: t.type, x: p.x, z: p.z, heading: p.heading, parked: false, brake: !t.car.controls.forward, tint: t.tint });
    });
    if (this.showPopulation && this.mode === 'ai') {
      const others = this.cars.filter((c) => c !== this.bestCar && !c.damaged).sort((a, b) => b.fittness - a.fittness).slice(0, 15);
      others.forEach((c, i) => {
        const p = carPose(c);
        vehicles.push({ id: `pop-${i}`, type: 'sedan', x: p.x, z: p.z, heading: p.heading, parked: false, brake: false, tint: 0.85 });
      });
    }
    const trafficLights: TrafficLightState[] = st.lights.map((l, i) => ({
      id: `light${i}`,
      x: l.pos.x,
      z: l.pos.z,
      heading: l.heading,
      state: l.marking.state === 'green' ? 'green' : l.marking.state === 'yellow' ? 'yellow' : 'red',
    }));
    const rays: WorldState['rays'] = [];
    if (this.showSensors && ego?.sensor) {
      ego.sensor.rays.forEach((r, i) => {
        const hit = ego.sensor!.readings[i];
        const a = toWorld(r[0]);
        const b = toWorld(hit ?? r[1]);
        rays.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, hit: !!hit });
      });
    }
    return {
      ...base,
      time: this.time,
      ego: pose,
      egoBrake: !!ego && (ego.damaged || (ego.speed < 0.6 && ego.controls.reverse === true)),
      speedLimit: 50,
      vehicles,
      pedestrians: [],
      lanes: { ...base.lanes, markings: st.markings, crosswalks: st.crosswalks, arrows: [] },
      props: { trafficLights, signs: st.signs },
      route: { points: route },
      trajectory: { ...base.trajectory, visible: route.length >= 2 },
      buildings: st.buildings,
      trees: st.trees,
      rays,
      mapId: st.id,
      streetName: undefined,
    };
  }
}

/** The rectangle the upstream Car builds in #createPolygon (rebuilt after a collision undo). */
function carPolygon(c: { x: number; y: number; angle: number; width: number; height: number }): Array<{ x: number; y: number }> {
  const rad = Math.hypot(c.width, c.height) / 2;
  const alpha = Math.atan2(c.width, c.height);
  return [
    { x: c.x - Math.sin(c.angle - alpha) * rad, y: c.y - Math.cos(c.angle - alpha) * rad },
    { x: c.x - Math.sin(c.angle + alpha) * rad, y: c.y - Math.cos(c.angle + alpha) * rad },
    { x: c.x - Math.sin(Math.PI + c.angle - alpha) * rad, y: c.y - Math.cos(Math.PI + c.angle - alpha) * rad },
    { x: c.x - Math.sin(Math.PI + c.angle + alpha) * rad, y: c.y - Math.cos(Math.PI + c.angle + alpha) * rad },
  ];
}

function carPose(c: { x: number; y: number; angle: number; speed: number }): { x: number; z: number; heading: number; speedKph: number } {
  const p = toWorld(c);
  return { x: p.x, z: p.z, heading: -c.angle, speedKph: Math.abs(c.speed) * FPS * PX_TO_M * 3.6 };
}

/** Chain the lane-guide segments (a polygon union) into oriented loops for right-hand traffic. */
/** Point and direction `dist` px further along a loop from (segment i, distance `along` into it). */
function loopPoint(loop: Loop, i: number, along: number, dist: number): { point: { x: number; y: number }; dir: { x: number; y: number } } {
  let idx = i;
  let seg = loop.segs[idx];
  let d = seg.directionVector();
  let s = along + dist;
  for (let k = 0; k < 8; k++) {
    const len = seg.length();
    if (s <= len) return { point: { x: seg.p1.x + d.x * s, y: seg.p1.y + d.y * s }, dir: d };
    s -= len;
    idx = (idx + 1) % loop.segs.length;
    seg = loop.segs[idx];
    d = seg.directionVector();
  }
  return { point: { x: seg.p1.x, y: seg.p1.y }, dir: d };
}

function buildLoops(world: VwWorld): Loop[] {
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const byEnd = new Map<string, VwSegment[]>();
  for (const s of world.laneGuides) {
    for (const p of [s.p1, s.p2]) {
      const k = key(p);
      let list = byEnd.get(k);
      if (!list) byEnd.set(k, (list = []));
      list.push(s);
    }
  }
  const used = new Set<VwSegment>();
  // zero-length guides (arc artefacts of the polygon union) have no direction: never follow them
  for (const s of world.laneGuides) if (s.length() < 0.5) used.add(s);
  const loops: Loop[] = [];
  for (const start of world.laneGuides) {
    if (used.has(start)) continue;
    const segs: VwSegment[] = [];
    let cur: VwSegment = start;
    let p1 = start.p1;
    let p2 = start.p2;
    let guard = 0;
    while (guard++ < 5000) {
      used.add(cur);
      segs.push(new vw.Segment(p1, p2));
      let next = (byEnd.get(key(p2)) ?? []).find((s) => !used.has(s));
      if (!next) {
        // the polygon union leaves small gaps in the corner arcs: bridge to the nearest loose end
        let bestGap = 45;
        for (const s of world.laneGuides) {
          if (used.has(s)) continue;
          for (const p of [s.p1, s.p2]) {
            const gap = Math.hypot(p.x - p2.x, p.y - p2.y);
            if (gap < bestGap) {
              bestGap = gap;
              next = s;
            }
          }
        }
        if (!next) break;
        const q = Math.hypot(next.p1.x - p2.x, next.p1.y - p2.y) <= Math.hypot(next.p2.x - p2.x, next.p2.y - p2.y) ? next.p1 : next.p2;
        if (Math.hypot(q.x - p2.x, q.y - p2.y) > 0.5) segs.push(new vw.Segment(p2, q));
        p2 = q;
      }
      cur = next;
      if (key(next.p1) === key(p2)) {
        p1 = next.p1;
        p2 = next.p2;
      } else {
        p1 = next.p2;
        p2 = next.p1;
      }
    }
    if (segs.length < 2) continue;
    // close the loop across a final gap so the follower does not jump back to the first segment
    const first = segs[0].p1;
    const last = segs[segs.length - 1].p2;
    const closing = Math.hypot(first.x - last.x, first.y - last.y);
    if (closing > 0.5 && closing < 120) segs.push(new vw.Segment(last, first));
    // orient: the road centre (nearest graph segment) should lie on the LEFT of travel
    let leftVotes = 0;
    let rightVotes = 0;
    for (const s of segs.slice(0, Math.min(segs.length, 40))) {
      const mid = new vw.Point((s.p1.x + s.p2.x) / 2, (s.p1.y + s.p2.y) / 2);
      const centre = vw.getNearestSegment(mid, world.graph.segments, world.roadWidth);
      if (!centre) continue;
      const proj = centre.projectPoint(mid);
      const d = s.directionVector();
      const cross = d.x * (proj.point.y - mid.y) - d.y * (proj.point.x - mid.x);
      if (cross < 0) leftVotes++;
      else rightVotes++;
    }
    const oriented = rightVotes > leftVotes ? segs.reverse().map((s) => new vw.Segment(s.p2, s.p1)) : segs;
    loops.push({ segs: oriented, length: oriented.reduce((a, s) => a + s.length(), 0) });
  }
  return loops;
}
