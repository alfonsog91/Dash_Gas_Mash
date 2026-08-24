# DGM Audit

**Status:** audit in progress  
**Evidence cutoff:** August 24, 2026  
**Baseline:** active branch `copilot/branch-safety` at the commit reported in the
session checkpoint

This directory is the documentation-only audit record. It does not authorize
runtime changes. Application source remains behind the explicit named-wave
approval gate.

## Artifacts

- `audit-ledger.json` — batch evidence and findings.
- `progress-ledger.json` — continuation point and live coverage.
- `coverage-report.md` — repository inventory and coverage method.
- `architecture.md` — component, dependency, runtime, and data-flow maps.
- `analysis.md` — functions, mathematics, optimization, Driver Intelligence,
  game theory, multi-agent, RL/OR, AI/OCR, and platform analysis.
- `baselines.md` — quality baselines and experiment design.
- `external-research.md` — authoritative public-source dossier.
- `top-20-backlog.json` — normalized top-twenty backlog.
- `roadmap.md` — staged roadmap, estimates, checkpoint, and approval list.

## Evidence labels

`VERIFIED IN REPOSITORY`, `VERIFIED BY EXECUTION`, `VERIFIED EXTERNALLY`,
`INFERRED`, `RECOMMENDED`, `UNKNOWN`, `DEFERRED`, `REJECTED`, and
`UNVERIFIED HYPOTHESIS`.

## Guardrails

- Main remains untouched.
- No application, dependency, lockfile, CI, manifest, service-worker,
  deployment, or production-configuration change is authorized.
- Coverage advances only when the ledgers record evidence.
- No implementation wave may begin without explicit human approval.
