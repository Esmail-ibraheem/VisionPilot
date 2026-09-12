import { SceneRenderer } from '../render/SceneRenderer';
import { Simulation } from '../world/simulation';
import type { WorldState } from '../world/types';

/** A camera feed the detector can consume, plus the element to show in the picture-in-picture. */
export interface FrameSource {
  readonly kind: 'synthetic' | 'file' | 'webcam';
  /** element handed to the detector and displayed in the PiP */
  readonly element: HTMLVideoElement | HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** true once frames are available */
  readonly ready: boolean;
  /** advance the source (synthetic sources render here); dt in seconds */
  tick(dt: number): void;
  /** ego motion known from odometry, if the source provides it */
  egoPose(): { x: number; z: number; heading: number; speedKph: number } | null;
  dispose(): void;
}

const SYN_W = 512;
const SYN_H = 288;

/**
 * Synthetic front camera: a second, hidden renderer draws the live simulation from the ego's
 * windshield. The detector only ever sees these pixels — objects reach the main view solely
 * through the neural network, the same way real camera footage would.
 */
export class SyntheticSource implements FrameSource {
  readonly kind = 'synthetic';
  readonly element: HTMLCanvasElement;
  readonly width = SYN_W;
  readonly height = SYN_H;
  ready = false;
  readonly sim: Simulation;
  private renderer: SceneRenderer;

  constructor(hfovDeg: number) {
    this.element = document.createElement('canvas');
    this.element.width = SYN_W;
    this.element.height = SYN_H;
    this.sim = new Simulation({ mode: 'live', liveCorridor: false });
    this.renderer = new SceneRenderer(this.element, { fov: verticalFov(hfovDeg, SYN_W / SYN_H) });
    this.renderer.dashcam = { height: 1.32, forward: 0.9 };
    this.renderer.showEgo = false;
    this.renderer.resize(SYN_W, SYN_H);
  }

  get truth(): WorldState {
    return this.sim.state;
  }

  tick(dt: number): void {
    this.sim.step(dt);
    this.renderer.update(this.sim.state);
    this.renderer.render();
    this.ready = true;
  }

  egoPose() {
    const e = this.sim.state.ego;
    return { x: e.x, z: e.z, heading: e.heading, speedKph: e.speedKph };
  }

  dispose(): void {
    this.renderer.dispose();
  }
}

function verticalFov(hfovDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((hfovDeg * Math.PI) / 360) / aspect) * 180) / Math.PI;
}

/** A local video file chosen by the user (never uploaded anywhere). */
export class FileSource implements FrameSource {
  readonly kind = 'file';
  readonly element: HTMLVideoElement;
  private url: string;
  constructor(file: File) {
    this.url = URL.createObjectURL(file);
    this.element = document.createElement('video');
    this.element.src = this.url;
    this.element.muted = true;
    this.element.loop = true;
    this.element.playsInline = true;
    void this.element.play();
  }
  get width(): number {
    return this.element.videoWidth;
  }
  get height(): number {
    return this.element.videoHeight;
  }
  get ready(): boolean {
    return this.element.readyState >= 2 && this.element.videoWidth > 0;
  }
  tick(): void {}
  egoPose() {
    return null;
  }
  dispose(): void {
    this.element.pause();
    URL.revokeObjectURL(this.url);
  }
}

export class WebcamSource implements FrameSource {
  readonly kind = 'webcam';
  readonly element: HTMLVideoElement;
  private stream: MediaStream | null = null;
  constructor() {
    this.element = document.createElement('video');
    this.element.muted = true;
    this.element.playsInline = true;
  }
  async open(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, facingMode: 'environment' }, audio: false });
    this.element.srcObject = this.stream;
    await this.element.play();
  }
  get width(): number {
    return this.element.videoWidth;
  }
  get height(): number {
    return this.element.videoHeight;
  }
  get ready(): boolean {
    return this.element.readyState >= 2 && this.element.videoWidth > 0;
  }
  tick(): void {}
  egoPose() {
    return null;
  }
  dispose(): void {
    this.element.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
  }
}
