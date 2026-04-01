# Dash Parking Estimate Map

Local, **public-data** map tool that renders a vector basemap with MapLibre GL JS and overlays a **parking opportunity-likelihood heat surface** based on transparent, bounded proxy models.

This is **not affiliated with DoorDash** and does **not** use proprietary DoorDash data. It’s a strategic, tunable proxy model inspired by public DoorDash engineering writeups.

## Map Philosophy

Dash Gas Mash uses an efficiency-first map philosophy.

Most platform heat maps are best understood as coverage maps. They are designed to answer a system question: where are drivers needed right now to keep delivery coverage stable? In that model, visible heat reflects perceived scarcity, coverage gaps, and reposition pressure. A glowing zone does not necessarily mean that a driver entering it will improve their personal outcome. It means the platform may want more supply there.

DGM asks a different question:

Where should I stay so the system comes to me at the lowest cost?

This app treats the map as a cost field shaped by merchant density, travel friction, pickup distance, and local competition. The goal is not to chase every short-term spike. The goal is to identify structurally favorable hold positions where movement is expensive, stability matters, and assignment likelihood can remain strong without constant repositioning.

This distinction matters because the two map logics optimize different invariants:

- Coverage-first maps optimize global coverage stability
- DGM optimizes local execution efficiency

In practical terms, DoorDash-style heat is interpreted as a platform-facing signal, while DGM is a driver-facing structural model. Platform heat asks where supply is needed. DGM asks where waiting is justified.

That creates predictable divergences:

- Heat does not equal opportunity
- Movement does not equal improvement
- Coverage gaps do not necessarily indicate profitable waiting zones
- A reactive system map can disagree with an anticipatory hold strategy

That is why this app does not treat “hot” areas as automatically better. Instead, it scores locations by public, interpretable proxies such as nearby merchant concentration, distance-decay effects, pickup cost, structural residential demand, and a rough competition penalty. The result is a descriptive map of local positional quality, not a claim about DoorDash’s internal dispatch state.

The governing idea is simple:

DoorDash’s map treats drivers as fluid units to be redistributed.  
DGM treats the driver as a fixed observer inside a changing field.

Once that distinction is clear, the mismatch many drivers feel becomes easier to explain. A map can glow brightly and still be a poor place to wait. Chasing heat can feel wrong because the platform may be solving for coverage restoration while the driver is solving for efficient, low-friction execution.

DGM does not attempt to predict individual assignments or override platform behavior; it provides a stable lens for interpreting public signals under uncertainty.

## What it does

- Loads **food merchant proxies** from OpenStreetMap via Overpass (amenity: restaurant / fast_food / cafe / food_court)
- Loads **parking candidate proxies** from OpenStreetMap (amenity=parking and parking=*)
- Loads **residential demand anchors** from OpenStreetMap (apartments / residential buildings / residential landuse) and blends them into the demand field with a user-controlled weight
- Excludes restaurants with parseable OSM `opening_hours` tags when they are currently closed in the client’s local time
- Uses an exact MIP selector when available, and otherwise falls back to a monotone submodular coverage selector instead of a naive top-K slice
- Includes a default-off monotone, calibrated dual-head GLM scorer behind a code-level feature flag; legacy and softplus scoring remain the default behavior
- Builds a heat surface over the current map view using a calibrated probability proxy:

First compute merchant and structural-demand intensities:

$$\lambda_m(p)=\sum_{r \in \text{restaurants}} w(r, h) \cdot e^{-d(p,r)/\tau_m}$$

$$\lambda_{res}(p)=\sum_{a \in \text{residential}} w(a, h, day) \cdot e^{-d(p,a)/\tau_{res}}$$

Then combine them with a competition denominator:

$$\lambda_{eff}(p)=\frac{\alpha(h,day)\lambda_m(p)+\eta\,\rho(h,day)\lambda_{res}(p)}{1+\gamma\,\Pi(p)}$$

