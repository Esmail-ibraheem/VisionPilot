/**
 * Export a stored map extract as OpenDRIVE:  npx vite-node scripts/export-xodr.ts [map-name]
 * Writes exports/<map-name>.xodr (loadable by CARLA, esmini, MetaDrive's OpenDRIVE importer …).
 */
import fs from 'node:fs';
import { parseOsm, type OsmExtract } from '../src/world/map/osm';
import { buildNetwork } from '../src/world/map/network';
import { exportOpenDrive } from '../src/world/map/xodr';

const name = process.argv[2] ?? 'berlin-prenzlauer-berg';
const extract = JSON.parse(fs.readFileSync(`public/maps/${name}.json`, 'utf8')) as OsmExtract;
const osm = parseOsm(extract);
const net = buildNetwork(osm);
const xml = exportOpenDrive(net, { geoReference: `+proj=eqc +lat_ts=${osm.center.lat} +lat_0=${osm.center.lat} +lon_0=${osm.center.lon} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs` });
fs.mkdirSync('exports', { recursive: true });
fs.writeFileSync(`exports/${name}.xodr`, xml);
console.log(`exports/${name}.xodr: ${net.segments.length} roads, ${net.junctions.length} junctions, ${(xml.length / 1024).toFixed(0)} kB`);
