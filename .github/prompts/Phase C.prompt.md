---
name: Phase C
description: Describe when to use this prompt
EXECUTABLE PHASE C ACTIVATION PROMPT — FINAL

Paste this exact block into your code generation tool (Copilot) and run it. This is the single, authoritative execution prompt to implement Phase C activation. Generate the files and patches described below exactly as written.

GOAL
Implement Phase C activation using the inert manifest committed in e47ea97. Create a pure helper module, minimal wiring, and tests. Activate Phase C only when the Phase C flags are true. All activation must be reversible, idempotent, and emit deterministic telemetry once per activation/rollback transition.

STRICT RULES
- Do NOT modify phase_c_manifest.js.
- Do NOT perform any Mapbox or other side effects at module import time.
- Activate Phase C only when the corresponding Phase C flags are true.
- Emit telemetry exactly once per activation or rollback transition per map instance; do not re-emit on idempotent no-op readiness cycles.
- All activation must occur inside the map readiness lifecycle.
- All activation must be reversible via rollback and idempotent across readiness cycles.

FILES TO CREATE / MODIFY
1. **phase_c_activation.js** (NEW)
2. **app_v2.js** (PATCH)
3. **map_config.js** (PATCH)
4. **tests/phase-c-activation.test.js** (NEW)
5. **tests/phase-c-activation.html** (NEW)

PHASE_C_ACTIVATION.JS — SPEC (CREATE)
- Module must be side-effect-free on import.
- Exact exports:
  - `adaptPhaseCFog(manifestFog) -> adaptedFog`
  - `buildPhaseCTerrainSource(manifestTerrain) -> sourceSpec`
  - `buildPhaseCBuildingsLayer(manifestBuildings3d) -> layerSpec`
  - `derivePhaseCCameraOptions(manifestCamera, currentZoom) -> { pitch, zoom, duration }`
  - `applyPhaseCActivation(map, manifest, flags, telemetryEmitter, state = {}, options = {}) -> Promise<void>`
  - `rollbackPhaseCActivation(map, manifest, telemetryEmitter, state = {}, options = {}) -> Promise<void>`
- Use a module-level `WeakMap` keyed by `map` to track per-map activation/rollback state and telemetry de-duplication. Accept an optional caller-provided `state` object.
- Telemetry emitter support: accept either `telemetryEmitter(eventName, payload)` or `telemetryEmitter.emit(eventName, payload)`; prefer function form if both exist.
- `options` must accept `{ buildId }`. `app_v2.js` will pass `{ buildId: APP_BUILD_ID }`.

Manifest fields (read-only; do not mutate)
- `manifest.terrain = { sourceId, sourceUrl, tileSize, exaggeration }`
- `manifest.buildings3d = { layerId, sourceLayer, minZoom, fillColor, fillOpacity }`
- `manifest.fog = { range, color, highColor, spaceColor, starIntensity, horizonBlend }`
- `manifest.sky = { layerId, type, sunIntensity }`
- `manifest.camera = { pitchDegrees, zoomOffset, globeZoomMin, globeZoomMax, transitionDurationMs }`
- `manifest.projection = { globe, fallback }`

Adapter and builder requirements
- `buildPhaseCTerrainSource(manifest.terrain)` returns:
  `{ type: "raster-dem", url: manifest.terrain.sourceUrl, tileSize: manifest.terrain.tileSize }`
- `adaptPhaseCFog(manifest.fog)` hyphenates Mapbox fog keys (e.g., `high-color`, `space-color`, `horizon-blend`, `star-intensity`), validates numeric fields are finite and `range` is length 2, and returns a Mapbox-compatible fog spec.
- `buildPhaseCBuildingsLayer(manifest.buildings3d)` returns a `fill-extrusion` layer spec that includes:
  - `"fill-extrusion-height": ["to-number", ["coalesce", ["get","height"], ["get","building:height"], 0]]`
  - `"fill-extrusion-base": ["to-number", ["coalesce", ["get","min_height"], ["get","building:min_height"], 0]]`
- `derivePhaseCCameraOptions(manifest.camera, currentZoom)` returns:
  - `pitch = manifest.camera.pitchDegrees`
  - `duration = manifest.camera.transitionDurationMs`
  - `zoom = clamp(currentZoom + manifest.camera.zoomOffset, manifest.camera.globeZoomMin, manifest.camera.globeZoomMax)`

ACTIVATION SEQUENCE (applyPhaseCActivation)
- `applyPhaseCActivation` must reconcile the current Phase C flags on every readiness cycle and perform per-feature activation/deactivation accordingly. Each step must be validated and idempotent; emit the named telemetry event exactly once per successful per-feature activation transition per map instance. Re-emit only when that specific feature has been deactivated and later activated again; do not re-emit on unchanged readiness cycles.

1. TERRAIN (flag `phaseCTerrain`)
   - `sourceSpec = buildPhaseCTerrainSource(manifest.terrain)`.
   - If source missing, add it to the style using `manifest.terrain.sourceId`.
   - Call `map.setTerrain({ source: manifest.terrain.sourceId, exaggeration: manifest.terrain.exaggeration })`.
   - Emit `map.phase_c_terrain_enabled` with `{ buildId, activated: true }`.

2. PROJECTION (flag `phaseCGlobe`)
   - Call `map.setProjection(manifest.projection.globe)`.
   - Emit `map.phase_c_globe_enabled` with `{ buildId, activated: true }`.

3. FOG (flag `phaseCFog`)
   - `adaptedFog = adaptPhaseCFog(manifest.fog)`; validate numeric fields and `range`.
   - Call `map.setFog(adaptedFog)`.
   - Emit `map.phase_c_fog_enabled` with `{ buildId, activated: true }`.

