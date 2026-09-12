import { Path, frameToWorld, type Frame, type Vec2 } from './geometry';
import { slotHash } from './hash';

/**
 * Road network the live demo drives through: straight roads crossing at intersections, and the
 * ego's route (a Path of lines + turn arcs) through them. Everything is generated deterministically
 * on demand as the ego advances.
 *
 * Road cross-section (v = lateral offset from the road centre, right positive):
 *   lanes at ±1.75 (inner) and ±5.25 (outer); v > 0 travel +u, v < 0 travel −u
 *   road edge ±7, sidewalk 7..9, parking bays beyond
 */
export const LANE_W = 3.5;
export const LANES_V = [1.75, 5.25, -1.75, -5.25] as const;
export const EGO_LANE_V = 5.25;
export const ROAD_HALF_W = 7;
export const SIDEWALK_V = 8.2;
export const STOP_LINE_OFFSET = 12.5; // from intersection centre to the stop line
export const CROSSWALK_CENTER = 9.5; // from intersection centre
export const RIGHT_TURN_RADIUS = 6.5;
export const LEFT_TURN_RADIUS = 11;

export type LightState = 'red' | 'yellow' | 'green';
/** A+ = leg road, ego direction (outer lane); A+in = same direction, inner lane; A- = oncoming; B = cross road. */
export type Movement = 'A+' | 'A+in' | 'A-' | 'B';

export interface Intersection {
  id: string;
  center: Vec2;
  /** the leg road this intersection belongs to and its u position there */
  roadA: Road;
  uA: number;
  /** the crossing road (its origin is the intersection centre) */
  roadB: Road;
  control: 'lights' | 'stop';
  /** does the ego's route turn here, and which way */
  turn: 'none' | 'left' | 'right';
  phaseOffset: number;
  /** pedestrians may cross here (never at turn intersections) */
  crossings: boolean;
}

export interface Road {
  id: string;
  frame: Frame;
  uMin: number;
  uMax: number;
  speedLimit: number;
  kind: 'main' | 'side';
  /** intersections along this road (both as A road and as B road), sorted by u */
  intersections: Array<{ u: number; intersection: Intersection; asA: boolean }>;
  /** parking bays on the right (diagonal) / left (parallel) side */
  parkingRight: boolean;
  parkingLeft: boolean;
}

export interface Leg {
  index: number;
  road: Road;
  /** route arc-length where the leg's straight part starts */
  sStart: number;
  /** route arc-length at the turn arc start (Infinity until the turn is generated) */
  sTurn: number;
  turn: 'left' | 'right';
  turnIntersection: Intersection | null;
}

// Signal timing (seconds)
const GREEN = 13;
const YELLOW = 3;
const ALL_RED = 1.2;

/**
 * Signal state for a movement at an intersection at world time t.
 * Where the ego turns left it does so from the outer lane, so that intersection runs a protected
 * phase: outer lane alone, then the cross road, then oncoming + inner lane together.
 */
export function lightState(inter: Intersection, movement: Movement, t: number): LightState {
  if (inter.control === 'stop') return movement === 'B' ? 'red' : 'green';
  const phases: Movement[][] = inter.turn === 'left' ? [['A+'], ['B'], ['A-', 'A+in']] : [['A+', 'A+in', 'A-'], ['B']];
  const phaseLen = GREEN + YELLOW + ALL_RED;
  const cycle = phaseLen * phases.length;
  const local = (((t + inter.phaseOffset) % cycle) + cycle) % cycle;
  const idx = Math.floor(local / phaseLen);
  const within = local - idx * phaseLen;
  if (!phases[idx].includes(movement)) return 'red';
  if (within < GREEN) return 'green';
  if (within < GREEN + YELLOW) return 'yellow';
  return 'red';
}

/** Pedestrian walk phase: crossing road A is allowed while A is red and B is green (and vice versa). */
export function walkAllowed(inter: Intersection, crossRoad: 'A' | 'B', t: number): boolean {
  if (!inter.crossings) return false;
  if (crossRoad === 'A') return lightState(inter, 'B', t) === 'green';
  return lightState(inter, 'A+', t) === 'green' && lightState(inter, 'A-', t) === 'green';
}

export interface NetworkOptions {
  /** ego lane offset used to place turn arcs */
  egoLaneV?: number;
}

/**
 * Generates legs on demand. Leg 0 is the reference road: its frame is chosen so the ego's lane
 * (v = EGO_LANE_V) coincides with world x = 0 at t = 0.
 */
export class RoadNetwork {
  readonly roads: Road[] = [];
  readonly intersections: Intersection[] = [];
  readonly legs: Leg[] = [];
  readonly route = new Path();
  private roadSerial = 0;
  private interSerial = 0;
  private egoLaneV: number;

  constructor(opts: NetworkOptions = {}) {
    this.egoLaneV = opts.egoLaneV ?? EGO_LANE_V;
    const road0 = this.createRoad({ origin: { x: -this.egoLaneV, z: 0 }, heading: 0 }, -120, 0, 50, 'main', true, true);
    this.route.startLine({ x: 0, z: 0 }, 0, 1);
    this.legs.push({ index: 0, road: road0, sStart: 0, sTurn: Infinity, turn: 'right', turnIntersection: null });
    this.growLeg(this.legs[0], 0);
  }

