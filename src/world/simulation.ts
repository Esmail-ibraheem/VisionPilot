import type { WorldState } from './types';
import { createReferenceState } from './reference';
import { LiveWorld } from './live';
import { VirtualWorldSim } from './vw/vwWorld';
import type { VwWorld } from '../vw/virtual-world';

export type SimMode = 'reference' | 'live';
/** Which world live mode drives: the procedural generator or the virtual-world (editor) world. */
export type WorldKind = 'generated' | 'virtual';

export interface SimulationOptions {
  mode?: SimMode;
  speedFactor?: number;
  /** Show the planned-path corridor in live mode (the frozen reference scene never shows it). */
  liveCorridor?: boolean;
  world?: WorldKind;
  /** Virtual world for `world: 'virtual'`; falls back to Simulation.defaultVirtualWorld. */
  virtualWorld?: VwWorld;
}

/**
 * Produces WorldState over time. `reference` mode is the frozen arrangement from the photo;
 * `live` mode hands the same arrangement to LiveWorld and drives on from there. All randomness is
 * hash-based, so identical step sequences give identical worlds.
 */
export class Simulation {
  state: WorldState;
  mode: SimMode;
  speedFactor: number;
  paused = false;
  liveCorridor: boolean;
  world: WorldKind;
  virtualWorld: VwWorld | null;
  /** Virtual world used by new simulations that ask for it without passing one. */
  static defaultVirtualWorld: VwWorld | null = null;
  private live: LiveWorld | VirtualWorldSim | null = null;
  private corridorOverride: boolean | null = null;

  constructor(opts: SimulationOptions = {}) {
    this.mode = opts.mode ?? 'live';
    this.speedFactor = opts.speedFactor ?? 1;
    this.liveCorridor = opts.liveCorridor ?? true;
    this.virtualWorld = opts.virtualWorld ?? Simulation.defaultVirtualWorld;
    this.world = opts.world ?? (this.virtualWorld ? 'virtual' : 'generated');
    this.state = createReferenceState();
    if (this.mode === 'live') this.enterLive();
  }

  /** Switch the live world (generated ↔ virtual) and restart it. */
  setWorld(world: WorldKind, virtualWorld?: VwWorld): void {
    if (virtualWorld) this.virtualWorld = virtualWorld;
    if (world === 'virtual' && !this.virtualWorld) return;
    this.world = world;
    if (this.mode === 'live') this.reset();
  }

  /** Replace the virtual world (editor load) keeping the same simulation object where possible. */
  replaceVirtualWorld(world: VwWorld): void {
    this.virtualWorld = world;
    if (this.live instanceof VirtualWorldSim) {
      this.live.setWorld(world);
      this.state = this.live.toState(this.state);
    }
  }

  /** The virtual-world simulation when active. */
  get vw(): VirtualWorldSim | null {
    return this.live instanceof VirtualWorldSim ? this.live : null;
  }

  reset(): void {
    this.state = createReferenceState();
    this.live = null;
    this.corridorOverride = null;
    if (this.mode === 'live') this.enterLive();
  }

  setMode(mode: SimMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.reset();
  }

  /** Corridor visibility as currently shown. */
  get corridorVisible(): boolean {
    return this.state.trajectory.visible;
  }

  setCorridor(visible: boolean): void {
    this.corridorOverride = visible;
    this.state.trajectory.visible = visible;
  }

  /** The live world (for diagnostics / tests); null in reference mode. */
  get liveWorld(): LiveWorld | VirtualWorldSim | null {
    return this.live;
  }

  private enterLive(): void {
    this.live = this.world === 'virtual' && this.virtualWorld ? new VirtualWorldSim(this.virtualWorld) : new LiveWorld(createReferenceState());
    this.state = this.live.toState(this.state);
    this.state.trajectory.visible = this.live instanceof VirtualWorldSim ? false : (this.corridorOverride ?? this.liveCorridor);
  }

  /** Advance by `dtSeconds` of wall time (scaled by speedFactor internally). */
  step(dtSeconds: number): WorldState {
    if (this.mode !== 'live' || this.paused || dtSeconds <= 0 || !this.live) return this.state;
    const total = Math.min(dtSeconds, 0.1) * this.speedFactor;
    if (this.live instanceof VirtualWorldSim) {
      this.live.step(total); // frame-based internally
      this.state = this.live.toState(this.state);
      return this.state;
    }
    // Sub-step so traffic behaviour is independent of frame rate.
    const n = Math.max(1, Math.ceil(total / (1 / 45)));
    const dt = total / n;
    for (let i = 0; i < n; i++) this.live.step(dt);
    const visible = this.state.trajectory.visible;
    this.state = this.live.toState(this.state);
    this.state.trajectory.visible = visible;
    return this.state;
  }
}
