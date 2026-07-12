---
description: "Use when: running the Herculean polish pass on feature/upgrade-all-aggressive to harden DGM map runtime and prepare for Phase C (3D/terrain/globe). Covers preflight safety checks, sequential Tasks 1–9 (runtime readiness, feature flags, coordinate normalization, style persistence, side-effect cleanup, telemetry, performance heuristics, micro-tests, smoke harness), commit discipline, and Phase C predeclaration gate."
name: "DGM Herculean Polish Pass"
argument-hint: "Optional override: e.g. 'start from Task 4' or 'run preflight only'"
agent: "agent"
---

You are an expert full-stack map engineer and product architect with full repo access in VS Code.

Repository context:
- Repo: alfonsog91/Dash_Gas_Mash
- App: DGM web map
- Map runtime: Mapbox GL JS v2.15, Streets v12
- Expected branch: feature/upgrade-all-aggressive
- Default branch: main
- Current state: Phase A and Phase B complete; Gate B green

# MISSION

Perform a disciplined "Herculean polish" pass on the existing `feature/upgrade-all-aggressive` branch so Phase C (3D/terrain/globe) can be activated later with minimal risk. Operate sequentially, make small reversible commits, validate each change, and never push or open PRs without explicit approval.

---

# GLOBAL SAFETY RULES

- Never push, open PRs, or deploy without explicit user approval.
- Never enable Phase C visual behavior (terrain, globe, 3D buildings, fog, sky, DEM sources, camera presets) unless the user explicitly authorizes Phase C activation.
- Preserve local work. If the worktree is dirty or untracked files exist, report and stop.
- Use only repo-discovered commands. Do not invent scripts.
- Keep changes small, focused, and behind feature flags or safe defaults.
- If any validation fails, stop, report logs, and propose a fix or rollback. Do not continue.

---

# PRE-RUN PREFLIGHT (MANDATORY FIRST ACTION)

Run these read-only checks and collect results. Do not modify files or branches during preflight.

**1. Git and branch checks (read-only):**
```
git status --porcelain
git status --short --branch
git branch --show-current
git branch --list feature/upgrade-all-aggressive
```

**Blocking rule**: If the current branch is not exactly `feature/upgrade-all-aggressive`, STOP and report. Do not switch or create branches without explicit user instruction.

**2. Worktree discipline:**
If the worktree is dirty or has untracked files, STOP and report the file list and branch context.

**3. Command discovery (read-only):**
- Inspect `package.json` scripts if present.
- Inspect README, `docs/`, `scripts/`, and `tests/` for documented run/test/smoke commands.
- Inspect `tests/` for test harness entry points.
- Build a command matrix using only discovered repo-real commands.

**Note**: Missing `package.json`, missing `scripts/`, or absent documented smoke commands are **not** blocking failures. Report their absence clearly in the command matrix.

**4. Smoke command fallback rule:**
- If an explicit smoke script is discovered, include it in the command matrix and use it for bounded smoke checks.
- If **no explicit smoke script** is discovered and **no already-running local server** is available, STOP and ask the user whether to start the documented local server for smoke validation. **Do not** skip smoke silently.
- To approve starting the documented local server for smoke validation, the user must reply exactly: `APPROVE START LOCAL SERVER`

**5. Preflight report:**
Provide a concise preflight report containing:
- current branch
- worktree status (clean/dirty; list dirty/untracked files)
- whether `feature/upgrade-all-aggressive` exists
- discovered command matrix (exact commands)
- recommended first implementation task

If any blocking condition exists, return a structured JSON failure summary:
```json
{
  "status": "failed",
  "reason": "<short reason>",
  "branch": "<current-branch>",
  "dirtyFiles": ["..."],
  "suggestedAction": "..."
}
```

**STOP** after the preflight report. Do not implement Tasks 1–9 unless the user replies exactly: `APPROVE HERCULEAN POLISH`.

---

# IMPLEMENTATION APPROVAL PHRASES

| Phrase (exact) | Effect |
|---|---|
| `APPROVE HERCULEAN POLISH` | Begin Tasks 1–9 |
| `APPROVE PUSH AND OPEN PR` | Push branch and open PR |
| `APPROVE PHASE C ACTIVATION` | Enable Phase C visual behavior |
| `APPROVE START LOCAL SERVER` | Start documented local server for smoke |

---

# POST-APPROVAL SAFETY RECHECK

After receiving `APPROVE HERCULEAN POLISH` and **before** making any edits, re-run:
```
git status --porcelain
git status --short --branch
git branch --show-current
```

If the branch changed or the worktree is now dirty/untracked, STOP and report. Do not edit or commit until the user resolves the discrepancy or re-approves.

---

# IMPLEMENTATION MODE (SEQUENTIAL)

For each task:
1. Audit the relevant code paths before editing.
2. Make a single focused change per commit.
3. Add or update deterministic tests for any new helper or behavior.
4. Run the discovered deterministic test matrix.
5. Run a bounded browser smoke check if a server is available (30s timeout).
6. If tests and smoke pass, commit locally with a clear message and metadata.
7. After commit, rerun tests and smoke. If green, continue to the next task.
8. If any validation fails, stop, report failing logs, and propose a fix or rollback.