Then map that to a probability over a horizon $T$ minutes (calibrated to the current view):

$$P(\text{any order in }T)=1-\exp\left(-k \cdot \frac{\lambda_{eff}(p)}{\lambda_{ref}} \cdot T\right)$$

Optional “ML-style predictor” mode replaces the proportional rate with a positive rate function:

$$rate(p)=softplus\left(b+\u03b2\cdot\log\left(\frac{\lambda_{eff}(p)}{\lambda_{ref}}\right)\right)$$
$$P(\text{any order in }T)=1-\exp\left(-rate(p)\cdot T\right)$$

An experimental learned predictor can also replace the hand-tuned rate and quality mapping while preserving the same output semantics:

$$\hat p_{any}(x)=\mathcal{C}_{any}\left(\sigma\left(\theta^\top \phi(x)\right)\right)$$

$$\hat q(x)=\mathcal{C}_{q}\left(\sigma\left(\omega^\top \psi(x)\right)\right)$$

$$\tilde p(x)=(1-\alpha(x))p_{legacy}(x)+\alpha(x)\hat p_{any}(x)$$

$$\tilde q(x)=(1-\alpha(x))q_{legacy}(x)+\alpha(x)\hat q(x)$$

$$P(\text{good in }T)=\tilde p(x) \cdot (0.25 + 0.75\tilde q(x))$$

Here $\phi(x)$ and $\psi(x)$ are built only from existing runtime signals and context: $I,M,R,D$, support, residential share, horizon, and time-bucket indicators. $\mathcal{C}$ denotes beta-style calibration, and $\alpha(x)$ is an uncertainty-aware shrinkage weight that keeps the learned model close to the legacy scorer in weak regimes.

And a “good order” proxy adds a transparent quality factor for **short pickup + higher-tip proxy**:

$$P(\text{good in }T)=P(\text{any in }T) \cdot (0.25 + 0.75\cdot quality(p))$$

Where:
- $p$ is a potential parking point
- $r$ is a merchant point
- $a$ is a residential demand anchor
- $d(\cdot)$ is great-circle distance (Haversine)
- $\tau_m, \tau_{res}$ are tunable distance-decay parameters (meters)
- $w(r,h)$ is a simple time-of-night weighting (late-night: fast_food up, cafes down)
- $w(a,h,day)$ is a structural residential weighting by building type and time bucket
- $\eta$ is the residential demand blend slider
- $\gamma\Pi(p)$ is the parking-density competition proxy

It also ranks parking lots in the current view using the same score.

When the CDN MIP solver is unavailable or disabled, DGM now uses a greedy weighted facility-location selector:

$$F(S)=\sum_{q \in Q} w_q \max_{p \in S} \left[u(p)\,e^{-d(p,q)/\sigma}\right]$$

Here $Q$ contains merchant and residential demand nodes, and $u(p)$ is a conservative parking utility derived from the score and its stability band. This objective is monotone submodular, so greedy selection under a pure cardinality constraint achieves the classic $(1-1/e)$ approximation guarantee on the supplied candidate pool.

## What “probability” means here

This app **does not** have real DoorDash order arrivals, courier supply, acceptance rates, batching, zones, or dispatch constraints.
So the “probability” is a **calibrated, view-relative estimate** driven by public proxies:
- More nearby merchants (and late-night weighting) ⇒ higher modeled arrival opportunity
- More nearby residential anchors (when the blend is above 0) ⇒ more structural delivery support around a hold point
- Optional “competition strength” applies a penalty using nearby parking density as a crude proxy (set to 0 to disable)
- “Good order” is currently tuned to: **short pickup distance** + **higher-ticket cuisine/type proxy** (tune via “Tip emphasis”)

If enabled, the **MIP optimizer** selects a *set* of $K$ suggested parking lots to maximize predicted value while keeping them spread out (minimum separation constraint). If it is disabled or unavailable, the fallback selector maximizes diverse demand coverage instead of just taking the top few raw scores.

