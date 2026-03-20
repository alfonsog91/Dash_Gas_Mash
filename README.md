# Dash Parking Estimate Map (OSM)

Local, **public-data** map tool that renders a real OpenStreetMap basemap and overlays a **parking opportunity-likelihood heat surface** based on transparent heuristics.

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

That is why this app does not treat “hot” areas as automatically better. Instead, it scores locations by public, interpretable proxies such as nearby merchant concentration, distance-decay effects, pickup cost, and a rough competition penalty. The result is a descriptive map of local positional quality, not a claim about DoorDash’s internal dispatch state.

The governing idea is simple:

DoorDash’s map treats drivers as fluid units to be redistributed.  
DGM treats the driver as a fixed observer inside a changing field.

Once that distinction is clear, the mismatch many drivers feel becomes easier to explain. A map can glow brightly and still be a poor place to wait. Chasing heat can feel wrong because the platform may be solving for coverage restoration while the driver is solving for efficient, low-friction execution.

DGM does not attempt to predict individual assignments or override platform behavior; it provides a stable lens for interpreting public signals under uncertainty.

## What it does

- Loads **food merchant proxies** from OpenStreetMap via Overpass (amenity: restaurant / fast_food / cafe / food_court)
- Loads **parking candidate proxies** from OpenStreetMap (amenity=parking and parking=*)
- Excludes restaurants with parseable OSM `opening_hours` tags when they are currently closed in the client’s local time
- Builds a heat surface over the current map view using a calibrated probability proxy:

First compute a merchant "intensity":

$$\lambda(p)=\sum_{r \in \text{restaurants}} w(r, h) \cdot e^{-d(p,r)/\tau}$$

Then map that to a probability over a horizon $T$ minutes (calibrated to the current view):

$$P(\text{any order in }T)=1-\exp\left(-k \cdot \frac{\lambda_{eff}(p)}{\lambda_{ref}} \cdot T\right)$$

Optional “ML-style predictor” mode replaces the proportional rate with a positive rate function:

$$rate(p)=softplus\left(b+\u03b2\cdot\log\left(\frac{\lambda_{eff}(p)}{\lambda_{ref}}\right)\right)$$
$$P(\text{any order in }T)=1-\exp\left(-rate(p)\cdot T\right)$$

And a “good order” proxy adds a transparent quality factor for **short pickup + higher-tip proxy**:

$$P(\text{good in }T)=P(\text{any in }T) \cdot (0.25 + 0.75\cdot quality(p))$$

Where:
- $p$ is a potential parking point
- $r$ is a merchant point
- $d(\cdot)$ is great-circle distance (Haversine)
- $\tau$ is a tunable distance-decay parameter (meters)
- $w(r,h)$ is a simple time-of-night weighting (late-night: fast_food up, cafes down)

It also ranks parking lots in the current view using the same score.

## What “probability” means here

This app **does not** have real DoorDash order arrivals, courier supply, acceptance rates, batching, zones, or dispatch constraints.
So the “probability” is a **calibrated, view-relative estimate** driven by public proxies:
- More nearby merchants (and late-night weighting) ⇒ higher modeled arrival opportunity
- Optional “competition strength” applies a penalty using nearby parking density as a crude proxy (set to 0 to disable)
- “Good order” is currently tuned to: **short pickup distance** + **higher-ticket cuisine/type proxy** (tune via “Tip emphasis”)

If enabled, the **MIP optimizer** selects a *set* of $K$ suggested parking lots to maximize predicted value while keeping them spread out (minimum separation constraint).

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

## Run locally (no Node required)

This is a static site. You just need Python.

From the workspace folder:

- PowerShell on Windows: `.\start.ps1`
- Manual fallback in PowerShell: `& .\.venv\Scripts\python.exe -m http.server 5173`
- Then open `http://localhost:5173/` in your browser

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
- **Tip emphasis (vs short pickup)**: Blends two “good order” proxies:
  - short pickup distance (expected distance to nearby merchants)
  - a higher-ticket “ticket proxy” inferred from OSM cuisine/type tags
- **Use ML-style predictor**: Changes the rate curve shape using a softplus rate function (still a public proxy; not trained on DoorDash data).
- **ML sensitivity (\u03b2)**: How aggressively the ML-style predictor boosts high-intensity areas.
- **Use MIP optimizer for top parking set**: Picks a set of $K$ parking lots maximizing predicted value while enforcing a minimum separation constraint.
- **Suggested spots (K)** and **Min separation**: How many suggestions and how spread out they should be.

## How to interpret the percentages

The UI shows **Proxy Score ($T$ min)**, which corresponds to **$P(\u200bgood\u200b\ in\ T)$** in the math. This is:
- **Calibrated to the current view** (relative to what’s on screen), because the app does not know real DoorDash order arrival rates.
- Driven by public proxies: nearby merchants, time-of-night weighting, and optional competition penalty.

When you click a point, the popup breaks it down:
- **P(any order)**: modeled chance of *any* order in $T$
- **ticket proxy**: a 0–100% ticket-size proxy score (from OSM cuisine/type tags; heuristic)
- **pickup**: estimated pickup distance (meters)

Use the % to compare two parking choices under the same settings: higher % means the model thinks that spot is better *relative to nearby alternatives*.

## Legal / attribution

- Basemap tiles are from OpenStreetMap’s public tile server in dev mode. For redistribution/production or heavy usage, use your own tile provider that permits your use case.
- Map data © OpenStreetMap contributors.

## Limitations

- OSM POIs are incomplete in some areas.
- Many OSM merchants do not publish `opening_hours`; those restaurants remain eligible because the dataset does not provide a reliable closed/open state.
- “Lane-accurate” geometry depends on OSM tagging; many roads will not include lane-level detail.
- This does **not** know real order volume, real-time supply, DoorDash acceptance, batching, zones, or anything private.
- Treat the heatmap as *relative* signal, not a guarantee.
