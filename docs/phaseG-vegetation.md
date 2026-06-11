# Phase G Vegetation & Vehicle Marker

Date: 2026-06-10
Branch: `feature/upgrade-all-aggressive`

Phase G adds two map-polish features that render on **Mapbox GL JS v2.15.0** using
only v2-compatible surfaces — **sprite billboards (symbol layers) and
fill-extrusion polygons**. There is no native GLTF/model layer in v2, so no
three.js or model layer is used. A Mapbox upgrade, if ever chosen, must be a
separate, explicitly approved commit with its own test plan.

Both features are heavy effects and are visible only when
`(isPhaseDTuningEnabled() OR an owner-local toggle)` is true AND the relevant
perf-guard effect has not tripped.

## Modules

- `intelligence/vegetation_core.js`: deterministic vegetation instance generator + LOD rules (pure; no Mapbox).
- `ui/vegetation_layer.js`: Mapbox v2 render surfaces (symbol sprites + fill-extrusion) + visibility/LOD gating.
- `ui/vehicle_marker.js`: heading-rotated symbol-sprite vehicle marker + deterministic camera helpers.
- `assets/sprites/tree_sample.png`, `assets/sprites/dodge_dart_sprite.png`: tiny placeholder dev sprites.

The app/UI owner remains `app_v2.js`.

## Vegetation core

```js
generateVegetationInstances(samples, { gridResolution, densityThreshold, lodRules })
// -> { instances, aggregates, metadata }
resolveLodMode(zoom, lodRules) // -> { mode: "hidden"|"extrusion"|"sprite", renderSprites, renderExtrusions }
```

Samples are vegetation points or polygons (OSM `natural=wood`/`tree`, landcover,
or synthetic). Points/polygons are rasterized onto a local-equirectangular
placement grid; cells whose accumulated density meets `densityThreshold` become
sprite-billboard instances and are aggregated into coarse fill-extrusion tiles.

Metadata:

- `instanceCount`
- `aggregateCount`
- `gridResolution`
- `densityThreshold`
- `sampleCount`
- `heuristicConfidenceScore` (bounded [0,1] support proxy — a rough signal, not calibrated)

### LOD rules

`lodRules` (defaults): `{ spriteMinZoom: 14, hideBelowZoom: 8, aggregationFactor: 4 }`.

- `zoom < hideBelowZoom` → `hidden`
- `hideBelowZoom <= zoom < spriteMinZoom` → `extrusion` (aggregated polygons)
- `zoom >= spriteMinZoom` → `sprite` (individual billboards)

Generation is fully deterministic: identical inputs always yield identical,
sorted instances/aggregates.

## Vegetation layer (UI)

```js
const veg = createVegetationLayer({ getMap, generateInstances, resolveLod, shouldExposeDebug });
veg.setSamples(samples);
veg.setEnabled(true);
veg.setDensityThreshold(value);
veg.syncVisibility({ zoom, guardDisabled, allowed }); // -> "hidden"|"sprite"|"extrusion"
```

The layer adds a symbol layer (sprite billboards) and a fill-extrusion layer, and
loads the sprite image once with a deterministic programmatic fallback so the
symbol layer never warns on a missing image. `app_v2.js` provides a collapsed
Vegetation control (toggle + density slider + status) in the map-mode drawer and
gates visibility on `(isPhaseDTuningEnabled() OR owner toggle) AND user toggle
AND NOT phaseGVegetationLayer-guarded`. LOD re-syncs on `moveend`.

Owner-local enable (independent of full Phase D tuning):
`?vegetation=true`, `window.DGM_VEGETATION = true`, or
`localStorage["dgm:phaseg:vegetation"] = "true"`.

## Vehicle marker + camera

```js
const marker = createVehicleMarker({ getMap, isGuardDisabled, shouldExposeDebug });
marker.update({ lng, lat, heading, speed }); // heading-smoothed symbol sprite
marker.show(); marker.hide();
```

The vehicle is a symbol sprite with `icon-rotate` (rotation-alignment: `map`) —
the v2-compatible alternative to a model layer. Camera helpers (pure,
deterministic):

```js
animateCameraAlongPath(path, { duration, easing, pitch, offset, frames }) // -> deterministic keyframes
buildFollowCamera({ lng, lat, heading, speed, mode, pitch, zoomConfig })   // -> CameraOptions
speedAdaptiveZoom(speedMps, { minZoom, maxZoom, minSpeed, maxSpeed })
interpolateHeading(fromDeg, toDeg, t)
```

### Blue-dot ownership

Only `location_runtime.js` mutates the blue dot. It exposes `hideDot()`,
`showDot()`, and `replaceDotWithVehicle(marker)` on its returned API; `app_v2.js`
**calls** these — it never edits the dot layers directly. When a vehicle marker
is active, `location_runtime.js` forwards live position (from
`setCurrentLocationState`) and heading/speed (from the continuous watch) to the
marker, and `app_v2.js` drives a heading-locked, speed-adaptive `easeTo` follow
**only when no route is active** (during navigation, `routing_runtime.js` owns the
camera and is untouched).

Owner-local enable: `?vehicle=true`, `window.DGM_VEHICLE = true`, or
`localStorage["dgm:phaseg:vehicle"] = "true"`. Gated on `phaseGVehicleModel`.

## Perf-guard effect-constant pattern (Phase F precedent)

Heavy Phase G effects are made guard-aware by appending constants to the frozen
`PHASE_E_PERFORMANCE_GUARD_EFFECTS` object in `performance/monitor.js`:

```js
PLACE_PHOTOS: "phaseGPlacePhotos",
VEGETATION_LAYER: "phaseGVegetationLayer",
VEHICLE_MODEL: "phaseGVehicleModel",
```

This follows the Phase F precedent (which added `OPPORTUNITY_OVERLAY`). The object
stays **frozen** and the guard stays **all-or-nothing on trip** — registering a
name simply adds it to the global "disable when slow" set (the exported effect
list is `Object.values(...)`). There is no per-effect selective disabling and no
mutable registry. Consumers check membership via `isEffectDisabled(name)` /
`isPhaseEPerformanceEffectDisabled(name)`. UI commits reuse these constants; they
do not modify `performance/monitor.js`.

## Tests

Node:

```sh
node -e "import('./tests/intelligence/vegetation_core.test.js').then(m => m.runVegetationCoreTests()).then(r => { if (r.failed) process.exit(1); })"
node -e "import('./tests/intelligence/vehicle_camera.test.js').then(m => m.runVehicleCameraTests()).then(r => { if (r.failed) process.exit(1); })"
```

Perf guard (extended for Phase G effect names):

```sh
node -e "import('./tests/perf-guard.test.js').then(m => m.runPerfGuardTests()).then(r => { if (r.failed) process.exit(1); })"
```

Browser smoke: run `./start.ps1`, open `http://localhost:5173/tests/browser-smoke.html`.
The vegetation check verifies toggle, sprite-vs-extrusion LOD, a simulated
low-FPS guard hiding the layer, and the density slider; the vehicle check
verifies blue-dot replacement, the symbol layer, and deterministic camera
keyframes.
