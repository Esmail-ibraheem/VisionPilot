import type { Vec2 } from '../geometry';
import { hash2 } from '../hash';
import type { ParsedOsm, OsmWay, Building } from './osm';
import { Polyline, wrap } from './polyline';

/**
 * Road network derived from OpenStreetMap: ways are split at shared nodes into segments, degree-2
 * continuations are merged back, segment ends are trimmed at junctions, and lanes / signals /
 * crossings / parking are read from the tags. Everything is metric; u runs along a segment's
 * polyline, v is the lateral offset to the right of the +u direction.
 */

export type RoadClass = 'major' | 'minor' | 'living';
export type ParkingOrientation = 'parallel' | 'diagonal' | 'perpendicular';

export interface SideParking {
  orientation: ParkingOrientation;
  /** width of the parking strip in metres */
  width: number;
}

export interface Crossing {
  id: string;
  u: number;
  kind: 'signals' | 'zebra' | 'unmarked';
}

export interface Segment {
  id: string;
  name: string;
  wayId: number;
  cls: RoadClass;
  line: Polyline;
  /** centreline before trimming (for exports / debugging) */
  raw: Polyline;
  trimStart: number;
  trimEnd: number;
  laneWidth: number;
  /** lateral offsets of lanes travelling +u (right side) and −u (left side) */
  fwd: number[];
  bwd: number[];
  oneway: boolean;
  speedLimit: number; // m/s
  halfRight: number; // extent of the carriageway on the right of the centreline
  halfLeft: number;
  parkingRight: SideParking | null;
  parkingLeft: SideParking | null;
  sidewalkRight: number; // v offset of the right sidewalk
  sidewalkLeft: number; // negative
  crossings: Crossing[];
  startJunction: Junction | null;
  endJunction: Junction | null;
}

export interface Arm {
  seg: Segment;
  /** which end of the segment touches the junction */
  end: 'start' | 'end';
  /** heading of traffic travelling INTO the junction along this arm */
  headingIn: number;
  /** signal phase group (0 or 1) */
  phase: number;
  /** stop control for traffic entering from this arm when the junction is not signalised */
  priority: boolean;
}

export interface Junction {
  id: string;
  nodeId: number;
  center: Vec2;
  arms: Arm[];
  control: 'lights' | 'priority' | 'none';
  radius: number;
  phaseOffset: number;
}

export interface RoadNetworkMap {
  name: string;
  segments: Segment[];
  junctions: Junction[];
  buildings: Building[];
  bounds: { min: Vec2; max: Vec2 };
}

const KPH = 1 / 3.6;
const GREEN = 14;
const YELLOW = 3;
const ALL_RED = 1.5;

function classOf(tags: Record<string, string>): RoadClass {
  const h = tags.highway ?? '';
  if (h === 'living_street') return 'living';
  if (/^(motorway|trunk|primary|secondary|tertiary)/.test(h)) return 'major';
  return 'minor';
}

function parseMaxspeed(tags: Record<string, string>, cls: RoadClass): number {
  const m = Number((tags.maxspeed ?? '').replace(/[^\d.]/g, ''));
  if (Number.isFinite(m) && m > 0) return m * KPH;
  return (cls === 'major' ? 50 : cls === 'living' ? 12 : 30) * KPH;
}

function parseParking(tags: Record<string, string>, side: 'left' | 'right'): SideParking | null {
  const val = tags[`parking:${side}`] ?? tags['parking:both'] ?? tags[`parking:lane:${side}`] ?? tags['parking:lane:both'];
  const orientationTag = tags[`parking:${side}:orientation`] ?? tags['parking:both:orientation'];
  if (!val) return null;
  const none = ['no', 'separate', 'no_parking', 'no_stopping', 'no_standing', 'fire_lane'];
  if (none.includes(val)) return null;
  const legacy: Record<string, ParkingOrientation> = { parallel: 'parallel', diagonal: 'diagonal', perpendicular: 'perpendicular' };
  let orientation: ParkingOrientation = 'parallel';
  if (orientationTag && legacy[orientationTag]) orientation = legacy[orientationTag];
  else if (legacy[val]) orientation = legacy[val];
  const width = orientation === 'parallel' ? 2.0 : orientation === 'diagonal' ? 4.4 : 4.9;
  return { orientation, width };
}

