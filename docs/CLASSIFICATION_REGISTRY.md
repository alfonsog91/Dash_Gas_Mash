# DGM Classification Registry

Each element from the Unified Mathematical Governance Corpus is classified below. Every entry includes: name, formal definition, classification, repository location, and rationale.

**Valid classifications:**
- `GOV` — Non-executable governance constraint
- `ABS` — Analytical or bounding structure
- `FEC` — Potential future executable candidate

---

## §1 — Foundational Primitives and Invariants

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 1.1 | Scalar cost field $C$ | $C : \mathcal{X} \times \mathcal{T} \rightarrow \mathbb{R}_{\ge 0}$ — cost density over space-time | `GOV` | [docs/GOVERNANCE.md §1](GOVERNANCE.md) | Governs interpretation of all spatial-temporal outputs; existing runtime outputs (`pGood`, `composite`, heatmap values) are already consistent with this definition but $C$ itself adds no new computation |
| 1.2 | Non-negativity invariant (I-1) | $C(x,t) \ge 0$ | `GOV` | [docs/GOVERNANCE.md §1](GOVERNANCE.md), enforced by `clamp01` in [model.js](../model.js) | Runtime already enforces via `clamp01`; governance formalizes the invariant |
| 1.3 | Order preservation invariant (I-2) | Admissible transforms preserve $\le$ ordering | `GOV` | [docs/GOVERNANCE.md §1](GOVERNANCE.md) | Constrains any future transform added to the pipeline |
| 1.4 | Reparameterization stability (I-3) | Relative ordering preserved under reparameterization | `GOV` | [docs/GOVERNANCE.md §1](GOVERNANCE.md) | Prevents future changes that would reorder outputs arbitrarily |
| 1.5 | No decision authority (I-4) | $C$ carries no operational semantics | `GOV` | [docs/GOVERNANCE.md §1](GOVERNANCE.md) | Existing outputs are descriptive; this constraint prevents future promotion to decision authority |

## §2 — Signal Decomposition and Aggregation

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 2.1 | Signal set $\mathcal{S}$ | $\{S_1, \dots, S_n\}$ : finite set of signals $S_i : \mathcal{X} \times \mathcal{T} \rightarrow \mathbb{R}$ | `GOV` | [docs/GOVERNANCE.md §2](GOVERNANCE.md), runtime: `sigI`, `sigM`, `sigR`, `sigD` in [model.js](../model.js) | Names and constrains the existing four-signal decomposition |
| 2.2 | Semantic independence (S-1) | No signal may proxy another | `GOV` | [docs/GOVERNANCE.md §2](GOVERNANCE.md) | Prevents future coupling where e.g. density proxies ticket size |
| 2.3 | Normalization (S-2) | Each signal normalized within its own semantic domain | `GOV` | [docs/GOVERNANCE.md §2](GOVERNANCE.md), enforced by `clamp01` per-signal in [model.js](../model.js) | Runtime already normalizes each signal to $[0,1]$ independently |
| 2.4 | No cross-signal inference (S-3) | Aggregation must not imply one signal from another | `GOV` | [docs/GOVERNANCE.md §2](GOVERNANCE.md) | Prevents future inference chains between signals |
| 2.5 | Descriptive aggregation operator $A$ | $C(x,t) = A(S_1, \dots, S_n)$; must be monotone, order-preserving, no coupling | `GOV` | [docs/GOVERNANCE.md §2](GOVERNANCE.md), runtime: `composite` in [model.js](../model.js) | Existing weighted-linear `composite` is monotone per component; constraint binds future changes |

## §3 — Temporal Structure and Weighting

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 3.1 | Time partition $\{T_k\}$ | Disjoint buckets covering $[0, 24)$ | `GOV` | [docs/GOVERNANCE.md §3](GOVERNANCE.md), runtime: `timeBucket()` in [model.js](../model.js) | Formalizes existing bucket structure as governance |
| 3.2 | Bucket weights | $w_k \ge 0$, $\sum_k w_k = 1$ | `GOV` | [docs/GOVERNANCE.md §3](GOVERNANCE.md), runtime: `wI, wM, wR, wD` in [model.js](../model.js) | Existing weights satisfy non-negativity; sum-to-one applies within composite use |
| 3.3 | Retrospective-only rule (T-1) | No extrapolation or prediction | `GOV` | [docs/GOVERNANCE.md §3](GOVERNANCE.md) | Runtime uses current hour only; prevents future forecasting logic |
| 3.4 | No extrapolation (T-2) | Weights apply to current or past state only | `GOV` | [docs/GOVERNANCE.md §3](GOVERNANCE.md) | Same scope as T-1; explicitly prevents trend projection |
| 3.5 | Explicit boundaries (T-3) | Bucket boundaries documented | `GOV` | [docs/GOVERNANCE.md §3](GOVERNANCE.md) | Boundaries are defined in `timeBucket()` source |

