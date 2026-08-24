# Functional, Mathematical, and Strategic Analysis

## High-Level Functions audit

Scores use a normalized five-part rubric: user outcome value, safety/privacy
impact, correctness risk, change leverage, and evidence gap. Each dimension is
zero to five. Priority is the arithmetic mean divided by five, yielding zero
to one. Scores are planning aids, not runtime values.

| ID | High-level function | Authority | Priority | Evidence |
|---|---|---|---:|---|
| HLF-001 | probability and explanation contract | `model.js` | 0.96 | VERIFIED IN REPOSITORY |
| HLF-002 | location, heading, route, and voice runtime | `*_runtime.js` | 0.92 | VERIFIED IN REPOSITORY |
| HLF-003 | external data acquisition and normalization | `overpass.js`, `weather.js`, `census.js` | 0.88 | VERIFIED IN REPOSITORY |
| HLF-004 | candidate selection and dispatch experiments | `optimizer.js`, `dispatch_assignment.js` | 0.86 | VERIFIED IN REPOSITORY |
| HLF-005 | map orchestration and lifecycle | `app_v2.js` | 0.84 | VERIFIED IN REPOSITORY |
| HLF-006 | opportunity/intelligence field | `intelligence/` | 0.78 | VERIFIED IN REPOSITORY |
| HLF-007 | place discovery, cache, and photos | `intelligence/place_*` | 0.74 | VERIFIED IN REPOSITORY |
| HLF-008 | activation and performance safeguards | `phase_c_*`, `performance/` | 0.68 | VERIFIED IN REPOSITORY |
| HLF-009 | visual polish and vegetation | `ui/`, `styles/` | 0.52 | VERIFIED IN REPOSITORY |

`RECOMMENDED` — promote work by evidence gap and safety/correctness leverage,
not by novelty.

## Mathematics and optimization audit

### Probability field

`VERIFIED IN REPOSITORY` — the model applies great-circle distance, exponential
distance-decay merchant/residential intensities, a competition denominator,
view-relative reference intensity, and a bounded event-probability mapping.
The displayed contract fixes a ten-minute horizon and emits low/mid/high
`pGood` values plus explanations.

Key limitations:

- `VERIFIED IN REPOSITORY` — the README states the field is calibrated relative
  to the current view and does not observe real arrivals or courier supply.
- `INFERRED` — spatial comparisons across different view bounds or parameter
  states are not exchangeable.
- `UNVERIFIED HYPOTHESIS` — the low/high band generated from intensity
  perturbation may be interpreted as a statistical confidence interval even
  though repository evidence does not establish frequentist or Bayesian
  coverage.
- `RECOMMENDED` — define calibration targets, proper scoring rules, holdout
  regimes, and reliability diagrams before calling outputs calibrated.

### Learned predictor

`VERIFIED IN REPOSITORY` — the dual-head learned path is default-off, uses
existing signals, applies beta-style calibration and uncertainty-aware
shrinkage, and preserves downstream output shape. `UNKNOWN` — no repository
training corpus, fitting pipeline, provenance record, or out-of-sample
calibration report was found in the initial inventory.

### Facility-location fallback

`VERIFIED IN REPOSITORY` — `optimizer.js` exposes parking utility, coverage
evaluation, and greedy submodular selection. The documented approximation
guarantee applies to a non-negative monotone facility-location objective under
a cardinality constraint, not automatically to every product constraint.

`UNVERIFIED HYPOTHESIS` — utility transformations, filtering, or future hard
separation constraints could invalidate monotonicity or the stated guarantee.

### MIP and dispatch

`VERIFIED IN REPOSITORY` — exact selection depends on a remotely supplied LP
solver and dispatch assignment is exported through `model.js` as an
experimental path. `INFERRED` — solver absence, infeasibility, timeout, and
numeric tolerance require explicitly equivalent user-facing fallback
semantics. `UNKNOWN` — no empirical optimality-gap or runtime-envelope dossier
is yet recorded.

## Driver Intelligence dossier

### Observed inputs

- public merchant, residential, parking, weather, traffic, place, and route
  proxies;
- current location, heading, map viewport, local time, and user-selected
  parameters;
- browser-stored map preferences, history, feature flags, and place cache.

### Produced intelligence

