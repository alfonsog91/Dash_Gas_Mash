# DGM Unified Mathematical Governance Corpus

**Status:** Governance Reference with Authorized Executable Promotions
**Authority:** Semantic, interpretive, and evolutionary constraints only
**Runtime Impact:** None unless explicitly authorized through the process defined in §8
**Completeness:** This corpus is complete and self-contained within its scope.

---

## §1 — Foundational Primitives and Invariants

Let the operational domain be a discrete spatial-temporal manifold $\mathcal{M}$ with locations $x \in \mathcal{X}$ and time $t \in \mathcal{T}$.

Define the scalar cost field:

$$C : \mathcal{X} \times \mathcal{T} \rightarrow \mathbb{R}_{\ge 0}$$

**Interpretation:** $C$ describes cost density only. It does not encode utility, preference, recommendation, or action.

**Invariants:**

| ID | Invariant | Formal Statement |
|----|-----------|-----------------|
| I-1 | Non-negativity | $C(x,t) \ge 0$ |
| I-2 | Order preservation | If $C_1 \le C_2$, then any admissible transform $f$ must satisfy $f(C_1) \le f(C_2)$ |
| I-3 | Stability under reparameterization | Relative ordering must be preserved |
| I-4 | No decision authority | $C$ has no operational semantics |

**Runtime mapping:** The existing `probabilityOfGoodOrder` function and `buildGridProbabilityHeat` grid produce scalar fields over $\mathcal{X} \times \mathcal{T}$. These outputs are descriptive and carry no decision authority, consistent with I-4. The `clamp01` function enforces I-1. Monotone aggregation preserves I-2.

---

## §2 — Signal Decomposition and Aggregation

Let $\mathcal{S} = \{S_1, S_2, \dots, S_n\}$ be a finite set of signals.

Each signal is defined as:

$$S_i : \mathcal{X} \times \mathcal{T} \rightarrow \mathbb{R}$$

**Constraints:**

| ID | Constraint | Description |
|----|-----------|-------------|
| S-1 | Semantic independence | No signal may proxy another |
| S-2 | Normalization | Each signal must be normalized within its own semantic domain |
| S-3 | No cross-signal inference | Aggregation must not imply one signal from another |

**Aggregation is descriptive only:**

$$C(x,t) = A(S_1(x,t), \dots, S_n(x,t))$$

Aggregation operator $A$ must: preserve ordering, be monotone, introduce no coupling or inference.

**Runtime mapping:** The four signals $\{I, M, R, D\}$ in `model.js` (`sigI`, `sigM`, `sigR`, `sigD`) are independently derived:
- $I$ — ticket index (cuisine/type tags)
- $M$ — merchant intensity (distance-decayed count)
- $R$ — proximity (closeness to nearest merchant)
- $D$ — competition proxy (parking density)

Each is normalized to $[0,1]$ independently. The `composite` aggregation is a weighted linear combination with time-varying weights, satisfying monotonicity and independence.

---

## §3 — Temporal Structure and Weighting

Time is partitioned into disjoint buckets $\{T_k\}$.

Define weights:

$$w_k \ge 0, \qquad \sum_k w_k = 1$$

**Rules:**

| ID | Rule | Description |
|----|------|-------------|
| T-1 | Retrospective only | No extrapolation or prediction |
| T-2 | No extrapolation | Weights apply to current or past state only |
| T-3 | Explicit boundary behavior | Bucket boundaries are defined and documented |

Temporal aggregation is descriptive only:

$$C(x) = \sum_k w_k \cdot C(x, T_k)$$

**Runtime mapping:** The `timeBucket(hour)` function partitions $[0, 24)$ into seven disjoint buckets. Each bucket defines weights $\{w_I, w_M, w_R, w_D\}$ that sum to $1.0$ (within the composite calculation, noting $w_D$ is subtracted). No forecasting or extrapolation is performed.

---

## §4 — Combinatorial Analysis and Bounding (Non-Executable)

Combinatorics is used strictly for analysis and constraint reasoning.

### §4.1 — Generating Functions

Use formal generating functions to encode configuration counts:

$$G(z) = \sum_{k \ge 0} a_k z^k$$

The coefficients $a_k$ represent counts of admissible configurations only; they are analytic descriptors, not probabilities.

### §4.2 — Inclusion-Exclusion

Use inclusion-exclusion to bound overlap and prevent double-counting:

$$|A \cup B| = |A| + |B| - |A \cap B|$$

and its higher-order generalizations for multiple sets.

### §4.3 — Partition Structure

Use Stirling numbers $S(n,k)$ and Bell numbers $B_n$ to describe analytical grouping only.

### §4.4 — Möbius Inversion on Posets

Let $(P, \le)$ be a finite poset representing interpretive or dependency structure. If a cumulative function $f$ is defined by

$$f(x) = \sum_{y \le x} g(y),$$

then primitive contributions are recovered by

$$g(x) = \sum_{y \le x} \mu(y,x) \cdot f(y),$$

where $\mu$ is the Möbius function of the poset.

### §4.5 — Symmetry

Equivalent configurations form equivalence classes to prevent semantic inflation.