## §4 — Combinatorial Analysis and Bounding

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 4.1 | Generating functions | $G(z) = \sum_{k \ge 0} a_k z^k$; coefficients are configuration counts | `ABS` | [docs/GOVERNANCE.md §4.1](GOVERNANCE.md) | Analytical reference for reasoning about configuration space; no runtime expression exists or is created |
| 4.2 | Inclusion-exclusion | $\|A \cup B\| = \|A\| + \|B\| - \|A \cap B\|$ and generalizations | `ABS` | [docs/GOVERNANCE.md §4.2](GOVERNANCE.md) | Available for overlap analysis in review; no runtime implementation |
| 4.3 | Stirling / Bell partition numbers | $S(n,k)$, $B_n$ for analytical grouping | `ABS` | [docs/GOVERNANCE.md §4.3](GOVERNANCE.md) | Describes grouping structure for analysis; no runtime implementation |
| 4.4 | Möbius inversion on posets | $g(x) = \sum_{y \le x} \mu(y,x) f(y)$ | `ABS` | [docs/GOVERNANCE.md §4.4](GOVERNANCE.md) | For disentangling dependencies in review; no runtime implementation |
| 4.5 | Symmetry / equivalence classes | Equivalent configurations form equivalence classes | `ABS` | [docs/GOVERNANCE.md §4.5](GOVERNANCE.md) | Prevents semantic inflation in analysis; no runtime implementation |
| 4.6 | Combinatorial bounds | Worst-case bounds for interpretive safety | `ABS` | [docs/GOVERNANCE.md §4.6](GOVERNANCE.md) | Documentation/review only; no thresholds or scoring |
| 4.7 | Generating functions as executable operator | If $G(z)$ were used to compute runtime configuration counts | `FEC` | [docs/GOVERNANCE.md §4.1](GOVERNANCE.md) | Would require runtime implementation; recorded only as potential future candidate per §8 |
| 4.8 | Möbius inversion as executable operator | If poset inversion were used to decompose runtime signal contributions | `FEC` | [docs/GOVERNANCE.md §4.4](GOVERNANCE.md) | Would require runtime implementation; recorded only as potential future candidate per §8 |
| 4.9 | Inclusion-exclusion as runtime overlap correction | If overlap correction were applied to runtime merchant counting | `FEC` | [docs/GOVERNANCE.md §4.2](GOVERNANCE.md) | Would require runtime implementation; recorded only as potential future candidate per §8 |

## §5 — Thresholds and Interpretive Limits

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 5.1 | Threshold set $\{\theta_i\}$ | Partition of $\mathbb{R}$ into interpretive bands $[\theta_i, \theta_{i+1})$ | `GOV` | [docs/GOVERNANCE.md §5](GOVERNANCE.md), runtime: `describeSignal`, `describeStability`, `describePickup` in [app.js](../app.js) and [model.js](../model.js) | Existing thresholds in describe-functions are display-only; governance prevents promotion to triggers |
| 5.2 | No-trigger rule (TH-1) | Thresholds do not trigger actions | `GOV` | [docs/GOVERNANCE.md §5](GOVERNANCE.md) | Prevents future automation based on threshold crossings |
| 5.3 | No-alert rule (TH-2) | Thresholds do not generate alerts | `GOV` | [docs/GOVERNANCE.md §5](GOVERNANCE.md) | Prevents future alert systems driven by thresholds |
| 5.4 | No implied action (TH-3) | Thresholds carry no implied action | `GOV` | [docs/GOVERNANCE.md §5](GOVERNANCE.md) | Prevents future action binding to threshold bands |
| 5.5 | Descriptive-only (TH-4) | Thresholds define interpretive bands only | `GOV` | [docs/GOVERNANCE.md §5](GOVERNANCE.md) | Formalizes existing behavior |

## §6 — Advisory Semantics and Non-Authority

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 6.1 | Annotation-only outputs | All outputs are annotations, not instructions | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md), runtime: all UI text in [app.js](../app.js), [index.html](../index.html) | Existing text is descriptive; constraint prevents imperative rewording |
| 6.2 | No imperative language (A-1) | Outputs must not command action | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md) | Constrains future UI text changes |
| 6.3 | No implied agency (A-2) | Outputs must not suggest the system acts | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md) | Prevents framing like "the system recommends" |
| 6.4 | No optimization framing (A-3) | Outputs must not frame results as optimal | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md) | Prevents language like "optimal spot" |
| 6.5 | No prescriptive phrasing (A-4) | Outputs must not prescribe specific behavior | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md) | Prevents "you should go here" |
| 6.6 | Many-to-one advisory mapping | Advisory mapping must be many-to-one and non-prescriptive | `GOV` | [docs/GOVERNANCE.md §6](GOVERNANCE.md) | Prevents reverse inference from text to unique mathematical state |

## §7 — Non-Executable Governance Constraints

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 7.1 | No conversion without authorization (G-1) | Corpus math cannot become executable without §8 process | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Master gate for all corpus elements |
| 7.2 | No new prediction/optimization/decision (G-2) | No new P/O/D logic beyond what is already present | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Prevents scope expansion |
| 7.3 | No semantic coupling beyond defined (G-3) | No coupling beyond §1–§6 definitions | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Prevents hidden dependencies |
| 7.4 | Preserve §1–§6 in all changes (G-4) | Future changes must preserve all sections | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Master preservation constraint |

## §8 — Conditions for Future Executable Proposals

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 8.1 | Reclassification gate | Four conditions required for any `FEC` → executable promotion | `GOV` | [docs/GOVERNANCE.md §8](GOVERNANCE.md) | Defines the only valid path for corpus math to become runtime |

## Summary Statistics

| Classification | Count |
|---------------|-------|
| `GOV` — Non-executable governance constraint | 27 |
| `ABS` — Analytical or bounding structure | 6 |
| `FEC` — Potential future executable candidate | 3 |
| **Total** | **36** |
