# Work Order 2 Acceptance

Branch: `agent/task-1787807004-wo2`

Stack base: `agent/task-1787807004` (WO-1 draft PR #21)

## Scope

The authoritative `origin/main` audit backlog and ledger identify DGM-009 as
the malformed geospatial input matrix. This Node-only slice fixes:

- `F-GEO-002`: boolean and blank coordinates were coerced to zero.
- `F-TIME-002`: numeric HHMM values accepted minutes above 59.
- `F-NET-001`: successful malformed Overpass JSON bypassed validation.

## Acceptance evidence

- [x] Each defect had a failing characterization before its fix.
- [x] Characterizations use exported Node runners and no browser or network.
- [x] Coordinate normalization accepts finite numbers and numeric strings while
  rejecting booleans, blanks, arrays, and objects.
- [x] Numeric HHMM normalization rejects invalid hours and minutes.
- [x] Overpass requires an `elements` array before extraction or caching.
- [x] Aggregator baseline increased visibly from 215 to 218 PASS lines.
- [x] Clean aggregator run observed 218 PASS lines, 0 FAIL lines, and exit 0.
- [x] A temporary `F-GEO-002` reintroduction produced 217 PASS lines, 1 FAIL
  line, and exit 1; the probe was restored before commit.

## Risk and rollback

Risk is limited to stricter rejection of malformed provider values. Existing
valid numeric strings, coordinates, HHMM values, and Overpass responses retain
their prior shape. Rollback is a revert of the focused WO-2 commit.