function laneLayout(tags: Record<string, string>, cls: RoadClass): { fwd: number[]; bwd: number[]; oneway: boolean; width: number; reverse: boolean } {
  const onewayTag = tags.oneway;
  const reverse = onewayTag === '-1';
  const oneway = onewayTag === 'yes' || onewayTag === 'true' || onewayTag === '1' || reverse || tags.junction === 'roundabout';
  const width = cls === 'major' ? 3.25 : cls === 'living' ? 2.9 : 3.0;
  const total = Number(tags.lanes);
  let nf: number;
  let nb: number;
  if (oneway) {
    nf = Number.isFinite(total) && total > 0 ? total : 1;
    nb = 0;
  } else {
    const f = Number(tags['lanes:forward']);
    const b = Number(tags['lanes:backward']);
    if (Number.isFinite(f) && Number.isFinite(b) && f > 0 && b > 0) {
      nf = f;
      nb = b;
    } else if (Number.isFinite(total) && total >= 2) {
      nf = Math.ceil(total / 2);
      nb = Math.floor(total / 2);
    } else {
      nf = 1;
      nb = 1;
    }
  }
  const fwd: number[] = [];
  const bwd: number[] = [];
  if (oneway) for (let i = 0; i < nf; i++) fwd.push((i + 0.5 - nf / 2) * width);
  else {
    for (let i = 0; i < nf; i++) fwd.push((i + 0.5) * width);
    for (let i = 0; i < nb; i++) bwd.push(-(i + 0.5) * width);
  }
  return { fwd, bwd, oneway, width, reverse };
}

interface RawSeg {
  way: OsmWay;
  nodeIds: number[];
}

