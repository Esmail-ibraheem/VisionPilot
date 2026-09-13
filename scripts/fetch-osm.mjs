/**
 * Fetch an OpenStreetMap extract (drivable roads + buildings) for a bounding box via the Overpass API
 * and store it as a compact JSON the app loads from its own origin.
 *
 *   node scripts/fetch-osm.mjs --name berlin-prenzlauer-berg --bbox 52.5310,13.4120,52.5440,13.4300
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 — see public/maps/LICENSE.txt.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, []),
);
const name = args.name ?? 'berlin-prenzlauer-berg';
const bbox = (args.bbox ?? '52.5310,13.4120,52.5440,13.4300').split(',').map(Number); // S,W,N,E
const endpoint = args.endpoint ?? 'https://overpass-api.de/api/interpreter';

const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const bb = bbox.join(',');
const query = `[out:json][timeout:120];
(
  way["highway"~"^(${HIGHWAYS})$"](${bb});
);
(._;>;);
out body;
way["building"](${bb});
out geom;`;

console.log(`fetching ${name} bbox=${bb} from ${endpoint} …`);
const endpoints = [endpoint, 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
let data = null;
for (const ep of endpoints) {
  try {
    const res = await fetch(ep, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'tesla-viz map fetch (https://github.com/; local research tool)', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    console.log(`  ok from ${ep}`);
    break;
  } catch (err) {
    console.warn(`  ${ep} failed: ${err instanceof Error ? err.message : err}`);
  }
}
if (!data) throw new Error('all Overpass endpoints failed');

const KEEP_NODE_TAGS = ['highway', 'crossing', 'crossing:markings', 'traffic_signals', 'direction', 'stop'];
const KEEP_WAY_TAGS = [
  'highway', 'name', 'lanes', 'lanes:forward', 'lanes:backward', 'oneway', 'maxspeed', 'junction',
  'parking:lane:left', 'parking:lane:right', 'parking:lane:both', 'parking:left', 'parking:right', 'parking:both',
  'parking:left:orientation', 'parking:right:orientation', 'parking:both:orientation', 'turn:lanes', 'turn:lanes:forward',
  'turn:lanes:backward', 'width', 'sidewalk', 'lit', 'surface', 'railway', 'busway', 'cycleway',
];
const pick = (tags, keys) => {
  if (!tags) return undefined;
  const out = {};
  for (const k of keys) if (tags[k] !== undefined) out[k] = tags[k];
  return Object.keys(out).length ? out : undefined;
};

const nodes = [];
const ways = [];
const buildings = [];
for (const el of data.elements) {
  if (el.type === 'node') nodes.push({ id: el.id, lat: el.lat, lon: el.lon, tags: pick(el.tags, KEEP_NODE_TAGS) });
  else if (el.type === 'way' && el.tags?.highway) ways.push({ id: el.id, nodes: el.nodes, tags: pick(el.tags, KEEP_WAY_TAGS) });
  else if (el.type === 'way' && el.tags?.building && el.geometry) {
    const levels = Number(el.tags['building:levels']);
    const height = Number(String(el.tags.height ?? '').replace(/[^\d.]/g, ''));
    buildings.push({
      id: el.id,
      pts: el.geometry.map((g) => [Number(g.lat.toFixed(7)), Number(g.lon.toFixed(7))]),
      levels: Number.isFinite(levels) ? levels : undefined,
      height: Number.isFinite(height) && height > 0 ? height : undefined,
      kind: el.tags.building,
    });
  }
}
const center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
const out = {
  name,
  source: 'OpenStreetMap contributors (ODbL 1.0) via Overpass API',
  fetched: new Date().toISOString().slice(0, 10),
  bbox,
  center,
  nodes,
  ways,
  buildings,
};
const file = path.join('public', 'maps', `${name}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${nodes.length} nodes, ${ways.length} road ways, ${buildings.length} buildings, ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
