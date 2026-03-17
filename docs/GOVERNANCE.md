# DGM Unified Mathematical Governance Corpus

**Status:** Non-Executable Governance and Analytical Reference
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
| G-2 | No prediction, optimization, or decision logic may be introduced that is not already present |
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

Until then, all content in this corpus remains non-executable.

---

## §9 — Classification Rules

Each element must be classified as exactly one of:

| Classification | Abbreviation |
|---------------|-------------|
| Non-executable governance constraint | `GOV` |
| Analytical or bounding structure | `ABS` |
| Potential future executable candidate | `FEC` |

Each record must include: definition, location, rationale. See [CLASSIFICATION_REGISTRY.md](CLASSIFICATION_REGISTRY.md).

---

## §10 — Preservation Checklist

| Check | Status | Verified By |
|-------|--------|-------------|
| Runtime outputs unchanged against baseline tests | ✓ | `tests/preservation.test.js` |
| No actionability introduced | ✓ | Code annotation review |
| Signal independence preserved | ✓ | §2 mapping verified |
| Temporal rules enforced | ✓ | §3 mapping verified |
| Möbius inversion documented and non-executable | ✓ | §4.4 — no runtime code |
| Combinatorial bounds recorded | ✓ | §4.6 — documentation only |
| Governance constraints registered | ✓ | Registry complete |

---

## Final Summary

This corpus increases analytical clarity and constrains semantic drift while preserving runtime behavior. All mathematics herein is non-executable unless explicitly reclassified through the formal process defined in §8.
