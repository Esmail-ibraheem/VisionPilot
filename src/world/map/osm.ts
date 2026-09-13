import type { Vec2 } from '../geometry';

/** Compact extract written by scripts/fetch-osm.mjs. */
export interface OsmExtract {
  name: string;
  source: string;
  bbox: [number, number, number, number]; // S, W, N, E
  center: [number, number]; // lat, lon
  nodes: Array<{ id: number; lat: number; lon: number; tags?: Record<string, string> }>;
  ways: Array<{ id: number; nodes: number[]; tags?: Record<string, string> }>;
  buildings: Array<{ id: number; pts: Array<[number, number]>; levels?: number; height?: number; kind?: string }>;
}

export interface OsmNode {
  id: number;
  p: Vec2;
  tags: Record<string, string>;
}

export interface OsmWay {
  id: number;
  nodes: number[];
  tags: Record<string, string>;
}

export interface Building {
  id: string;
  polygon: Vec2[];
  height: number;
}

export interface ParsedOsm {
  name: string;
  nodes: Map<number, OsmNode>;
  ways: OsmWay[];
  buildings: Building[];
  /** metres per degree at the extract centre */
  scale: { x: number; z: number };
  center: { lat: number; lon: number };
}

const EARTH = 6371008.8;

/** Equirectangular projection around the extract centre: x east, z north, metres. */
export function makeProjection(center: { lat: number; lon: number }) {
  const kz = (Math.PI / 180) * EARTH;
  const kx = kz * Math.cos((center.lat * Math.PI) / 180);
  return {
    scale: { x: kx, z: kz },
    project: (lat: number, lon: number): Vec2 => ({ x: (lon - center.lon) * kx, z: (lat - center.lat) * kz }),
    unproject: (p: Vec2): { lat: number; lon: number } => ({ lat: center.lat + p.z / kz, lon: center.lon + p.x / kx }),
  };
}

export function parseOsm(extract: OsmExtract): ParsedOsm {
  const center = { lat: extract.center[0], lon: extract.center[1] };
  const proj = makeProjection(center);
  const nodes = new Map<number, OsmNode>();
  for (const n of extract.nodes) nodes.set(n.id, { id: n.id, p: proj.project(n.lat, n.lon), tags: n.tags ?? {} });
  const ways: OsmWay[] = extract.ways.map((w) => ({ id: w.id, nodes: w.nodes, tags: w.tags ?? {} }));
  const buildings: Building[] = [];
  for (const b of extract.buildings) {
    if (b.pts.length < 4) continue;
    const polygon = b.pts.map(([lat, lon]) => proj.project(lat, lon));
    // closed ring in the source; drop the repeated last vertex
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (Math.hypot(first.x - last.x, first.z - last.z) < 0.01) polygon.pop();
    if (polygon.length < 3) continue;
    const height = b.height ?? (b.levels ? b.levels * 3.3 + 1.2 : b.kind === 'garage' || b.kind === 'shed' || b.kind === 'roof' ? 3.5 : 17);
    buildings.push({ id: `b${b.id}`, polygon, height });
  }
  return { name: extract.name, nodes, ways, buildings, scale: proj.scale, center };
}
