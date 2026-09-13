import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { parseOsm, type OsmExtract } from '../src/world/map/osm';
import { buildNetwork, connector, exitsFrom, incomingLanes, outgoingLanes, targetLane, turnBetween } from '../src/world/map/network';
import { Polyline } from '../src/world/map/polyline';

const extract = JSON.parse(fs.readFileSync('public/maps/berlin-prenzlauer-berg.json', 'utf8')) as OsmExtract;

describe('polyline', () => {
  it('parameterises by arc length and offsets to the right', () => {
    const p = new Polyline([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 10, z: 10 }]);
    expect(p.length).toBeCloseTo(20);
    expect(p.pointAt(5)).toEqual({ x: 0, z: 5 });
    expect(p.pointAt(15).x).toBeCloseTo(5);
    const o = p.offsetPoint(5, 2);
    expect(o.x).toBeCloseTo(2); // right of +z travel is +x
    const pr = p.project({ x: 3, z: 4 });
    expect(pr.u).toBeCloseTo(4);
    expect(pr.v).toBeCloseTo(3);
    const h = Polyline.hermite({ x: 0, z: 0 }, 0, { x: 10, z: 10 }, Math.PI / 2);
    expect(Math.abs(h.headingAt(0))).toBeLessThan(0.2); // chord of the first ~1 m sample
    expect(Math.abs(h.headingAt(h.length - 0.01) - Math.PI / 2)).toBeLessThan(0.15);
  });
});

describe('Berlin network', () => {
  const osm = parseOsm(extract);
  const net = buildNetwork(osm);

  it('builds a sizeable, connected network with signals and parking', () => {
    expect(net.segments.length).toBeGreaterThan(150);
    expect(net.junctions.length).toBeGreaterThan(60);
    const lights = net.junctions.filter((j) => j.control === 'lights');
    expect(lights.length).toBeGreaterThan(8);
    const withParking = net.segments.filter((s) => s.parkingLeft || s.parkingRight);
    expect(withParking.length).toBeGreaterThan(80);
    const named = net.segments.filter((s) => s.name.includes('Kollwitz'));
    expect(named.length).toBeGreaterThan(0);
    expect(net.buildings.length).toBeGreaterThan(1000);
    // every segment end that touches a junction is listed as an arm there
    for (const s of net.segments) {
      if (s.startJunction) expect(s.startJunction.arms.some((a) => a.seg === s && a.end === 'start')).toBe(true);
      if (s.endJunction) expect(s.endJunction.arms.some((a) => a.seg === s && a.end === 'end')).toBe(true);
      expect(s.line.length).toBeGreaterThan(1);
      expect(s.fwd.length + s.bwd.length).toBeGreaterThan(0);
    }
  });

  it('connectors join lane ends smoothly and turns classify sensibly', () => {
    let straight = 0;
    let turns = 0;
    for (const j of net.junctions) {
      for (const from of j.arms) {
        if (incomingLanes(from).lanes.length === 0) continue;
        for (const to of exitsFrom(j, from)) {
          const t = turnBetween(from, to);
          if (t === 'straight') straight++;
          else turns++;
          const fl = incomingLanes(from).lanes;
          const tl = outgoingLanes(to).lanes;
          const c = connector(from, fl.length - 1, to, targetLane(t, fl.length - 1, fl.length, tl.length));
          expect(c.length).toBeGreaterThan(1);
          expect(c.length).toBeLessThan(80);
          for (const p of c.points) expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
        }
      }
    }
    expect(straight).toBeGreaterThan(50);
    expect(turns).toBeGreaterThan(50);
  });
});