## Experimental Learned Predictor

The learned scorer is implemented but remains **off by default**. This preserves existing behavior until you explicitly promote it.

To enable it, set the bootstrap flag in [index.html](index.html):

```html
<script>
  window.DGM_PREDICTION_MODEL = "glm";
  window.DGM_SHADOW_PREDICTION_MODEL = false;
</script>
```

Rollback is immediate:

```html
<script>
  window.DGM_PREDICTION_MODEL = "legacy";
</script>
```

Notes:
- `legacy` keeps the original proportional-rate scorer unless the UI `Use ML-style predictor` checkbox is enabled
- `softplus` is still the original hand-tuned softplus-curve path
- `glm` enables the learned monotone dual-head scorer
- `window.DGM_SHADOW_PREDICTION_MODEL = true` logs learned-vs-active ranking deltas without changing visible behavior

## Why this relates to public DoorDash engineering blogs (high-level)

DoorDash has publicly described dispatch/assignment as combining:
- **Predictions** (ETAs, ready times, acceptance likelihood)
- **Optimization** (route/assignment decisions)
- **Batching/routing** improvements under latency constraints

This repo does **not** reproduce those internals. Instead, it uses a safe public proxy: being nearer to more relevant merchants generally increases the chance you’re eligible for offers, which we model as an exponential distance-decay sum.

### Hybrid “Predict → Optimize” (public proxy)

DoorDash has described a pipeline where ML predictions feed an optimizer (MIP / routing) that chooses assignments.
This app mirrors that pattern in a **non-proprietary** way:

- **Predict:** compute public-proxy features and an estimated probability over a time horizon
- **Optimize:** optionally solve a small mixed-integer problem to pick a diverse top-$K$ set of parking suggestions

References (public):
- Using ML and Optimization to Solve DoorDash’s Dispatch Problem: https://careersatdoordash.com/blog/using-ml-and-optimization-to-solve-doordashs-dispatch-problem/
- Next-Generation Optimization for Dasher Dispatch at DoorDash: https://careersatdoordash.com/blog/next-generation-optimization-for-dasher-dispatch-at-doordash/
- Scaling a routing algorithm (DeepRed / ruin-and-recreate): https://careersatdoordash.com/blog/scaling-a-routing-algorithm-using-multithreading-and-ruin-and-recreate/
- Reinforcement learning for on-demand logistics (assignment): https://careersatdoordash.com/blog/reinforcement-learning-for-on-demand-logistics/
- Improving ETAs (probabilistic forecasts): https://careersatdoordash.com/blog/improving-etas-with-multi-task-models-deep-learning-and-probabilistic-forecasts/

## Live web address

The app is hosted on GitHub Pages and is publicly accessible at:

**https://alfonsog91.github.io/Dash_Gas_Mash/**

No installation or local server required — just open that URL in any modern browser.

> The live site is automatically updated whenever changes are pushed to the `main` branch via the GitHub Actions workflow in `.github/workflows/deploy.yml`.

## Run locally (no Node required)

This is a static site. You just need Python.

From the workspace folder:

- PowerShell on Windows: `.\start.ps1`
- Manual fallback in PowerShell: `& .\.venv\Scripts\python.exe -m http.server 5173`
- Then open `http://localhost:5173/` in your browser

## Basemap configuration

The app now uses `MapLibre GL JS`.

- If `window.DASH_MAPTILER_KEY` is set in [index.html](index.html), the app uses a hosted `MapTiler` vector style.
- If no key is configured, it falls back to the public `MapLibre` demo style so the app still loads for development.

To enable `MapTiler`, edit [index.html](index.html) and set:

```html
<script>
  window.DASH_MAPTILER_KEY = "your-maptiler-key";
  window.DASH_MAPTILER_STYLE_ID = "basic-v2";
</script>
```

## How to use

- Pan/zoom to your target area (Rancho Cucamonga / Ontario / Guasti, or anywhere)
- Click **Load / Refresh for current view**
- Adjust:
  - Local hour (late-night weighting)
  - $\tau$ distance decay
  - Grid step (performance vs detail)
