# Work Order 3 Acceptance

Branch: `agent/task-1787807004-wo3`

Stack base: `agent/task-1787807004-wo2` (WO-2 draft PR #22)

## Scope

- Cancel fetch owners when navigation or map appearance context changes.
- Cancel map-data fetches when the map moves.
- Reject late map-data and route results by generation or request token.
- Preserve last known-good map data while replacement work is pending or stale.
- Document provider ownership and lifecycle contracts.

## Acceptance evidence

- [x] A late Overpass response after map movement is discarded by generation.
- [x] The tested stale response cannot replace state, parameters, statistics, or
  map-source features.
- [x] Overpass abort is terminal and does not retry fallback endpoints.
- [x] Navigation mode changes notify the lifecycle owner only on transitions.
- [x] Route cancellation aborts and releases its controller.
- [x] A late route response cannot apply after its request token is cancelled.
- [x] A late geolocation result cannot resurrect a superseded navigation start.
- [x] Superseded geolocation cannot overwrite newer location state.
- [x] Cancelled generic route failures normalize to `AbortError`.
- [x] Cancelled Overpass JSON cannot replace a newer cache entry.
- [x] A provider failure aborts pending siblings in the shared data load.
- [x] Map-data invalidation begins on `movestart`, before stale data can apply
  during an active camera move.
- [x] Results are rejected while `map.isMoving()` and generation advances again
  at `moveend`, covering loads started mid-motion.
- [x] Cancelled place-sheet route summaries leave loading state and reject late
  completions.
- [x] Cancelled reroutes preserve the last successful throttle markers and clear
  transient status.
- [x] Replacement navigation stops the old location watch and queued callbacks
  are rejected by watch generation.
- [x] A failed replacement restores a fresh watch for the retained prior route.
- [x] A slow non-forced reroute is not replaced by each location update.
- [x] Search-started navigation ignores expected `AbortError` cancellation.
- [x] Submitted address search shares the abort and sequence owner used by
  suggestions.
- [x] Submitted search clears pending autocomplete debounce before fetching.
- [x] Data, search, route, and place-summary fetch owners cancel on navigation
  or map appearance mode changes.
- [x] Runtime syntax checks pass.
- [x] Aggregator baseline increased visibly from 218 to 233 PASS lines.
- [x] Clean aggregator run observed 233 PASS lines, 0 FAIL lines, and exit 0.

## Risk and rollback

Risk is cancellation timing around rapid map and navigation transitions. The
generation/token checks are independent of provider abort compliance. Rollback
is a revert of the focused WO-3 commit, restoring the prior controller-only
behavior.
