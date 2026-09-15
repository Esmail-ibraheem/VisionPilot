/**
 * Generate the default virtual-world save (public/worlds/default.world) with the upstream World
 * class: a small town grid with a curved loop, signals, stop/yield signs, crossings, parking spots,
 * a start and a target. Also converts the upstream big.world (a JS file) to plain JSON.
 *
 *   node scripts/make-default-world.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import * as vw from '../src/vw/virtual-world.js';

const { Graph, Point, Segment, World, Start, Light, Stop, Yield, Crossing, Parking, Target, getNearestSegment } = vw;

// ─── graph: 4 × 3 grid (900 px ≈ 85 m blocks) plus a rounded loop road around the south side
const cols = [0, 900, 1800, 2700];
const rows = [0, 800, 1600];
const pts = new Map();
const P = (x, y) => {
  const key = `${x},${y}`;
  if (!pts.has(key)) pts.set(key, new Point(x, y));
  return pts.get(key);
};
const segs = [];
for (const y of rows) for (let i = 0; i < cols.length - 1; i++) segs.push(new Segment(P(cols[i], y), P(cols[i + 1], y)));
for (const x of cols) for (let j = 0; j < rows.length - 1; j++) segs.push(new Segment(P(x, rows[j]), P(x, rows[j + 1])));
// loop: from (0,1600) south, round the corners, east along y=2400, back up to (2700,1600)
const loop = [
  [0, 1600], [0, 2050], [80, 2250], [250, 2380], [500, 2440], [1200, 2440], [1800, 2440], [2400, 2440], [2620, 2380], [2700, 2200], [2700, 1600],
];
for (let i = 0; i < loop.length - 1; i++) segs.push(new Segment(P(...loop[i]), P(...loop[i + 1])));
// a diagonal shortcut
segs.push(new Segment(P(900, 1600), P(1800, 2440)));

const graph = new Graph([...pts.values()], segs);
const world = new World(graph);
const RW = world.roadWidth;

// ─── markings, placed like the editors do: snapped to the nearest lane guide. `travel` is the
// direction of the traffic the marking addresses; upstream markings point AGAINST travel (the stop
// line is the −dir edge and the start pose launches cars toward −dir), so dir = −travel.
function mark(Cls, x, y, travel, width, height) {
  const guide = getNearestSegment(new Point(x, y), world.laneGuides, 60);
  if (!guide) throw new Error(`no lane guide near ${x},${y}`);
  const proj = guide.projectPoint(new Point(x, y));
  let dir = guide.directionVector();
  if (travel && dir.x * travel[0] + dir.y * travel[1] > 0) dir = new Point(-dir.x, -dir.y);
  const m = new Cls(proj.point, dir, width, height);
  world.markings.push(m);
  return m;
}
// right-hand traffic: heading +x uses the +y (south) lane, heading −x the −y lane, heading +y the −x lane, heading −y the +x lane
mark(Start, 350, 825, [1, 0], RW / 2, RW / 2);
// signals at the central crossing (1800, 800), one per approach, ~60 px before the node
mark(Light, 1740, 825, [1, 0], RW / 2, RW / 2);
mark(Light, 1860, 775, [-1, 0], RW / 2, RW / 2);
mark(Light, 1775, 740, [0, 1], RW / 2, RW / 2);
mark(Light, 1825, 860, [0, -1], RW / 2, RW / 2);
// stop signs at (900, 800) on the north/south approaches, yield at (2700, 800)
mark(Stop, 875, 730, [0, 1], RW / 2, RW / 2);
mark(Stop, 925, 870, [0, -1], RW / 2, RW / 2);
mark(Yield, 2640, 825, [1, 0], RW / 2, RW / 2);
mark(Yield, 2675, 740, [0, 1], RW / 2, RW / 2);
// crossings mid-block
mark(Crossing, 450, 25, [1, 0], RW, RW / 2);
mark(Crossing, 1350, 1625, [1, 0], RW, RW / 2);
mark(Crossing, 2725, 1200, [0, 1], RW, RW / 2);
mark(Crossing, 1500, 2415, [1, 0], RW, RW / 2);
// parking spots along the west block and the loop
mark(Parking, 200, 1625, [1, 0], RW / 2, RW / 2);
mark(Parking, 320, 1625, [1, 0], RW / 2, RW / 2);
mark(Parking, 440, 1625, [1, 0], RW / 2, RW / 2);
mark(Parking, 2200, 2465, [1, 0], RW / 2, RW / 2);
mark(Parking, 2320, 2465, [1, 0], RW / 2, RW / 2);
// target
mark(Target, 2250, 1575, [-1, 0], RW / 2, RW / 2);

world.zoom = 2.5;
world.offset = { x: -1350, y: -1200 };

fs.mkdirSync('public/worlds', { recursive: true });
fs.writeFileSync('public/worlds/default.world', JSON.stringify(world));
console.log(`default.world: ${graph.points.length} points, ${graph.segments.length} segments, ${world.buildings.length} buildings, ${world.trees.length} trees, ${world.laneGuides.length} lane guides, ${world.markings.length} markings, ${(fs.statSync('public/worlds/default.world').size / 1024).toFixed(0)} kB`);

// ─── upstream sample town: strip the `const world = World.load(` wrapper
const bigSrc = path.resolve('external/virtual-world/11. MiniMap/world/saves/big.world');
if (fs.existsSync(bigSrc)) {
  let s = fs.readFileSync(bigSrc, 'utf8');
  s = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  const big = JSON.parse(s);
  // the upstream file keeps per-marking DOM image objects; drop them
  for (const m of big.markings) delete m.img;
  fs.writeFileSync('public/worlds/big.world', JSON.stringify(big));
  console.log(`big.world: ${big.graph.segments.length} segments, ${(fs.statSync('public/worlds/big.world').size / 1024 / 1024).toFixed(1)} MB`);
}