- Click a parking marker to see “likely nearby merchants” (proxy list)
- Click anywhere on the map to score that exact spot and see the breakdown

## Controls (what they mean)

- **Load / Refresh for current view**: Fetches OSM POIs via Overpass for what’s currently on screen. If you’re zoomed way out, the app clamps the query area to avoid 504 timeouts.
- **Local hour**: Adjusts time-of-night weighting. Late-night shifts weight toward fast food (public heuristic).
- **Opening-hours eligibility**: Restaurants with parseable OSM `opening_hours` tags are filtered against the client’s current local time before they enter scoring, normalization, heatmap generation, or parking ranking.
- **Probability horizon (minutes)** ($T$): The percent shown is “chance within the next $T$ minutes”. Increasing $T$ will generally increase the percent.
- **Distance decay $\tau$ (meters)**: How quickly merchant influence drops with distance. Smaller $\tau$ means “only very close merchants matter”; bigger $\tau$ means “clusters can influence from farther away”.
- **Grid step (meters)**: Heatmap resolution. Larger values are faster but less detailed.
- **Competition strength (proxy)**: Applies a penalty using nearby parking POI density as a crude proxy for “other drivers may also be staged here”. Set to 0 to disable.
- **Residential demand blend**: Blends in nearby housing and apartment anchors as structural demand support. Set to 0 to revert to the earlier merchant-only model.
- **Tip emphasis (vs short pickup)**: Blends two “good order” proxies:
  - short pickup distance (expected distance to nearby merchants)
  - a higher-ticket “ticket proxy” inferred from OSM cuisine/type tags
- **Use ML-style predictor**: Changes the rate curve shape using a softplus rate function (still a public proxy; not trained on DoorDash data).
- **Learned predictor flag**: Separate from the UI. Set `window.DGM_PREDICTION_MODEL = "glm"` in [index.html](index.html) to enable the experimental learned scorer; default remains `legacy`.
- **ML sensitivity (\u03b2)**: How aggressively the ML-style predictor boosts high-intensity areas.
- **Use MIP optimizer for top parking set**: Picks a set of $K$ parking lots maximizing predicted value while enforcing a minimum separation constraint.
- **Suggested spots (K)** and **Min separation**: How many suggestions to show. Hard separation applies in MIP mode; the approximate fallback spreads picks through diminishing returns instead of a hard spacing rule.

## How to interpret the percentages

The UI shows **Proxy Score ($T$ min)**, which corresponds to **$P(\u200bgood\u200b\ in\ T)$** in the math. This is:
- **Calibrated to the current view** (relative to what’s on screen), because the app does not know real DoorDash order arrival rates.
- Driven by public proxies: nearby merchants, time-of-night weighting, and optional competition penalty.

When you click a point, the popup breaks it down:
- **P(any order)**: modeled chance of *any* order in $T$
- **ticket proxy**: a 0–100% ticket-size proxy score (from OSM cuisine/type tags; heuristic)
- **pickup**: estimated pickup distance (meters)
- **demand mix**: merchant-driven versus residential-driven support at that point

Use the % to compare two parking choices under the same settings: higher % means the model thinks that spot is better *relative to nearby alternatives*.

## Legal / attribution

- The app uses `MapLibre GL JS` with either `MapTiler` vector tiles or the public `MapLibre` demo style for development.
- Map data © OpenStreetMap contributors.

## Limitations

- OSM POIs are incomplete in some areas.
- Many OSM merchants do not publish `opening_hours`; those restaurants remain eligible because the dataset does not provide a reliable closed/open state.
- “Lane-accurate” geometry depends on OSM tagging; many roads will not include lane-level detail.
- This does **not** know real order volume, real-time supply, DoorDash acceptance, batching, zones, or anything private.
- Treat the heatmap as *relative* signal, not a guarantee.
