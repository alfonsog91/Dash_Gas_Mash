# Phase F Tuning

Phase F tuning is intentionally parameterized in code and docs, not in `map_config.js` or `style.json`. Do not add Phase F runtime toggles to those files.

## Gate Contract

Runtime visuals and behavior use the existing Phase D tuning helper:

```js
isPhaseDTuningEnabled()
```

This returns true only when the Phase C aggregate lifecycle is active and tuning is requested by `?phaseD=true` or `localStorage.DGM_PHASE_D_TUNING === "true"`.

Debug exposure uses:

```js
shouldExposePhaseDDebug()
```

Do not create separate Phase F gates.

## Recommended Defaults

Use these as starting points for local experiments. Keep changes focused and commit one tuning change at a time.

| Context | gridResolution | smoothingSigma | decayWindow | cluster eps | minSamples | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Urban | 180 m | 320 m | 60 min | 280 m | 5 | Dense downtown or shopping corridor samples. |
| Suburban | 220 m | 420 m | 90 min | 440 m | 4 | Current app default for Rancho/Ontario-style coverage. |
| Rural | 360 m | 720 m | 150 min | 900 m | 3 | Sparse samples where continuity matters more than precision. |

Default field weights:

```js
{
  recentDensity: 0.52,
  historicalDensity: 0.14,
  zoneBoost: 0.24,
  travelCost: 0.10,
}
```

Engine adapter default weight:

```js
weights.opportunityField = 0.18
```

## Tuning Workflow

1. Start the server:

```powershell
python -m http.server 5173
```

2. Open the tuning URL:

```text
http://localhost:5173/?phaseD=true
```

3. Confirm the gate:

```js
window.__DGM_DEBUG.isPhaseDTuningEnabled()
```

4. Load data, open the map drawer, expand Opportunity, enable Overlay, and adjust opacity.

5. Inspect metadata:

```js
window.__DGM_DEBUG.getPhaseFOpportunityMetadata()
```

6. Keep tuning changes scoped to the relevant module or app owner.

## Parameter Guidance

### Grid Resolution

Lower values create more cells and sharper local variation. Higher values reduce rendering and recompute cost.

Do not drop mobile tuning below the urban default without re-running browser smoke and the perf guard tests.

### Smoothing Sigma

Higher values blend nearby samples into broader surfaces. Lower values make peaks more localized and can produce noisy tiles when sample support is thin.

The metadata confidence score should fall when sample support is weak or smoothing is poorly matched to grid resolution.

### Decay Window

Shorter windows favor recent aggregate samples. Longer windows keep stale aggregate support active for sparse contexts.

Only bucketed timestamps should be used. Never store raw order timestamps or payloads.

### Cluster Parameters

`eps` should roughly match the practical distance at which nearby opportunity belongs to the same zone. `minSamples` uses aggregate counts, not raw order count.

If the spatial index misses obvious cluster lookups, inspect hull metadata first. Near-colinear clusters intentionally fall back to a deterministic bounding polygon.

### Field Weights

Use small, deliberate changes:

- increase `recentDensity` for live surface responsiveness
- increase `historicalDensity` for recurring hour-of-week patterns
- increase `zoneBoost` when clustered hotspots should stand out
- increase `travelCost` when distance or drive burden should suppress far cells

## Performance Guard

The Phase F named guard effect is registered in `performance/monitor.js`:

```js
PHASE_E_PERFORMANCE_GUARD_EFFECTS.OPPORTUNITY_OVERLAY
```

When sustained mobile FPS is below 30, `evaluatePhaseEPerformanceGuard()` includes `phaseFOpportunityOverlay` in `disabledEffects`. The app checks that named effect and hides the overlay. No separate Phase F performance monitor exists.

Focused test:

```powershell
node -e "import('./tests/perf-guard.test.js').then((m) => m.runPerfGuardTests()).then((result) => { if (result.failed) process.exit(1); })"
```

## Debug Rules

Allowed debug exposure:

```js
window.__DGM_DEBUG.phaseFOpportunity
window.__DGM_DEBUG.getPhaseFOpportunityMetadata()
```

This exposure is app-owned and must stay behind `shouldExposePhaseDDebug()`.

Not allowed:

- raw order payloads
- raw order identifiers
- exact order history
- network upload of aggregate samples
- writing runtime aggregate files under `data/`

## Validation Checklist

Run the tests that match the touched files:

```powershell
node -e "import('./tests/intelligence/opportunity_core.test.js').then((m) => { const result = m.runOpportunityCoreTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/zone_clustering.test.js').then((m) => { const result = m.runZoneClusteringTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/historical_aggregates.test.js').then((m) => { const result = m.runHistoricalAggregatesTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/opportunity_field.test.js').then((m) => { const result = m.runOpportunityFieldTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/intelligence/superposition_engine.test.js').then((m) => { const result = m.runSuperpositionEngineTests(); if (result.failed) process.exit(1); })"
node -e "import('./tests/perf-guard.test.js').then((m) => m.runPerfGuardTests()).then((result) => { if (result.failed) process.exit(1); })"
```

For app/UI changes, also run:

```text
http://localhost:5173/tests/browser-smoke.html
```

Expected result: `All 8 browser smoke checks passed`.

## Rollback

Find recent Phase F commits:

```powershell
git log --oneline -8
```

Revert the focused commit:

```powershell
git revert <commit-hash>
```

If the reverted commit touched `app_v2.js` or `performance/monitor.js`, re-run browser smoke and `tests/perf-guard.test.js`.