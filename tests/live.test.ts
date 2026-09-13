import { describe, expect, it } from 'vitest';
import { Path, frameToWorld, worldToFrame } from '../src/world/geometry';
import { RoadNetwork, lightState, EGO_LANE_V } from '../src/world/network';
import { Simulation } from '../src/world/simulation';
import { createReferenceState } from '../src/world/reference';

describe('geometry', () => {
  it('frame round-trips', () => {
    const f = { origin: { x: 3, z: -2 }, heading: 0.7 };
    const p = frameToWorld(f, 12, -4);
    const back = worldToFrame(f, p);
    expect(back.u).toBeCloseTo(12, 6);
    expect(back.v).toBeCloseTo(-4, 6);
  });

  it('arcs are tangent-continuous and turn the right way', () => {
    const path = new Path();
    path.startLine({ x: 0, z: 0 }, 0, 10);
    path.appendArc(5, Math.PI / 2); // right turn
    path.appendLine(10);
    const beforeArc = path.poseAt(9.999);
    const arcStart = path.poseAt(10.001);
    expect(arcStart.x).toBeCloseTo(beforeArc.x, 2);
    expect(arcStart.z).toBeCloseTo(beforeArc.z, 2);
    const end = path.poseAt(10 + (5 * Math.PI) / 2 + 10);
    expect(end.heading).toBeCloseTo(Math.PI / 2, 6);
    // right turn from +z ends heading +x, displaced +x
    expect(end.x).toBeCloseTo(5 + 10, 6);
    expect(end.z).toBeCloseTo(15, 6);
    const left = new Path();
    left.startLine({ x: 0, z: 0 }, 0, 10);
    left.appendArc(5, -Math.PI / 2);
    const le = left.poseAt(left.length);
    expect(le.heading).toBeCloseTo(-Math.PI / 2, 6);
    expect(le.x).toBeCloseTo(-5, 6);
    expect(le.z).toBeCloseTo(15, 6);
  });
});

describe('road network', () => {
  it('turn arcs land on the ego lane of the cross road', () => {
    const net = new RoadNetwork();
    net.ensureAhead(0, 2500);
    expect(net.legs.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < net.legs.length - 1; i++) {
      const leg = net.legs[i];
      const next = net.legs[i + 1];
      const arcEnd = net.route.poseAt(next.sStart);
      const { v } = worldToFrame(next.road.frame, { x: arcEnd.x, z: arcEnd.z });
      expect(v).toBeCloseTo(EGO_LANE_V, 3);
      expect(Math.abs(Math.sin(arcEnd.heading - next.road.frame.heading))).toBeLessThan(1e-6);
      const arcStart = net.route.poseAt(leg.sTurn);
      const a = worldToFrame(leg.road.frame, { x: arcStart.x, z: arcStart.z });
      expect(a.v).toBeCloseTo(EGO_LANE_V, 3);
    }
  });

  it('signals never show green to conflicting movements', () => {
    const net = new RoadNetwork();
    net.ensureAhead(0, 2500);
    for (const inter of net.intersections) {
      if (inter.control !== 'lights') continue;
      for (let t = 0; t < 120; t += 0.5) {
        const a = lightState(inter, 'A+', t) === 'green' || lightState(inter, 'A+in', t) === 'green' || lightState(inter, 'A-', t) === 'green';
        const b = lightState(inter, 'B', t) === 'green';
        expect(a && b).toBe(false);
        if (inter.turn === 'left') {
          // protected turn: the ego's phase excludes oncoming and inner-lane traffic
          const egoGreen = lightState(inter, 'A+', t) === 'green';
          if (egoGreen) {
            expect(lightState(inter, 'A-', t)).toBe('red');
            expect(lightState(inter, 'A+in', t)).toBe('red');
          }
        }
      }
    }
  });
});

describe('live world', () => {
  function run(sim: Simulation, seconds: number): void {
    const steps = Math.round(seconds * 30);
    for (let i = 0; i < steps; i++) sim.step(1 / 30);
  }

  it('starts from the reference arrangement', () => {
    const sim = new Simulation({ mode: 'live' });
    const ref = createReferenceState();
    for (const v of ref.vehicles) {
      const now = sim.state.vehicles.find((x) => x.id === v.id)!;
      expect(now, v.id).toBeDefined();
      expect(now.x).toBeCloseTo(v.x, 3);
      expect(now.z).toBeCloseTo(v.z, 3);
    }
    expect(sim.state.ego.speedKph).toBeCloseTo(42, 3);
    expect(sim.state.route.points.length).toBeGreaterThan(10);
  });

  it('drives through turns, stops at red lights and never collides', () => {
    const sim = new Simulation({ mode: 'live', world: 'generated' });
    const world = sim.liveWorld as import('../src/world/live').LiveWorld;
    let headings = new Set<number>();
    let minSpeed = Infinity;
    let maxSpeed = 0;
    const problems: string[] = [];
    let steps = 0;
    for (let t = 0; t < 300 && steps < 300 * 30; t += 1 / 30) {
      sim.step(1 / 30);
      steps++;
      const s = sim.state;
      headings.add(Math.round(s.ego.heading * 4) / 4);
      minSpeed = Math.min(minSpeed, s.ego.speedKph);
      maxSpeed = Math.max(maxSpeed, s.ego.speedKph);
      if (steps % 15 !== 0) continue;
      // pairwise vehicle separation (moving + parked + ego)
      const objs = [...s.vehicles.map((v) => ({ id: v.id, x: v.x, z: v.z, h: v.heading, l: 4.7 })), { id: 'ego', x: s.ego.x, z: s.ego.z, h: s.ego.heading, l: 4.72 }];
      for (let i = 0; i < objs.length; i++) {
        for (let j = i + 1; j < objs.length; j++) {
          const a = objs[i];
          const b = objs[j];
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < 1.9) problems.push(`t=${t.toFixed(1)} ${a.id} vs ${b.id} d=${d.toFixed(2)}`);
        }
      }
      // pedestrians never inside a moving vehicle
      for (const p of s.pedestrians) {
        for (const v of s.vehicles) {
          if (v.parked) continue;
          const d = Math.hypot(p.x - v.x, p.z - v.z);
          if (d < 1.2) problems.push(`t=${t.toFixed(1)} ped ${p.id} hit by ${v.id}`);
        }
        if (Math.hypot(p.x - s.ego.x, p.z - s.ego.z) < 1.2) problems.push(`t=${t.toFixed(1)} ped ${p.id} hit by ego`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(world.currentLeg().index).toBeGreaterThanOrEqual(1); // at least one turn taken
    expect(headings.size).toBeGreaterThanOrEqual(2);
    expect(minSpeed).toBeLessThan(2); // stopped at a light at least once
    expect(maxSpeed).toBeLessThan(50);
  });

  it('is deterministic', () => {
    const a = new Simulation({ mode: 'live' });
    const b = new Simulation({ mode: 'live' });
    run(a, 60);
    run(b, 60);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('respects pause, speed factor and reset', () => {
    const sim = new Simulation({ mode: 'live' });
    sim.paused = true;
    run(sim, 2);
    expect(sim.state.time).toBe(0);
    sim.paused = false;
    sim.speedFactor = 2;
    run(sim, 2);
    expect(sim.state.time).toBeCloseTo(4, 4);
    sim.reset();
    expect(sim.state.time).toBe(0);
    expect(sim.state.ego.z).toBe(0);
  });
});
