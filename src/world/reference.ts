import { DEG, type WorldState, type VehicleState, type PedestrianState } from './types';

/**
 * The frozen arrangement estimated from the reference photo.
 * Positions are metres relative to the ego (x right, z forward).
 */

function v(
  id: string,
  type: VehicleState['type'],
  x: number,
  z: number,
  headingDeg: number,
  opts: Partial<Pick<VehicleState, 'parked' | 'brake' | 'tint'>> = {},
): VehicleState {
  return {
    id,
    type,
    x,
    z,
    heading: headingDeg * DEG,
    parked: opts.parked ?? false,
    brake: opts.brake ?? false,
    tint: opts.tint ?? 0.5,
  };
}

function p(id: string, x: number, z: number, headingDeg: number, phase = 0): PedestrianState {
  return { id, x, z, heading: headingDeg * DEG, phase };
}

export const LANE_WIDTH = 3.5;
export const QUEUE_LANE_X = -3.1;
export const QUEUE_SPACING = 6.6;

export function createReferenceState(): WorldState {
  return {
    time: 0,
    ego: { x: 0, z: 0, heading: 0, speedKph: 42 },
    vehicles: [
      // Queue in the left lane, slightly left of the ego; brake lights lit.
      v('q1', 'sedan', QUEUE_LANE_X, 11.0, 0, { brake: true, tint: 0.55 }),
      v('q2', 'sedan', QUEUE_LANE_X - 0.05, 17.6, 0, { brake: true, tint: 0.45 }),
      v('q3', 'sedan', QUEUE_LANE_X - 0.1, 24.2, 0, { brake: true, tint: 0.6 }),
      v('q4', 'crossover', QUEUE_LANE_X - 0.1, 30.8, 0, { brake: false, tint: 0.5 }),
      // Car ahead in the ego lane, and one much further in the fog.
      v('a1', 'sedan', -1.2, 29.0, 0, { tint: 0.5 }),
      v('a2', 'sedan', -5.4, 56.0, 0, { tint: 0.5 }),
      // Left side: a parked car ahead and a large car angled behind, bottom-left.
      v('l1', 'sedan', -6.0, 7.9, 0, { parked: true, tint: 0.5 }),
      v('l2', 'sedan', -7.3, -7.9, -22, { parked: true, tint: 0.55 }),
      // Right side: diagonal row (nose-in), then a second cluster further right.
      v('r1', 'sedan', 5.4, 16.5, 38, { parked: true, tint: 0.5 }),
      v('r2', 'sedan', 6.7, 13.6, 38, { parked: true, tint: 0.45 }),
      v('r3', 'crossover', 7.5, 10.4, 38, { parked: true, tint: 0.55 }),
      v('r4', 'sedan', 8.2, 6.0, 38, { parked: true, tint: 0.5 }),
      v('r5', 'sedan', 12.3, 7.9, 0, { parked: true, tint: 0.5 }),
      v('r6', 'sedan', 11.2, -4.0, -34, { parked: true, tint: 0.5 }),
      v('r7', 'van', 15.2, 1.3, -30, { parked: true, tint: 0.5 }),
      v('r8', 'sedan', 9.3, -15.4, -30, { parked: true, tint: 0.5 }),
    ],
    pedestrians: [p('ped1', 1.8, 17.3, 0)],
    lanes: {
      lines: [
        { id: 'left', x: -LANE_WIDTH / 2, zStart: -80, zEnd: 400, dashed: true },
        { id: 'right', x: LANE_WIDTH / 2, zStart: 9, zEnd: 400, dashed: true },
      ],
      arrows: [{ id: 'arrow1', x: -0.2, z: 11.2 }],
      dashPeriod: 6,
      dashLength: 4.4,
      width: 0.13,
    },
    trajectory: { visible: false, halfWidth: 1.1, length: 40 },
  };
}
