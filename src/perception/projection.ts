import type { Detection } from './detector';
import type { VehicleType } from '../world/types';

/**
 * Monocular ground-plane projection: a forward-facing camera at height `cameraHeight` looking
 * level (horizon at `horizon` × image height). The bottom edge of a detection box touches the
 * ground, so its pixel row gives the distance; the column gives the lateral offset.
 */
export interface CameraModel {
  /** horizontal field of view in degrees */
  hfovDeg: number;
  /** camera height above the road in metres */
  cameraHeight: number;
  /** horizon row as a fraction of image height (0.5 = level camera) */
  horizon: number;
}

export const DEFAULT_CAMERA: CameraModel = { hfovDeg: 70, cameraHeight: 1.35, horizon: 0.5 };

export type ObjectKind = VehicleType | 'pedestrian';

export interface ProjectedObject {
  kind: ObjectKind;
  label: string;
  score: number;
  /** metres; x right, z forward, relative to the camera */
  x: number;
  z: number;
  bbox: Detection['bbox'];
}

export function classifyKind(d: Detection): ObjectKind {
  const [, , w, h] = d.bbox;
  switch (d.label) {
    case 'car':
      return 'sedan';
    case 'truck':
      return h / Math.max(w, 1) > 0.9 ? 'van' : 'crossover';
    case 'bus':
      return 'van';
    default:
      return 'pedestrian';
  }
}

export function projectDetection(d: Detection, cam: CameraModel, width: number, height: number): ProjectedObject | null {
  const [bx, by, bw, bh] = d.bbox;
  const f = width / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360);
  const yHorizon = cam.horizon * height;
  const yBottom = by + bh;
  const rows = yBottom - yHorizon;
  if (rows < 3) return null; // above the horizon: not on the ground plane
  let z = (cam.cameraHeight * f) / rows;
  const kind = classifyKind(d);
  // Boxes clipped by the frame edge sit closer than their bottom row suggests; clamp instead.
  if (yBottom >= height - 2) z = Math.min(z, 6);
  if (z > 140) return null;
  const xCenter = bx + bw / 2;
  const x = ((xCenter - width / 2) * z) / f;
  // A vehicle's box bottom is its rear bumper; place the body centre a bit further.
  const zCenter = kind === 'pedestrian' ? z : z + 2.2;
  return { kind, label: d.label, score: d.score, x, z: zCenter, bbox: d.bbox };
}
