/* Loose typings for the vendored virtual-world bundle (see scripts/build-vw.mjs). */
export interface VwPoint {
  x: number;
  y: number;
  equals(p: VwPoint): boolean;
  draw(ctx: CanvasRenderingContext2D, opts?: Record<string, unknown>): void;
}
export interface VwSegment {
  p1: VwPoint;
  p2: VwPoint;
  oneWay?: boolean;
  length(): number;
  directionVector(): VwPoint;
  distanceToPoint(p: VwPoint): number;
  projectPoint(p: VwPoint): { point: VwPoint; offset: number };
  includes(p: VwPoint): boolean;
  draw(ctx: CanvasRenderingContext2D, opts?: Record<string, unknown>): void;
}
export interface VwPolygon {
  points: VwPoint[];
  segments: VwSegment[];
  containsPoint(p: VwPoint): boolean;
  distanceToPoint(p: VwPoint): number;
}
export interface VwMarking {
  type: 'marking' | 'stop' | 'start' | 'crossing' | 'parking' | 'light' | 'target' | 'yield';
  center: VwPoint;
  directionVector: VwPoint;
  width: number;
  height: number;
  support: VwSegment;
  poly: VwPolygon;
  /** lights only */
  state?: 'off' | 'green' | 'yellow' | 'red';
  border?: VwSegment;
  borders?: VwSegment[];
  draw(ctx: CanvasRenderingContext2D): void;
}
export interface VwGraph {
  points: VwPoint[];
  segments: VwSegment[];
  hash(): string;
  dispose(): void;
}
export interface VwWorld {
  graph: VwGraph;
  roadWidth: number;
  roadRoundness: number;
  buildingWidth: number;
  buildingMinLength: number;
  spacing: number;
  treeSize: number;
  envelopes: Array<{ poly: VwPolygon; skeleton: VwSegment }>;
  roadBorders: VwSegment[];
  buildings: Array<{ base: VwPolygon; height: number }>;
  trees: Array<{ center: VwPoint; size: number; height: number; base: VwPolygon }>;
  laneGuides: VwSegment[];
  markings: VwMarking[];
  cars: VwCar[];
  bestCar: VwCar | null;
  frameCount: number;
  zoom?: number;
  offset?: { x: number; y: number };
  generate(): void;
  draw(ctx: CanvasRenderingContext2D, viewPoint: VwPoint, showStartMarkings?: boolean, renderRadius?: number): void;
}
export interface VwControls {
  forward: boolean | number;
  left: boolean | number;
  right: boolean | number;
  reverse: boolean | number;
}
export interface VwSensor {
  rayCount: number;
  rayLength: number;
  rays: Array<[{ x: number; y: number }, { x: number; y: number }]>;
  readings: Array<{ x: number; y: number; offset: number } | null>;
}
export interface VwNetwork {
  levels: Array<{ inputs: number[]; outputs: number[]; biases: number[]; weights: number[][] }>;
}
export interface VwCar {
  x: number;
  y: number;
  width: number;
  height: number;
  speed: number;
  maxSpeed: number;
  angle: number;
  damaged: boolean;
  fittness: number;
  useBrain: boolean;
  sensor?: VwSensor;
  brain?: VwNetwork;
  controls: VwControls;
  polygon?: Array<{ x: number; y: number }>;
  update(roadBorders: Array<[VwPoint, VwPoint] | { x: number; y: number }[]>, traffic: VwCar[]): void;
}
export interface VwEditor {
  enable(): void;
  disable(): void;
  display(): void;
  dispose?(): void;
}
export interface VwViewport {
  canvas: HTMLCanvasElement;
  zoom: number;
  offset: VwPoint;
  reset(): void;
  getOffset(): VwPoint;
  getMouse(evt: MouseEvent, subtractDragOffset?: boolean): VwPoint;
}

export const Point: new (x: number, y: number) => VwPoint;
export const Segment: new (p1: VwPoint, p2: VwPoint, oneWay?: boolean) => VwSegment;
export const Polygon: { new (points: VwPoint[]): VwPolygon; union(polys: VwPolygon[]): VwSegment[] };
export const Envelope: new (skeleton: VwSegment, width: number, roundness?: number) => { poly: VwPolygon };
export const Graph: { new (points?: VwPoint[], segments?: VwSegment[]): VwGraph; load(info: unknown): VwGraph };
export const Osm: { parseRoads(data: unknown): { points: VwPoint[]; segments: VwSegment[] } };
export const World: { new (graph: VwGraph, ...rest: number[]): VwWorld; load(info: unknown): VwWorld };
export const Marking: { load(info: unknown): VwMarking };
export const Stop: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Start: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Crossing: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Parking: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Light: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Target: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Yield: new (c: VwPoint, d: VwPoint, w: number, h: number) => VwMarking;
export const Viewport: new (canvas: HTMLCanvasElement, zoom?: number, offset?: { x: number; y: number } | null) => VwViewport;
export const GraphEditor: new (viewport: VwViewport, graph: VwGraph) => VwEditor & { dispose(): void };
export const StopEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const CrossingEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const StartEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const ParkingEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const LightEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const TargetEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const YieldEditor: new (viewport: VwViewport, world: VwWorld) => VwEditor;
export const Controls: new (type: 'KEYS' | 'DUMMY' | 'AI') => VwControls;
export const Car: new (x: number, y: number, width: number, height: number, controlType: 'KEYS' | 'DUMMY' | 'AI', angle?: number, maxSpeed?: number, color?: string) => VwCar;
export const NeuralNetwork: { new (neuronCounts: number[]): VwNetwork; feedForward(inputs: number[], network: VwNetwork): number[]; mutate(network: VwNetwork, amount?: number): void };
export const Visualizer: { drawNetwork(ctx: CanvasRenderingContext2D, network: VwNetwork): void };
export const MiniMap: new (canvas: HTMLCanvasElement, graph: VwGraph, size: number) => { update(viewPoint: VwPoint): void; graph: VwGraph };
export function setEditorWorld(world: VwWorld): void;
export function getNearestSegment(loc: VwPoint, segments: VwSegment[], threshold?: number): VwSegment | null;
export function getNearestPoint(loc: VwPoint, points: VwPoint[], threshold?: number): VwPoint | null;
export function distance(a: VwPoint, b: VwPoint): number;
export function scale(p: VwPoint, s: number): VwPoint;
export function add(a: VwPoint, b: VwPoint): VwPoint;
export function subtract(a: VwPoint, b: VwPoint): VwPoint;
export function angle(p: VwPoint): number;
export function perpendicular(p: VwPoint): VwPoint;
export function lerp(a: number, b: number, t: number): number;
export function polysIntersect(a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>): boolean;
