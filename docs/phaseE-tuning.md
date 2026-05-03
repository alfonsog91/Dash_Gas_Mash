# Phase E Tuning

Phase E adds smoothing, deterministic intelligence transparency, and a mobile performance guard on top of the Phase D tuning gate.

## Performance Guard

The runtime monitor samples animation frames in the browser and keeps a rolling dashboard with:

- `averageFps`
- `averageFrameTimeMs`
- `worstFrameTimeMs`
- `frameSamples`
- `gpuMemoryMb` only when the browser or test environment exposes it

When the monitor sees sustained mobile FPS below 30, it triggers `sustained_mobile_fps_below_30` and disables non-essential visual polish:

- `phaseDColorGrading`
- `phaseDFogTuning`
- `phaseDLabelOpacity`
- `dgmTrafficStyling`

The guard logs `map.phase_e_performance_guard_triggered` with the exact reason, disabled effects, FPS, and frame-time metrics. GPU memory is included only when available.

## Debug Dashboard

When `shouldExposePhaseDDebug()` is true, inspect:

```js
window.__DGM_DEBUG.getPhaseEPerformanceDashboard()
```

The dashboard is read-only runtime state. It is exposed on localhost or when Phase D tuning is explicitly requested, matching the existing Phase D debug policy.

## Runtime Behavior

The guard is conservative and one-way for the current page session. After it trips, Phase D activation re-applies with the guard snapshot and skips or rolls back the heavy polish effects listed above.

Traffic uses the same guard snapshot. If optional DGM traffic styling is disabled, the app restores standard traffic visibility instead of adding or showing the `dgm-traffic` overlay.

## Local Verification

Run the focused test harness from the repo root:

```powershell
node -e "import('./tests/perf-guard.test.js').then(async (m) => { const result = await m.runPerfGuardTests(); if (result.failed) process.exit(1); })"
```

A full Phase C regression pass is still useful after changing guard behavior:

```powershell
node -e "import('./tests/phase-c-activation.test.js').then(async (m) => { const result = await m.runPhaseCActivationTests(); if (result.failed) process.exit(1); })"
```

## Rollback

Revert the focused perf-guard commit to remove the monitor integration and restore the prior Phase D tuning path:

```powershell
git revert <phasee/perf-guard-and-docs-commit>
```
