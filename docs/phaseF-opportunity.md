# Phase F Opportunity Field

Date: 2026-05-30
Branch: `feature/upgrade-all-aggressive`

Phase F adds a deterministic, privacy-safe spatial intelligence layer that can feed UI overlays and the pure superposition engine. Runtime visibility stays behind the existing Phase D tuning contract: Phase C aggregate activation must be active, and either `?phaseD=true` or `localStorage.DGM_PHASE_D_TUNING === "true"` must request tuning.

## Modules

Executable Phase F spatial code lives under `intelligence/`:

- `intelligence/opportunity_core.js`: creates an Opportunity Grid from aggregated point samples.
- `intelligence/zone_clustering.js`: groups nearby aggregate samples into deterministic zones.
- `intelligence/historical_aggregates.js`: stores hour-of-week aggregate counts and EV summaries in memory by default.
- `intelligence/opportunity_field.js`: combines grid, historical, zone, and travel-cost terms into one surface.

The app/UI owner remains `app_v2.js`. It owns rendering, throttling, opacity, the collapsed Opportunity control, and `window.__DGM_DEBUG` exposure.

## Opportunity Grid

API:

```js
generateOpportunityGrid(samples, { gridResolution, smoothingSigma, decayWindow })
```

Inputs must be aggregated point samples, not raw orders. Supported fields include `lat`, `lng` or `lon`, `count` or `sampleCount`, `aggregateEV` or `avgEV`, and bucketed timestamps. The generator projects samples to a local meter grid, applies Gaussian smoothing and exponential decay, and normalizes cell values to a deterministic 0..1 range.

Metadata includes:

- `gridResolution`
- `smoothingSigma`
- `sampleCount`
- `timestamp`
- `heuristicConfidenceScore`

## Zone Clustering

API:

```js
clusterOpportunityZones(samples, { eps, minSamples })
queryZoneClusterIndex(spatialIndex, { lat, lng })
```

The clustering module uses a DBSCAN-style weighted neighborhood pass over aggregate samples. `eps` is measured in meters and `minSamples` uses aggregate sample counts. Cluster hull output is polygon-like and stable: convex hulls are used when adequate, with a deterministic small bounding polygon for near-colinear clusters.

Each cluster exposes:

- `polygon`
- `centroid`
- `stats.sampleCount`
- `stats.avgEV`
- `stats.peakHour`

The spatial index is serializable and uses meter buckets for cluster lookup.

## Historical Aggregates

API:

```js
const cache = createHistoricalAggregateCache({ retentionWeeks });
cache.ingest(samples);
cache.queryZoneDensity(zoneId, { hourOfWeek });
cache.queryGridCellDensity(cellId, { hourOfWeek });
cache.enforceRetentionPolicy({ now });
cache.serialize();
deserializeHistoricalAggregateCache(serialized);
```

The cache stores only privacy-safe aggregates:

- counts
- aggregate EV
- hour-of-week buckets
- bucketed timestamps for retention

It does not store raw order identifiers, raw payloads, exact order history, network data, or repo-local runtime files. Browser-local persistence is optional through serialization; the default is in-memory.

## Opportunity Field

API:

```js
generateOpportunityField(samples, {
  gridResolution,
  smoothingSigma,
  decayWindow,
  historicalAggregates,
  clusters,
  weights,
  travelCostProvider,
})
```

Scoring formula:

```text
opportunity = w1 * recentDensity + w2 * historicalDensity + w3 * zoneBoost - w4 * travelCost
```

Weights can be supplied as `w1` to `w4` or as named keys: `recentDensity`, `historicalDensity`, `zoneBoost`, and `travelCost`.

Metadata includes:

- `weights`
- `gridResolution`
- `smoothingSigma`
- `sampleCount`
- `timestamp`
- `heuristicConfidenceScore`

## Engine Adapter

`intelligence/superposition_engine.js` remains pure and deterministic. It accepts optional `opportunityField` input and maps the nearest deterministic field cell to an `opportunityFieldScore`. That score nudges `futureEV` using `weights.opportunityField` and returns per-candidate metadata:

- `opportunityField.applied`
- `opportunityField.score`
- `opportunityField.cellId`
- `opportunityField.distanceMeters`
- `opportunityField.source`
- `opportunityField.appliedWeight`
- `opportunityField.candidateFieldCount`

When no Opportunity Field input is supplied, legacy scoring output is unchanged.

## Runtime Integration

`app_v2.js` adds a hidden `opportunity-field` GeoJSON source and `opportunity-field-layer` fill layer. The layer is empty and hidden unless Phase D tuning is enabled and the Opportunity overlay checkbox is enabled.

The collapsed Opportunity control lives inside the existing map drawer and provides:

- overlay toggle
- opacity slider
- Opportunity details status

Expensive field recompute is throttled and only runs when the overlay is enabled. Opacity changes reuse the latest field and only update rendered feature opacity.

## Perf Guard Wiring

`performance/monitor.js` registers the named Phase F effect:

```js
PHASE_E_PERFORMANCE_GUARD_EFFECTS.OPPORTUNITY_OVERLAY === "phaseFOpportunityOverlay"
```

When sustained mobile FPS drops below 30, the existing Phase E guard includes this effect in `disabledEffects`. `app_v2.js` checks the existing monitor snapshot through `isPhaseEPerformanceEffectDisabled()` and hides the Opportunity overlay when the guard disables it.

## Debug Exposure

Only the app/UI layer exposes Phase F metadata to `window.__DGM_DEBUG`, and only when `shouldExposePhaseDDebug()` is true.

Useful checks:

```js
window.__DGM_DEBUG.isPhaseDTuningEnabled()
window.__DGM_DEBUG.getPhaseFOpportunityMetadata()
window.__DGM_DEBUG.phaseFOpportunity
```

Localhost may expose debug helpers, but localhost alone does not enable tuning.

## Local Validation

Run focused unit tests from the repo root:

```powershell
node -e "import('./tests/intelligence/opportunity_core.test.js').then((m) => { const result = m.runOpportunityCoreTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/zone_clustering.test.js').then((m) => { const result = m.runZoneClusteringTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/historical_aggregates.test.js').then((m) => { const result = m.runHistoricalAggregatesTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/opportunity_field.test.js').then((m) => { const result = m.runOpportunityFieldTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/superposition_engine.test.js').then((m) => { const result = m.runSuperpositionEngineTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/perf-guard.test.js').then((m) => m.runPerfGuardTests()).then((result) => { if (result.failed) process.exit(1); })"
```

Browser smoke:

```powershell
python -m http.server 5173
```

Then open:

```text
http://localhost:5173/tests/browser-smoke.html
http://localhost:5173/?phaseD=true
```

Expected browser checks:

- browser smoke reports `All 8 browser smoke checks passed`
- without Phase D tuning, the Opportunity control is hidden
- with Phase D tuning active, the control appears collapsed
- enabling the overlay shows `opportunity-field-layer`
- moving the opacity slider changes overlay opacity without a full recompute
- `window.__DGM_DEBUG.getPhaseFOpportunityMetadata()` returns metadata only through the existing debug gate

## Rollback

Each Phase F commit is focused. Find the target hash:

```powershell
git log --oneline -8
```

Revert one focused commit:

```powershell
git revert <commit-hash>
```

After rollback, re-run the focused tests for the reverted area and the browser smoke harness when app code changed.