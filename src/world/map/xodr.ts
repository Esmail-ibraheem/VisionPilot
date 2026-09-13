import { connector, exitsFrom, incomingLanes, outgoingLanes, targetLane, turnBetween, type Arm, type Junction, type RoadNetworkMap, type Segment } from './network';
import type { Polyline } from './polyline';

/**
 * OpenDRIVE 1.6 export of a map network.
 *
 * Frame: OpenDRIVE x = east, y = north, hdg counter-clockwise from +x. Our world x = east,
 * z = north, heading clockwise from +z (north) — so (x, y) = (x, z) and hdg = atan2(dz, dx).
 * Each segment becomes a road whose planView is a chain of <line> geometries following the
 * polyline; right lanes (negative ids) travel with the road direction (+u), left lanes against it.
 * Junctions get one connecting road per permitted movement (outermost lane of each pair).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function planView(line: Polyline): string {
  const out: string[] = [];
  for (let i = 0; i < line.points.length - 1; i++) {
    const a = line.points[i];
    const b = line.points[i + 1];
    const len = line.cum[i + 1] - line.cum[i];
    if (len < 1e-4) continue;
    const hdg = Math.atan2(b.z - a.z, b.x - a.x);
    out.push(`      <geometry s="${line.cum[i].toFixed(4)}" x="${a.x.toFixed(4)}" y="${a.z.toFixed(4)}" hdg="${hdg.toFixed(6)}" length="${len.toFixed(4)}"><line/></geometry>`);
  }
  return out.join('\n');
}

function laneSection(seg: Segment): string {
  const w = seg.laneWidth.toFixed(3);
  const lane = (id: number) => `        <lane id="${id}" type="driving" level="false"><width sOffset="0.0" a="${w}" b="0.0" c="0.0" d="0.0"/></lane>`;
  const left = seg.oneway ? [] : seg.bwd.map((_, i) => lane(i + 1)).reverse();
  const right = seg.fwd.map((_, i) => lane(-(i + 1)));
  // one-way roads: all lanes are "right" lanes; the centreline sits in the middle of the carriageway,
  // which the OpenDRIVE reference line reproduces via a lane offset
  const offset = seg.oneway ? (seg.fwd.length * seg.laneWidth) / 2 : 0;
  return `    <laneOffset s="0.0" a="${offset.toFixed(3)}" b="0.0" c="0.0" d="0.0"/>
    <laneSection s="0.0">
      <left>
${left.join('\n')}
      </left>
      <center><lane id="0" type="none" level="false"><roadMark sOffset="0.0" type="${seg.oneway ? 'none' : 'solid'}" weight="standard" color="standard" width="0.12"/></lane></center>
      <right>
${right.join('\n')}
      </right>
    </laneSection>`;
}

interface Ids {
  road: Map<Segment, number>;
  junction: Map<Junction, number>;
}

function roadXml(seg: Segment, ids: Ids): string {
  const id = ids.road.get(seg)!;
  const pred = seg.startJunction ? `<predecessor elementType="junction" elementId="${ids.junction.get(seg.startJunction)}"/>` : '';
  const succ = seg.endJunction ? `<successor elementType="junction" elementId="${ids.junction.get(seg.endJunction)}"/>` : '';
  const limit = (seg.speedLimit * 3.6).toFixed(0);
  return `  <road name="${esc(seg.name)}" length="${seg.line.length.toFixed(4)}" id="${id}" junction="-1">
    <link>${pred}${succ}</link>
    <type s="0.0" type="town"><speed max="${limit}" unit="km/h"/></type>
    <planView>
${planView(seg.line)}
    </planView>
    <lanes>
${laneSection(seg)}
    </lanes>
  </road>`;
}

/** OpenDRIVE lane id of a lane index on a side: right lanes are negative, left lanes positive. */
function laneIdOf(side: 'fwd' | 'bwd', index: number): number {
  return side === 'fwd' ? -(index + 1) : index + 1;
}

export function exportOpenDrive(net: RoadNetworkMap, opts: { name?: string; geoReference?: string } = {}): string {
  const ids: Ids = { road: new Map(), junction: new Map() };
  let nextId = 1;
  for (const seg of net.segments) ids.road.set(seg, nextId++);
  for (const j of net.junctions) ids.junction.set(j, nextId++);
  const roads: string[] = net.segments.map((s) => roadXml(s, ids));
  const junctions: string[] = [];
  const connectingRoads: string[] = [];
  for (const j of net.junctions) {
    const jid = ids.junction.get(j)!;
    const connections: string[] = [];
    let connIndex = 0;
    for (const from of j.arms) {
      const inc = incomingLanes(from);
      if (inc.lanes.length === 0) continue;
      const exits = j.arms.length === 2 ? j.arms.filter((a) => a !== from && outgoingLanes(a).lanes.length > 0) : exitsFrom(j, from);
      for (const to of exits) {
        const turn = turnBetween(from, to);
        const outg = outgoingLanes(to);
        const fromLane = inc.lanes.length - 1;
        const toLane = targetLane(turn, fromLane, inc.lanes.length, outg.lanes.length);
        const line = connector(from, fromLane, to, toLane);
        const rid = nextId++;
        connectingRoads.push(connectingRoadXml(rid, jid, line, from, to, ids, from.seg.laneWidth));
        connections.push(
          `    <connection id="${connIndex++}" incomingRoad="${ids.road.get(from.seg)}" connectingRoad="${rid}" contactPoint="start">
      <laneLink from="${laneIdOf(inc.side, fromLane)}" to="-1"/>
    </connection>`,
        );
      }
    }
    junctions.push(`  <junction name="${esc(j.id)}" id="${jid}" type="default">
${connections.join('\n')}
  </junction>`);
  }
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="6" name="${esc(opts.name ?? net.name)}" version="1.00" date="${new Date().toISOString().slice(0, 10)}" north="${net.bounds.max.z.toFixed(2)}" south="${net.bounds.min.z.toFixed(2)}" east="${net.bounds.max.x.toFixed(2)}" west="${net.bounds.min.x.toFixed(2)}">
    <geoReference><![CDATA[${opts.geoReference ?? '+proj=eqc +units=m'}]]></geoReference>
  </header>`;
  return [header, ...roads, ...connectingRoads, ...junctions, '</OpenDRIVE>', ''].join('\n');
}

function connectingRoadXml(id: number, junctionId: number, line: Polyline, from: Arm, to: Arm, ids: Ids, width: number): string {
  const fromContact = from.end === 'end' ? 'end' : 'start';
  const toContact = to.end === 'start' ? 'start' : 'end';
  return `  <road name="conn" length="${line.length.toFixed(4)}" id="${id}" junction="${junctionId}">
    <link>
      <predecessor elementType="road" elementId="${ids.road.get(from.seg)}" contactPoint="${fromContact}"/>
      <successor elementType="road" elementId="${ids.road.get(to.seg)}" contactPoint="${toContact}"/>
    </link>
    <planView>
${planView(line)}
    </planView>
    <lanes>
      <laneOffset s="0.0" a="${(width / 2).toFixed(3)}" b="0.0" c="0.0" d="0.0"/>
      <laneSection s="0.0">
        <center><lane id="0" type="none" level="false"/></center>
        <right>
          <lane id="-1" type="driving" level="false"><width sOffset="0.0" a="${width.toFixed(3)}" b="0.0" c="0.0" d="0.0"/></lane>
        </right>
      </laneSection>
    </lanes>
  </road>`;
}