### §4.6 — Combinatorial Bounds

Worst-case bounds may be derived for interpretive safety only. Such bounds may inform documentation and review only. Such bounds must not define thresholds, scoring behavior, or operational decisions.

### Usage Constraints

| ID | Constraint | Description |
|----|-----------|-------------|
| C-1 | Analytical only | No runtime computation |
| C-2 | Dependency disentanglement | Used to prevent hidden coupling in review |
| C-3 | No causality inference | Never used for causal reasoning |
| C-4 | No optimization use | Never used for runtime optimization |
| C-5 | Documentation required | Poset definitions and interpretive mappings must be documented |

**Runtime mapping:** None. All §4 content is classified as **analytical or bounding structure** with no runtime implementation. Any element from §4 that requires runtime implementation to exist is recorded as a **potential future executable candidate** in the Classification Registry.

---

## §5 — Thresholds and Interpretive Limits

Define thresholds $\{\theta_i\}$ that partition $\mathbb{R}$ into interpretive bands $[\theta_i, \theta_{i+1})$.

**Rules:**

| ID | Rule | Description |
|----|------|-------------|
| TH-1 | No triggers | Thresholds do not trigger actions |
| TH-2 | No alerts | Thresholds do not generate alerts |
| TH-3 | No implied action | Thresholds carry no implied action |
| TH-4 | Descriptive only | Thresholds define interpretive bands only |

**Runtime mapping:** Functions `describeSignal`, `describeStability`, `describePickup`, and the `advisory` field in `probabilityOfGoodOrder` use threshold-based text selection. These are display-only — they produce descriptive text bound to no trigger, alert, or automated action. The `advisory` value (`'hold'`/`'rotate'`) is a descriptive label only; it executes nothing.

---

## §6 — Advisory Semantics and Non-Authority

All outputs derived from mathematical artifacts are annotations only.

**Prohibitions:**

| ID | Prohibition | Description |
|----|------------|-------------|
| A-1 | No imperative language | Outputs must not command action |
| A-2 | No implied agency | Outputs must not suggest the system acts |
| A-3 | No optimization framing | Outputs must not frame results as optimal |
| A-4 | No prescriptive phrasing | Outputs must not prescribe specific behavior |

**Formal constraint:** Any advisory mapping from mathematical state to text must be many-to-one and non-prescriptive to prevent reverse inference.

**Runtime mapping:** UI text in `app.js` uses phrasing like "chance", "estimated", "proxy", "heuristic". The `describeSignal` function uses descriptive language ("Excellent area", "Sparse area") without imperative commands. All popups and summary cards are informational. The word "suggest" in the MIP context refers to list output, not prescription.

---

## §7 — Non-Executable Governance Constraints

These constraints bind future evolution:

| ID | Constraint |
|----|-----------|
| G-1 | No conversion to executable logic without explicit authorization per §8 |
| G-2 | No prediction, optimization, or decision logic may be introduced unless it replaces a named heuristic and satisfies §8 |
| G-3 | No semantic coupling beyond what is defined in §1–§6 |
| G-4 | All future changes must preserve §1–§6 in interpretation, documentation, and execution semantics |

These constraints are binding but non-runtime.

---

## §8 — Conditions for Future Executable Proposals

A mathematical element from this corpus may become executable only if **all** of the following are satisfied:

1. It is explicitly reclassified with documented authorization
2. It is proven equivalent to existing behavior where required
3. It preserves all invariants (§1 I-1 through I-4)
4. It is independently reviewed
5. Regression coverage and rollback conditions are documented

Until then, all content in this corpus remains non-executable.

### §8.2 — Authorized Executable Promotion: Residential Demand Field

The residential demand field is now an authorized executable component in the main runtime path.

Formal structure:

$$\lambda_{res}(p)=\sum_{a \in \mathcal{A}} w(a,h,day) \cdot e^{-d(p,a)/\tau_{res}}$$

and

$$\lambda_{eff}(p)=\frac{\alpha(h,day)\lambda_m(p)+\eta\,\rho(h,day)\lambda_{res}(p)}{1+\gamma\Pi(p)}$$

This promotion replaces the prior merchant-only heuristic in the app flow, where residential-demand math existed in isolation but was not wired into active loading, heatmap generation, point scoring, or parking ranking.

Authorized invariant set:

- Non-negativity is preserved because all component weights, kernels, and denominators remain non-negative
- Monotonicity is preserved in merchant intensity and residential intensity for fixed competition
- Rollback safety is preserved because setting the residential blend $\eta$ to $0$ recovers the merchant-only path
- Advisory semantics are preserved because outputs remain descriptive only

### §8.3 — Authorized Executable Promotion: Submodular Coverage Selector

The non-MIP fallback selector is now an authorized executable component.

Formal structure:

$$F(S)=\sum_{q \in Q} w_q \max_{p \in S}\left[u(p)\,e^{-d(p,q)/\sigma}\right]$$

where $Q$ is the set of merchant and residential demand nodes and $u(p)$ is a conservative utility derived from the scored parking point.

This promotion replaces the prior fallback heuristic of taking the top raw parking scores with no diversity objective. The new objective is a weighted facility-location form, which is monotone submodular under a pure cardinality constraint.