export function buildNetwork(osm: ParsedOsm): RoadNetworkMap {
  // 1) node usage across drivable ways
  const usage = new Map<number, number>();
  for (const w of osm.ways) {
    const seen = new Set<number>();
    for (const n of w.nodes) {
      if (seen.has(n)) continue;
      seen.add(n);
      usage.set(n, (usage.get(n) ?? 0) + 1);
    }
  }
  // 2) split ways at shared nodes
  const raws: RawSeg[] = [];
  for (const w of osm.ways) {
    if (w.nodes.length < 2) continue;
    let current: number[] = [w.nodes[0]];
    for (let i = 1; i < w.nodes.length; i++) {
      current.push(w.nodes[i]);
      const shared = (usage.get(w.nodes[i]) ?? 0) > 1;
      if ((shared || i === w.nodes.length - 1) && current.length >= 2) {
        raws.push({ way: w, nodeIds: current });
        current = [w.nodes[i]];
      }
    }
  }
  // 3) merge continuations at nodes where exactly two segment ends meet
  const endIndex = new Map<number, RawSeg[]>();
  const addEnds = (r: RawSeg) => {
    for (const id of [r.nodeIds[0], r.nodeIds[r.nodeIds.length - 1]]) {
      const list = endIndex.get(id) ?? [];
      list.push(r);
      endIndex.set(id, list);
    }
  };
  for (const r of raws) addEnds(r);
  const alive = new Set(raws);
  let merged = true;
  while (merged) {
    merged = false;
    for (const [nodeId, list] of endIndex) {
      const ends = list.filter((r) => alive.has(r));
      if (ends.length !== 2 || ends[0] === ends[1]) continue;
      if ((usage.get(nodeId) ?? 0) > 2) continue;
      const [a, b] = ends;
      const la = laneLayout(a.way.tags, classOf(a.way.tags));
      const lb = laneLayout(b.way.tags, classOf(b.way.tags));
      if (la.oneway !== lb.oneway || la.fwd.length !== lb.fwd.length || la.bwd.length !== lb.bwd.length) continue;
      // orient both so that a ends at the node and b starts at it
      const aNodes = a.nodeIds[a.nodeIds.length - 1] === nodeId ? a.nodeIds : [...a.nodeIds].reverse();
      const bNodes = b.nodeIds[0] === nodeId ? b.nodeIds : [...b.nodeIds].reverse();
      const aFlipped = aNodes !== a.nodeIds;
      const bFlipped = bNodes !== b.nodeIds;
      // one-way roads must keep their direction; two-way roads can be flipped freely
      const aOk = !la.oneway || aFlipped === la.reverse;
      const bOk = !lb.oneway || bFlipped === lb.reverse;
      if (!aOk || !bOk) continue;
      if (la.oneway && la.reverse !== lb.reverse && aFlipped === bFlipped) continue;
      const longer = polyLength(osm, a.nodeIds) >= polyLength(osm, b.nodeIds) ? a : b;
      const mergedSeg: RawSeg = { way: { ...longer.way, tags: { ...longer.way.tags, oneway: la.oneway ? 'yes' : longer.way.tags.oneway ?? '' } }, nodeIds: [...aNodes, ...bNodes.slice(1)] };
      if (la.oneway && (aFlipped ? !la.reverse : la.reverse)) {
        // merged direction is opposite to travel: reverse the whole thing
        mergedSeg.nodeIds.reverse();
      }
      alive.delete(a);
      alive.delete(b);
      alive.add(mergedSeg);
      addEnds(mergedSeg);
      merged = true;
      break;
    }
  }

  // 4) segments + junction discovery
  const segments: Segment[] = [];
  const junctionNodes = new Map<number, Segment[]>();
  let serial = 0;
  for (const r of alive) {
    const tags = r.way.tags;
    const cls = classOf(tags);
    const layout = laneLayout(tags, cls);
    let ids = r.nodeIds;
    if (layout.reverse) ids = [...ids].reverse();
    const pts = ids.map((id) => osm.nodes.get(id)!.p).filter(Boolean);
    if (pts.length < 2) continue;
    const raw = new Polyline(pts);
    if (raw.length < 4) continue;
    const parkingRight = parseParking(tags, 'right');
    const parkingLeft = parseParking(tags, 'left');
    const halfRight = layout.oneway ? (layout.fwd.length * layout.width) / 2 : layout.fwd.length * layout.width;
    const halfLeft = layout.oneway ? halfRight : layout.bwd.length * layout.width;
    const seg: Segment = {
      id: `s${serial++}`,
      name: tags.name ?? '',
      wayId: r.way.id,
      cls,
      line: raw,
      raw,
      trimStart: 0,
      trimEnd: 0,
      laneWidth: layout.width,
      fwd: layout.fwd,
      bwd: layout.bwd,
      oneway: layout.oneway,
      speedLimit: parseMaxspeed(tags, cls),
      halfRight,
      halfLeft,
      parkingRight,
      parkingLeft,
      sidewalkRight: halfRight + (parkingRight?.width ?? 0) + 1.6,
      sidewalkLeft: -(halfLeft + (parkingLeft?.width ?? 0) + 1.6),
      crossings: [],
      startJunction: null,
      endJunction: null,
    };
    // crossings along the way (before trimming; converted after)
    for (let i = 1; i < ids.length - 1; i++) {
      const n = osm.nodes.get(ids[i])!;
      if (n.tags.highway === 'crossing') {
        const c = n.tags.crossing ?? '';
        const kind: Crossing['kind'] = c === 'traffic_signals' ? 'signals' : c === 'zebra' || c === 'marked' || c === 'uncontrolled' ? 'zebra' : 'unmarked';
        seg.crossings.push({ id: `${seg.id}:c${i}`, u: raw.cum[i], kind });
      }
    }
    segments.push(seg);
    for (const [idx, key] of [[0, 'start'], [ids.length - 1, 'end']] as const) {
      const nodeId = ids[idx];
      const list = junctionNodes.get(nodeId) ?? [];
      list.push(seg);
      junctionNodes.set(nodeId, list);
      void key;
    }
  }

  // 5) junctions (nodes where ≥ 2 segment ends meet)
  const junctions: Junction[] = [];
  const signalNode = (id: number) => osm.nodes.get(id)?.tags.highway === 'traffic_signals';
  let jSerial = 0;
  for (const [nodeId, segs] of junctionNodes) {
    const distinct = Array.from(new Set(segs));
    if (distinct.length < 2) continue;
    const node = osm.nodes.get(nodeId)!;
    const arms: Arm[] = [];
    for (const seg of distinct) {
      const ends: Array<'start' | 'end'> = [];
      if (seg.line.points[0] === node.p || dist(seg.raw.points[0], node.p) < 0.05) ends.push('start');
      if (dist(seg.raw.points[seg.raw.points.length - 1], node.p) < 0.05) ends.push('end');
      for (const end of ends) {
        const headingIn = end === 'end' ? seg.raw.headingAt(seg.raw.length) : wrap(seg.raw.headingAt(0) + Math.PI);
        arms.push({ seg, end, headingIn, phase: 0, priority: seg.cls === 'major' });
      }
    }
    if (arms.length < 2) continue;
    // signals: on the node itself or on any arm within 30 m of it
    let lights = signalNode(nodeId);
    if (!lights) {
      for (const arm of arms) {
        const ids = wayNodeIds(osm, arm.seg);
        const seq = arm.end === 'end' ? [...ids].reverse() : ids;
        let d = 0;
        for (let i = 1; i < seq.length && d < 30; i++) {
          const a = osm.nodes.get(seq[i - 1])!.p;
          const b = osm.nodes.get(seq[i])!.p;
          d += dist(a, b);
          if (signalNode(seq[i])) lights = true;
        }
      }
    }
    // phases: arms whose axis is within 45° of the first arm's axis vs the rest
    const axis0 = arms[0].headingIn;
    let twoAxes = false;
    for (const arm of arms) {
      const d = Math.abs(wrap(arm.headingIn - axis0));
      const along = d < Math.PI / 4 || d > (3 * Math.PI) / 4;
      arm.phase = along ? 0 : 1;
      if (!along) twoAxes = true;
    }
    const anyMajor = arms.some((a) => a.priority);
    const allMajor = arms.every((a) => a.priority);
    if (!anyMajor || allMajor) for (const a of arms) a.priority = true;
    const control: Junction['control'] = !twoAxes ? 'none' : lights ? 'lights' : 'priority';
    let radius = 6;
    for (const a of arms) radius = Math.max(radius, Math.max(a.seg.halfRight, a.seg.halfLeft) + 2.5);
    if (arms.length === 2) radius = Math.min(radius, 4);
    const j: Junction = { id: `j${jSerial++}`, nodeId, center: node.p, arms, control, radius: Math.min(radius, 16), phaseOffset: hash2(nodeId % 100000, 7, 3) * 40 };
    junctions.push(j);
    for (const arm of arms) {
      if (arm.end === 'start') arm.seg.startJunction = j;
      else arm.seg.endJunction = j;
    }
  }

  // 6) trim segments at junctions
  for (const seg of segments) {
    let t0 = seg.startJunction ? seg.startJunction.radius : 0;
    let t1 = seg.endJunction ? seg.endJunction.radius : 0;
    const minLen = 6;
    if (seg.raw.length - t0 - t1 < minLen) {
      const spare = Math.max(0, seg.raw.length - minLen);
      const total = t0 + t1 || 1;
      t0 = (spare * t0) / total;
      t1 = (spare * t1) / total;
    }
    seg.trimStart = t0;
    seg.trimEnd = t1;
    seg.line = seg.raw.slice(t0, seg.raw.length - t1);
    seg.crossings = seg.crossings
      .map((c) => ({ ...c, u: c.u - t0 }))
      .filter((c) => c.u > 1.5 && c.u < seg.line.length - 1.5);
  }

  const bounds = { min: { x: Infinity, z: Infinity }, max: { x: -Infinity, z: -Infinity } };
  for (const seg of segments) {
    for (const p of seg.line.points) {
      bounds.min.x = Math.min(bounds.min.x, p.x);
      bounds.min.z = Math.min(bounds.min.z, p.z);
      bounds.max.x = Math.max(bounds.max.x, p.x);
      bounds.max.z = Math.max(bounds.max.z, p.z);
    }
  }
  return { name: osm.name, segments, junctions, buildings: osm.buildings, bounds };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function polyLength(osm: ParsedOsm, ids: number[]): number {
  let d = 0;
  for (let i = 1; i < ids.length; i++) d += dist(osm.nodes.get(ids[i - 1])!.p, osm.nodes.get(ids[i])!.p);
  return d;
}

/** Node ids of a segment's raw polyline, recovered by matching coordinates (segments were merged). */
function wayNodeIds(osm: ParsedOsm, seg: Segment): number[] {
  if (nodeIdCache.has(seg)) return nodeIdCache.get(seg)!;
  const index = coordIndex(osm);
  const ids = seg.raw.points.map((p) => index.get(`${p.x.toFixed(3)},${p.z.toFixed(3)}`) ?? -1);
  nodeIdCache.set(seg, ids);
  return ids;
}
const nodeIdCache = new WeakMap<Segment, number[]>();
let coordIndexCache: { osm: ParsedOsm; map: Map<string, number> } | null = null;
function coordIndex(osm: ParsedOsm): Map<string, number> {
  if (coordIndexCache && coordIndexCache.osm === osm) return coordIndexCache.map;
  const map = new Map<string, number>();
  for (const n of osm.nodes.values()) map.set(`${n.p.x.toFixed(3)},${n.p.z.toFixed(3)}`, n.id);
  coordIndexCache = { osm, map };
  return map;
}

// ─── signals ──────────────────────────────────────────────────────────────────

export type LightColor = 'red' | 'yellow' | 'green';

export function armLight(j: Junction, arm: Arm, t: number): LightColor {
  if (j.control !== 'lights') return 'green';
  const phaseLen = GREEN + YELLOW + ALL_RED;
  const cycle = phaseLen * 2;
  const local = (((t + j.phaseOffset) % cycle) + cycle) % cycle;
  const idx = Math.floor(local / phaseLen);
  if (idx !== arm.phase) return 'red';
  const within = local - idx * phaseLen;
  if (within < GREEN) return 'green';
  if (within < GREEN + YELLOW) return 'yellow';
  return 'red';
}

/** Pedestrians may cross an arm while that arm's traffic has red (with a margin). */
export function armWalk(j: Junction, arm: Arm, t: number): boolean {
  if (j.control !== 'lights') return false;
  const phaseLen = GREEN + YELLOW + ALL_RED;
  const cycle = phaseLen * 2;
  const local = (((t + j.phaseOffset) % cycle) + cycle) % cycle;
  const idx = Math.floor(local / phaseLen);
  const within = local - idx * phaseLen;
  return idx !== arm.phase && within > 1 && within < GREEN - 2;
}

// ─── movements ────────────────────────────────────────────────────────────────

export type Turn = 'straight' | 'left' | 'right' | 'uturn';

/** Classify the movement from an incoming arm to an outgoing arm at a junction. */
export function turnBetween(from: Arm, to: Arm): Turn {
  const headingOut = to.end === 'start' ? to.seg.line.headingAt(0) : wrap(to.seg.line.headingAt(to.seg.line.length) + Math.PI);
  const d = wrap(headingOut - from.headingIn);
  if (Math.abs(d) < Math.PI / 5) return 'straight';
  if (Math.abs(d) > (4 * Math.PI) / 5) return 'uturn';
  return d > 0 ? 'right' : 'left';
}

/** Lanes an outgoing arm offers to traffic leaving the junction, with their travel direction. */
export function outgoingLanes(arm: Arm): { side: 'fwd' | 'bwd'; lanes: number[] } {
  return arm.end === 'start' ? { side: 'fwd', lanes: arm.seg.fwd } : { side: 'bwd', lanes: arm.seg.bwd };
}

export function incomingLanes(arm: Arm): { side: 'fwd' | 'bwd'; lanes: number[] } {
  return arm.end === 'end' ? { side: 'fwd', lanes: arm.seg.fwd } : { side: 'bwd', lanes: arm.seg.bwd };
}

/** Pose of a lane at the junction end of an arm (position + travel heading). */
export function armLanePose(arm: Arm, side: 'fwd' | 'bwd', laneIndex: number, atJunction: 'in' | 'out'): { p: Vec2; heading: number } {
  const seg = arm.seg;
  const v = (side === 'fwd' ? seg.fwd : seg.bwd)[laneIndex];
  if (arm.end === 'end') {
    const p = seg.line.offsetPoint(seg.line.length, v);
    const h = seg.line.headingAt(seg.line.length);
    return { p, heading: atJunction === 'in' ? h : wrap(h + Math.PI) };
  }
  const p = seg.line.offsetPoint(0, v);
  const h = seg.line.headingAt(0);
  return { p, heading: atJunction === 'in' ? wrap(h + Math.PI) : h };
}

const connectorCache = new Map<string, Polyline>();

/** Curve through the junction from an incoming lane end to an outgoing lane start. */
export function connector(from: Arm, fromLane: number, to: Arm, toLane: number): Polyline {
  const key = `${from.seg.id}:${from.end}:${fromLane}>${to.seg.id}:${to.end}:${toLane}`;
  let c = connectorCache.get(key);
  if (c) return c;
  const a = armLanePose(from, incomingLanes(from).side, fromLane, 'in');
  const b = armLanePose(to, outgoingLanes(to).side, toLane, 'out');
  c = Polyline.hermite(a.p, a.heading, b.p, b.heading, from === to ? 0.9 : 0.55);
  connectorCache.set(key, c);
  return c;
}

/** Pick the target lane on the outgoing arm for a movement. */
export function targetLane(turn: Turn, fromLane: number, fromLanes: number, toLanes: number): number {
  if (toLanes <= 1) return 0;
  if (turn === 'right') return toLanes - 1; // outermost right lane (index grows outward on the right)
  if (turn === 'left' || turn === 'uturn') return 0;
  // straight: keep relative position
  return Math.min(toLanes - 1, Math.round((fromLane * (toLanes - 1)) / Math.max(1, fromLanes - 1)));
}

/** Arms a driver may continue onto from `from` (excluding U-turns unless nothing else exists). */
export function exitsFrom(j: Junction, from: Arm): Arm[] {
  const out = j.arms.filter((a) => a !== from && outgoingLanes(a).lanes.length > 0 && turnBetween(from, a) !== 'uturn');
  return out;
}
