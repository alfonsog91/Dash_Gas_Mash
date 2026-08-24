# Quality Baselines and Experimentation Plan

## Security baseline

- `VERIFIED IN REPOSITORY` — the browser directly calls multiple third-party
  services and loads two executable CDN dependencies.
- `VERIFIED IN REPOSITORY` — the Pages workflow injects a Mapbox token at
  deployment; the baseline HTML also contains a public client token.
- `VERIFIED IN REPOSITORY` — place-card code contains explicit
  `noopener`/`noreferrer` and sandbox planning.
- `RECOMMENDED` — document client-token scope and origin restrictions, add a
  Content Security Policy design, pin third-party versions with an update
  owner, review URL construction and response validation, and threat-model
  storage and debug surfaces.
- `UNKNOWN` — deployed response headers, token restrictions, rate limits, and
  third-party incident handling.

## Privacy baseline

- `VERIFIED IN REPOSITORY` — location, heading, route queries, search queries,
  preferences, place history, and place cache can be processed or retained.
- `INFERRED` — route/geocoding/search providers can receive location-linked
  requests; the repository has no consolidated data inventory or retention
  notice.
- `RECOMMENDED` — minimize precision, make each network recipient visible,
  bound and clear persisted data, avoid telemetry payloads containing precise
  location, and add a user-accessible privacy control surface.

## Performance baseline

- `VERIFIED IN REPOSITORY` — the application contains performance heuristics,
  a monitor, browser smoke checks, and a performance guard test.
- `INFERRED` — grid generation, repeated distance calculations, map-layer
  updates, clustering, imagery, and the large entrypoint dominate CPU/memory
  risk.
- `RECOMMENDED` — measure cold start, interaction latency, refresh latency,
  grid compute time, route update time, memory high-water mark, network bytes,
  and frame stability on low/mid/high mobile profiles.
- `UNKNOWN` — committed budgets and reproducible benchmark results.

## Reliability baseline

- `VERIFIED IN REPOSITORY` — Overpass has multiple endpoints; runtime-ready,
  activation rollback, route/location tests, and smoke diagnostics exist.
- `INFERRED` — correctness under simultaneous stale cache, denied permission,
  partial API failure, map-style reload, and rapid repeated refresh is not
  proven by the initial evidence.
- `RECOMMENDED` — formalize state machines, cancellation/last-write-wins rules,
  freshness metadata, idempotent teardown, retry budgets, and degraded-mode
  contracts.

## Accessibility baseline

- `VERIFIED IN REPOSITORY` — semantic controls and some ARIA text exist in the
  HTML/UI sources.
- `UNVERIFIED HYPOTHESIS` — map-only results, dynamic status, popups, focus
  restoration, color encoding, touch targets, and voice/heading interactions
  may not provide equivalent nonvisual and keyboard operation.
- `RECOMMENDED` — audit against WCAG 2.2 AA: keyboard sequence,
  accessible names, live regions, modal/popup focus, contrast, zoom/reflow,
  reduced motion, target size, error identification, and a text alternative to
  every ranked spatial result.

## Security and privacy threat scenarios

| Scenario | Existing boundary | Verification needed |
|---|---|---|
| malicious/compromised CDN | remote scripts execute in origin | CSP/SRI and dependency strategy |
| exposed unrestricted map token | client token is public by design | provider-side restriction evidence |
| precise-location leakage | third-party fetches | endpoint-by-endpoint payload review |
| persistent shared-device history | local/IndexedDB storage | retention, clear, and private-mode behavior |
| untrusted place content | cards, links, images, previews | sanitization and navigation tests |
| debug data exposure | global debug/runtime objects | production gating and payload review |

## Simulation and experimentation plan

### Ground rules

No experiment may imply platform internals. Separate descriptive proxy
evaluation from driver-outcome evaluation. Pre-register hypotheses, metrics,
regimes, stopping rules, exclusions, and rollback conditions.

### Layered plan

| Stage | Environment | Purpose | Gate |
|---|---|---|---|
| S-0 | deterministic unit fixtures | invariants, bounds, malformed inputs | all invariant checks pass |
| S-1 | synthetic spatial fields | sensitivity, calibration, ranking stability | known ground truth recovered |
| S-2 | replay of public snapshots | reproducibility and service degradation | bounded drift and failure behavior |
| S-3 | agent-based simulator | congestion and policy feedback | validated against declared stylized facts |
| S-4 | shadow-only field logging | latency, freshness, recommendation stability | privacy and consent approval |
| S-5 | user-controlled prospective study | usefulness without automation | ethics/safety and statistical plan approval |

### Synthetic scenario matrix

- sparse/dense merchants and housing;
- edge-of-viewport clusters and dateline/polar coordinate stress;
- closed/unknown opening hours;
- rain extremes and missing weather;
- no parking, duplicated POIs, invalid coordinates, and outliers;
- solver absent/infeasible/slow;
- denied/intermittent location and heading;
- slow, reordered, stale, malformed, and failed network responses;
- one, many, homogeneous, and heterogeneous simulated drivers.

### Metrics

Model: Brier score, log loss, calibration error, rank correlation, top-set
stability, uncertainty coverage only when statistically defined. Optimizer:
objective value, optimality gap where computable, constraint violations,
selection churn, runtime. Runtime: task latency, cancellation correctness,
degraded-mode success, memory, frames, network. Human factors: comprehension,
appropriate reliance, accessibility completion, interaction while stationary.

### Stop conditions

Stop on privacy-policy violation, unsafe moving interaction, unbounded storage,
material calibration deterioration, unexplained subgroup/regional disparity,
constraint violation, or a failure mode that presents stale output as current.
