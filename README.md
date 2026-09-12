# Driving Visualization (Tesla-style) — Three.js recreation

An interactive 3D recreation of the Tesla Model 3/Y driving-visualization screen: pale gray
perception world, elevated long-lens rear camera, black ego car, simplified gray vehicles, lane
markings, a pedestrian, and the HTML/CSS instrument, media, navigation and dock overlays.

Everything renders from a real Three.js scene (vehicles, wheels, pedestrians and lane geometry are
3D objects in world coordinates). The rendering library is bundled from `node_modules`; all vehicle
models are generated procedurally at start-up, so the app makes **no runtime requests to third-party
CDNs and needs no downloaded assets**.

![reference mode](screenshots/reference.png)

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5180/
```

Production build and preview:

```bash
npm run build      # type-check + bundle into dist/
npm run preview    # serves dist/ on http://127.0.0.1:5181/
```

`dist/` is fully static — copy it to any web server (relative asset paths are used).

Tests (simulation invariants + loft geometry checks):

```bash
npm test
```

Headless screenshot of the running app (uses the locally installed Edge/Chrome via puppeteer-core;
also reports console errors and any non-same-origin request):

```bash
npm run screenshot -- --url http://127.0.0.1:5180/ --out screenshots/reference.png
npm run screenshot -- --query "mode=live" --wait 4000 --out screenshots/live.png
```

## Using the app

The page opens in **reference mode**: the frozen arrangement from the reference photo. The developer
panel (the small `DEV` tab on the right edge, or the `D` key) exposes:

| Control | Effect |
| --- | --- |
| Reference / Live | Frozen reference scene ↔ live demo (ego drives at 42 km/h, traffic and parked rows stream by) |
| Pause / Resume, Reset | Pause the live demo; reset returns to the reference arrangement |
| Speed | Simulation speed factor 0.25×–3× |
| Show planned-path corridor | Optional blue trajectory ribbon (off in the reference scene) |
| Camera sliders | fov / back / height / ahead / lateral / fog near / far — live tuning |
| Simulate context loss | Forces a WebGL context loss; the app shows a banner and rebuilds on restore |
| Save frame PNG | Downloads the current 3D frame |

Keyboard: `Space` pause/resume (starts live mode from reference), `R` reset, `L` toggle live/reference,
`T` corridor, `[` / `]` speed, `D` panel. The media panel's pause/play button also pauses/resumes the
demo; the ±15 s buttons nudge the (simulated) podcast progress. Nothing is connected to real vehicle,
navigation or audio services.

`prefers-reduced-motion: reduce` keeps the scene frozen until the live demo is explicitly started.

URL parameters (handy for comparisons): `?mode=live`, `?speed=2`, `?hud=0` (hide overlays),
`?dev=1` (open the panel), camera overrides such as `?fov=27.4&back=43.6&height=13.1&ahead=6.5`,
`?probe=sedan|crossover|van|ego&yaw=145` (single-model viewer), `?simulateError=1` (exercise the error
overlay + Retry).

## How it is built

```
src/
  world/            world-state model — independent of rendering
    types.ts        WorldState: ego pose/speed, vehicles, pedestrians, lane geometry, trajectory
    reference.ts    the frozen arrangement estimated from the reference photo
    simulation.ts   deterministic demo simulation producing WorldState from elapsed time
  render/
    SceneRenderer.ts  Three.js scene, camera rig, lights, fog; update(state) syncs object pools
    vehicles/loft.ts  cross-section loft: profile curves → smooth body mesh with glass/body/trim groups
    vehicles/specs.ts sedan, crossover, van and ego (Model 3-like) body definitions
    vehicles/buildVehicle.ts  body + wheels + lights + mirrors + contact shadow per vehicle type
    pedestrian.ts, ground.ts (lane dashes, arrow, corridor), environment.ts, blobShadow.ts
  ui/               HUD scaling + developer panel
  main.ts           bootstrap, error overlay/retry, context-loss handling, frame loop
```

The simulation produces a plain `WorldState`; the renderer only reads it. To drive the display from
another data source, construct `WorldState` objects yourself and call `SceneRenderer.update(state)`.

### Camera

A long-lens perspective camera (27.4° vertical FOV) sits 43.6 m behind and 13.1 m above the ego,
aimed 6.5 m ahead of it. These numbers were solved from the reference photo (object size ratios
and the vertical spread of the queue) and then refined against screenshots. An orthographic camera
was considered but rejected: the reference shows clear, if restrained, perspective convergence in
the lane lines and vehicle sizes.

### Vehicles

Each body is a loft of cross-section rings along the length. Five profile curves (roof/hood height,
belt line, plan-view half-width, roof-width ratio, underside height) plus corner-rounding radii define
the shape; wheel arches are cut by raising the underside around the axles. The ring is sampled in three
fixed segments (lower body, greenhouse side, roof) so the belt line is an exact vertex row and the
glass/body boundary is crisp; windshield and rear window are detected from the roof-profile slope.
Faces are grouped into body / glass / lower-trim materials. Wheels, lights and mirror housings are
merged per vehicle type (≈ 9 draw calls per vehicle).

## Verification performed

- Unit tests: simulation determinism, pause/reset/speed, parked objects fixed in world space, no
  visible pop-in, loft geometry sanity (extents, outward normals, arches, material groups).
- Browser: first load renders the full scene; refresh works; console clean; all requests same-origin;
  live/pause/resume/reset/speed/corridor controls verified; context loss → banner → automatic rebuild;
  simulated init failure → overlay → Retry recovers; layouts checked at 1200×791, 900×560, 480×800.
- Screenshots in `screenshots/` are produced from the production bundle with the headless script.
