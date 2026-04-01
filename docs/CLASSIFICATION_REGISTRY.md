# DGM Classification Registry

Each element from the Unified Mathematical Governance Corpus is classified below. Every entry includes: name, formal definition, classification, repository location, and rationale.

**Valid classifications:**
- `GOV` — Non-executable governance constraint
- `ABS` — Analytical or bounding structure
- `EXE` — Authorized executable runtime component
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
| 7.2 | No new prediction/optimization/decision (G-2) | No new P/O/D logic unless it replaces a named heuristic and satisfies §8 | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Prevents unbounded scope expansion while allowing controlled promotion |
| 7.3 | No semantic coupling beyond defined (G-3) | No coupling beyond §1–§6 definitions | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Prevents hidden dependencies |
| 7.4 | Preserve §1–§6 in all changes (G-4) | Future changes must preserve all sections | `GOV` | [docs/GOVERNANCE.md §7](GOVERNANCE.md) | Master preservation constraint |

## §8 — Conditions for Future Executable Proposals

| ID | Element | Definition | Classification | Location | Rationale |
|----|---------|-----------|---------------|----------|-----------|
| 8.1 | Reclassification gate | Five conditions required for any `FEC` → executable promotion | `GOV` | [docs/GOVERNANCE.md §8](GOVERNANCE.md) | Defines the only valid path for corpus math to become runtime |
| 8.2 | Residential demand field $\lambda_{res}$ | $\lambda_{res}(p)=\sum_{a \in \mathcal{A}} w(a,h,day)e^{-d(p,a)/\tau_{res}}$ and blended $\lambda_{eff}$ contribution | `EXE` | [docs/GOVERNANCE.md §8.2](GOVERNANCE.md), runtime: `residentialIntensityAtPoint()` and `probabilityOfGoodOrder()` in [model.js](../model.js), fetch path in [overpass.js](../overpass.js), wiring in [app.js](../app.js) | Promoted because residential-demand math already existed but was dormant in the app flow; activation replaces the merchant-only heuristic while preserving non-negativity, monotonicity, and rollback via blend $\eta=0$ |
| 8.3 | Demand coverage node set $Q$ | $Q$ is the non-negative weighted set of merchant and residential demand nodes used by the fallback selector | `EXE` | [docs/GOVERNANCE.md §8.3](GOVERNANCE.md), runtime: `buildDemandCoverageNodes()` in [model.js](../model.js), consumed in [app.js](../app.js) | Required to isolate demand representation for the fallback objective without changing the existing four-signal decomposition |
| 8.4 | Submodular coverage objective $F(S)$ | $F(S)=\sum_{q \in Q} w_q \max_{p \in S}[u(p)e^{-d(p,q)/\sigma}]$ with greedy cardinality-constrained selection | `EXE` | [docs/GOVERNANCE.md §8.3](GOVERNANCE.md), runtime: `selectParkingSetSubmodular()` and `evaluateParkingCoverage()` in [optimizer.js](../optimizer.js), shadow audit in [app.js](../app.js) | Promoted to replace the naive non-MIP top-K slice. The objective is monotone submodular on the supplied candidate pool, so greedy selection provides the classical $(1-1/e)$ approximation guarantee for the fallback path |
| 8.5 | Learned monotone predictor $\hat p_{any}, \hat q$ | $\hat p_{any}(x)=\mathcal{C}_{any}(\sigma(\theta^\top \phi(x)))$, $\hat q(x)=\mathcal{C}_{q}(\sigma(\omega^\top \psi(x)))$ with $\phi,\psi$ built only from existing runtime signals and context | `EXE` | [docs/GOVERNANCE.md §8.4](GOVERNANCE.md), runtime: `predictLearnedOrderModel()` and `buildLearnedFeatureMaps()` in [learned_predictor.js](../learned_predictor.js), integration in [model.js](../model.js), flag bootstrap in [index.html](../index.html) | Promoted to replace the hand-tuned rate and quality mapping only when explicitly enabled. The model preserves output semantics, is bounded to existing signals, and leaves downstream optimization unchanged |
| 8.6 | Beta-style calibration layer $\mathcal{C}$ | $\mathcal{C}(p)=\sigma(a\log p + b\log(1-p) + c)$ | `EXE` | [docs/GOVERNANCE.md §8.5](GOVERNANCE.md), runtime: `betaCalibrate()` in [learned_predictor.js](../learned_predictor.js) | Promoted because the learned predictor needs calibrated probabilities while keeping outputs in $[0,1]$ and preserving the existing probability semantics |
| 8.7 | Uncertainty-aware shrinkage $\tilde p, \tilde q$ | $\tilde p=(1-\alpha)p_{legacy}+\alpha\hat p$, $\tilde q=(1-\alpha)q_{legacy}+\alpha\hat q$ with $\alpha$ driven by support and predictive uncertainty | `EXE` | [docs/GOVERNANCE.md §8.6](GOVERNANCE.md), runtime: `predictLearnedOrderModel()` in [learned_predictor.js](../learned_predictor.js), consumed in [model.js](../model.js) | Promoted to preserve regime stability and guarantee rollback-safe behavior by anchoring weak-support regions to the legacy scorer |

## Summary Statistics

| Classification | Count |
|---------------|-------|
| `GOV` — Non-executable governance constraint | 27 |
| `ABS` — Analytical or bounding structure | 6 |
| `EXE` — Authorized executable runtime component | 6 |
| `FEC` — Potential future executable candidate | 3 |
| **Total** | **42** |
