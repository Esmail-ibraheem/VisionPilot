import { Detector, type Detection } from './detector';
import { DEFAULT_CAMERA, projectDetection, type CameraModel } from './projection';
import { Tracker, type Track } from './tracker';
import type { FrameSource } from './sources';
import { createReferenceState } from '../world/reference';
import type { PedestrianState, VehicleState, WorldState } from '../world/types';

const KPH = 1 / 3.6;

export interface PerceptionStats {
  detectorFps: number;
  backend: string;
  detections: number;
  tracks: number;
  sourceKind: string;
  modelReady: boolean;
}

/**
 * Camera → neural network → tracks → WorldState. Runs the detector asynchronously at up to
 * ~12 Hz while `toState()` produces a smooth world every render frame.
 */
export class PerceptionMode {
  readonly detector = new Detector();
  readonly tracker = new Tracker();
  camera: CameraModel = { ...DEFAULT_CAMERA };
  /** speed assumed when the source has no odometry (video / webcam), km/h */
  nominalSpeedKph = 40;
  source: FrameSource | null = null;
  lastDetections: Detection[] = [];
  private running = false;
  private time = 0;
  private detectTimes: number[] = [];
  private display = new Map<string, { x: number; z: number; phase: number }>();
  private ego = { x: 0, z: 0, heading: 0, speedKph: 40 };
  private state: WorldState = createReferenceState();
  private confirmed: Track[] = [];
  private lastFrameElement: HTMLVideoElement | HTMLCanvasElement | null = null;

  async start(source: FrameSource): Promise<void> {
    this.stop();
    this.source = source;
    this.running = true;
    this.tracker.reset();
    this.display.clear();
    this.time = 0;
    this.ego = { x: 0, z: 0, heading: 0, speedKph: this.nominalSpeedKph };
    await this.detector.load();
    void this.detectLoop();
  }

  stop(): void {
    this.running = false;
    this.source?.dispose();
    this.source = null;
  }

  get active(): boolean {
    return this.running && this.source !== null;
  }

  private async detectLoop(): Promise<void> {
    let last = performance.now();
    while (this.running && this.source) {
      const src = this.source;
      if (!src.ready) {
        await sleep(60);
        continue;
      }
      const t0 = performance.now();
      let dets: Detection[] = [];
      try {
        dets = await this.detector.detect(src.element);
      } catch (err) {
        console.warn('detector error', err);
        await sleep(200);
        continue;
      }
      if (!this.running || this.source !== src) break;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      this.lastDetections = dets;
      this.lastFrameElement = src.element;
      const objs = dets
        .map((d) => projectDetection(d, this.camera, src.width, src.height))
        .filter((o): o is NonNullable<typeof o> => o !== null);
      this.confirmed = this.tracker.update(objs, now / 1000, dt);
      this.detectTimes.push(now - t0);
      if (this.detectTimes.length > 20) this.detectTimes.shift();
      // Cap the rate so rendering keeps priority.
      const elapsed = performance.now() - t0;
      if (elapsed < 80) await sleep(80 - elapsed);
    }
  }

  stats(): PerceptionStats {
    const avg = this.detectTimes.length ? this.detectTimes.reduce((a, b) => a + b, 0) / this.detectTimes.length : 0;
    return {
      detectorFps: avg > 0 ? Math.min(12.5, 1000 / Math.max(avg, 80)) : 0,
      backend: this.detector.backend,
      detections: this.lastDetections.length,
      tracks: this.confirmed.length,
      sourceKind: this.source?.kind ?? 'none',
      modelReady: this.detector.ready,
    };
  }

  /** The element most recently analysed (for drawing boxes over the PiP). */
  get frameElement(): HTMLVideoElement | HTMLCanvasElement | null {
    return this.lastFrameElement;
  }

  /** Advance ego odometry and produce the world for this render frame. */
  step(dt: number): WorldState {
    const src = this.source;
    if (!src) return this.state;
    src.tick(dt);
    this.time += dt;
    const odo = src.egoPose();
    if (odo) this.ego = odo;
    else {
      const v = this.nominalSpeedKph * KPH;
      this.ego.speedKph = this.nominalSpeedKph;
      this.ego.z += v * dt;
    }
    const e = this.ego;
    const sinH = Math.sin(e.heading);
    const cosH = Math.cos(e.heading);
    const vehicles: VehicleState[] = [];
    const pedestrians: PedestrianState[] = [];
    const seen = new Set<string>();
    const k = Math.min(1, dt * 9);
    for (const t of this.confirmed) {
      seen.add(t.id);
      let d = this.display.get(t.id);
      if (!d) {
        d = { x: t.x, z: t.z, phase: 0 };
        this.display.set(t.id, d);
      }
      d.x += (t.x - d.x) * k;
      d.z += (t.z - d.z) * k;
      d.phase += dt * 6;
      // camera-relative → world
      const wx = e.x + d.z * sinH + d.x * cosH;
      const wz = e.z + d.z * cosH - d.x * sinH;
      if (t.kind === 'pedestrian') pedestrians.push({ id: t.id, x: wx, z: wz, heading: e.heading, phase: d.phase });
      else vehicles.push({ id: t.id, type: t.kind, x: wx, z: wz, heading: e.heading, parked: false, brake: false, tint: 0.5 });
    }
    for (const id of this.display.keys()) if (!seen.has(id)) this.display.delete(id);

    // Lane geometry is not detected by this pipeline: assume straight lanes around the ego.
    const ahead = 400;
    const behind = 100;
    const mk = (id: string, lateral: number, dashed: boolean, kind: 'lane' | 'edge') => ({
      id,
      kind,
      dashed,
      width: 0.13,
      points: [
        { x: e.x + lateral * cosH - behind * sinH, z: e.z - lateral * sinH - behind * cosH },
        { x: e.x + lateral * cosH + ahead * sinH, z: e.z - lateral * sinH + ahead * cosH },
      ],
    });
    // Anchor the lines to a stable world origin so dashes scroll instead of sticking to the ego:
    // quantise the start point to the dash period along the heading.
    const period = 6;
    const along = e.x * sinH + e.z * cosH;
    const snap = Math.floor(along / period) * period - along; // ≤ 0
    const shift = (lat: number, dashed: boolean, id: string, kind: 'lane' | 'edge') => {
      const m = mk(id, lat, dashed, kind);
      for (const p of m.points) {
        p.x += snap * sinH;
        p.z += snap * cosH;
      }
      return m;
    };
    this.state = {
      time: this.time,
      ego: { ...e },
      egoBrake: false,
      speedLimit: 50,
      vehicles,
      pedestrians,
      lanes: {
        markings: [shift(-1.75, true, 'pl', 'lane'), shift(1.75, true, 'pr', 'lane'), shift(-5.25, false, 'el', 'edge'), shift(5.25, false, 'er', 'edge')],
        crosswalks: [],
        arrows: [],
        dashPeriod: period,
        dashLength: 4.4,
      },
      props: { trafficLights: [], signs: [] },
      route: { points: [] },
      trajectory: { visible: false, halfWidth: 1.1, length: 40 },
    };
    return this.state;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
