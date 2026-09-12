import type { BodySpec } from './loft';
import type { VehicleType } from '../../world/types';

export type BodyKind = VehicleType | 'ego';

/** Generic mid-size sedan (≈ 4.7 × 1.85 × 1.46 m, wheelbase 2.8 m). */
export const SEDAN: BodySpec = {
  length: 4.7,
  width: 1.88,
  top: [
    [-2.35, 0.9], [-1.95, 0.94], [-1.6, 0.97], [-1.4, 1.05], [-1.0, 1.29], [-0.65, 1.39],
    [-0.2, 1.42], [0.25, 1.41], [0.55, 1.36], [0.9, 1.17], [1.2, 0.99], [1.4, 0.94], [1.9, 0.87], [2.35, 0.79],
  ],
  belt: [[-2.35, 0.86], [-1.6, 0.92], [-1.3, 0.95], [0.9, 0.96], [1.3, 0.92], [1.9, 0.83], [2.35, 0.75]],
  halfWidth: [[-2.35, 0.87], [-1.6, 0.925], [-0.5, 0.94], [0.8, 0.94], [1.6, 0.915], [2.35, 0.85]],
  topRatio: [
    [-2.35, 0.9], [-1.6, 0.88], [-1.45, 0.84], [-0.9, 0.66], [-0.3, 0.62], [0.4, 0.62],
    [0.9, 0.7], [1.25, 0.84], [1.5, 0.9], [2.35, 0.9],
  ],
  bottom: [[-2.35, 0.4], [-1.9, 0.27], [-0.5, 0.25], [1.6, 0.25], [2.0, 0.29], [2.35, 0.4]],
  noseRadius: 0.5,
  tailRadius: 0.4,
  noseEdge: 0.22,
  tailEdge: 0.2,
  bottomRatio: 0.92,
  crown: 0.035,
  shoulderRound: 0.58,
  trimHeight: 0.36,
  wheels: { radius: 0.34, width: 0.2, track: 1.54, frontZ: 1.4, rearZ: -1.4, archGap: 0.06 },
  glass: { zRear: -1.45, zFront: 1.25, roofIsGlass: false, roofNormalY: 0.93, pillars: [-0.2], pillarWidth: 0.1 },
};

/** Compact crossover / SUV (≈ 4.6 × 1.9 × 1.66 m). */
export const CROSSOVER: BodySpec = {
  length: 4.6,
  width: 1.9,
  top: [
    [-2.3, 1.12], [-2.15, 1.2], [-1.95, 1.4], [-1.7, 1.56], [-1.4, 1.63], [-0.5, 1.66], [0.3, 1.64],
    [0.7, 1.55], [1.05, 1.3], [1.35, 1.12], [1.55, 1.06], [2.0, 1.0], [2.3, 0.94],
  ],
  belt: [[-2.3, 1.0], [-1.7, 1.06], [-1.3, 1.1], [0.8, 1.1], [1.3, 1.06], [2.0, 0.98], [2.3, 0.9]],
  halfWidth: [[-2.3, 0.88], [-1.5, 0.94], [0, 0.95], [1.5, 0.93], [2.3, 0.86]],
  topRatio: [
    [-2.3, 0.9], [-2.05, 0.86], [-1.8, 0.74], [-1.4, 0.68], [0.5, 0.66], [0.85, 0.72],
    [1.2, 0.84], [1.5, 0.9], [2.3, 0.9],
  ],
  bottom: [[-2.3, 0.4], [-1.9, 0.27], [0, 0.25], [1.8, 0.25], [2.1, 0.3], [2.3, 0.42]],
  noseRadius: 0.48,
  tailRadius: 0.34,
  noseEdge: 0.2,
  tailEdge: 0.16,
  bottomRatio: 0.9,
  crown: 0.02,
  shoulderRound: 0.45,
  trimHeight: 0.4,
  wheels: { radius: 0.37, width: 0.22, track: 1.58, frontZ: 1.38, rearZ: -1.37, archGap: 0.07 },
  glass: { zRear: -2.1, zFront: 1.3, roofIsGlass: false, roofNormalY: 0.93, pillars: [-0.1, -1.5], pillarWidth: 0.1 },
};

