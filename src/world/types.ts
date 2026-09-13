/**
 * World-state model shared between the simulation (producer) and the renderer (consumer).
 *
 * Frame: right-handed, y up. +x is the ego's right, +z is the ego's forward direction at t = 0.
 * Units are metres, seconds, degrees only where explicitly named `*Deg`.
 * Heading is a rotation about +y in radians; heading 0 points along +z, positive turns toward +x.
 */

export type VehicleType = 'sedan' | 'crossover' | 'van';

export interface Pose2D {
  x: number;
  z: number;
  /** radians, 0 = facing +z, positive = turning toward +x */
  heading: number;
}

export interface EgoState extends Pose2D {
  speedKph: number;
}

export interface VehicleState extends Pose2D {
  id: string;
  type: VehicleType;
  /** Parked vehicles never move in world coordinates. */
  parked: boolean;
  /** Brake lights lit (queue traffic in the reference shows red tail lights). */
  brake: boolean;
  /** 0..1 shade variation so a row of cars is not perfectly uniform. */
  tint: number;
}

export interface PedestrianState extends Pose2D {
  id: string;
  /** Walk-cycle phase in radians, advanced by the simulation. */
  phase: number;
}

export type MarkingKind = 'lane' | 'center' | 'edge' | 'stop';

/** A painted line on the road: a polyline of world points, dashed or solid. */
export interface Marking {
  id: string;
  kind: MarkingKind;
  points: Array<{ x: number; z: number }>;
  dashed: boolean;
  /** Line width, metres. */
  width: number;
}

/** Zebra crossing: centred at (x, z), stripes run along `heading` (the road direction). */
export interface Crosswalk {
  id: string;
  x: number;
  z: number;
  heading: number;
  /** extent across the road */
  length: number;
  /** extent along the road */
  depth: number;
}

export interface LaneArrow {
  id: string;
  x: number;
  z: number;
  heading: number;
}

export interface LaneGeometry {
  markings: Marking[];
  crosswalks: Crosswalk[];
  arrows: LaneArrow[];
  /** Length of one dash + gap, metres. */
  dashPeriod: number;
  dashLength: number;
}

export type LightColor = 'red' | 'yellow' | 'green';

export interface TrafficLightState {
  id: string;
  x: number;
  z: number;
  /** direction the lamps face */
  heading: number;
  state: LightColor;
}

export interface SignState {
  id: string;
  kind: 'stop';
  x: number;
  z: number;
  heading: number;
}

export interface Props {
  trafficLights: TrafficLightState[];
  signs: SignState[];
}

export interface Trajectory {
  visible: boolean;
  /** Corridor half-width in metres. */
  halfWidth: number;
  /** Corridor length ahead of the ego in metres (used when `route` has no points). */
  length: number;
}

export interface WorldState {
  /** Simulation time in seconds since reset. */
  time: number;
  ego: EgoState;
  /** Ego brake lights lit. */
  egoBrake: boolean;
  /** Posted limit for the road the ego is on (km/h). */
  speedLimit: number;
  vehicles: VehicleState[];
  pedestrians: PedestrianState[];
  lanes: LaneGeometry;
  props: Props;
  /** Planned path ahead of the ego (world points), drawn as the blue corridor when visible. */
  route: { points: Array<{ x: number; z: number }> };
  trajectory: Trajectory;
  /** Name of the street the ego is on (map worlds). */
  streetName?: string;
  /** Static building footprints (map worlds); the renderer rebuilds when `mapId` changes. */
  buildings?: Array<{ id: string; polygon: Array<{ x: number; z: number }>; height: number }>;
  mapId?: string;
}

export const DEG = Math.PI / 180;
