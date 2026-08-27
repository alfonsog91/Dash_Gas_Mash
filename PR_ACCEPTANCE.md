# Work Order 6 Acceptance

Branch: `agent/task-1787807004-wo6`

Stack base: `agent/task-1787807004-wo5` (WO-5 draft PR #25)

## Scope

- Select Mapbox GL JS v2 or v3 before map initialization, never both.
- Preserve v2.15.0 as the default and expose v3.15.0 as experimental.
- Support `window.DASH_FLAGS.mapboxV3` and the `mapboxV3` query parameter.
- Inventory browser query-version dependency edges and generate a migration
  cost report with source locations.

## Acceptance evidence

- [x] Flag absent or false selects only the pinned v2.15.0 CSS/JS pair.
- [x] Window flag or query true selects only the v3.15.0 CSS/JS pair.
- [x] Explicit query false overrides a true window flag for rollback.
- [x] `index.html` contains no direct Mapbox v2/v3 asset or app module tag.
- [x] The app module imports only after both selected Mapbox CSS and JS load.
- [x] A selected stylesheet failure rejects before the app imports.
- [x] Browser default path rendered one nonzero canvas with v2.15.0, no fatal
  overlay, and no captured app/page/unhandled errors.
- [x] Browser experimental path rendered one nonzero canvas with v3.15.0, no
  fatal overlay, and no captured app/page/unhandled errors.
- [x] Repository browser smoke passed 11/11 checks on both v2 and v3 paths.
- [x] Both selected CDN script and stylesheet URLs returned HTTP 200.
- [x] Migration estimator reports 42 query-version occurrences across 11 files
  with one-based line/column locations.
- [x] Migration discovery uses Git-tracked text files, so untracked local files
  cannot alter the report.
- [x] Generated `docs/migration_cost.md` exactly matches a fresh scan.
- [x] Aggregator baseline increased visibly from 233 to 242 PASS lines.
- [x] Clean aggregator run observed 242 PASS lines, 0 FAIL lines, and exit 0.

## Risk and rollback

The v3 path is experimental and opt-in. Default users retain v2.15.0. Rollback
is setting `mapboxV3=false` or reverting the focused WO-6 commit. Browser smoke
covered current runtime behavior, but device-specific Mapbox v3 behavior remains
outside this spike.
