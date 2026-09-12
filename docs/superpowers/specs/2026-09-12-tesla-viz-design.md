# Tesla driving visualization recreation — design

Date: 2026-09-12

## Goal
Interactive 3D recreation of the Tesla Model 3/Y "driving visualization" screen from the
supplied reference photo: pale gray environment, elevated long-lens rear camera, black ego car,
simplified gray perception vehicles, lane markings, pedestrian, compact HUD, media/nav panels, dock.

## Stack
Vite 8 + TypeScript + Three.js 0.186 (bundled from node_modules, no CDN). All geometry is
procedural, so nothing is fetched at runtime. Vitest for logic tests. `puppeteer-core` + local
Edge for headless PNG screenshots.

## Modules
- `src/world/types.ts` — `WorldState`: `{ time, ego:{x,z,heading,speedKph}, vehicles:[{id,type,x,z,heading,parked,brake}], pedestrians:[{id,x,z,heading,phase}], lanes:{lines,arrows}, trajectory }`.
  World frame: x right, z forward, y up. Ego lane centre is x=0 at t=0.
- `src/world/reference.ts` — the frozen arrangement estimated from the photo.
- `src/world/simulation.ts` — `Simulation` class: `reset()`, `step(dtSeconds)`, `state`. Modes:
  `reference` (frozen) and `live`. Ego travels +z at 42 km/h × speed factor; queue lane traffic
  moves at ~38 km/h with fixed spacing; parked cars/pedestrians stay in world coords; objects that
  fall > 40 m behind the ego are recycled ahead beyond the fog (≥ 120 m) into deterministic slots.
- `src/render/SceneRenderer.ts` — owns the Three.js scene/camera/lights/fog/ground; `update(state)`
  syncs object pools to state; `render()`; `resize()`; `dispose()`.
- `src/render/vehicles/loft.ts` — cross-section loft builder → `BufferGeometry` with material groups
  (body, glass, trim). `specs.ts` — sedan / crossover / van / ego parameter sets.
  `buildVehicle.ts` — assembles body + wheels + lights + mirrors + shadow blob into a `Group`.
- `src/render/pedestrian.ts`, `src/render/ground.ts` (lane dashes, arrow, blob texture), `src/render/environment.ts` (gradient env map).
- `src/ui/hud.ts` (scaling), `src/ui/devPanel.ts` (mode, pause, reset, speed, trajectory, camera readout, context-loss test).
- `src/main.ts` — bootstrap, error overlay with retry, context loss handling, RAF loop using elapsed time, reduced-motion handling.

## Camera
Perspective, vertical FOV 27.4°, 43.6 m behind and 13.1 m above the ego, aimed 6.5 m ahead of it
(`DEFAULT_RIG` in `SceneRenderer.ts`). Solved from the reference photo: the vertical spread between
the ego and the queue fixes `f·(h/D) ≈ 487 px`, the ego's 66 px width fixes `f/D`, and a depression
angle of ≈ 17° at the ego matches the visible roof/rear proportions; then refined by screenshot
comparison. Fog 65–160 m from the camera. An orthographic camera was rejected (the reference has
visible perspective convergence).

## Error handling
- WebGL unavailable / renderer construction throws → overlay with message + Retry.
- `webglcontextlost` → preventDefault, show banner; `webglcontextrestored` → rebuild renderer.
- Any exception in the frame loop → overlay + retry (loop stops so the page never spins).

## Testing
- Vitest: simulation determinism, reset, pause (no change), speed factor scaling, parked cars fixed,
  loft geometry has no NaNs, wheel bottoms at y≈0, glass group non-empty.
- Browser: console clean, network shows only same-origin requests, screenshots vs reference.

## Outcome (2026-09-12)
Implemented as specified. Deviations from the first draft: vite 5 instead of 8 (Node 20.16 lacks the
rolldown native binding), the world→scene x mirror (`render/frame.ts`) because a camera looking along
+z sees world +x on the left, and the loft ring was split into fixed segments so glass boundaries are
exact vertex rows. Vehicle sub-parts are merged per template to keep draw calls ≈ 9 per vehicle.