  /** Make sure the route and roads exist at least `ahead` metres beyond route position `s`. */
  ensureAhead(s: number, ahead: number): void {
    let guard = 0;
    while (this.route.length < s + ahead && guard++ < 20) {
      const leg = this.legs[this.legs.length - 1];
      this.finishLeg(leg);
    }
  }

  legAt(s: number): Leg {
    let leg = this.legs[0];
    for (const l of this.legs) if (s >= l.sStart) leg = l;
    return leg;
  }

  private createRoad(frame: Frame, uMin: number, uMax: number, speedLimit: number, kind: Road['kind'], parkingRight: boolean, parkingLeft: boolean): Road {
    const road: Road = {
      id: `road${this.roadSerial++}`,
      frame,
      uMin,
      uMax,
      speedLimit,
      kind,
      intersections: [],
      parkingRight,
      parkingLeft,
    };
    this.roads.push(road);
    return road;
  }

  /** Lay out intersections along a leg road, choosing where the route turns. */
  private growLeg(leg: Leg, uFrom: number): void {
    const road = leg.road;
    const k = leg.index;
    const nInter = 2 + Math.floor(slotHash(k, 101) * 2); // 2..3 intersections before the turn
    let u = uFrom;
    for (let i = 0; i < nInter; i++) {
      u += 150 + Math.floor(slotHash(k * 7 + i, 102) * 90);
      const isTurn = i === nInter - 1;
      const control: Intersection['control'] = !isTurn && slotHash(k * 7 + i, 103) < 0.35 ? 'stop' : 'lights';
      const turnDir: Intersection['turn'] = isTurn ? (slotHash(k, 104) < 0.5 ? 'left' : 'right') : 'none';
      const center = frameToWorld(road.frame, u, 0);
      const crossHeading = road.frame.heading + (turnDir === 'left' ? -Math.PI / 2 : Math.PI / 2);
      const side = slotHash(k * 7 + i, 105) < 0.5 ? 'side' : 'main';
      const crossRoad = this.createRoad(
        { origin: center, heading: crossHeading },
        -170,
        170,
        side === 'side' ? 30 : 50,
        isTurn ? 'main' : side,
        slotHash(k * 7 + i, 106) < 0.6,
        slotHash(k * 7 + i, 107) < 0.4,
      );
      const inter: Intersection = {
        id: `int${this.interSerial++}`,
        center,
        roadA: road,
        uA: u,
        roadB: crossRoad,
        control,
        turn: turnDir,
        phaseOffset: slotHash(k * 7 + i, 108) * 40,
        crossings: !isTurn && control === 'lights',
      };
      this.intersections.push(inter);
      road.intersections.push({ u, intersection: inter, asA: true });
      crossRoad.intersections.push({ u: 0, intersection: inter, asA: false });
      if (isTurn) {
        leg.turn = turnDir as 'left' | 'right';
        leg.turnIntersection = inter;
        road.uMax = u + 140; // the road continues past the turn
      }
    }
    road.intersections.sort((a, b) => a.u - b.u);
  }

  /** Append the turn arc and the next leg's straight to the route. */
  private finishLeg(leg: Leg): void {
    const inter = leg.turnIntersection!;
    const v = this.egoLaneV;
    const right = leg.turn === 'right';
    const R = right ? RIGHT_TURN_RADIUS : LEFT_TURN_RADIUS;
    // Arc start on road A (ego lane) measured along u; arc end on road B at u' from the centre.
    const uArcStart = right ? inter.uA - v - R : inter.uA + v - R;
    const uEnd = right ? v + R : R - v;
    // Leg straight runs from its start to the arc start.
    const straightLen = uArcStart - this.legStartU(leg);
    this.route.setLastLineLength(straightLen);
    leg.sTurn = leg.sStart + straightLen;
    this.route.appendArc(R, right ? Math.PI / 2 : -Math.PI / 2);
    const nextRoad = inter.roadB;
    // Next leg: its straight starts at the arc end (u' = uEnd on road B).
    const nextLeg: Leg = {
      index: leg.index + 1,
      road: nextRoad,
      sStart: this.route.length,
      sTurn: Infinity,
      turn: 'right',
      turnIntersection: null,
    };
    this.route.appendLine(1);
    this.legs.push(nextLeg);
    nextRoad.uMin = -170;
    nextRoad.kind = 'main';
    nextRoad.speedLimit = 50;
    this.growLeg(nextLeg, uEnd);
    nextRoad.intersections.sort((a, b) => a.u - b.u);
  }

  /** Where the ego's straight starts on a leg road (u coordinate). */
  legStartU(leg: Leg): number {
    if (leg.index === 0) return 0;
    const prev = this.legs[leg.index - 1];
    const r = prev.turn === 'right';
    const R = r ? RIGHT_TURN_RADIUS : LEFT_TURN_RADIUS;
    return r ? this.egoLaneV + R : R - this.egoLaneV;
  }

  /** Retire roads that are far behind the ego's current leg to keep the world small. */
  retireBefore(legIndex: number): Road[] {
    const keep = new Set<string>();
    for (const leg of this.legs) if (leg.index >= legIndex - 1) keep.add(leg.road.id);
    for (const inter of this.intersections) if (keep.has(inter.roadA.id)) keep.add(inter.roadB.id);
    const retired: Road[] = [];
    for (let i = this.roads.length - 1; i >= 0; i--) {
      if (!keep.has(this.roads[i].id)) retired.push(...this.roads.splice(i, 1));
    }
    return retired;
  }
}
