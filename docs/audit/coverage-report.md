# Repository Inventory and Coverage

## Final status

`VERIFIED IN REPOSITORY` — the deterministic static audit is complete on
`copilot/branch-safety`, with behavioral and environment blind spots retained
explicitly. Audit completion means every pre-audit target file has a terminal
classification; it does not mean every runtime path was executed.

## Reconciled inventory

| Measure | Count |
|---|---:|
| Current tracked files, including audit artifacts | 111 |
| Pre-audit target files | 101 |
| `docs/audit/` artifact files | 10 |
| Relevant source files | 81 |
| Fully reviewed relevant source files | 44 |
| Partially reviewed relevant source files | 37 |
| Relevant source lines | 32132 |
| Statically reviewed source lines | 32132 |
| Terminal file coverage | 100% |
| Static source-line accounting | 100% |
| Fully reviewed relevant-file share | 54.32% |

Relevant source is the tracked JavaScript, HTML, CSS, PowerShell, and workflow
YAML in the pre-audit target. Markdown, exported data/style JSON, and binary
sprites are separately dispositioned and are not part of the source-line
denominator.

`PARTIALLY REVIEWED` is terminal here: the source was statically accounted for,
but browser or environment-dependent execution remains incomplete. Therefore
the one-hundred-percent static line figure is not a claim of complete
behavioral, branch, statement, integration, deployed, or empirical coverage.

## Terminal classifications

| Classification | Files | Meaning in this audit |
|---|---:|---|
| FULLY REVIEWED | 58 | Static review completed |
| PARTIALLY REVIEWED | 37 | Static review completed; browser/environment behavior remains |
| INVENTORIED ONLY | 3 | Prompts and bounded data inventoried |
| EXCLUDED | 0 | No target file excluded |
| GENERATED | 1 | Exported Mapbox style |
| VENDOR | 0 | No vendored source |
| BINARY | 2 | PNG metadata and consumers reviewed |
| UNKNOWN | 0 | No target file lacks a disposition |
| **Pre-audit target** | **101** | |

The prohibited `.github/agents/` path was neither accessed nor counted. It is a
scope exclusion outside the reconciled target, not a classified target file.

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
| **Pre-audit target** | **101** |

`VERIFIED IN REPOSITORY` — no package manifest, lockfile, web app manifest, or
service worker exists.

## Deterministic batches

| Batch | Scope | Files | Terminal status |
|---|---|---:|---|
| B-01 | foundation and entrypoint | 8 | COMPLETE |
| B-02 | model, predictor, optimizer, dispatch, scoring | 5 | COMPLETE |
| B-03 | map, location, heading, routing, interaction | 9 | COMPLETE |
| B-04 | intelligence core and clustering | 5 | COMPLETE |
| B-05 | places, cache, photos, providers, search | 5 | COMPLETE |
| B-06 | UI, vegetation, vehicle, and styles | 7 | COMPLETE |
| B-07 | external adapters, data, generated style, assets | 7 | COMPLETE |
| B-08 | activation, performance, readiness, diagram | 6 | COMPLETE |
| B-09 | module and preservation tests | 12 | COMPLETE |
| B-10 | intelligence tests | 13 | COMPLETE |
| B-11 | browser harnesses and HTML wrappers | 12 | COMPLETE |
| B-12 | remaining docs, workflow, prompts, support | 12 | COMPLETE |

The per-file authority is `audit-ledger.json`; checkpoint history and cumulative
counts are in `progress-ledger.json`.

## Remaining blind spots

- `UNKNOWN` — browser smoke, WebGL, Mapbox rendering, remote services,
  permissions, orientation sensors, speech, focus, and responsive behavior were
  not executed.
- `UNKNOWN` — deployed headers, provider-side token restrictions, quotas,
  incident handling, and external-service reliability.
- `UNKNOWN` — representative low-end mobile, PWA, Capacitor, and Android
  behavior.
- `UNKNOWN` — observed platform outcomes, probability calibration, uncertainty
  coverage, causal benefit, optimizer gaps, and regional generalization.
- `UNKNOWN` — exported-style regeneration provenance and useful pre-graft
  per-file history.

## Change-scope reconciliation

`VERIFIED IN REPOSITORY` — this continuation changed only files under
`docs/audit/`. No application source, dependency, workflow, manifest, service
worker, runtime, or mathematical behavior was changed.

No changed file outside `docs/audit/` was created by this continuation. If an
outside-scope difference is observed relative to another branch or an older
baseline, its origin is pre-existing or unknown and is not represented as
audit-created without independent history evidence.
