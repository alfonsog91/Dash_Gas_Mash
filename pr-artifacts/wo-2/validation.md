# Work Order 2 Validation

Date: 2026-08-26

Stack base: `457e853c1a736937b08cc54c97d3359fff84c875`

## Audit selection

The defect source is `docs/audit/top-20-backlog.json` and
`docs/audit/audit-ledger.json` at `origin/main`. Those files are a documentation
descendant of the current `main-agent` base and were read without importing
`origin/main` code.

Selected under DGM-009:

| Finding | Audit evidence | Node reproduction |
| --- | --- | --- |
| `F-GEO-002` | VERIFIED IN REPOSITORY | malformed coordinate runner |
| `F-TIME-002` | VERIFIED BY EXECUTION | place-model hours runner |
| `F-NET-001` | VERIFIED BY EXECUTION | mocked Overpass fetch runner |

Lifecycle finding DGM-005 is reserved for WO-3. Browser, device, security
policy, calibration, and optimizer-contract findings are outside this Node-only
defect slice. No mathematical behavior is changed.

## Characterization results

Before each implementation fix:

```text
F-GEO-002: 5 passed, 1 failed, exit 1
F-TIME-002: 10 passed, 1 failed, exit 1
F-NET-001: 0 passed, 1 failed, exit 1
```

After each implementation fix:

```text
Coordinate runner: 6 passed, 0 failed
Place-model runner: 11 passed, 0 failed
Overpass runner: 1 passed, 0 failed
```

## Aggregator

Command: `node eng/run_all_tests.mjs`

```text
Test summary: PASS 218, FAIL 0
Recorded baseline: PASS 218
Exit: 0
```

A temporary reintroduction of `F-GEO-002` produced:

```text
FAIL rejects booleans and blank coordinate strings: boolean latitude rejected
Test summary: PASS 217, FAIL 1
Recorded baseline: PASS 218
Exit: 1
```

The temporary change was restored before commit, and the clean aggregator then
returned to 218 PASS lines and exit 0.