Authorized guarantee and guardrails:

- Greedy selection on the supplied candidate pool attains the classical $(1-1/e)$ approximation guarantee for the fallback objective
- MIP remains the primary exact path when available; the submodular selector runs in shadow mode for comparison when MIP is active
- The selector is descriptive only and does not add decision authority
- Rollback safety is preserved by disabling the fallback path in favor of MIP or reverting to the prior code path

### §8.4 — Authorized Executable Promotion: Learned Monotone Predictor

The predictive mapping from current runtime signals to $P(\text{any order in }T)$ and the conditional quality factor is now authorized as an executable, default-off learned component.

Formal structure:

$$\hat p_{any}(x)=\mathcal{C}_{any}\left(\sigma\left(\theta^\top \phi(x)\right)\right)$$

$$\hat q(x)=\mathcal{C}_{q}\left(\sigma\left(\omega^\top \psi(x)\right)\right)$$

$$\hat p_{good}(x)=\hat p_{any}(x) \cdot (0.25 + 0.75\hat q(x))$$

where $\phi(x)$ and $\psi(x)$ are formed only from existing runtime signals and context: normalized $I,M,R,D$, support, residential share, horizon, and time-bucket indicators.

This promotion replaces the prior fully hand-tuned rate and quality mapping only when the code-level feature flag is enabled. The optimizer, selection logic, constraints, and UI contract remain unchanged.

Authorized invariant set:

- Feature scope is bounded to existing runtime signals and context; no new private or external data is introduced
- Monotonicity is preserved where encoded by sign-constrained feature effects, with demand-support terms non-negative and competition terms non-positive
- Default behavior is preserved because the learned model is disabled unless explicitly promoted by feature flag
- Output semantics are preserved because the learned path still emits $p_{any}$, quality, and $p_{good}$ in the same ranges and meanings expected downstream

### §8.5 — Authorized Executable Promotion: Calibration Layer

The learned predictor includes an executable beta-style calibration layer.

Formal structure:

$$\mathcal{C}(p)=\sigma\left(a\log p + b\log(1-p) + c\right)$$

This layer maps raw model probabilities into the same bounded probability semantics expected by the rest of the runtime.

Authorized guardrails:

- Calibration preserves probability bounds in $[0,1]$
- Calibration is local to the learned predictor and does not alter optimizer semantics
- Calibration parameters are static until explicitly retrained and reclassified

### §8.6 — Authorized Executable Promotion: Uncertainty-Aware Shrinkage

The learned predictor includes an executable regime-preservation layer that shrinks learned outputs toward the legacy scorer when support is weak or predictive entropy is high.

Formal structure:

$$\tilde p(x)=(1-\alpha(x))p_{legacy}(x)+\alpha(x)\hat p_{any}(x)$$

$$\tilde q(x)=(1-\alpha(x))q_{legacy}(x)+\alpha(x)\hat q(x)$$

with $\alpha(x)$ increasing with local support and decreasing with predictive uncertainty.

Authorized guardrails:

- Rollback safety is immediate: setting the prediction-model flag back to `legacy` bypasses the learned path entirely
- Regime preservation is enforced by design because low-support regions remain anchored to the legacy scorer
- Stability bands remain compatible with existing beta-style confidence reporting by scaling support instead of replacing the banding mechanism

---

## §9 — Classification Rules

Each element must be classified as exactly one of:

| Classification | Abbreviation |
|---------------|-------------|
| Non-executable governance constraint | `GOV` |
| Analytical or bounding structure | `ABS` |
| Authorized executable runtime component | `EXE` |
| Potential future executable candidate | `FEC` |

Each record must include: definition, location, rationale. See [CLASSIFICATION_REGISTRY.md](CLASSIFICATION_REGISTRY.md).

---

## §10 — Preservation Checklist

| Check | Status | Verified By |
|-------|--------|-------------|
| Core invariants preserved against regression tests | ✓ | `tests/preservation.test.js` |
| Residential demand field active in the main app flow | ✓ | `app.js`, `model.js`, `overpass.js` |
| Non-MIP selector upgraded to submodular coverage | ✓ | `optimizer.js`, `app.js` |
| Learned predictor remains default-off with rollback flag | ✓ | `index.html`, `app.js`, `model.js`, `learned_predictor.js` |
| Learned predictor improves synthetic calibration while staying close on simple cases | ✓ | `tests/preservation.test.js`, `learned_predictor.js` |
| No actionability introduced | ✓ | Code annotation review |
| Signal independence preserved | ✓ | §2 mapping verified |
| Temporal rules enforced | ✓ | §3 mapping verified |
| Möbius inversion documented and non-executable | ✓ | §4.4 — no runtime code |
| Combinatorial bounds recorded | ✓ | §4.6 — documentation only |
| Governance constraints registered | ✓ | Registry complete |

---

## Final Summary

This corpus increases analytical clarity and constrains semantic drift while allowing tightly scoped runtime promotions when they replace a named heuristic, preserve invariants, and remain rollback-safe. All mathematics herein is non-executable unless explicitly reclassified through the formal process defined in §8.
