import type { CameraRig } from '../render/SceneRenderer';
import type { SimMode } from '../world/simulation';

export interface DevPanelHandlers {
  setMode(mode: SimMode): void;
  togglePause(): void;
  reset(): void;
  setSpeed(factor: number): void;
  setTrajectory(visible: boolean): void;
  onRigChange(): void;
  loseContext(): void;
  snapshot(): void;
}

export interface DevPanelState {
  mode: SimMode;
  paused: boolean;
  speed: number;
  trajectory: boolean;
}

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

  constructor(
    private rig: CameraRig,
    handlers: DevPanelHandlers,
  ) {
    this.toggle.addEventListener('click', () => this.setOpen(this.panel.hidden));
    for (const radio of this.panel.querySelectorAll<HTMLInputElement>('input[name="mode"]')) {
      radio.addEventListener('change', () => radio.checked && handlers.setMode(radio.value as SimMode));
    }
    this.pauseBtn.addEventListener('click', () => handlers.togglePause());
    document.getElementById('dev-reset')!.addEventListener('click', () => handlers.reset());
    this.speedInput.addEventListener('input', () => handlers.setSpeed(Number(this.speedInput.value)));
    this.trajectoryInput.addEventListener('change', () => handlers.setTrajectory(this.trajectoryInput.checked));
    document.getElementById('dev-lose-context')!.addEventListener('click', () => handlers.loseContext());
    document.getElementById('dev-snapshot')!.addEventListener('click', () => handlers.snapshot());

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
    this.pauseBtn.disabled = state.mode !== 'live';
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
}
