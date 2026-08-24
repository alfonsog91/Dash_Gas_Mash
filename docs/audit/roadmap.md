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

Expected documentation commits for the audit: roughly eight to fourteen.
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
