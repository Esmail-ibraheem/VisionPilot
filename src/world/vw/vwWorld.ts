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
  showSensors = true;
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
    if (this.mode === 'manual') this.spawnManual();
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
  }

  resetManual(): void {
    this.spawnManual();
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
    for (const t of this.traffic) this.driveTraffic(t);
    for (const t of this.traffic) t.car.update(this.index.near(t.car.x, t.car.y, 120), []);
    if (this.mode === 'manual' && this.manualCar) {
      this.manualCar.update(this.index.near(this.manualCar.x, this.manualCar.y, RAY_LENGTH + 40), trafficCars);
    }
    let best = this.cars[0];
    for (const car of this.cars) {
      if (!car.damaged) car.update(this.index.near(car.x, car.y, RAY_LENGTH + 40), trafficCars);
      if (car.fittness > best.fittness) best = car;
    }
    this.bestCar = best;
    this.world.cars = this.cars;
    this.world.bestCar = best;
    // generation bookkeeping (upstream saves manually; here the loop is automatic)
    const alive = this.cars.some((c) => !c.damaged);
    if (best.speed < 0.05) this.stallTime += 1 / FPS;
    else this.stallTime = 0;
    const elapsed = this.time - this.generationStart;
    if (!alive || elapsed > this.opts.maxGenerationSeconds || this.stallTime > 6) this.nextGeneration();
    this.maintainTraffic();
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
      this.traffic.push({ id: `traffic-${n}`, car, loop, i, type: slotHash(n, 14) < 0.7 ? 'sedan' : slotHash(n, 14) < 0.9 ? 'crossover' : 'van', tint: 0.35 + 0.4 * slotHash(n, 15), stopTimer: 0, passedStop: null });
    }
  }

  private maintainTraffic(): void {
    const ego = this.egoCar();
    this.traffic = this.traffic.filter((t) => !t.car.damaged && (!ego || Math.hypot(t.car.x - ego.x, t.car.y - ego.y) < 2500));
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
    // look-ahead point along the loop
    let ahead = 55;
    let idx = t.i;
    let seg = loop.segs[idx];
    let d = seg.directionVector();
    let along = (car.x - seg.p1.x) * d.x + (car.y - seg.p1.y) * d.y;
    let target = { x: 0, y: 0 };
    for (let k = 0; k < 6; k++) {
      const remain = seg.length() - along;
      if (ahead <= remain) {
        target = { x: seg.p1.x + d.x * (along + ahead), y: seg.p1.y + d.y * (along + ahead) };
        break;
      }
      ahead -= remain;
      idx = (idx + 1) % loop.segs.length;
      seg = loop.segs[idx];
      d = seg.directionVector();
      along = 0;
      target = { x: seg.p2.x, y: seg.p2.y };
    }
    const desired = Math.atan2(-(target.x - car.x), -(target.y - car.y));
    const err = wrap(desired - car.angle);
    car.controls.left = err > 0.02;
    car.controls.right = err < -0.02;
    // car-following: anything ahead in a narrow cone within 70 px → coast
    const fx = -Math.sin(car.angle);
    const fy = -Math.cos(car.angle);
    let blocked = false;
    const others: VwCar[] = [...this.traffic.map((o) => o.car), ...(this.egoCar() ? [this.egoCar()!] : [])];
    for (const o of others) {
      if (o === car) continue;
      const dx = o.x - car.x;
      const dy = o.y - car.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 75 && (dx * fx + dy * fy) / Math.max(dist, 1e-6) > 0.8) blocked = true;
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
          if (dist < 30) {
            t.stopTimer += 1 / FPS;
            if (t.stopTimer < (m.type === 'stop' ? 1.2 : 0.4)) blocked = true;
            else t.passedStop = key;
          } else blocked = blocked || dist < 55;
        }
      }
    }
    if (!blocked) t.stopTimer = 0;
    car.controls.forward = !blocked;
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
          for (const b of m.borders ?? []) markings.push({ id: `pk${i}${b === m.borders![0] ? 'a' : 'b'}`, kind: 'edge', dashed: false, width: 0.12, points: segPts(b) });
          parked.push({ id: `parked${i}`, type: hash2(i, 1, 5) < 0.75 ? 'sedan' : 'crossover', x: c.x, z: c.z, heading: h, parked: true, brake: false, tint: 0.35 + 0.4 * hash2(i, 2, 5) });
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
    const pose = ego ? carPose(ego) : { x: 0, z: 0, heading: 0, speedKph: 0 };
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
      route: { points: [] },
      trajectory: { ...base.trajectory, visible: false },
      buildings: st.buildings,
      trees: st.trees,
      rays,
      mapId: st.id,
      streetName: undefined,
    };
  }
}

function carPose(c: VwCar): { x: number; z: number; heading: number; speedKph: number } {
  const p = toWorld(c);
  return { x: p.x, z: p.z, heading: -c.angle, speedKph: Math.abs(c.speed) * FPS * PX_TO_M * 3.6 };
}

/** Chain the lane-guide segments (a polygon union) into oriented loops for right-hand traffic. */
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
      const next = (byEnd.get(key(p2)) ?? []).find((s) => !used.has(s));
      if (!next) break;
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
