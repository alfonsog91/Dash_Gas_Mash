# Phase G Place Pages

Date: 2026-06-10
Branch: `feature/upgrade-all-aggressive`

Phase G adds tappable Place Pages: a bottom-sheet "place card" that opens when a
base-map POI is tapped, plus a deterministic place-data stack (model, cache,
photos, provider adapters, search). Place Pages are enabled by default; only
debug diagnostics are gated, behind `shouldExposePhaseDDebug()`.

## Modules

Executable Phase G place code lives under `intelligence/` and `ui/`:

- `intelligence/place_model.js`: canonical place model + normalization/validation and IndexedDB/localStorage serialization.
- `intelligence/place_cache.js`: bounded LRU + TTL cache with optional IndexedDB (preferred) / localStorage persistence.
- `intelligence/place_photos.js`: photoRef pipeline — bounded thumbnails (canvas downscale) + lazy full-res URLs.
- `intelligence/place_provider_adapter.js`: provider interface + synthetic provider + runtime registry.
- `intelligence/place_search.js`: debounced map-click lookup + typed `searchPlaces(query, bbox)`.
- `ui/place_card.js`: dependency-injected bottom-sheet place card.
- `styles/place_card.css`: card styles (lazily injected via a `<link>`; no `index.html` edit).

The app/UI owner remains `app_v2.js`. It lazily constructs the provider registry,
photos handler, place card, and search, wires the map-click handler, and exposes
`window.DGM_RUNTIME.placeCard`.

## Place model

```js
normalizePlace(payload) // -> { id, name, lat, lon, category, phone, website, hours, rating, photoRefs[], lastFetchedTs }
serializePlace(place)   // -> JSON-safe record with schemaVersion
deserializePlace(record)
```

Required fields (`id`, `name`, `lat`, `lon`) throw when missing/invalid; optional
fields degrade to `null`. `hours` is normalized to `{ periods: [{ day, open, close }], weekdayText }`.
`photoRefs` hold metadata only (`{ ref, width, height, attribution }`) — never image bytes.

## Place cache

```js
const cache = createPlaceCache({ maxRecords, ttlMs, storage, now });
cache.putPlace(place);
cache.getPlace(id);                       // touches LRU recency; prunes expired
cache.queryNearby(lat, lon, radiusMeters); // haversine, sorted; does NOT touch LRU
await cache.hydrate();                     // load persisted snapshot (drops expired)
await cache.persist();                     // save snapshot
```

Cache sizing: `maxRecords` defaults to 200, `ttlMs` to 6 hours. Use
`createBrowserPlaceStorage()` to pick IndexedDB → localStorage → in-memory.
Only bounded metadata is cached (privacy). Storage failures never break the cache.

## Photos

```js
const photos = createPlacePhotosHandler({ buildPhotoUrl, loadImage, createCanvas, canCacheThumbnail, isGuardDisabled, shouldExposeDebug });
await photos.getThumbnail(photoRef);      // bounded canvas downscale; cached; placeholder on failure/guard
photos.getFullResolution(photoRef);       // lazy URL; full-res bytes are NEVER cached (TOS)
photos.getPlaceholder();                  // network-free inline placeholder
```

Photo fetching checks the `phaseGPlacePhotos` guard effect and returns a
placeholder when the perf guard has tripped. Thumbnail caching is bounded and can
be disabled per-provider via `canCacheThumbnail`. See `docs/phaseG-security.md`
for provider TOS caveats.

## Provider adapters

```js
const registry = createProviderRegistry();      // "synthetic" registered + active by default
registry.register("google", myAdapter);          // adapter implements the interface below
registry.setActiveProvider("google");
```

Adapter interface (all async, all returning normalized model objects):

- `fetchPlaceById(id, { lat, lon })` → place | null
- `searchPlacesByBBox(bbox, { limit })` → place[]  (bbox = `{ minLat, minLon, maxLat, maxLon }`)
- `fetchPhotos(idOrPlace)` → photoRef[]
- `describe()` → `{ id, label, cachePolicy }`

`describe().cachePolicy` advertises what the provider permits caching; the cache
and photos handler honor it. No API keys are committed. Real adapters receive
credentials at runtime (referrer-restricted client keys or a reviewed serverless
proxy) — see `docs/phaseG-security.md`.

## Search + map integration

```js
const search = createPlaceSearch({ getProvider, cache, onPlace, debounceMs, scheduler });
search.requestByClick({ id, lat, lon, bbox }); // debounced; supersedes prior pending click
await search.searchPlaces(query, bbox);         // typed/area search
```

A POI tap in `app_v2.js` (`tryOpenPhaseGPlaceCardFromClick`) defers to existing
app markers (restaurant/parking/location), then claims base-map POI labels and
feeds the debounced search → place card. Rapid clicks coalesce to a single
provider fetch.

## Place card

`createPlaceCard({ documentLike, windowLike, container, onNavigate, getPhotosHandler, isPhotoGuardDisabled, shouldExposeDebug })`
returns `{ open, close, isOpen, getActiveModel, getDebugMetadata, destroy }`.

The card renders name, category, rating, structured hours, a `tel:` link, a
sandboxed website preview (with a new-tab fallback), a photos carousel
(thumbnail → lazy full-res), and a Navigate button that calls
`startInAppNavigation` (which routes through `createRoutingRuntime` in
`routing_runtime.js` — routing internals are unchanged).

Accessibility: `role="dialog"`, `aria-modal`, focus trap + restore, Escape to
close, ARIA labels on actions. Website-preview security is documented in
`docs/phaseG-security.md`.

## Debug

When `shouldExposePhaseDDebug()` is true (Phase D tuning requested or a localhost
debug host), `window.__DGM_DEBUG.getPhaseGPlaceCardMetadata()` and the photos
handler diagnostics are exposed. They are `null` otherwise.

## Tests

Node (per module):

```sh
node -e "import('./tests/intelligence/place_model.test.js').then(m => m.runPlaceModelTests()).then(r => { if (r.failed) process.exit(1); })"
node -e "import('./tests/intelligence/place_cache.test.js').then(m => m.runPlaceCacheTests()).then(r => { if (r.failed) process.exit(1); })"
node -e "import('./tests/intelligence/place_photos.test.js').then(m => m.runPlacePhotosTests()).then(r => { if (r.failed) process.exit(1); })"
node -e "import('./tests/intelligence/place_provider_adapter.test.js').then(m => m.runPlaceProviderAdapterTests()).then(r => { if (r.failed) process.exit(1); })"
node -e "import('./tests/intelligence/place_search.test.js').then(m => m.runPlaceSearchTests()).then(r => { if (r.failed) process.exit(1); })"
```

Browser smoke: run `./start.ps1`, open `http://localhost:5173/tests/browser-smoke.html`
(the place card check verifies open, ARIA, `tel:`, iframe sandbox, new-tab
fallback, lazy photos, and debug gating).
