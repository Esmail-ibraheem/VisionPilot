import { SceneRenderer, DEFAULT_RIG, type CameraRig } from './render/SceneRenderer';
import { Simulation, type SimMode } from './world/simulation';
import { DevPanel, type AppMode, type PerceptionParams, type SourceKind } from './ui/devPanel';
import { updateHudScale } from './ui/hud';
import { PerceptionMode } from './perception/perception';
import { FileSource, SyntheticSource, WebcamSource, type FrameSource } from './perception/sources';
import type { VehicleStyle } from './render/vehicles/buildVehicle';
import { loadMapNetwork } from './world/map/load';
import type { WorldKind } from './world/simulation';
import { MapWorld } from './world/map/mapWorld';
import { LiveWorld } from './world/live';
import type { WorldState } from './world/types';

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
  private raf = 0;
  private lastTime = 0;
  private contextLost = false;
  private frames = 0;
  private fpsTime = 0;
  private fps = 0;
  private perception = new PerceptionMode();
  private perceptionParams: PerceptionParams;
  private appMode: AppMode = 'live';
  private sourceKind: SourceKind = 'synthetic';
  private pendingFile: File | null = null;
  private lastState: WorldState;
  private pip = document.getElementById('pip') as HTMLElement;
  private pipFrame = this.pip.querySelector('.pip-frame') as HTMLElement;
  private pipBoxes = this.pip.querySelector('.pip-boxes') as HTMLCanvasElement;
  private pipStats = document.getElementById('pip-stats') as HTMLElement;
  private perceptionPaused = false;
  /** Car models: the sibling project's (`dv`, default) or this app's lofts (`?cars=loft`). */
  private vehicleStyle: VehicleStyle = params.get('cars') === 'loft' ? 'loft' : 'dv';

  private worldKind: WorldKind;

  constructor() {
    const requestedApp = params.get('mode');
    const requestedMode = (requestedApp === 'reference' ? 'reference' : 'live') as SimMode;
    this.worldKind = params.get('world') === 'generated' || !Simulation.defaultNetwork ? 'generated' : 'map';
    this.perceptionParams = { ...this.perception.camera, nominalSpeedKph: this.perception.nominalSpeedKph };
    this.sim = new Simulation({
      mode: requestedMode,
      speedFactor: Number(params.get('speed')) || 1,
      liveCorridor: params.get('corridor') !== '0',
      world: this.worldKind,
    });
    if (requestedMode === 'live' && reducedMotion) {
      this.sim.paused = true;
      motionNote.hidden = false;
    }
    if (params.get('hud') === '0') hud.hidden = true;
    // ?skip=<s>: deterministically pre-advance the live world (inspection / screenshots).
    const skip = Number(params.get('skip'));
    if (skip > 0 && this.sim.mode === 'live') {
      const step = 1 / 30;
      for (let t = 0; t < skip; t += step) this.sim.step(step);
    }
    const probe = params.get('probe');
    if (probe) {
      this.sim.setMode('reference'); // probes are static
      this.appMode = 'reference';
      this.applyProbe(probe);
    }

    this.lastState = this.sim.state;
    this.devPanel = new DevPanel(this.rig, this.perceptionParams, {
      setMode: (mode) => void this.setMode(mode),
      setSource: (kind) => {
        this.sourceKind = kind;
        if (this.appMode === 'perception') void this.startPerception();
      },
      setVehicleStyle: (style) => {
        this.vehicleStyle = style;
        this.renderer?.setVehicleStyle(style);
        this.syncPanel();
      },
      setWorld: (world) => {
        if (world === 'map' && !Simulation.defaultNetwork) return;
        this.worldKind = world;
        this.sim.setWorld(world);
        this.syncPanel();
      },
      fileChosen: (file) => {
        this.pendingFile = file;
        this.sourceKind = 'file';
        if (this.appMode === 'perception') void this.startPerception();
        else void this.setMode('perception');
      },
      onPerceptionChange: () => this.applyPerceptionParams(),
      togglePause: () => this.togglePause(),
      reset: () => this.reset(),
      setSpeed: (factor) => {
        this.sim.speedFactor = factor;
        this.syncPanel();
      },
      setTrajectory: (visible) => {
        this.sim.setCorridor(visible);
        this.syncPanel();
      },
      onRigChange: () => this.renderer?.applyRig(),
      loseContext: () => this.simulateContextLoss(),
      snapshot: () => this.snapshot(),
      exportOpenDrive: () => void this.exportOpenDrive(),
    });
    if (params.get('dev') === '1') this.devPanel.setOpen(true);
    this.startInPerception = requestedApp === 'perception';

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
      if (!this.renderer) this.renderer = new SceneRenderer(canvas, this.rig, this.vehicleStyle);
      this.renderer.showEgo = !this.hideEgo;
      this.resize();
      this.renderer.update(this.lastState);
      this.renderer.render();
      errorBox.hidden = true;
      this.syncPanel();
      this.lastTime = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame((t) => this.frame(t));
      if (this.startInPerception) {
        this.startInPerception = false;
        void this.setMode('perception');
      }
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
      if (this.appMode === 'perception' && this.perception.active) {
        this.lastState = this.perceptionPaused ? this.lastState : this.perception.step(dt * this.sim.speedFactor);
        this.updatePip();
      } else {
        this.sim.step(dt);
        this.lastState = this.sim.state;
      }
      this.renderer.update(this.lastState);
      this.renderer.render();
      this.updateHud();
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

  private startInPerception = false;

  private async setMode(mode: AppMode): Promise<void> {
    if (mode === 'perception') {
      this.appMode = 'perception';
      this.syncPanel();
      await this.startPerception();
      return;
    }
    if (this.appMode === 'perception') {
      this.perception.stop();
      this.pip.hidden = true;
      this.pipFrame.replaceChildren();
    }
    this.appMode = mode;
    this.sim.setMode(mode);
    if (mode === 'live' && reducedMotion && !this.sim.paused) {
      this.sim.paused = true;
      motionNote.hidden = false;
    }
    this.syncPanel();
  }

  /** Start (or restart) the perception pipeline with the selected source. */
  private async startPerception(): Promise<void> {
    this.pipFrame.replaceChildren();
    this.pip.hidden = false;
    this.pipStats.textContent = 'loading model…';
    let source: FrameSource;
    try {
      if (this.sourceKind === 'webcam') {
        const cam = new WebcamSource();
        await cam.open();
        source = cam;
      } else if (this.sourceKind === 'file') {
        if (!this.pendingFile) {
          this.pipStats.textContent = 'choose a video file in the developer panel';
          this.devPanel.setOpen(true);
          source = new SyntheticSource(this.perceptionParams.hfovDeg, this.vehicleStyle);
          this.sourceKind = 'synthetic';
        } else source = new FileSource(this.pendingFile);
      } else {
        source = new SyntheticSource(this.perceptionParams.hfovDeg, this.vehicleStyle);
      }
      this.applyPerceptionParams();
      this.pipFrame.replaceChildren(source.element);
      await this.perception.start(source);
      const titles = { synthetic: 'FRONT CAMERA (SYNTHETIC)', file: 'FRONT CAMERA (VIDEO)', webcam: 'FRONT CAMERA (WEBCAM)' };
      document.getElementById('pip-title')!.textContent = titles[source.kind];
    } catch (err) {
      this.pipStats.textContent = 'perception failed: ' + (err instanceof Error ? err.message : String(err));
      console.warn(err);
    }
    this.syncPanel();
  }

  private applyPerceptionParams(): void {
    this.perception.camera = {
      hfovDeg: this.perceptionParams.hfovDeg,
      cameraHeight: this.perceptionParams.cameraHeight,
      horizon: this.perceptionParams.horizon,
    };
    this.perception.nominalSpeedKph = this.perceptionParams.nominalSpeedKph;
  }

  private pipDetectionsSeen = -1;

  /** Draw the detector's boxes over the camera frame and refresh the PiP status line. */
  private updatePip(): void {
    const el = this.perception.frameElement;
    if (!el) return;
    const w = this.pipBoxes.clientWidth || 1;
    const h = this.pipBoxes.clientHeight || 1;
    if (this.pipBoxes.width !== w || this.pipBoxes.height !== h) {
      this.pipBoxes.width = w;
      this.pipBoxes.height = h;
    }
    const src = this.perception.source;
    const sw = src?.width || 1;
    const sh = src?.height || 1;
    const ctx = this.pipBoxes.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1.5;
    ctx.font = Math.max(9, h * 0.065) + 'px ' + getComputedStyle(document.body).fontFamily;
    for (const d of this.perception.lastDetections) {
      const [x, y, bw, bh] = d.bbox;
      const isPerson = d.label === 'person' || d.label === 'bicycle' || d.label === 'motorcycle';
      ctx.strokeStyle = isPerson ? '#ffcf3d' : '#4fd3ff';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.strokeRect((x / sw) * w, (y / sh) * h, (bw / sw) * w, (bh / sh) * h);
      ctx.fillText(d.label + ' ' + (d.score * 100).toFixed(0) + '%', (x / sw) * w + 2, Math.max(9, (y / sh) * h - 3));
    }
    const st = this.perception.stats();
    if (st.detections !== this.pipDetectionsSeen || !st.modelReady) {
      this.pipDetectionsSeen = st.detections;
      this.pipStats.textContent = st.modelReady ? st.backend + ' · ' + st.detectorFps.toFixed(0) + ' Hz · ' + st.tracks + ' objects' : 'loading model…';
    }
    if (this.devPanel.isOpen()) {
      this.devPanel.setPerceptionStats(
        st.sourceKind + ' · model ' + (st.modelReady ? 'ready (' + st.backend + ')' : 'loading') + ' · ' + st.detectorFps.toFixed(1) + ' detections/s\n' +
          st.detections + ' boxes → ' + st.tracks + ' tracked objects',
      );
    }
  }

  private togglePause(): void {
    if (this.appMode === 'perception') {
      this.perceptionPaused = !this.perceptionPaused;
      this.syncPanel();
      return;
    }
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
    if (this.appMode === 'perception') {
      void this.startPerception();
      this.perceptionPaused = false;
    } else {
      this.sim.reset();
      this.sim.paused = false;
    }
    this.syncPanel();
  }

  private hudSpeed = document.querySelector('.speed') as HTMLElement;
  private hudLimit = document.querySelector('.limit-sign') as HTMLElement;
  private mapRoads = document.querySelector('.map .roads') as SVGGElement | null;
  private lastShownSpeed = -1;
  private lastShownLimit = -1;
  private streetLabel = document.getElementById('street-label') as HTMLElement;
  private lastStreet = '';

  /** Speed, posted limit and the scrolling mini-map follow the simulation. */
  private updateHud(): void {
    const s = this.lastState;
    const kph = Math.round(s.ego.speedKph);
    if (kph !== this.lastShownSpeed) {
      this.hudSpeed.textContent = String(kph);
      this.lastShownSpeed = kph;
    }
    if (s.speedLimit !== this.lastShownLimit) {
      this.hudLimit.textContent = String(s.speedLimit);
      this.lastShownLimit = s.speedLimit;
    }
    const street = s.streetName ?? '';
    if (street !== this.lastStreet) {
      this.lastStreet = street;
      this.streetLabel.textContent = street;
      this.streetLabel.hidden = street === '';
    }
    if (this.mapRoads && this.sim.mode === 'live') {
      // 1 map unit ≈ 2.4 m; the pattern repeats every 400 units so the scroll can wrap.
      const lw = this.sim.liveWorld;
      const travelled = lw instanceof LiveWorld ? lw.egoS : lw instanceof MapWorld ? lw.time * 8 : 0;
      const offset = (travelled / 2.4) % 400;
      this.mapRoads.setAttribute('transform', `translate(0 ${offset.toFixed(1)})`);
    }
  }

  private syncPanel(): void {
    this.devPanel.sync({
      mode: this.appMode,
      paused: this.appMode === 'perception' ? this.perceptionPaused : this.sim.paused,
      speed: this.sim.speedFactor,
      trajectory: this.sim.corridorVisible,
      source: this.sourceKind,
      cars: this.vehicleStyle,
      world: this.worldKind,
      mapAvailable: Simulation.defaultNetwork !== null,
    });
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
        void this.setMode(this.appMode === 'live' ? 'reference' : 'live');
        break;
      case 'p':
      case 'P':
        void this.setMode(this.appMode === 'perception' ? 'live' : 'perception');
        break;
      case 't':
      case 'T':
        this.sim.setCorridor(!this.sim.corridorVisible);
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
      this.renderer.update(this.lastState);
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

  /** Download the loaded map network as OpenDRIVE (for CARLA / esmini / MetaDrive). */
  private async exportOpenDrive(): Promise<void> {
    const net = Simulation.defaultNetwork;
    if (!net) return;
    const { exportOpenDrive } = await import('./world/map/xodr');
    const xml = exportOpenDrive(net);
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${net.name}.xodr`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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

  debug(): { sim: Simulation; renderer: () => SceneRenderer | null; perception: PerceptionMode; mode: () => AppMode; state: () => WorldState } {
    return { sim: this.sim, renderer: () => this.renderer, perception: this.perception, mode: () => this.appMode, state: () => this.lastState };
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

// Load the real-map network (served by the app itself) before the first frame; fall back to the
// procedural world if it is missing or slow.
const mapName = params.get('map') ?? 'berlin-prenzlauer-berg';
if (params.get('world') !== 'generated') {
  try {
    Simulation.defaultNetwork = await Promise.race([
      loadMapNetwork(mapName),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('map load timed out')), 8000)),
    ]);
  } catch (err) {
    console.warn('map unavailable, using the generated world:', err);
  }
}
const app = new App();
app.start();
// Debug handle for browser-based verification (read-only use intended).
(window as unknown as { __viz: unknown }).__viz = app.debug();
