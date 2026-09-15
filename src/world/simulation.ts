import type { WorldState } from './types';
import { createReferenceState } from './reference';
import { LiveWorld } from './live';

export type SimMode = 'reference' | 'live';

export interface SimulationOptions {
  mode?: SimMode;
  speedFactor?: number;
  /** Show the planned-path corridor in live mode (the frozen reference scene never shows it). */
  liveCorridor?: boolean;
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
  private live: LiveWorld | null = null;
  private corridorOverride: boolean | null = null;

  constructor(opts: SimulationOptions = {}) {
    this.mode = opts.mode ?? 'live';
    this.speedFactor = opts.speedFactor ?? 1;
    this.liveCorridor = opts.liveCorridor ?? true;
    this.state = createReferenceState();
    if (this.mode === 'live') this.enterLive();
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
  get liveWorld(): LiveWorld | null {
    return this.live;
  }

  private enterLive(): void {
    this.live = new LiveWorld(createReferenceState());
    this.state = this.live.toState(this.state);
    this.state.trajectory.visible = this.corridorOverride ?? this.liveCorridor;
  }

  /** Advance by `dtSeconds` of wall time (scaled by speedFactor internally). */
  step(dtSeconds: number): WorldState {
    if (this.mode !== 'live' || this.paused || dtSeconds <= 0 || !this.live) return this.state;
    // Sub-step so traffic behaviour is independent of frame rate.
    const total = Math.min(dtSeconds, 0.1) * this.speedFactor;
    const n = Math.max(1, Math.ceil(total / (1 / 45)));
    const dt = total / n;
    for (let i = 0; i < n; i++) this.live.step(dt);
    const visible = this.state.trajectory.visible;
    this.state = this.live.toState(this.state);
    this.state.trajectory.visible = visible;
    return this.state;
  }
}
