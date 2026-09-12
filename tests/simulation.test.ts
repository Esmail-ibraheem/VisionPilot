import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/world/simulation';
import { createReferenceState } from '../src/world/reference';

function run(sim: Simulation, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
}

describe('reference arrangement', () => {
  it('places the ego at the origin facing +z at 42 km/h', () => {
    const s = createReferenceState();
    expect(s.ego).toEqual({ x: 0, z: 0, heading: 0, speedKph: 42 });
  });

  it('contains the queue, parked rows, a van and one pedestrian', () => {
    const s = createReferenceState();
    const queue = s.vehicles.filter((v) => v.id.startsWith('q'));
    expect(queue.length).toBeGreaterThanOrEqual(4);
    expect(queue.every((v) => v.x < -1.75)).toBe(true);
    expect(s.vehicles.some((v) => v.type === 'van' && v.parked)).toBe(true);
    expect(s.vehicles.filter((v) => v.parked && v.x > 3).length).toBeGreaterThanOrEqual(4);
    expect(s.pedestrians).toHaveLength(1);
    expect(s.trajectory.visible).toBe(false);
  });
});

describe('Simulation', () => {
  it('is frozen in reference mode', () => {
    const sim = new Simulation({ mode: 'reference' });
    const before = JSON.stringify(sim.state);
    run(sim, 5);
    expect(JSON.stringify(sim.state)).toBe(before);
  });

  it('advances the ego forward in live mode using elapsed time', () => {
    const sim = new Simulation({ mode: 'live' });
    run(sim, 2);
    expect(sim.state.time).toBeCloseTo(2, 5);
    expect(sim.state.ego.z).toBeCloseTo((42 / 3.6) * 2, 3);
    expect(sim.state.ego.x).toBe(0);
  });

  it('does not move while paused and resumes afterwards', () => {
    const sim = new Simulation({ mode: 'live' });
    sim.paused = true;
    run(sim, 1);
    expect(sim.state.ego.z).toBe(0);
    sim.paused = false;
    run(sim, 1);
    expect(sim.state.ego.z).toBeGreaterThan(0);
  });

  it('scales motion by the speed factor', () => {
    const a = new Simulation({ mode: 'live', speedFactor: 1 });
    const b = new Simulation({ mode: 'live', speedFactor: 2 });
    run(a, 1);
    run(b, 1);
    expect(b.state.ego.z).toBeCloseTo(a.state.ego.z * 2, 6);
  });

  it('keeps parked vehicles fixed in world coordinates', () => {
    const sim = new Simulation({ mode: 'live' });
    const parkedBefore = sim.state.vehicles.filter((v) => v.parked).map((v) => ({ ...v }));
    run(sim, 1.5);
    for (const p of parkedBefore) {
      const now = sim.state.vehicles.find((v) => v.id === p.id);
      expect(now, p.id).toBeDefined();
      expect(now!.x).toBe(p.x);
      expect(now!.z).toBe(p.z);
      expect(now!.heading).toBe(p.heading);
    }
  });

  it('is deterministic for identical inputs', () => {
    const a = new Simulation({ mode: 'live' });
    const b = new Simulation({ mode: 'live' });
    run(a, 30);
    run(b, 30);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it('recycles objects only outside the visible range and keeps the queue populated', () => {
    const sim = new Simulation({ mode: 'live' });
    const seen = new Set<string>();
    const problems: string[] = [];
    for (let i = 0; i < 60 * 90; i++) {
      sim.step(1 / 60);
      const egoZ = sim.state.ego.z;
      let queueAhead = 0;
      for (const v of sim.state.vehicles) {
        // Nothing appears closer than 38 m ahead for the first time (no visible pop-in).
        if (!seen.has(v.id)) {
          seen.add(v.id);
          if (sim.state.time > 0.05 && v.z - egoZ <= 38) problems.push(`pop-in ${v.id} at ${v.z - egoZ}`);
        }
        if (v.z - egoZ <= -50) problems.push(`lingering ${v.id}`);
        if (v.id.startsWith('q') && v.z > egoZ + 10) queueAhead++;
      }
      if (queueAhead < 4) problems.push(`queue thin at t=${sim.state.time}`);
    }
    // Parked vehicles never share a slot (rough overlap check).
    const parked = sim.state.vehicles.filter((v) => v.parked);
    for (let i = 0; i < parked.length; i++) {
      for (let j = i + 1; j < parked.length; j++) {
        const d = Math.hypot(parked[i].x - parked[j].x, parked[i].z - parked[j].z);
        if (d <= 2.4) problems.push(`overlap ${parked[i].id} vs ${parked[j].id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('reset restores the reference arrangement', () => {
    const sim = new Simulation({ mode: 'live' });
    run(sim, 20);
    sim.reset();
    expect(JSON.stringify(sim.state)).toBe(JSON.stringify(createReferenceState()));
  });
});
