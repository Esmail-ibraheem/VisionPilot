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

export interface LaneLine {
  id: string;
  /** Lateral offset of the line (metres, world x at t = 0). */
  x: number;
  /** Forward range in which the line exists, relative to the ego at t = 0. */
  zStart: number;
  zEnd: number;
  dashed: boolean;
}

export interface LaneArrow {
  id: string;
  x: number;
  z: number;
}

export interface LaneGeometry {
  lines: LaneLine[];
  arrows: LaneArrow[];
  /** Length of one dash + gap, metres. Used by the renderer to tile markings seamlessly. */
  dashPeriod: number;
  dashLength: number;
  /** Line width, metres. */
  width: number;
}

export interface Trajectory {
  visible: boolean;
  /** Corridor half-width in metres. */
  halfWidth: number;
  /** Corridor length ahead of the ego in metres. */
  length: number;
}

export interface WorldState {
  /** Simulation time in seconds since reset. */
  time: number;
  ego: EgoState;
  vehicles: VehicleState[];
  pedestrians: PedestrianState[];
  lanes: LaneGeometry;
  trajectory: Trajectory;
}

export const DEG = Math.PI / 180;