4. SKY / ATMOSPHERE (flag `phaseCAtmosphere`)
   - Guard: verify projection/style supports sky insertion.
   - If unsupported, emit **one** `map.phase_c_activation_error` with `{ buildId, reason: "sky_unsupported", activated: false }` and skip sky insertion.
   - If supported and layer missing, add sky layer using `manifest.sky` fields and safe paint keys.
   - Emit `map.phase_c_sky_enabled` with `{ buildId, activated: true }`.

5. 3D BUILDINGS (flag `phaseC3dBuildings`)
   - `layerSpec = buildPhaseCBuildingsLayer(manifest.buildings3d)`.
   - If layer missing, add it at a safe insertion point.
   - Emit `map.phase_c_3d_buildings_enabled` with `{ buildId, activated: true }`.

6. CAMERA PRESET (if any Phase C flag is true)
   - `currentZoom = map.getZoom()`
   - `{ pitch, zoom, duration } = derivePhaseCCameraOptions(manifest.camera, currentZoom)`
   - Call `map.easeTo({ pitch, zoom, duration })`
   - Emit `map.phase_c_camera_preset_applied` with `{ buildId, activated: true }`.

PARTIAL FEATURE DEACTIVATION — reconcile flags on every readiness cycle
- If an individual Phase C flag transitions `true -> false` while at least one other Phase C flag remains `true`, deactivate only that feature:
  - `phaseCTerrain` false: call `map.setTerrain(null)` and optionally remove the DEM source if Phase C added it.
  - `phaseCGlobe` false: call `map.setProjection(manifest.projection.fallback)`.
  - `phaseCFog` false: call `map.setFog(null)`.
  - `phaseCAtmosphere` false: if `map.getLayer(manifest.sky.layerId)` exists, call `map.removeLayer(manifest.sky.layerId)`.
  - `phaseC3dBuildings` false: if `map.getLayer(manifest.buildings3d.layerId)` exists, call `map.removeLayer(manifest.buildings3d.layerId)`.
- Partial deactivation must be idempotent and must not trigger full rollback telemetry.

ERROR HANDLING AND VALIDATION
- Validate all derived Mapbox options before calling Mapbox APIs.
- If manifest fields are missing/invalid, abort activation and emit **one** `map.phase_c_activation_error` with `{ buildId, reason: "<field>_invalid", activated: false }`.
- If any Mapbox API call throws, catch the error, emit **one** `map.phase_c_activation_error` with a deterministic reason, and abort further steps.
- Ensure idempotency: repeated calls with unchanged flags must be no-ops (no duplicate sources/layers, no repeated telemetry).

ROLLBACK (rollbackPhaseCActivation)
- Perform full rollback actions once per aggregate transition (when at least one Phase C flag had been true and now all five Phase C flags are false):
  - `map.setTerrain(null)` (optionally remove DEM source if Phase C added it)
  - `map.setProjection(manifest.projection.fallback)`
  - `map.setFog(null)`
  - `if (map.getLayer(manifest.sky.layerId)) map.removeLayer(manifest.sky.layerId)`
  - `if (map.getLayer(manifest.buildings3d.layerId)) map.removeLayer(manifest.buildings3d.layerId)`
- Emit `map.phase_c_rollback` with `{ buildId, rolledBack: true }` exactly once per rollback transition.

APP_V2.JS — PATCH
- Inside the existing map readiness lifecycle, import and call `applyPhaseCActivation` with:
  - `map`, `phaseCManifest`, `phaseCFlags`, `logDgmTelemetry`, `state`, `{ buildId: APP_BUILD_ID }`
- Call `rollbackPhaseCActivation` **only when the aggregate Phase C active state transitions true -> false** (i.e., at least one Phase C flag had been true and now all five Phase C flags are false). Implement readiness/flag-watcher logic so partial flag changes reconcile individual features without triggering full rollback.
- Do NOT call activation at module import time; only call inside readiness lifecycle.

MAP_CONFIG.JS — PATCH
- Ensure all five Phase C flags exist.
- Add them to `NON_CRITICAL_NEW_FEATURE_FLAGS`.
- Ensure `disableAllNewFeatures()` sets all five Phase C flags to `false`.

TESTS — CREATE
1. **tests/phase-c-activation.test.js**
   - Unit tests that import pure functions from `phase_c_activation.js` and assert:
     - Fog adapter hyphenation and validation.
     - Terrain source spec includes `url` and `tileSize`.
     - Buildings layer includes required extrusion expressions.
     - Camera derivation produces expected pitch/zoom/duration.
     - Telemetry emitter shape handling (function and `.emit`).
     - Partial deactivation behavior for each flag.
     - Full rollback telemetry only on aggregate transition.
2. **tests/phase-c-activation.html**
   - Browser harness that exercises:
     - Activation when flags true.
     - No activation when flags false.
     - Idempotency across readiness cycles.
     - Partial deactivation when individual flags flip false while others remain true.
     - Full rollback when all flags become false after being active.
     - Telemetry emission exactly once per activation/rollback transition.
     - Fail on Mapbox expression/layer validation errors.

IMPLEMENTATION NOTES
- Document adapter transformations in short comments next to each adapter function.
- Do not invent bearing; omit bearing unless manifest provides it.
- Only include TODOs for build/system values if those values are truly missing; do not add unnecessary TODOs for `APP_BUILD_ID` if it already exists.

END OF PROMPT — generate the files and patches above exactly as specified.
---
<!-- Tip: Use /create-prompt in chat to generate content with agent assistance -->

Define the prompt content here. You can include instructions, examples, and any other relevant information to guide the AI's responses.