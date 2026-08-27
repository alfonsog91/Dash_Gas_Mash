# Provider and Runtime Lifecycle

## Scope

This document defines request ownership, cancellation, and stale-result behavior
for browser fetch operations and map-data application. It does not change the
meaning of the Opportunity Score or make provider availability guarantees.

## Ownership

| Operation | Owner | Cancellation | Stale-result rule |
| --- | --- | --- | --- |
| OSM food, parking, residential | data scoring runtime | shared load `AbortController` | load generation must still be current |
| Static Census anchors | data scoring runtime | shared load `AbortController` | load generation must still be current |
| Open-Meteo weather | data scoring runtime | shared load `AbortController` | load generation must still be current |
| Mapbox/Nominatim search | search runtime in `app_v2.js` | search `AbortController` | search sequence must still be current |
| OSRM route | routing runtime | route `AbortController` | cancelled owner cannot apply its fetch result |
| Place-sheet route summaries | map interaction runtime | per-summary `AbortController` | controller must remain the active token |

Only an owner creates, replaces, aborts, or releases its controller. Callers
request cancellation through the owner's public operation rather than mutating
the controller directly.

## Data-load lifecycle

`createDataScoringRuntime()` owns a monotonically increasing load generation.

1. `loadForView()` aborts the previous controller, increments the generation,
   and captures a new controller, signal, and generation locally.
2. OSM, optional Census, and optional weather operations receive that signal.
3. The runtime awaits the complete provider set.
4. Before any fetched result clears a layer, updates state, or writes a map
   source, the captured signal must be active and its generation must equal the
   current generation.
5. A current load applies its data and returns
   `{ status: "applied", generation }`.
6. An aborted or superseded load performs no fetched-result writes and returns
   `{ status: "discarded", generation, currentGeneration }`.
7. A current provider failure aborts the shared controller before propagating
  the original error, so pending sibling operations cannot outlive the load.

Starting another load, starting a map move, changing map appearance mode, or
changing navigation context invalidates in-flight data work. Map movement marks
existing data stale; it does not automatically start a replacement provider request.
This preserves the last known-good state until the user or startup lifecycle
requests a new load.

The runtime also rejects a result while `map.isMoving()` is true, and `moveend`
invalidates again. This covers loads started after `movestart` against
transitional camera bounds.

The load button is released only by the controller that still owns the active
load. An older request cannot reset UI owned by a newer request.

## Navigation and mode changes

Navigation start, navigation clear, and actual navigation camera-mode changes
notify the app lifecycle coordinator. Base-map and standard-theme changes call
the same coordinator. The coordinator:

- invalidates and aborts map-data fetches;
- aborts an active geocoding request and advances its result sequence;
- asks the routing runtime to abort and release an active route request; and
- aborts active and comparison place-sheet route summaries.

Ordinary map `moveend` events invalidate only map-data work. Programmatic route
camera movement must not cancel the route operation that caused it.

## Provider contracts

### Overpass

- Requests are POSTed to the configured fallback endpoints.
- Only an HTTP-success JSON object with an `elements` array is accepted.
- Invalid JSON, missing `elements`, non-JSON responses, retryable HTTP status,
  and network failure may move to a fallback endpoint within the existing retry
  budget.
- `AbortError` is terminal. Cancellation is never retried and an already-aborted
  signal never enters backoff.
- Extraction and cache replacement occur only after response validation.

### Census and weather

- Both operations receive the active data-load signal.
- Their provider failures degrade independently to existing fallback behavior
  only while the load generation remains current.
- A superseded generation cannot publish fallback status, provenance, or values.

### Search

- A new query aborts the previous query and increments `searchSequence`.
- Submitted address searches and suggestion searches share this owner.
- Starting a submitted search cancels its pending autocomplete debounce.
- Closing search or changing navigation/map mode aborts the active request.
- Results render only when their local controller is active and request sequence
  is still current. Closing the overlay also advances that sequence.

### Routing

- A replacement route request aborts and releases the previous route controller.
- Navigation or map-mode context changes can call
  `cancelInFlightRouteRequest()`.
- Controller identity is the navigation request token from origin acquisition
  through route fetch. A result can apply only while its controller remains the
  active token.
- Geolocation is checked for cancellation before it can update shared location
  state.
- Cancellation wins over a non-cooperative provider's later fulfillment or
  failure; both normalize to `AbortError`.
- Reroute origin/time throttle markers commit only after a successful owned
  response. Explicit context cancellation clears transient route status.
- A pending non-forced reroute is retained instead of replaced by every location
  update.
- Navigation replacement stops the prior location watch. A watch generation
  rejects callbacks already queued when that watch was stopped.
- If replacement routing fails while the prior route remains current, that
  route receives a fresh watch before the failure is surfaced.
- Place-sheet route summaries use the same identity rule for active and compare
  requests and leave `loading` when cancelled.
- Abort is not surfaced as a user-facing route failure by existing callers.

## Regression contract

The Node regression in `tests/data-scoring-runtime.test.js` simulates a provider
that resolves after its signal is aborted. A map-move invalidation advances the
generation from 1 to 2. Generation 1 returns `discarded`, cannot replace state,
and cannot write stale features to map sources.
