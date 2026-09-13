import { buildNetwork, type RoadNetworkMap } from './network';
import { parseOsm, type OsmExtract } from './osm';

/** Load a map extract served by the app itself (public/maps/<name>.json) and build its network. */
export async function loadMapNetwork(name: string): Promise<RoadNetworkMap> {
  const url = new URL(`maps/${name}.json`, document.baseURI).toString();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`map "${name}" not found (${res.status})`);
  const extract = (await res.json()) as OsmExtract;
  return buildNetwork(parseOsm(extract));
}