describe('Berlin traffic', () => {
  it('drives the real network for 240 s without collisions, passing junctions', async () => {
    const { MapWorld } = await import('../src/world/map/mapWorld');
    const osm = parseOsm(extract);
    const net = buildNetwork(osm);
    const world = new MapWorld(net);
    const base = (await import('../src/world/reference')).createReferenceState();
    const problems: string[] = [];
    let minSpeed = Infinity;
    let maxSpeed = 0;
    const visited = new Set<string>();
    let travelled = 0;
    let last = world.egoPose();
    for (let i = 0; i < 240 * 30; i++) {
      world.step(1 / 30);
      const e = world.egoPose();
      travelled += Math.hypot(e.x - last.x, e.z - last.z);
      last = e;
      if (i % 15) continue;
      const s = world.toState(base);
      if (!Number.isFinite(s.ego.x) || !Number.isFinite(s.ego.heading)) problems.push(`nan at ${i}`);
      minSpeed = Math.min(minSpeed, s.ego.speedKph);
      maxSpeed = Math.max(maxSpeed, s.ego.speedKph);
      visited.add(s.streetName ?? '');
      const moving = s.vehicles.filter((v) => !v.parked);
      const objs = [...moving.map((v) => ({ id: v.id, x: v.x, z: v.z })), { id: 'ego', x: s.ego.x, z: s.ego.z }];
      for (let a = 0; a < objs.length; a++) {
        for (let b = a + 1; b < objs.length; b++) {
          const d = Math.hypot(objs[a].x - objs[b].x, objs[a].z - objs[b].z);
          if (d < 2.6) problems.push(`t=${(i / 30).toFixed(1)} ${objs[a].id} vs ${objs[b].id} d=${d.toFixed(2)}`);
        }
      }
      for (const p of s.pedestrians) {
        for (const o of objs) if (Math.hypot(p.x - o.x, p.z - o.z) < 1.1) problems.push(`t=${(i / 30).toFixed(1)} ped ${p.id} hit by ${o.id}`);
      }
    }
    expect(problems.slice(0, 12)).toEqual([]);
    expect(travelled).toBeGreaterThan(900);
    expect(visited.size).toBeGreaterThanOrEqual(3); // drove onto other streets
    expect(maxSpeed).toBeLessThan(56);
    expect(minSpeed).toBeLessThan(22); // slowed for a turn / crossing at least once
  }, 120000);
});

describe('OpenDRIVE export', () => {
  it('produces well-linked roads, lanes and junction connections', async () => {
    const { exportOpenDrive } = await import('../src/world/map/xodr');
    const net = buildNetwork(parseOsm(extract));
    const xml = exportOpenDrive(net);
    expect(xml.startsWith('<?xml')).toBe(true);
    const roadIds = new Set([...xml.matchAll(/<road [^>]*\bid="(\d+)"/g)].map((m) => m[1]));
    const junctionIds = new Set([...xml.matchAll(/<junction [^>]*\bid="(\d+)"/g)].map((m) => m[1]));
    expect(roadIds.size).toBe((xml.match(/<road /g) ?? []).length); // unique ids
    expect(junctionIds.size).toBe(net.junctions.length);
    // every link target exists
    for (const m of xml.matchAll(/<(predecessor|successor) elementType="(road|junction)" elementId="(\d+)"/g)) {
      expect(m[2] === 'road' ? roadIds.has(m[3]) : junctionIds.has(m[3]), m[0]).toBe(true);
    }
    for (const m of xml.matchAll(/incomingRoad="(\d+)" connectingRoad="(\d+)"/g)) {
      expect(roadIds.has(m[1]) && roadIds.has(m[2]), m[0]).toBe(true);
    }
    // planView geometry lengths add up to the road length
    const roads = xml.split('<road ').slice(1);
    let checked = 0;
    for (const r of roads) {
      const len = Number(/length="([\d.]+)"/.exec(r)![1]);
      const sum = [...r.matchAll(/<geometry [^>]*length="([\d.]+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
      expect(Math.abs(sum - len)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(200);
    expect((xml.match(/<connection /g) ?? []).length).toBeGreaterThan(100);
    expect(xml).toContain('type="driving"');
  });
});