/** Panel van / people carrier (≈ 5.0 × 1.95 × 1.95 m). */
export const VAN: BodySpec = {
  length: 5.0,
  width: 1.95,
  top: [
    [-2.5, 1.8], [-2.2, 1.9], [-1.5, 1.94], [0.5, 1.95], [1.15, 1.92], [1.35, 1.8], [1.6, 1.5],
    [1.85, 1.15], [2.1, 1.02], [2.5, 0.92],
  ],
  belt: [[-2.5, 1.05], [-1.5, 1.1], [1.2, 1.12], [1.8, 1.08], [2.2, 1.0], [2.5, 0.92]],
  halfWidth: [[-2.5, 0.93], [-1, 0.975], [1.2, 0.975], [2.0, 0.95], [2.5, 0.88]],
  topRatio: [[-2.5, 0.86], [-1.5, 0.84], [1.0, 0.82], [1.4, 0.82], [1.9, 0.86], [2.5, 0.9]],
  bottom: [[-2.5, 0.36], [-2.1, 0.26], [0, 0.24], [2.0, 0.26], [2.5, 0.38]],
  noseRadius: 0.42,
  tailRadius: 0.3,
  noseEdge: 0.2,
  tailEdge: 0.15,
  bottomRatio: 0.92,
  crown: 0.02,
  shoulderRound: 0.4,
  trimHeight: 0.4,
  wheels: { radius: 0.35, width: 0.2, track: 1.62, frontZ: 1.55, rearZ: -1.65, archGap: 0.07 },
  glass: { zRear: -2.3, zFront: 1.9, roofIsGlass: false, roofNormalY: 0.93, pillars: [0.85, -0.55, -1.75], pillarWidth: 0.12 },
};

/** The black ego car, proportioned like a Tesla Model 3 (4.72 × 1.85 × 1.44 m, wheelbase 2.88 m). */
export const EGO: BodySpec = {
  length: 4.72,
  width: 1.85,
  top: [
    [-2.36, 0.9], [-2.0, 0.96], [-1.65, 1.02], [-1.45, 1.1], [-1.0, 1.32], [-0.6, 1.42], [-0.15, 1.44],
    [0.3, 1.42], [0.65, 1.34], [1.05, 1.12], [1.3, 0.98], [1.55, 0.92], [2.0, 0.83], [2.36, 0.74],
  ],
  belt: [[-2.36, 0.88], [-1.7, 0.95], [-1.3, 0.99], [0.9, 1.0], [1.35, 0.95], [2.0, 0.82], [2.36, 0.72]],
  halfWidth: [[-2.36, 0.85], [-1.5, 0.91], [0, 0.925], [1.4, 0.91], [2.36, 0.82]],
  topRatio: [
    [-2.36, 0.9], [-1.7, 0.88], [-1.45, 0.82], [-0.9, 0.68], [-0.2, 0.64], [0.5, 0.65],
    [0.95, 0.74], [1.3, 0.86], [1.6, 0.9], [2.36, 0.9],
  ],
  bottom: [[-2.36, 0.36], [-1.9, 0.24], [0, 0.2], [1.6, 0.2], [2.0, 0.24], [2.36, 0.34]],
  noseRadius: 0.55,
  tailRadius: 0.42,
  noseEdge: 0.2,
  tailEdge: 0.2,
  bottomRatio: 0.9,
  crown: 0.025,
  shoulderRound: 0.55,
  trimHeight: 0,
  wheels: { radius: 0.34, width: 0.21, track: 1.56, frontZ: 1.44, rearZ: -1.44, archGap: 0.06 },
  glass: { zRear: -1.7, zFront: 1.3, roofIsGlass: true, roofNormalY: 1, pillars: [], pillarWidth: 0 },
};

export const BODY_SPECS: Record<BodyKind, BodySpec> = {
  sedan: SEDAN,
  crossover: CROSSOVER,
  van: VAN,
  ego: EGO,
};