- relative probability field and uncertainty band;
- ranked or diversity-selected candidate hold locations;
- nearby-merchant explanation and place context;
- opportunity zones, route/heading guidance, and runtime diagnostics.

### Explicitly absent

`VERIFIED IN REPOSITORY` — actual platform demand, offers, acceptance, pay,
tips, courier supply, batching, dispatch constraints, and proprietary platform
state are absent. Consequently, DGM supports exploratory comparison, not a
claim of causal advantage or guaranteed earnings.

### Decision risks

- proxy validity and regional incompleteness;
- automation bias from map salience and precise percentages;
- stale data or partial-network failure;
- distracted-driving risk if interaction is expected while moving;
- feedback loops if many agents follow the same visible recommendation.

`RECOMMENDED` — preserve descriptive semantics, show data age and source
health, expose uncertainty provenance, and design a parked-only interaction
mode before increasing actionability.

## Game Theory and Multi-Agent analysis

`INFERRED` — DGM currently treats competition mainly as an exogenous parking
density proxy. A real delivery market is endogenous: drivers reposition,
platform dispatch changes, merchants queue, customers arrive, and congestion
responds.

| Phenomenon | DGM relevance | Audit disposition |
|---|---|---|
| congestion game | multiple drivers select the same hold zone | UNVERIFIED HYPOTHESIS |
| minority-game dynamics | less-popular zones may outperform visible hot zones | UNVERIFIED HYPOTHESIS |
| information cascade | shared recommendations can erase modeled advantage | UNVERIFIED HYPOTHESIS |
| exploration externality | one driver's observations can improve shared estimates | INFERRED |
| mechanism response | platform assignment may react to repositioned supply | UNKNOWN |
| fairness | recommendations may shift burden or access across neighborhoods | UNKNOWN |

`RECOMMENDED` — simulate heterogeneous agents, delayed/noisy observations,
capacity-constrained zones, and policy feedback before any multi-driver claim.

## RL versus OR options matrix

| Option | Best fit | Data need | Explainability | Safety/control | Disposition |
|---|---|---|---|---|---|
| deterministic scoring + OR | transparent current-state selection | low | high | high | RECOMMENDED baseline |
| stochastic/robust OR | uncertain travel, demand, and service failures | moderate | high | high | RECOMMENDED next |
| contextual bandit | bounded online comparison without long horizons | logged outcomes | medium | medium | DEFERRED pending data |
| offline RL | sequential reposition policy | large, representative trajectories | low-medium | difficult | DEFERRED |
| multi-agent RL | endogenous strategic response | validated simulator | low | difficult | REJECTED for near-term runtime |
| hybrid predict-then-optimize | learned estimates with explicit constraints | labeled outcomes | medium-high | high | RECOMMENDED after validation |

## AI chat, OCR, and screenshot-analysis architecture

No chat, OCR, or screenshot model is present in the baseline inventory:
`VERIFIED IN REPOSITORY`.

`RECOMMENDED` architecture if approved later:

```text
explicit user capture/import
  -> on-device redaction and crop
  -> consent + purpose/retention declaration
  -> OCR adapter with confidence and provenance
  -> schema validation and contradiction checks
  -> non-authoritative explanation layer
  -> user confirmation before any DGM state import
  -> immediate deletion or explicit bounded retention
```

Hard gates: no background capture, no credential/notification extraction, no
silent location linkage, no training reuse without separate consent, no chat
claim unsupported by source evidence, and no direct OCR-to-navigation action.

## PWA, Capacitor, and Android feasibility

- `VERIFIED IN REPOSITORY` — no web app manifest or service worker exists.
- `INFERRED` — the app is not currently installable/offline as a complete PWA.
- `INFERRED` — basic Capacitor wrapping is feasible because the UI is a static
  web application, but it would not by itself solve network, permission,
  lifecycle, WebGL, background-location, or privacy requirements.
- `RECOMMENDED` — validate responsive/WebView rendering, Mapbox terms and token
  restrictions, geolocation/orientation permission flows, route speech,
  external navigation intents, storage migration, offline failure behavior,
  and Android accessibility before choosing a wrapper.
- `DEFERRED` — background location, telemetry upload, and Play Store deployment
  until purpose, retention, disclosure, and safety reviews are approved.
