# Repository Inventory and Coverage

## Baseline

- `VERIFIED IN REPOSITORY` — branch `copilot/branch-safety`.
- `VERIFIED IN REPOSITORY` — the working tree was clean at audit start.
- `VERIFIED IN REPOSITORY` — deterministic inventory: 101 files,
  excluding `.git/` and the prohibited `.github/agents/` path.

## Language and asset inventory

| Kind | Count |
|---|---:|
| JavaScript | 65 |
| Markdown | 14 |
| HTML | 12 |
| JSON | 2 |
| CSS | 2 |
| PNG | 2 |
| YAML | 1 |
| PowerShell | 1 |
| Git/support | 2 |
| **Total** | **101** |

`VERIFIED IN REPOSITORY` — no package manifest, lockfile, web app manifest, or
service worker appears in the baseline inventory.

## Areas

| Area | Role |
|---|---|
| root | entrypoint, scoring, dispatch, optimization, geospatial, and runtimes |
| `intelligence/` | opportunity, place, cache, vegetation, and clustering |
| `ui/` | dynamic map interface components |
| `performance/` | runtime performance guard |
| `tests/` | browser harnesses and module tests |
| `data/` | bounded Census tract slice |
| `assets/` | binary sprites |
| `styles/` | component presentation |
| `docs/` | governance and phase records |
| `.github/` | prompts and Pages deployment workflow |

## Deterministic batches

Files are assigned once and reviewed lexicographically within each batch.

| Batch | Scope |
|---|---|
| B-01 | foundation and entrypoint |
| B-02 | model, predictor, optimizer, dispatch, scoring |
| B-03 | map, location, heading, routing, interaction |
| B-04 | intelligence core and clustering |
| B-05 | places, cache, photos, providers, search |
| B-06 | UI, vegetation, vehicle, and styles |
| B-07 | external data adapters, data, and assets |
| B-08 | activation, traffic, performance, readiness |
| B-09 | module and preservation tests |
| B-10 | intelligence tests |
| B-11 | browser harnesses and HTML tests |
| B-12 | remaining docs, workflow, prompts, support |

## Coverage rule

Coverage is reviewed inventory files divided by 101. A file becomes
reviewed only when its batch records a disposition and evidence-backed
observation. Execution strengthens evidence but does not replace source review.
Binary assets may be dispositioned through metadata and consumer review.

The live counters in `progress-ledger.json` are authoritative. Complete
coverage is not claimed while any batch is open, undocumented, or unreconciled
against the baseline.
