import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as vw from '../src/vw/virtual-world';
import { VirtualWorldSim, PX_TO_M } from '../src/world/vw/vwWorld';
import { createReferenceState } from '../src/world/reference';

const load = () => vw.World.load(JSON.parse(fs.readFileSync('public/worlds/default.world', 'utf8')));

describe('virtual-world bundle', () => {
  it('generates roads, buildings, trees and lane guides from a graph', () => {
    const g = new vw.Graph([new vw.Point(0, 0), new vw.Point(600, 0), new vw.Point(600, 600)], []);
    g.segments.push(new vw.Segment(g.points[0], g.points[1]), new vw.Segment(g.points[1], g.points[2]));
    const w = new vw.World(g);
    expect(w.envelopes).toHaveLength(2);
    expect(w.roadBorders.length).toBeGreaterThan(10);
    expect(w.laneGuides.length).toBeGreaterThan(10);
    expect(w.buildings.length).toBeGreaterThan(0);
  });

  it('loads the shipped default world with its markings', () => {
    const w = load();
    expect(w.graph.segments.length).toBe(28);
    const types = w.markings.map((m) => m.type);
    for (const t of ['start', 'light', 'stop', 'yield', 'crossing', 'parking', 'target']) expect(types).toContain(t);
  });
});

describe('VirtualWorldSim', () => {
  it('drives the AI population, cycles lights, keeps traffic on the roads and emits WorldState', () => {
    const sim = new VirtualWorldSim(load(), { populationSize: 30, trafficCount: 8 });
    const base = createReferenceState();
    const s0 = sim.toState(base);
    // centre lines and road borders are batched into one marking each, plus stop lines / target ring / parking edges
    const centres = s0.lanes.markings.find((m) => m.id === 'centres')!;
    const borders = s0.lanes.markings.find((m) => m.id === 'borders')!;
    expect(centres.points.length).toBe(28 * 2);
    expect(borders.points.length).toBeGreaterThan(200);
    expect(s0.lanes.markings.length).toBeGreaterThan(10);
    expect(s0.lanes.crosswalks).toHaveLength(4);
    expect(s0.props.trafficLights).toHaveLength(4);
    expect(s0.props.signs.map((s) => s.kind).sort()).toEqual(['stop', 'stop', 'yield', 'yield']);
    expect(s0.buildings!.length).toBeGreaterThan(50);
    expect(s0.trees!.length).toBeGreaterThan(10);
    expect(s0.vehicles.filter((v) => v.parked)).toHaveLength(5);
    const trafficAtStart = sim.traffic.length;
    expect(trafficAtStart).toBeGreaterThan(3);
    // the ego starts at the start marking, travelling +x (east); the marking itself points −x
    const start = sim.world.markings.find((m) => m.type === 'start')!;
    expect(start.directionVector.x).toBeLessThan(0);
    expect(s0.ego.x).toBeCloseTo(start.center.x * PX_TO_M, 3);
    expect(Math.abs(s0.ego.heading - Math.PI / 2)).toBeLessThan(0.05);

    const lightStates = new Set<string>();
    let maxFitness = 0;
    let trafficDamaged = 0;
    for (let i = 0; i < 60 * 20; i++) {
      sim.step(1 / 60);
      const s = sim.toState(base);
      for (const l of s.props.trafficLights) lightStates.add(l.state);
      maxFitness = Math.max(maxFitness, sim.stats().bestFitness);
      trafficDamaged += sim.traffic.filter((t) => t.car.damaged).length;
      expect(Number.isFinite(s.ego.x) && Number.isFinite(s.ego.heading)).toBe(true);
    }
    expect(lightStates).toEqual(new Set(['red', 'green', 'yellow']));
    expect(maxFitness).toBeGreaterThan(0); // cars moved
    expect(trafficDamaged).toBe(0); // the lane-guide followers stay on the road
    expect(sim.traffic.length).toBeGreaterThan(3);
    // traffic keeps moving (not all stuck)
    expect(sim.traffic.some((t) => t.car.speed > 0.5)).toBe(true);
  });

  it('advances generations automatically and keeps the best brain', () => {
    const sim = new VirtualWorldSim(load(), { populationSize: 10, maxGenerationSeconds: 3, trafficCount: 0 });
    for (let i = 0; i < 60 * 8; i++) sim.step(1 / 60);
    expect(sim.generation).toBeGreaterThanOrEqual(2);
    expect(sim.cars[0].brain).toBeDefined();
  });
});
