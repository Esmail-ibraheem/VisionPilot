import type { CameraRig } from '../render/SceneRenderer';
import type { CameraModel } from '../perception/projection';
import type { VehicleStyle } from '../render/vehicles/buildVehicle';
import type { WorldKind } from '../world/simulation';

export type AppMode = 'live' | 'reference' | 'perception';
export type SourceKind = 'synthetic' | 'file' | 'webcam';

export interface PerceptionParams extends CameraModel {
  nominalSpeedKph: number;
}

export interface DevPanelHandlers {
  setMode(mode: AppMode): void;
  setSource(kind: SourceKind): void;
  setVehicleStyle(style: VehicleStyle): void;
  setWorld(world: WorldKind): void;
  fileChosen(file: File): void;
  onPerceptionChange(): void;
  togglePause(): void;
  reset(): void;
  setSpeed(factor: number): void;
  setTrajectory(visible: boolean): void;
  onRigChange(): void;
  loseContext(): void;
  snapshot(): void;
  exportOpenDrive(): void;
}

export interface DevPanelState {
  mode: AppMode;
  paused: boolean;
  speed: number;
  trajectory: boolean;
  source: SourceKind;
  cars: VehicleStyle;
  world: WorldKind;
  mapAvailable: boolean;
}

const PERCEPTION_FIELDS: Array<{ key: keyof PerceptionParams; label: string; min: number; max: number; step: number }> = [
  { key: 'hfovDeg', label: 'camera hfov °', min: 40, max: 120, step: 1 },
  { key: 'cameraHeight', label: 'camera height m', min: 0.6, max: 2.6, step: 0.05 },
  { key: 'horizon', label: 'horizon (0–1)', min: 0.3, max: 0.7, step: 0.005 },
  { key: 'nominalSpeedKph', label: 'assumed speed km/h', min: 0, max: 90, step: 1 },
];

const RIG_FIELDS: Array<{ key: keyof CameraRig; min: number; max: number; step: number }> = [
  { key: 'fov', min: 10, max: 60, step: 0.5 },
  { key: 'back', min: 10, max: 120, step: 1 },
  { key: 'height', min: 2, max: 60, step: 0.5 },
  { key: 'ahead', min: -20, max: 60, step: 0.5 },
  { key: 'lateral', min: -10, max: 10, step: 0.1 },
  { key: 'fogNear', min: 10, max: 300, step: 5 },
  { key: 'fogFar', min: 50, max: 600, step: 5 },
];

export class DevPanel {
  private panel = document.getElementById('dev-panel') as HTMLElement;
  private toggle = document.getElementById('dev-toggle') as HTMLButtonElement;
  private pauseBtn = document.getElementById('dev-pause') as HTMLButtonElement;
  private speedInput = document.getElementById('dev-speed') as HTMLInputElement;
  private speedVal = document.getElementById('dev-speed-val') as HTMLElement;
  private trajectoryInput = document.getElementById('dev-trajectory') as HTMLInputElement;
  private stats = document.getElementById('dev-stats') as HTMLElement;
  private rigInputs = new Map<keyof CameraRig, { range: HTMLInputElement; val: HTMLElement }>();
  private perceptionStats = document.getElementById('dev-perception-stats') as HTMLElement;

  constructor(
    private rig: CameraRig,
    perception: PerceptionParams,
    handlers: DevPanelHandlers,
  ) {
    this.toggle.addEventListener('click', () => this.setOpen(this.panel.hidden));
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
      radio.addEventListener('change', () => radio.checked && handlers.setMode(radio.value as AppMode));
    }
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="source"]')) {
      radio.addEventListener('change', () => radio.checked && handlers.setSource(radio.value as SourceKind));
    }
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="cars"]')) {
      radio.addEventListener('change', () => radio.checked && handlers.setVehicleStyle(radio.value as VehicleStyle));
    }
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="world"]')) {
      radio.addEventListener('change', () => radio.checked && handlers.setWorld(radio.value as WorldKind));
    }
    const fileInput = document.getElementById('dev-video-file') as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) handlers.fileChosen(f);
    });
    const pgrid = document.getElementById('dev-perception')!;
    for (const f of PERCEPTION_FIELDS) {
      const label = document.createElement('label');
      label.textContent = f.label;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(f.min);
      range.max = String(f.max);
      range.step = String(f.step);
      range.value = String(perception[f.key]);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = String(perception[f.key]);
      range.addEventListener('input', () => {
        perception[f.key] = Number(range.value);
        val.textContent = range.value;
        handlers.onPerceptionChange();
      });
      pgrid.append(label, range, val);
    }
    this.pauseBtn.addEventListener('click', () => handlers.togglePause());
    document.getElementById('dev-reset')!.addEventListener('click', () => handlers.reset());
    this.speedInput.addEventListener('input', () => handlers.setSpeed(Number(this.speedInput.value)));
    this.trajectoryInput.addEventListener('change', () => handlers.setTrajectory(this.trajectoryInput.checked));
    document.getElementById('dev-lose-context')!.addEventListener('click', () => handlers.loseContext());
    document.getElementById('dev-snapshot')!.addEventListener('click', () => handlers.snapshot());
    document.getElementById('dev-export-xodr')!.addEventListener('click', () => handlers.exportOpenDrive());

    const grid = document.getElementById('dev-camera')!;
    for (const f of RIG_FIELDS) {
      const label = document.createElement('label');
      label.textContent = f.key;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(f.min);
      range.max = String(f.max);
      range.step = String(f.step);
      range.value = String(rig[f.key]);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = String(rig[f.key]);
      range.addEventListener('input', () => {
        rig[f.key] = Number(range.value);
        val.textContent = range.value;
        handlers.onRigChange();
      });
      grid.append(label, range, val);
      this.rigInputs.set(f.key, { range, val });
    }
  }

  setOpen(open: boolean): void {
    this.panel.hidden = !open;
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  sync(state: DevPanelState): void {
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
      radio.checked = radio.value === state.mode;
    }
    this.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
    this.pauseBtn.disabled = state.mode === 'reference';
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="source"]')) {
      radio.checked = radio.value === state.source;
    }
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="cars"]')) {
      radio.checked = radio.value === state.cars;
    }
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="world"]')) {
      radio.checked = radio.value === state.world;
      if (radio.value === 'map') radio.disabled = !state.mapAvailable;
    }
    this.speedInput.value = String(state.speed);
    this.speedVal.textContent = `${state.speed.toFixed(2).replace(/\.?0+$/, '')}×`;
    this.trajectoryInput.checked = state.trajectory;
    for (const [key, { range, val }] of this.rigInputs) {
      range.value = String(this.rig[key]);
      val.textContent = String(this.rig[key]);
    }
  }

  setStats(text: string): void {
    if (!this.panel.hidden) this.stats.textContent = text;
  }

  setPerceptionStats(text: string): void {
    this.perceptionStats.textContent = text;
  }
}
