# DGM Preservation Report

**Date:** 2026-04-01
**Scope:** Promotion of residential demand, submodular fallback selection, and the default-off learned predictor
**Verdict:** Core invariants preserved. Runtime behavior was intentionally extended in bounded, documented, rollback-safe ways.

---

## 1. Intentional Runtime Promotions

This change set is not a no-op preservation pass. Three runtime promotions were authorized and implemented:

| File | Promotion | Outcome |
|------|-----------|---------|
| `overpass.js` | Residential anchor fetch path activated | Apartment / residential anchors now load with the active view |
| `model.js` | Residential demand field promoted | Residential intensity now contributes to `lambdaEff`; demand-mix diagnostics added |
| `learned_predictor.js` | Learned predictor added | Monotone dual-head GLM, beta-style calibration, and uncertainty-aware shrinkage implemented behind a feature flag |
| `optimizer.js` | Submodular fallback selector added | Naive non-MIP top-K slicing replaced by a weighted facility-location objective |
| `app.js` | Main-flow wiring + shadow audit | Residential anchors now feed heatmap, point scoring, parking ranking, and learned-model shadow audit |
| `index.html` | Rollback controls exposed | Residential blend can be set to `0` to recover the merchant-only demand path, and `window.DGM_PREDICTION_MODEL` controls learned-model promotion |

---

## 2. Residential Demand Path Is Now End-to-End

Before this promotion, residential-demand math existed in the repository but was dormant in the main app flow. The runtime loaded only restaurants and parking, so heatmaps and parking rankings behaved as if the residential term were zero.

The promoted path now:

- Fetches residential anchors alongside restaurants and parking
- Passes those anchors into `buildGridProbabilityHeat`, `probabilityOfGoodOrder`, and `rankParking`
- Surfaces the merchant-vs-residential demand mix in the popup layer
- Preserves rollback safety through the `Residential demand blend` slider; `0` restores merchant-only behavior

**Verification:** `tests/preservation.test.js` now includes a symmetric two-parking test showing that residential anchors break the symmetry only when explicitly passed into the scoring path.

---

## 3. Fallback Selection Now Has a Formal Guarantee

The prior non-MIP fallback was a plain raw-score slice:

```js
rankedAll.slice(0, 12)
```

That heuristic had two weaknesses:

- It could cluster multiple picks into the same plaza
- It had no diversity objective and no approximation guarantee

The new fallback maximizes a weighted facility-location objective over merchant and residential demand nodes:

$$F(S)=\sum_{q \in Q} w_q \max_{p \in S}\left[u(p)e^{-d(p,q)/\sigma}\right]$$

This objective is monotone submodular under a pure cardinality constraint, so greedy selection achieves the standard $(1-1/e)$ approximation guarantee on the supplied candidate pool.

MIP remains the primary exact path when available. When MIP is active, the submodular selector runs in shadow mode and logs a coverage comparison for auditability without changing the visible selection.

**Verification:** `tests/preservation.test.js` now includes a synthetic clustered-demand case showing that the submodular selector covers both regimes, beats the old naive top-K on coverage, and stays near the brute-force optimum on a small instance.

---

## 4. Invariants and Non-Actionability Remain Intact

The updated test suite continues to verify:

- Non-negativity of `pGood`, `pAny`, `composite`, and signal outputs
- Order preservation on simple near-vs-far comparisons
- Signal normalization and structural consistency
- `pGood <= pAny`
- Deterministic outputs for fixed inputs
- Learned-model agreement with legacy scoring on simple real-runtime cases
- Learned-model calibration improvement on deterministic synthetic held-out data
- No `recommendation`, `action`, `decision`, or `command` keys in runtime results
- `advisory` remains a descriptive string label only

No automation, triggers, or imperative output language were introduced.

The learned predictor is additionally bounded in three ways:

- It is default-off and can be bypassed completely through a single bootstrap flag
- It is restricted to existing runtime features and context rather than new data sources
- It shrinks toward the legacy scorer in weak-support regimes, preserving current behavior where the learned model is least trustworthy

---

## 5. Classifications Updated

The classification scheme now includes an executable category:

| Classification | Count | Runtime Impact |
|---------------|-------|---------------|
| `GOV` — Non-executable governance constraint | 27 | Governance only |
| `ABS` — Analytical or bounding structure | 6 | None |
| `EXE` — Authorized executable runtime component | 6 | Active runtime logic |
| `FEC` — Potential future executable candidate | 3 | None until reclassified |

The executable entries are:

1. `8.2` — Residential demand field
2. `8.3` — Demand coverage node construction
3. `8.4` — Submodular coverage objective and greedy selector
4. `8.5` — Learned monotone predictor
5. `8.6` — Beta-style calibration layer
6. `8.7` — Uncertainty-aware shrinkage to the legacy prior

All are recorded in [docs/CLASSIFICATION_REGISTRY.md](CLASSIFICATION_REGISTRY.md) with definitions, locations, and rationale.

---

## 6. Artifacts Produced or Updated

| Artifact | Path | Type |
|----------|------|------|
| Canonical governance document | `docs/GOVERNANCE.md` | Governance documentation |
| Classification registry | `docs/CLASSIFICATION_REGISTRY.md` | Classification metadata |
| Preservation report | `docs/PRESERVATION_REPORT.md` | Audit / review metadata |
| Preservation tests | `tests/preservation.test.js` | Regression and invariant validation |
| Test runner page | `tests/preservation.html` | Browser harness |
| Runtime docs | `README.md` | User-facing model documentation |
| Learned predictor module | `learned_predictor.js` | Executable prediction logic |

---

## 7. How to Run Preservation Tests

```powershell
python -m http.server 5173
# Open http://localhost:5173/tests/preservation.html
```

All tests should show ✅. Any ❌ indicates either invariant drift or a regression in one of the promoted components.