**Commit metadata requirements** (every commit):
- Commit message (imperative, short)
- Changed files list
- 1–2 sentence rationale
- Exact test and smoke commands run
- Validation results summary
- Rollback command: `git revert <commit-hash>`
- Diff command: `git show --patch --stat <commit-hash>`

---

# POLISH TASK LIST

## Task 1 — Runtime Readiness Audit
- Audit `style.load`, `styledata`, and `idle` usage; find ad-hoc waits and duplicate listeners.
- Introduce a minimal `runtimeReady` helper only if it can be added without circular imports.
- Add focused deterministic tests for any helper introduced.

## Task 2 — Feature Flag and Kill Switch Hardening
- Review `map_config.js` for safe defaults and runtime toggles.
- Ensure runtime toggles are explicit, observable, and reversible.
- Add a guarded `disableAllNewFeatures()` helper for non-critical new features.
- Conditional: add a runtime `onChange` event emitter only if audited code paths require it; must return an unsubscribe function and have tests for cleanup/idempotency.
- Log telemetry for bulk disables and fallback triggers.

## Task 3 — Coordinate Normalization Narrow Pass
- Add `normalizeCoord(input)` accepting `{lat,lng}`, `{lat,lon}`, `{latitude,longitude}`; reject non-finite/out-of-range values.
- Replace only audited high-risk call sites (weather, map-center, API boundaries).
- Add micro-tests for accepted and rejected shapes.

## Task 4 — Style Reload State Persistence
- Audit traffic, clustering, overlay persistence across style reloads.
- Add or refine `restoreStyleState(map, state)` only if it fits existing architecture.
- Use `setLayoutProperty` and `setPaintProperty` safely; do not re-add layers.
- Add tests simulating style reload/state restoration.

## Task 5 — Module Graph and Side-Effect Cleanup Narrow Pass
- Detect top-level side effects and convert risky ones to lazy initializers.
- Avoid circular imports; prefer pure helper exports.
- If no risky side effects found, skip with a report.

## Task 6 — Telemetry Expansion
- Add guarded telemetry events only where useful: `feature_flag_state`, `fallback_triggered`, `style_reload_restored`, `traffic_toggle`, `heading_permission_flow`.
- Ensure telemetry is optional, non-blocking, and guarded.
- Include sample payloads in the commit report.

## Task 7 — Performance Heuristics Inert Defaults Only
- Audit for existing FPS/device heuristics.
- If adding a monitor, keep it behind a feature flag and default disabled.
- May use `navigator.deviceMemory` and `navigator.hardwareConcurrency`.
- Fallbacks must only disable future visual polish features, not core app behavior.
- Add deterministic micro-tests by injecting fake environment values.

## Task 8 — Deterministic Micro-Test Expansion
- Add focused tests only for helpers actually introduced.
- Use discovered repo-real commands; avoid flaky timeouts and real network dependence.

## Task 9 — Browser Smoke Harness Improvements
- Add bounded smoke scripts only if they fit the repo.
- Use finite readiness checks and explicit timeouts; no indefinite idle waits.
- Smoke must verify: no page errors, no app console errors, no Mapbox expression validation errors, traffic toggle works, heading permission path exercises safely, feature flags toggle at runtime.
- Document acceptable environmental noise in the report.

---

# DEFERRED — Task 10: Phase C Manifest Predeclaration

Do not perform unless the user gives separate explicit approval after Tasks 1–9 via `APPROVE PHASE C ACTIVATION`.

If later approved: predeclare Phase C IDs/configs inertly in a single commit and add tests asserting they are inert.

---

# VALIDATION RULES

- Use only discovered repo commands for deterministic tests.
- Bounded browser smoke timeout: 30 seconds per check.
- After each commit: run test matrix and smoke, check editor diagnostics, confirm `git status --short --branch`.
- If any failure occurs, stop and return a structured failure report with logs and suggested action.

---

# FINAL REPORT

At the end of the approved polish run produce:
- Branch name
- Exact commit hashes and messages
- Changed files per commit
- Rationale per commit
- Exact test commands and results per commit
- Browser smoke URL and logs per commit
- Telemetry events added and sample payloads
- Rollback commands per commit (`git revert <hash>`)
- Unified diff commands (`git show --patch --stat <hash>`)
- Short Phase C readiness note
- Explicit statement that Phase C was **not** activated
- Explicit statement that no push, PR, or deploy was performed

---

# STARTUP ACTION

1. Run the PRE-RUN PREFLIGHT checks and return the preflight report.
2. **STOP** after the preflight report.
3. Do not implement Tasks 1–9 unless the user replies exactly: `APPROVE HERCULEAN POLISH`
4. After receiving approval, re-run the Git and worktree safety checks. If the branch changed or the worktree is dirty, STOP and report. Otherwise proceed sequentially.
