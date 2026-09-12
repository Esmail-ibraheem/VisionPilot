import * as THREE from 'three';
import type { WorldState } from '../world/types';
import { VehicleObject, PALETTE, disposeVehicleTemplates } from './vehicles/buildVehicle';
import { PedestrianObject } from './pedestrian';
import { LaneMarkings, PathRibbon, createGround } from './ground';
import { PropsRenderer } from './props';
import { createGradientEnvironment } from './environment';
import { toSceneHeading, toSceneX } from './frame';

/** Camera placement relative to the ego. All distances in metres, fov in degrees. */
export interface CameraRig {
  fov: number;
  /** distance behind the ego */
  back: number;
  /** height above the ground */
  height: number;
  /** the camera aims at a ground point this far ahead of the ego */
  ahead: number;
  /** lateral offset of camera and aim point (world x, positive = right) */
  lateral: number;
  fogNear: number;
  fogFar: number;
}

export const DEFAULT_RIG: CameraRig = {
  fov: 27.4,
  back: 43.6,
  height: 13.1,
  ahead: 6.5,
  lateral: 0,
  fogNear: 65,
  fogFar: 160,
};

export interface RendererStats {
  drawCalls: number;
  triangles: number;
  vehicles: number;
}

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  rig: CameraRig;
  /** Developer aid: hide the ego (used by the single-model probe view). */
  showEgo = true;
  /** When set, the camera sits at the ego's windshield looking forward (synthetic front camera). */
  dashcam: { height: number; forward: number } | null = null;
  private vehicles = new Map<string, VehicleObject>();
  private pedestrians = new Map<string, PedestrianObject>();
  private ego: VehicleObject;
  private lanes = new LaneMarkings();
  private props = new PropsRenderer();
  private ribbon = new PathRibbon();
  private fog: THREE.Fog;
  private envTexture: THREE.Texture;
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement, rig: Partial<CameraRig> = {}) {
    this.rig = { ...DEFAULT_RIG, ...rig };
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(PALETTE.background, 1);

    this.camera = new THREE.PerspectiveCamera(this.rig.fov, 1, 1, 900);
    this.fog = new THREE.Fog(PALETTE.background, this.rig.fogNear, this.rig.fogFar);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(PALETTE.background);

    // Soft overcast lighting: bright sky, gray ground bounce, and a gentle key light from the
    // front-left so rear faces read slightly darker than roofs and hoods.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd0d0d0, 1.55);
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(-35, 70, 45);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(40, 30, -60);
    this.scene.add(hemi, key, fill);

    this.envTexture = createGradientEnvironment(this.renderer);
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.45;

    this.scene.add(createGround(PALETTE.background));
    this.scene.add(this.lanes.group);
    this.scene.add(this.props.group);
    this.scene.add(this.ribbon.mesh);

    this.ego = new VehicleObject('ego');
    this.scene.add(this.ego.group);
  }

  applyRig(): void {
    this.camera.fov = this.rig.fov;
    this.camera.updateProjectionMatrix();
    this.fog.near = this.rig.fogNear;
    this.fog.far = this.rig.fogFar;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** Sync scene objects to the world state. Pure function of `state` (plus pooling). */
  update(state: WorldState): void {
    const { ego } = state;
    const egoX = toSceneX(ego.x);

    this.ego.group.position.set(egoX, 0, ego.z);
    this.ego.group.rotation.y = toSceneHeading(ego.heading);
    this.ego.group.visible = this.showEgo;
    this.ego.setBrake(state.egoBrake);

    const seen = new Set<string>();
    for (const v of state.vehicles) {
      seen.add(v.id);
      let obj = this.vehicles.get(v.id);
      if (!obj) {
        obj = new VehicleObject(v.type);
        obj.setTint(v.tint);
        this.vehicles.set(v.id, obj);
        this.scene.add(obj.group);
      }
      obj.group.position.set(toSceneX(v.x), 0, v.z);
      obj.group.rotation.y = toSceneHeading(v.heading);
      obj.setBrake(v.brake);
    }
    for (const [id, obj] of this.vehicles) {
      if (!seen.has(id)) {
        this.scene.remove(obj.group);
        obj.dispose();
        this.vehicles.delete(id);
      }
    }

    const seenPeds = new Set<string>();
    for (const p of state.pedestrians) {
      seenPeds.add(p.id);
      let obj = this.pedestrians.get(p.id);
      if (!obj) {
        obj = new PedestrianObject();
        this.pedestrians.set(p.id, obj);
        this.scene.add(obj.group);
      }
      obj.group.position.set(toSceneX(p.x), 0, p.z);
      obj.group.rotation.y = toSceneHeading(p.heading);
      obj.setPhase(p.phase);
    }
    for (const [id, obj] of this.pedestrians) {
      if (!seenPeds.has(id)) {
        this.scene.remove(obj.group);
        this.pedestrians.delete(id);
      }
    }

    this.lanes.update(state.lanes);
    this.props.update(state.props);

    const tr = state.trajectory;
    this.ribbon.mesh.visible = tr.visible;
    if (tr.visible) {
      const pts = state.route.points.length >= 2 ? state.route.points : straightAhead(ego, tr.length);
      this.ribbon.update(pts, tr.halfWidth);
    }

    // Camera follows the ego rigidly (position and heading): elevated, far back, long lens.
    const r = this.rig;
    const h = toSceneHeading(ego.heading);
    const dx = Math.sin(h);
    const dz = Math.cos(h);
    const rx = Math.cos(h);
    const rz = -Math.sin(h);
    if (this.dashcam) {
      const px = egoX + dx * this.dashcam.forward;
      const pz = ego.z + dz * this.dashcam.forward;
      this.camera.position.set(px, this.dashcam.height, pz);
      this.camera.lookAt(px + dx * 60, this.dashcam.height, pz + dz * 60);
      return;
    }
    const lx = toSceneX(r.lateral);
    this.camera.position.set(egoX - dx * r.back + rx * lx, r.height, ego.z - dz * r.back + rz * lx);
    this.camera.lookAt(egoX + dx * r.ahead + rx * lx, 0, ego.z + dz * r.ahead + rz * lx);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  stats(): RendererStats {
    const info = this.renderer.info.render;
    return { drawCalls: info.calls, triangles: info.triangles, vehicles: this.vehicles.size + 1 };
  }

  dispose(): void {
    for (const v of this.vehicles.values()) v.dispose();
    this.vehicles.clear();
    this.pedestrians.clear();
    this.ego.dispose();
    this.lanes.dispose();
    this.envTexture.dispose();
    disposeVehicleTemplates();
    this.renderer.dispose();
  }
}

/** Fallback corridor: straight ahead of the ego (world points). */
function straightAhead(ego: { x: number; z: number; heading: number }, length: number): Array<{ x: number; z: number }> {
  const pts: Array<{ x: number; z: number }> = [];
  const dx = Math.sin(ego.heading);
  const dz = Math.cos(ego.heading);
  for (let d = 2.6; d <= 2.6 + length; d += 2) pts.push({ x: ego.x + dx * d, z: ego.z + dz * d });
  return pts;
}
