import { SceneRenderer, DEFAULT_RIG, type CameraRig } from './render/SceneRenderer';
import { Simulation, type SimMode } from './world/simulation';
import { DevPanel } from './ui/devPanel';
import { bindMediaPanel, updateHudScale } from './ui/hud';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLElement;
const errorBox = document.getElementById('error') as HTMLElement;
const errorMsg = document.getElementById('error-msg') as HTMLElement;
const motionNote = document.getElementById('motion-note') as HTMLElement;

const params = new URLSearchParams(location.search);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function rigFromParams(): CameraRig {
  const rig: CameraRig = { ...DEFAULT_RIG };
  for (const key of Object.keys(rig) as Array<keyof CameraRig>) {
    const v = params.get(key);
    if (v !== null && Number.isFinite(Number(v))) rig[key] = Number(v);
  }
  return rig;
}

class App {
  private sim: Simulation;
  private renderer: SceneRenderer | null = null;
  private rig = rigFromParams();
  private devPanel: DevPanel;
  private media: ReturnType<typeof bindMediaPanel>;
  private raf = 0;
  private lastTime = 0;
  private contextLost = false;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;
  private mediaProgress = 0.48;

  constructor() {
    const requestedMode = (params.get('mode') === 'live' ? 'live' : 'reference') as SimMode;
    this.sim = new Simulation({ mode: requestedMode, speedFactor: Number(params.get('speed')) || 1 });
    if (requestedMode === 'live' && reducedMotion) {
      this.sim.paused = true;
      motionNote.hidden = false;
    }
    if (params.get('hud') === '0') hud.hidden = true;
    const probe = params.get('probe');
    if (probe) this.applyProbe(probe);

    this.devPanel = new DevPanel(this.rig, {
      setMode: (mode) => this.setMode(mode),
      togglePause: () => this.togglePause(),
      reset: () => this.reset(),
      setSpeed: (factor) => {
        this.sim.speedFactor = factor;
        this.syncPanel();
      },
      setTrajectory: (visible) => {
        this.sim.state.trajectory.visible = visible;
        this.syncPanel();
      },
      onRigChange: () => this.renderer?.applyRig(),
      loseContext: () => this.simulateContextLoss(),
      snapshot: () => this.snapshot(),
    });
    if (params.get('dev') === '1') this.devPanel.setOpen(true);

    this.media = bindMediaPanel(document.querySelector('.panel.media') as HTMLElement, {
      toggle: () => this.togglePause(),
      nudge: (seconds) => {
        this.mediaProgress = Math.min(0.98, Math.max(0.02, this.mediaProgress + seconds / 3600));
        this.updateMediaProgress();
      },
    });

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.onKey(e));
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.showError('The WebGL context was lost. Waiting for the browser to restore it…', false);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.restart();
    });
    document.getElementById('error-retry')!.addEventListener('click', () => this.restart());
    this.resize();
  }

  /** Test aid: `?simulateError=1` makes the first renderer construction fail so the overlay + Retry path can be exercised. */
  private failOnce = params.get('simulateError') === '1';

  start(): void {
    try {
      if (this.failOnce) {
        this.failOnce = false;
        throw new Error('Simulated renderer failure (dev flag simulateError=1)');
      }
      if (!this.renderer) this.renderer = new SceneRenderer(canvas, this.rig);
      this.renderer.showEgo = !this.hideEgo;
      this.resize();
      this.renderer.update(this.sim.state);
      this.renderer.render();
      errorBox.hidden = true;
      this.syncPanel();
      this.updateMediaProgress();
      this.lastTime = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } catch (err) {
      this.showError(describe(err), true);
    }
  }

  private restart(): void {
    cancelAnimationFrame(this.raf);
    try {
      this.renderer?.dispose();
    } catch {
      /* the old context may already be gone */
    }
    this.renderer = null;
    this.start();
  }

  private frame(now: number): void {
    if (!this.renderer || this.contextLost) return;
    try {
      const dt = Math.min(0.1, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.sim.step(dt);
      if (this.isPlaying()) {
        this.mediaProgress = Math.min(0.98, this.mediaProgress + (dt * this.sim.speedFactor) / 3600);
        this.updateMediaProgress();
      }
      this.renderer.update(this.sim.state);
      this.renderer.render();
      this.frames++;
      if (now - this.fpsTime > 500) {
        this.fps = (this.frames * 1000) / (now - this.fpsTime);
        this.frames = 0;
        this.fpsTime = now;
        if (this.devPanel.isOpen()) {
          const s = this.renderer.stats();
          this.devPanel.setStats(
            `${this.fps.toFixed(0)} fps · ${s.drawCalls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris\n` +
              `${s.vehicles} vehicles · ego z ${this.sim.state.ego.z.toFixed(1)} m · t ${this.sim.state.time.toFixed(1)} s`,
          );
        }
      }
      this.raf = requestAnimationFrame((t) => this.frame(t));
    } catch (err) {
      this.showError(describe(err), true);
    }
  }

  /** Developer aid: show a single vehicle type close to the camera (?probe=sedan|crossover|van|ego). */
  private applyProbe(type: string): void {
    const s = this.sim.state;
    const heading = (Number(params.get('yaw') ?? 145) * Math.PI) / 180;
    const z = Number(params.get('pz') ?? -22);
    const x = Number(params.get('px') ?? 3);
    s.pedestrians = [];
    s.lanes.arrows = [];
    if (type === 'ego') {
      s.vehicles = [];
      s.ego.x = x;
      s.ego.z = z;
      s.ego.heading = heading;
    } else {
      s.vehicles = [{ id: 'probe', type: type as 'sedan', x, z, heading, parked: true, brake: params.get('brake') === '1', tint: 0.5 }];
      this.hideEgo = true;
    }
  }

  private hideEgo = false;

  private isPlaying(): boolean {
    return this.sim.mode === 'live' && !this.sim.paused;
  }

  private setMode(mode: SimMode): void {
    this.sim.setMode(mode);
    if (mode === 'live' && reducedMotion && !this.sim.paused) {
      this.sim.paused = true;
      motionNote.hidden = false;
    }
    this.syncPanel();
  }

  private togglePause(): void {
    if (this.sim.mode !== 'live') {
      this.sim.setMode('live');
      this.sim.paused = false;
    } else {
      this.sim.paused = !this.sim.paused;
    }
    if (!this.sim.paused) motionNote.hidden = true;
    this.syncPanel();
  }

  private reset(): void {
    this.sim.setMode('reference');
    this.sim.reset();
    this.sim.paused = false;
    this.mediaProgress = 0.48;
    this.updateMediaProgress();
    this.syncPanel();
  }

  private syncPanel(): void {
    this.devPanel.sync({
      mode: this.sim.mode,
      paused: this.sim.paused,
      speed: this.sim.speedFactor,
      trajectory: this.sim.state.trajectory.visible,
    });
    this.media.setPlaying(this.isPlaying() || (this.sim.mode === 'reference' && !this.sim.paused));
  }

  private updateMediaProgress(): void {
    const pct = `${(this.mediaProgress * 100).toFixed(2)}%`;
    (document.querySelector('.progress-fill') as HTMLElement).style.width = pct;
    (document.querySelector('.progress-dot') as HTMLElement).style.left = pct;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        this.togglePause();
        break;
      case 'r':
      case 'R':
        this.reset();
        break;
      case 'l':
      case 'L':
        this.setMode(this.sim.mode === 'live' ? 'reference' : 'live');
        break;
      case 't':
      case 'T':
        this.sim.state.trajectory.visible = !this.sim.state.trajectory.visible;
        this.syncPanel();
        break;
      case '[':
        this.sim.speedFactor = Math.max(0.25, this.sim.speedFactor - 0.25);
        this.syncPanel();
        break;
      case ']':
        this.sim.speedFactor = Math.min(3, this.sim.speedFactor + 0.25);
        this.syncPanel();
        break;
      case 'd':
      case 'D':
      case '`':
        this.devPanel.setOpen(!this.devPanel.isOpen());
        break;
    }
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    updateHudScale(w, h);
    this.renderer?.resize(w, h);
    if (this.renderer && !this.contextLost) {
      this.renderer.update(this.sim.state);
      this.renderer.render();
    }
  }

  private simulateContextLoss(): void {
    const gl = this.renderer?.renderer.getContext();
    const ext = gl?.getExtension('WEBGL_lose_context');
    if (!ext) return;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), 1500);
  }

  private snapshot(): void {
    if (!this.renderer) return;
    this.renderer.render();
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'driving-visualization.png';
    a.click();
  }

  debug(): { sim: Simulation; renderer: () => SceneRenderer | null } {
    return { sim: this.sim, renderer: () => this.renderer };
  }

  private showError(message: string, retryable: boolean): void {
    cancelAnimationFrame(this.raf);
    errorMsg.textContent = message;
    (document.getElementById('error-retry') as HTMLButtonElement).hidden = !retryable;
    errorBox.hidden = false;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.message}\n\nIf this persists, make sure hardware acceleration / WebGL is enabled in the browser.`;
  return String(err);
}

const app = new App();
app.start();
// Debug handle for browser-based verification (read-only use intended).
(window as unknown as { __viz: unknown }).__viz = app.debug();
