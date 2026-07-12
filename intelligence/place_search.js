// Phase G place search + map-integration core.
//
// A small, deterministic coordinator between map interactions and the place
// provider. It provides:
//   - searchPlaces(query, bbox): typed/area search via the active provider,
//   - requestByClick({ id, lat, lon, bbox }): a debounced map-click lookup that
//     coalesces rapid clicks so only the final one triggers a provider fetch,
//   - onPlace(callback): subscribe to resolved places (the host opens the card).
//
// Design notes / approximations (documented inline):
// - All timing is injected via a scheduler ({ schedule, cancel }) so debouncing
//   is deterministic under Node tests. The browser default uses setTimeout.
// - Debounce + supersession: each requestByClick cancels the prior pending
//   request and resolves it as { superseded: true } (so callers never hang),
//   guaranteeing at most one provider fetch per debounce window. This is the
//   "debouncing prevents duplicate fetches" guarantee.
// - Cache-first: when a cache is supplied, lookups by id consult it before the
//   provider, and resolved places are written back.
// - Map clicks rarely carry a provider id, so a click without an id falls back
//   to a bounding-box search and picks the geographically nearest result.

const EARTH_RADIUS_METERS = 6371000;
const DEFAULT_DEBOUNCE_MS = 220;
const DEFAULT_CLICK_BBOX_RADIUS_METERS = 60;

const defaultScheduler = Object.freeze({
  schedule(fn, ms) {
    return typeof setTimeout !== "undefined" ? setTimeout(fn, ms) : null;
  },
  cancel(handle) {
    if (handle !== null && typeof clearTimeout !== "undefined") {
      clearTimeout(handle);
    }
  },
});

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Build a small bbox around a point for a click-driven area search.
function boundingBoxAround(lat, lon, radiusMeters = DEFAULT_CLICK_BBOX_RADIUS_METERS) {
  const centerLat = toFiniteNumber(lat);
  const centerLon = toFiniteNumber(lon);
  const radius = Math.max(1, toFiniteNumber(radiusMeters, DEFAULT_CLICK_BBOX_RADIUS_METERS));
  if (centerLat === null || centerLon === null) {
    return null;
  }
  const latDelta = (radius / EARTH_RADIUS_METERS) * (180 / Math.PI);
  const lonDelta = latDelta / Math.max(0.000001, Math.cos((centerLat * Math.PI) / 180));
  return {
    minLat: centerLat - latDelta,
    minLon: centerLon - lonDelta,
    maxLat: centerLat + latDelta,
    maxLon: centerLon + lonDelta,
  };
}

function pickNearest(places, lat, lon) {
  const centerLat = toFiniteNumber(lat);
  const centerLon = toFiniteNumber(lon);
  const list = Array.isArray(places) ? places : [];
  if (list.length === 0) {
    return null;
  }
  if (centerLat === null || centerLon === null) {
    return list[0];
  }
  return list.reduce((best, place) => {
    const distance = haversineMeters(centerLat, centerLon, place.lat, place.lon);
    if (!best || distance < best.distance) {
      return { place, distance };
    }
    return best;
  }, null)?.place ?? null;
}

function matchesQuery(place, normalizedQuery) {
  if (!normalizedQuery) {
    return true;
  }
  const name = String(place.name || "").toLowerCase();
  const category = String(place.category || "").toLowerCase();
  return name.includes(normalizedQuery) || category.includes(normalizedQuery);
}

function createPlaceSearch({
  getProvider,
  cache = null,
  onPlace = null,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  scheduler = defaultScheduler,
  clickBBoxRadiusMeters = DEFAULT_CLICK_BBOX_RADIUS_METERS,
} = {}) {
  if (typeof getProvider !== "function") {
    throw new TypeError("createPlaceSearch requires a getProvider function");
  }

  const subscribers = new Set();
  if (typeof onPlace === "function") {
    subscribers.add(onPlace);
  }

  let pending = null; // { handle, resolve }
  const diagnostics = { fetches: 0, cacheHits: 0, clicks: 0, superseded: 0, searches: 0 };

  function emitPlace(place) {
    for (const subscriber of subscribers) {
      try {
        subscriber(place);
      } catch {
        // A faulty subscriber must not break the search pipeline.
      }
    }
  }

  async function executeLookup(request) {
    const provider = getProvider();
    if (!provider) {
      return { place: null, fromCache: false };
    }

    if (request.id && cache && typeof cache.getPlace === "function") {
      const cached = cache.getPlace(request.id);
      if (cached) {
        diagnostics.cacheHits += 1;
        return { place: cached, fromCache: true };
      }
    }

    let place = null;
    if (request.id) {
      diagnostics.fetches += 1;
      place = await provider.fetchPlaceById(request.id, { lat: request.lat, lon: request.lon });
    } else if (request.bbox) {
      diagnostics.fetches += 1;
      const results = await provider.searchPlacesByBBox(request.bbox);
      place = pickNearest(results, request.lat, request.lon);
    }

    if (place && cache && typeof cache.putPlace === "function") {
      cache.putPlace(place);
    }
    return { place, fromCache: false };
  }

  function supersede() {
    if (pending) {
      diagnostics.superseded += 1;
      const { handle, resolve } = pending;
      pending = null;
      scheduler.cancel(handle);
      resolve({ place: null, superseded: true, fromCache: false });
    }
  }

  // Debounced map-click lookup. Resolves { place, superseded, fromCache }.
  // Rapid successive calls supersede earlier ones; only the last triggers a
  // provider fetch after the debounce window.
  function requestByClick(rawRequest = {}) {
    diagnostics.clicks += 1;
    const lat = toFiniteNumber(rawRequest.lat);
    const lon = toFiniteNumber(rawRequest.lon);
    const request = {
      id: typeof rawRequest.id === "string" && rawRequest.id ? rawRequest.id : null,
      lat,
      lon,
      bbox:
        rawRequest.bbox ||
        (rawRequest.id ? null : boundingBoxAround(lat, lon, clickBBoxRadiusMeters)),
    };

    return new Promise((resolve) => {
      supersede();
      const handle = scheduler.schedule(async () => {
        pending = null;
        const { place, fromCache } = await executeLookup(request);
        if (place) {
          emitPlace(place);
        }
        resolve({ place, superseded: false, fromCache });
      }, debounceMs);
      pending = { handle, resolve };
    });
  }

  // Typed / area search. Returns provider places filtered by a name/category
  // substring query. An empty query returns all results in the bbox.
  async function searchPlaces(query, bbox) {
    diagnostics.searches += 1;
    const provider = getProvider();
    if (!provider || !bbox) {
      return [];
    }
    const results = await provider.searchPlacesByBBox(bbox);
    const normalizedQuery = String(query || "").trim().toLowerCase();
    return (Array.isArray(results) ? results : []).filter((place) => matchesQuery(place, normalizedQuery));
  }

  function onPlaceResolved(callback) {
    if (typeof callback === "function") {
      subscribers.add(callback);
    }
    return () => subscribers.delete(callback);
  }

  function cancelPending() {
    supersede();
  }

  function getDiagnostics() {
    return { ...diagnostics, hasPending: Boolean(pending) };
  }

  return {
    requestByClick,
    searchPlaces,
    onPlace: onPlaceResolved,
    cancelPending,
    getDiagnostics,
  };
}

export {
  createPlaceSearch,
  boundingBoxAround,
  pickNearest,
  DEFAULT_DEBOUNCE_MS,
};
