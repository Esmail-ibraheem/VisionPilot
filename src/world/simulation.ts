import { DEG, type VehicleState, type VehicleType, type WorldState, type PedestrianState } from './types';
import { createReferenceState, QUEUE_LANE_X, QUEUE_SPACING } from './reference';

export type SimMode = 'reference' | 'live';

export interface SimulationOptions {
  mode?: SimMode;
  speedFactor?: number;
}

const KPH = 1 / 3.6;
const QUEUE_SPEED_KPH = 38;
const PEDESTRIAN_SPEED = 1.25;
const DESPAWN_BEHIND = 48;
const SPAWN_AHEAD = 135;

/** Deterministic hash → [0, 1) for slot-based procedural placement. */
export function slotHash(slot: number, salt: number): number {
  let h = (slot * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface ParkingRow {
  key: string;
  x: number;
  headingDeg: number;
  period: number;
  offset: number;
  fill: number;
  types: VehicleType[];
  /** Small lateral wobble so rows are not laser-straight. */
  jitterX: number;
}

/**
 * Rows of parked vehicles generated ahead of the ego in live mode. The reference arrangement
 * occupies z < 50, so the generators only start beyond that (offset ≥ 60).
 */
const PARKING_ROWS: ParkingRow[] = [
  { key: 'pr', x: 6.6, headingDeg: 38, period: 5.2, offset: 62, fill: 0.55, types: ['sedan', 'sedan', 'crossover', 'sedan', 'van'], jitterX: 0.5 },
  { key: 'pf', x: 14.5, headingDeg: -32, period: 8.5, offset: 66, fill: 0.4, types: ['sedan', 'crossover', 'sedan', 'van'], jitterX: 1.2 },
  { key: 'pl', x: -6.9, headingDeg: 0, period: 7.2, offset: 60, fill: 0.42, types: ['sedan', 'crossover', 'sedan'], jitterX: 0.2 },
];

/**
 * Produces WorldState over time. `reference` mode is frozen; `live` mode advances the ego and
 * traffic using elapsed seconds. All randomness is slot-hashed so runs are deterministic.
 */
export class Simulation {
  state: WorldState;
  mode: SimMode;
  speedFactor: number;
  paused = false;
  private queueFrontSerial = 0;
  private lastQueueSpawnZ = 0;

  constructor(opts: SimulationOptions = {}) {
    this.mode = opts.mode ?? 'reference';
    this.speedFactor = opts.speedFactor ?? 1;
    this.state = createReferenceState();
    this.initQueueTracking();
  }

  reset(): void {
    this.state = createReferenceState();
    this.initQueueTracking();
  }

  setMode(mode: SimMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'reference') this.reset();
  }

  private initQueueTracking(): void {
    const queue = this.state.vehicles.filter((v) => v.id.startsWith('q'));
    this.lastQueueSpawnZ = Math.max(...queue.map((v) => v.z));
    this.queueFrontSerial = queue.length;
  }

  /** Advance by `dtSeconds` of wall time (already scaled by speedFactor internally). */
  step(dtSeconds: number): WorldState {
    if (this.mode !== 'live' || this.paused || dtSeconds <= 0) return this.state;
    const dt = Math.min(dtSeconds, 0.1) * this.speedFactor;
    const s = this.state;
    s.time += dt;

    const egoV = s.ego.speedKph * KPH;
    s.ego.z += egoV * dt;

    for (const veh of s.vehicles) {
      if (veh.parked) continue;
      const speed = veh.id.startsWith('q') ? QUEUE_SPEED_KPH * KPH : egoV;
      veh.z += Math.cos(veh.heading) * speed * dt;
      veh.x += Math.sin(veh.heading) * speed * dt;
    }

    for (const ped of s.pedestrians) {
      ped.z += Math.cos(ped.heading) * PEDESTRIAN_SPEED * dt;
      ped.x += Math.sin(ped.heading) * PEDESTRIAN_SPEED * dt;
      ped.phase += dt * 6.5;
    }

    this.recycle();
    this.extendLanes();
    return s;
  }

  private recycle(): void {
    const s = this.state;
    const egoZ = s.ego.z;
    s.vehicles = s.vehicles.filter((v) => v.z > egoZ - DESPAWN_BEHIND);
    s.pedestrians = s.pedestrians.filter((p) => p.z > egoZ - DESPAWN_BEHIND && p.z < egoZ + SPAWN_AHEAD + 20);

    // Queue lane: keep a coherent line of cars extending into the fog.
    while (this.lastQueueSpawnZ < egoZ + SPAWN_AHEAD) {
      this.lastQueueSpawnZ += QUEUE_SPACING * (0.9 + 0.35 * slotHash(this.queueFrontSerial, 11));
      this.queueFrontSerial += 1;
      const serial = this.queueFrontSerial;
      const type: VehicleType = slotHash(serial, 12) < 0.22 ? 'crossover' : 'sedan';
      s.vehicles.push({
        id: `q${serial}`,
        type,
        x: QUEUE_LANE_X - 0.15 * slotHash(serial, 13),
        z: this.lastQueueSpawnZ,
        heading: 0,
        parked: false,
        brake: slotHash(serial, 14) < 0.75,
        tint: 0.35 + 0.4 * slotHash(serial, 15),
      });
    }

    // Parked rows: ensure slots inside the window exist; they stay fixed in world coordinates.
    const existing = new Set(s.vehicles.map((v) => v.id));
    for (const row of PARKING_ROWS) {
      const kMin = Math.ceil((egoZ - DESPAWN_BEHIND - row.offset) / row.period);
      const kMax = Math.floor((egoZ + SPAWN_AHEAD - row.offset) / row.period);
      for (let k = Math.max(0, kMin); k <= kMax; k++) {
        const id = `${row.key}${k}`;
        if (existing.has(id)) continue;
        if (slotHash(k, row.key.charCodeAt(1)) > row.fill) continue;
        const z = row.offset + k * row.period;
        if (z < egoZ + 40) continue; // never pop into view; only appear inside the fog
        const type = row.types[Math.floor(slotHash(k, 21) * row.types.length)];
        s.vehicles.push({
          id,
          type,
          x: row.x + (slotHash(k, 22) - 0.5) * row.jitterX,
          z,
          heading: (row.headingDeg + (slotHash(k, 23) - 0.5) * 6) * DEG,
          parked: true,
          brake: false,
          tint: 0.35 + 0.4 * slotHash(k, 24),
        });
        existing.add(id);
      }
    }

    // Pedestrians: sparse, walking along the right-hand parking edge.
    const pedPeriod = 55;
    const pedIds = new Set(s.pedestrians.map((p) => p.id));
    const kMin = Math.ceil((egoZ + 40) / pedPeriod);
    const kMax = Math.floor((egoZ + SPAWN_AHEAD) / pedPeriod);
    for (let k = Math.max(1, kMin); k <= kMax; k++) {
      const id = `pedk${k}`;
      if (pedIds.has(id) || this.spawnedPeds.has(k)) continue;
      this.spawnedPeds.add(k);
      if (slotHash(k, 31) > 0.5) continue;
      const forward = slotHash(k, 32) < 0.6;
      const ped: PedestrianState = {
        id,
        x: 3.7 + slotHash(k, 33) * 0.6, // road edge, between the ego lane and the parked row
        z: k * pedPeriod + slotHash(k, 34) * 20,
        heading: forward ? 0 : Math.PI,
        phase: slotHash(k, 35) * Math.PI * 2,
      };
      s.pedestrians.push(ped);
    }

    // Lane arrows repeat every 60 m.
    const arrowPeriod = 60;
    const arrowIds = new Set(s.lanes.arrows.map((a) => a.id));
    s.lanes.arrows = s.lanes.arrows.filter((a) => a.z > egoZ - DESPAWN_BEHIND);
    for (let k = Math.ceil((egoZ - 10) / arrowPeriod); k * arrowPeriod + 11.2 < egoZ + SPAWN_AHEAD + 80; k++) {
      const id = `arrow${k + 1}`;
      if (arrowIds.has(id) || k < 0) continue;
      s.lanes.arrows.push({ id, x: -0.2, z: 11.2 + k * arrowPeriod });
    }
  }

  private spawnedPeds = new Set<number>();

  private extendLanes(): void {
    for (const line of this.state.lanes.lines) {
      line.zEnd = Math.max(line.zEnd, this.state.ego.z + 600);
    }
  }
}

export function vehicleLengthHint(type: VehicleType): number {
  switch (type) {
    case 'van':
      return 5.1;
    case 'crossover':
      return 4.6;
    default:
      return 4.7;
  }
}

export type { VehicleState };
