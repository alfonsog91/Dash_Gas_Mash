# Staged Modernization Roadmap and Approval Gate

## Checkpoint

The audit foundation identifies exact backlog IDs but authorizes no source
change. Earliest candidates are `DGM-004` for documentation traceability,
then the Wave One evidence/safety set: `DGM-001`, `DGM-002`,
`DGM-003`, `DGM-005`, `DGM-007`, `DGM-008`, `DGM-010`, and
`DGM-012`.

## Stages

### Wave Zero — audit corrections only

Backlog: `DGM-004`. Reconcile audit-proven contract and entrypoint references.
This remains documentation-only and still requires named approval if it touches
documentation outside `docs/audit/`.

### Wave One — safety, contracts, and measurement

Backlog: `DGM-001`, `DGM-002`, `DGM-003`, `DGM-005`,
`DGM-007`, `DGM-008`, `DGM-010`, `DGM-012`.
Define observable contracts, privacy/security controls, accessibility
equivalence, concurrency behavior, and performance baselines without changing
model strategy.

### Wave Two — model and optimizer evidence

Backlog: `DGM-006`, `DGM-009`, `DGM-011`, `DGM-013`,
`DGM-014`, `DGM-016`. Validate data/model provenance,
geospatial boundaries, storage lifecycle, solver/fallback semantics, regime
sensitivity, and privacy-preserving observability.

### Wave Three — simulation and platform feasibility

Backlog: `DGM-015`, `DGM-017`, `DGM-018`. Build a validated
multi-agent simulator, then separately decide whether PWA or Android packaging
serves an approved product need.

### Wave Four — AI/OCR only after governance

Backlog: `DGM-019`, `DGM-020`. Require an approved data-protection
design, explicit capture/import, redaction, provenance, confidence,
user-confirmed extraction, retention limits, and grounded-answer evaluation.

## Compute and agent-session estimates

These are planning ranges, not commitments:

| Work | Focused sessions | Compute profile |
|---|---:|---|
| complete file audit and ledger reconciliation | 3–5 | static review, low |
| execution matrix and browser evidence | 2–4 | browser/WebGL, medium |
| model/optimizer synthetic evaluation | 3–6 | repeated local simulation, medium |
| multi-agent simulator validation | 5–9 | repeated simulation, high |
| PWA/Android feasibility spike | 2–4 | browser/device matrix, medium-high |
| OCR/chat governance and prototype evaluation | 4–8 | model inference, high |

Expected documentation commits for the audit: roughly 8 to 14.
Implementation commits are intentionally not estimated until a named wave is
approved and decomposed.

## Human-approval checklist

- [ ] Audit and progress ledgers reconcile to the complete inventory.
- [ ] Deferred and unknown files/questions have explicit dispositions.
- [ ] External claims have authoritative citations and retrieval dates.
- [ ] Backlog scores and dependencies are accepted.
- [ ] A named wave and exact backlog IDs are approved in writing.
- [ ] User-visible semantics and non-goals are accepted.
- [ ] Security, privacy, accessibility, and moving-user safety gates are set.
- [ ] Test, rollback, observability, and stop conditions are accepted.
- [ ] Data sources, retention, consent, and third-party recipients are approved.
- [ ] Any new dependency receives advisory and license review.
- [ ] Main remains outside the agent's operations; review occurs by PR only.

## Approval status

`UNKNOWN` — no implementation wave has been explicitly approved. Therefore all
application-source, dependency, CI, manifest, service-worker, deployment, and
production-configuration changes remain prohibited.

## Final audit checkpoint

`VERIFIED IN REPOSITORY` — every pre-audit target file has a terminal
classification and every deterministic batch is closed. The first separately
approved implementation wave should be:

- `DGM-001` probability and uncertainty contract;
- `DGM-002` privacy and third-party threat model;
- `DGM-003` freshness and degraded-mode contract;
- `DGM-005` cancellation and last-write-wins evidence;
- `DGM-007` performance budgets;
- `DGM-008` accessible non-map equivalents;
- `DGM-010` token, CSP, and CDN integrity strategy;
- `DGM-012` moving-user safety.

`DGM-004` is a documentation-only traceability correction that
may precede that wave if separately approved. New intelligence, RL, game
theory, OCR, chat, PWA, Capacitor, or Android work is not part of the first
wave.

## Test and CI strategy

`RECOMMENDED` staged gates:

- deterministic exported test runners and JSON parse validation on every
  change;
- static source/security analysis and changed-file secret scanning;
- served browser smoke with console/network capture and Mapbox/WebGL readiness;
- accessibility automation plus keyboard, focus, zoom, contrast, motion, and
  non-map-equivalence checks;
- external-service contract fixtures, cancellation, stale-response, and
  degraded-mode tests;
- low-end mobile performance budgets before expensive effects are enabled;
- deployment only after all required gates pass, with published-artifact and
  response-header verification.

The current workflow implements none of these gates. This section is a strategy,
not a claim that CI exists.

## Feature-flag and rollback strategy

`VERIFIED IN REPOSITORY` — map feature flags, kill switches, phase activation,
performance fallback, and documented commit reversion already exist, but their
coverage and ownership are uneven.

`RECOMMENDED` for every approved implementation item:

- default new behavior off unless the approval explicitly authorizes default-on;
- one stable flag and one emergency kill switch with an owner and expiry;
- preserve old semantics until comparison gates pass;
- record flag state, build identity, reason, and non-sensitive health without
  precise location;
- define rollback triggers before release;
- verify rollback in deterministic tests and the browser matrix;
- prefer flag disablement for immediate containment and focused commit revert
  for durable rollback;
- never let fallback silently increase prescriptive authority or reduce privacy.

## Human approval state

- [x] Ledgers reconcile to the complete pre-audit target.
- [x] Every file has a terminal disposition.
- [x] External claims have a retrieval date and verification disposition.
- [x] The backlog is valid JSON with unique IDs and recomputed scores.
- [ ] The user has accepted backlog priorities and dependencies.
- [ ] The user has approved a named implementation wave and exact IDs.
- [ ] The user has approved semantics, safety, privacy, accessibility, tests,
  rollback, retention, third parties, and stop conditions.

Application implementation still requires separate explicit approval.
