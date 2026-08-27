# Work Order 3 Validation

Date: 2026-08-26

Stack base: `4b5c43da532e0eb5f35edf4f9b76cec07c2746de`

## Baseline defect

The first late-Overpass characterization failed before implementation:

```text
FAIL late Overpass results after a map move are discarded by generation:
runtime exposes its load generation
Results: 0 passed, 1 failed
Exit: 1
```

After generation support was added, a stronger last-known-good assertion also
failed before write timing was corrected:

```text
FAIL late Overpass results after a map move are discarded by generation:
stale parameters never overwrite state
Results: 0 passed, 1 failed
Exit: 1
```

The final regression advances generation 1 to generation 2 on map movement,
then resolves all three stale Overpass operations even though their signals are
aborted. Generation 1 returns `discarded` and performs no fetched-result state
or map-source write.

## Cancellation checks

Observed focused results:

```text
PASS late Overpass results after a map move are discarded by generation
PASS propagates abort without retrying another endpoint
PASS navigation mode changes notify the lifecycle owner
PASS route request cancellation aborts and clears the owned controller
PASS late route response cannot apply after its request token is cancelled
PASS newer navigation owns routing when geolocation resolves out of order
PASS cancelled route normalizes a late provider rejection to AbortError
PASS cancelled late JSON cannot overwrite a newer cache entry
PASS a provider failure aborts pending siblings before releasing the load
PASS cancelled place route summary leaves loading and rejects a late result
PASS a load completed during camera motion cannot apply transitional bounds
PASS cancelled reroute preserves successful throttle state and clears pending status
PASS replacement navigation stops the old watch and ignores its queued callback
PASS a slow reroute is not replaced by each location update
PASS failed replacement navigation restores the previous route watch
```

The Overpass abort check initially produced 1 pass and 1 failure before abort
was made terminal. The navigation notification and explicit route cancellation
checks each failed before their owner APIs were implemented.

The late-route fixture was advanced through one microtask so it cancels an
installed request token rather than cancelling before the fetch begins.

An independent staged-diff review found six lifecycle gaps: pre-fetch navigation
ownership, post-parse Overpass cache replacement, sibling-provider cleanup,
late map-move invalidation, stuck place-summary loading state, and generic late
route errors after cancellation. Each was corrected before commit and covered
by a focused regression where the behavior is Node-verifiable. Map invalidation
was moved from `moveend` to `movestart` and is additionally syntax-checked here;
browser event dispatch is not claimed.

A second independent staged-diff review found three remaining integration gaps:
loads begun mid-motion, cancelled reroute throttle/status state, and expected
search-navigation cancellation surfacing as an error. The first two received
focused Node regressions. The search caller now ignores `AbortError` and is
covered by syntax and full-suite validation; browser interaction is not claimed.

A final review found four more route/search ownership gaps: stale geolocation
side effects, old-watch callbacks during navigation replacement, non-forced
reroute churn, and submitted search outside the abort owner. Geolocation now
checks ownership before writing shared location, replacement invalidates its old
watch generation, pending non-forced reroutes are retained, and submitted search
uses the shared search controller and sequence. The first three are covered in
the routing runner; submitted-search browser interaction is not claimed.

The final narrow verification found that failed replacement could retain the
old route without a watch and that an autocomplete timer could cancel an
immediate form submission. Failed replacement now restores a generation-fresh
watch only when the prior route is still current and no newer request owns
routing. Submitted search cancels and clears the debounce timer before creating
its controller. The watch path has a focused regression; the browser form path
is syntax/full-suite validated without a browser execution claim.

## Complete validation

Commands:

```text
node --check app_v2.js
node --check data_scoring_runtime.js
node --check map_interaction_runtime.js
node --check overpass.js
node --check routing_runtime.js
node eng/run_all_tests.mjs
```

Observed result:

```text
Test summary: PASS 233, FAIL 0
Recorded baseline: PASS 233
Exit: 0
```

No browser or device result is claimed by this Node work order.
