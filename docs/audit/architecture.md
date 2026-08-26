# Component, Dependency, Runtime, and Data-Flow Maps

## System boundary

`VERIFIED IN REPOSITORY` — DGM is a static, browser-executed application.
`index.html` loads Mapbox GL JS and javascript-lp-solver from CDNs, then loads
the ES-module entrypoint `app_v2.js`. No package manager or application
server is present.

## Component map

| Component | Repository authority | Responsibility | Evidence |
|---|---|---|---|
| shell and controls | `index.html`, `styles.css` | map container, controls, status, bootstrap flags | VERIFIED IN REPOSITORY |
| orchestration | `app_v2.js` | imports subsystems, owns state, binds UI, coordinates refresh | VERIFIED IN REPOSITORY |
| probability contract | `model.js` | geospatial intensity, quality, probability bands, grid and ranking | VERIFIED IN REPOSITORY |
| learned scoring | `learned_predictor.js` | default-off monotone dual-head predictor and calibration | VERIFIED IN REPOSITORY |
| set selection | `optimizer.js` | facility-location fallback and coverage evaluation | VERIFIED IN REPOSITORY |
| dispatch experiment | `dispatch_assignment.js` | bounded driver/order assignment experiment | VERIFIED IN REPOSITORY |
| data acquisition | `overpass.js`, `weather.js`, `census.js` | OSM, Open-Meteo, and static Census inputs | VERIFIED IN REPOSITORY |
| navigation | `location_runtime.js`, `routing_runtime.js`, `heading_runtime.js` | position, route, heading, voice guidance | VERIFIED IN REPOSITORY |
| map adaptation | `map_config.js`, `map_interaction_runtime.js`, `style_state.js`, `traffic_visibility.js` | map behavior and restoration | VERIFIED IN REPOSITORY |
| opportunity intelligence | `intelligence/opportunity_*`, `superposition_engine.js`, `zone_clustering.js` | field generation, overlays, clusters | VERIFIED IN REPOSITORY |
| place intelligence | `intelligence/place_*` | provider normalization, search, cache, and photos | VERIFIED IN REPOSITORY |
| visual intelligence | `intelligence/vegetation_core.js`, `ui/*` | vegetation, place cards, vehicle marker | VERIFIED IN REPOSITORY |
| safeguards | `performance/monitor.js`, `runtime_ready.js`, `phase_c_*` | readiness, telemetry, activation and rollback | VERIFIED IN REPOSITORY |

## Static dependency map

```text
index.html
  -> Mapbox GL JS CDN
  -> javascript-lp-solver CDN
  -> app_v2.js
       -> model.js -> learned_predictor.js
                    -> dispatch_assignment.js
       -> optimizer.js -> model.js
       -> overpass.js / weather.js / census.js
       -> map, location, heading, routing, and scoring runtimes
       -> intelligence/* -> place_model.js and opportunity_core.js
       -> ui/* and performance/monitor.js
```

`VERIFIED IN REPOSITORY` — the entrypoint directly imports approximately thirty
local modules. `INFERRED` — this concentration makes it the primary integration
and regression-risk boundary.

## Runtime map

```text
bootstrap flags + DOM
  -> validate web-server protocol and map token
  -> construct map and readiness/activation guards
  -> bind map, location, heading, route, traffic, place, and control events
  -> fetch OSM/weather/Census context on refresh
  -> normalize and filter observations
  -> derive score statistics and probability field
  -> rank/select candidate hold locations
  -> render heat, markers, cards, route, and diagnostics
  -> persist bounded preferences/history/cache in browser storage
```

## Data-flow map

| Source | Transform | Sink | Boundary |
|---|---|---|---|
| Overpass endpoints | POI parsing, eligibility, distance decay | merchant/residential/parking features | public network |
| static Census JSON | coordinate normalization and bounded anchors | residential demand | bundled data |
| Open-Meteo | precipitation-to-lift mapping | demand parameter | public network |
| browser geolocation/orientation | normalization and runtime filtering | vehicle, heading, routing | sensitive device input |
| OSRM | route request/response adaptation | route geometry and guidance | public network |
| Mapbox geocoding | query and normalization | map navigation/place UI | third-party network |
| Nominatim | fallback search | place navigation | public network |
| local/IndexedDB storage | schema normalization and TTL/bounds | preferences, history, place cache | device persistence |
| model outputs | grid/rank/selection and explanation | map layers, cards, diagnostics | in-browser |

## Dependency inventory

`VERIFIED IN REPOSITORY`:

- Mapbox GL JS `v2.15.0`, remotely loaded.
- javascript-lp-solver `0.4.24`, remotely loaded.
- Mapbox geocoding, Nominatim, OSRM, Overpass, and Open-Meteo runtime services.
- Native browser APIs: Fetch, Geolocation, Device Orientation, Speech
  Synthesis, localStorage, IndexedDB, Canvas/WebGL, and DOM.

`UNKNOWN` — CDN and external API service-level objectives, quota policy, and
version-upgrade ownership are not encoded in the repository.

## Architectural findings

- `F-ARCH-001` — `VERIFIED IN REPOSITORY`: governance and README contain
  references to `app.js`, but the inventoried and loaded entrypoint is
  `app_v2.js`; contract-to-runtime traceability is stale.
- `F-ARCH-002` — `VERIFIED IN REPOSITORY`: the static application has no
  build-time dependency pinning or integrity metadata for its CDN scripts.
- `F-ARCH-003` — `INFERRED`: broad orchestration ownership in the
  entrypoint increases race, teardown, and state-consistency risk.
- `F-ARCH-004` — `VERIFIED IN REPOSITORY`: multiple public network
  services participate in a refresh/navigation workflow; partial failure is a
  first-class operating mode.

## Completed dependency and lifecycle reconciliation

`VERIFIED IN REPOSITORY` — the static import graph contains no RL, multi-agent
policy, OCR, screenshot-analysis, chat-model, PWA, Capacitor, or Android module.
Those concepts are options assessed by the audit, not latent implementation.

The most consequential runtime ownership boundaries are:

```text
app orchestration
  -> location runtime watch
  -> routing runtime watch
  -> heading sensor listeners and animation
  -> map readiness/style event lifecycle
  -> external refresh requests and caches
  -> UI image, iframe, and timer lifecycle
```

`VERIFIED IN REPOSITORY` — these owners do not share one general cancellation
and disposal contract. `INFERRED` — duplicated position streams, stale
asynchronous image/search results, and style reloads can create state divergence.
`RECOMMENDED` — define explicit owner, generation, cancellation, teardown,
freshness, and degraded-mode contracts before decomposing the entrypoint.

## Trust-boundary map

| Boundary | Data or authority crossing it | Final disposition |
|---|---|---|
| CDN scripts | executable Mapbox and LP solver code | HIGH risk; integrity/update ownership unresolved |
| public service requests | view bounds, coordinates, routes, search, weather | privacy, quota, and failure behavior unresolved |
| browser permissions | precise location and orientation | explicit-purpose and parked-use review required |
| device persistence | flags, history, aggregates, place cache | retention, migration, clear, and policy enforcement required |
| third-party place content | URLs, images, previews, provider metadata | sandboxing exists; races and provider policy remain |
| deployment workflow | token injection and published artifact | escaping and pre-deploy validation absent |
