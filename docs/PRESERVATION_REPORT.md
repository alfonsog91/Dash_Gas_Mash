# DGM Preservation Report

**Date:** 2026-03-16
**Scope:** Integration of the Unified Mathematical Governance Corpus into Dash Gas Map
**Verdict:** All preservation criteria satisfied. Runtime behavior unchanged.

---

## 1. Runtime Outputs Unchanged

No runtime code was added, removed, or altered in logic. All changes to source files consist exclusively of block-comment annotations (non-executable). Specifically:

| File | Change Type | Lines Affected |
|------|------------|----------------|
| `model.js` | Comment annotations added | Header block, `timeBucket()`, signal decomposition, `advisory` |
| `optimizer.js` | Comment annotation added | Header block |
| `overpass.js` | Comment annotation added | Header block |
| `app.js` | Comment annotation added | Header block |

**Verification:** The test suite in `tests/preservation.test.js` executes the model functions with fixed inputs and asserts deterministic, identical outputs across repeated calls. It verifies non-negativity, order preservation, signal bounds, and structural consistency of all scoring outputs.

---

## 2. No Actionability Introduced

The test suite explicitly checks:
- Output objects contain no `recommendation`, `action`, `decision`, or `command` keys
- `advisory` remains a plain string label (`'hold'` | `'rotate'`), not a function or action-bearing object
- `pGood` remains a plain number
- No new UI elements, alerts, triggers, or automation were added

No imperative, prescriptive, or optimization-framing language was introduced in any file.

---

## 3. No Prediction or Optimization Introduced

- No new prediction logic was added. The existing `probabilityOfGoodOrder` and `buildGridProbabilityHeat` remain unchanged.
- No new optimization logic was added. The existing MIP optimizer in `optimizer.js` remains unchanged.
- The combinatorial structures from §4 of the corpus (generating functions, inclusion-exclusion, Möbius inversion, Stirling/Bell numbers) were recorded as `ABS` (analytical/bounding) or `FEC` (potential future executable) — none were implemented.

---

## 4. Governance Math Remains Non-Executable

Every mathematical element from the corpus was classified into exactly one of three categories:

| Classification | Count | Runtime Impact |
|---------------|-------|---------------|
| `GOV` — Non-executable governance constraint | 27 | None |
| `ABS` — Analytical or bounding structure | 6 | None |
| `FEC` — Potential future executable candidate | 3 | None (recorded only) |

The three `FEC` elements are:
1. **4.7** — Generating functions as executable operator
2. **4.8** — Möbius inversion as executable operator
3. **4.9** — Inclusion-exclusion as runtime overlap correction

These are recorded in the Classification Registry as requiring the full §8 reclassification process before any runtime implementation.

---

## 5. Classifications Recorded and Traceable

All 36 classified elements are documented in [docs/CLASSIFICATION_REGISTRY.md](CLASSIFICATION_REGISTRY.md) with:
- Unique ID
- Element name
- Formal definition
- Classification (`GOV`, `ABS`, or `FEC`)
- Repository location (file path and governance section reference)
- Rationale

Cross-reference annotations in source files point back to specific governance sections and registry entries.

---

## 6. Artifacts Produced

| Artifact | Path | Type |
|----------|------|------|
| Canonical governance document | `docs/GOVERNANCE.md` | Governance documentation |
| Classification registry | `docs/CLASSIFICATION_REGISTRY.md` | Classification metadata |
| Preservation report | `docs/PRESERVATION_REPORT.md` | Audit / review metadata |
| Preservation tests | `tests/preservation.test.js` | Non-drift validation |
| Test runner page | `tests/preservation.html` | Test harness |
| Source annotations | `model.js`, `optimizer.js`, `overpass.js`, `app.js` | Non-executable code annotations |

---

## 7. How to Run Preservation Tests

```
python -m http.server 5173
# Open http://localhost:5173/tests/preservation.html
```

All tests should show ✅. Any ❌ indicates a runtime drift from the governance baseline.
