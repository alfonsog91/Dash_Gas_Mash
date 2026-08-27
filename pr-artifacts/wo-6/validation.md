# Work Order 6 Validation

Date: 2026-08-26

Stack base: `3ee343f6f541b46c85a40957dae1769469b84e4c`

## Flag contract

Default path:

```text
window.DASH_FLAGS.mapboxV3: absent or false
query mapboxV3: absent or false
selected build: Mapbox GL JS 2.15.0
experimental: false
```

Experimental path:

```text
window.DASH_FLAGS.mapboxV3: true
or query mapboxV3=true
selected build: Mapbox GL JS 3.15.0
experimental: true
```

When both sources are present, the explicit query value wins. The bootstrap
injects one stylesheet and one script for the selected major, waits for both,
verifies `window.mapboxgl`, and then imports `app_v2.js`. A stylesheet or script
failure rejects before app import and reaches the bootstrap fatal path.

## CDN probe

PowerShell `Invoke-WebRequest -Method Head` returned HTTP 200 for:

```text
https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css
https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js
https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.js
https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.css
```

## Browser validation

Local server: `http://localhost:5173`

Default/off path:

```text
runtime build: v2 / 2.15.0 / experimental false
loaded Mapbox resources: v2.15.0 CSS and v2.15.0 JS only
canvas count: 1
canvas size: 677.33 x 656 CSS pixels
fatal overlays: 0
captured console/page/unhandled errors: 0
browser smoke: 11 passed, 0 failed
```

Experimental/on path:

```text
runtime build: v3 / 3.15.0 / experimental true
loaded Mapbox resources: v3.15.0 CSS and v3.15.0 JS only
canvas count: 1
canvas size: 677.33 x 656 CSS pixels
fatal overlays: 0
captured console/page/unhandled errors: 0
browser smoke: 11 passed, 0 failed
```

Rendered screenshots were visually inspected for both paths. Both showed the
same loaded Rancho/Ontario map framing. No browser/device equivalence beyond the
recorded checks is claimed.

## Migration estimator

Command: `node eng/estimate_migration_cost.mjs`

```text
Wrote docs/migration_cost.md with 42 occurrences across 11 files.
```

The migration runner verifies every occurrence has a file and one-based line
location and that the checked-in report is byte-for-byte current. Discovery is
limited to `git ls-files`; a self-cleaning untracked Markdown probe does not
change the inventory.

## Node validation

```text
Mapbox bootstrap runner: 6 passed, 0 failed
Migration-cost runner: 3 passed, 0 failed
Test summary: PASS 242, FAIL 0
Recorded baseline: PASS 242
Exit: 0
```

An independent staged-diff review identified missing CSS readiness gating and
untracked-file-dependent migration counts. Both were characterized failing,
fixed, and included in the runner totals above before commit.
