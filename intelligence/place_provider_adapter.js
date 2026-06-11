// Phase G place provider adapter.
//
// Defines a small, stable provider interface and a deterministic synthetic
// provider used for tests and offline development. Real providers (Google
// Places, Foursquare, Overpass, etc.) are registered at runtime through
// createProviderRegistry / setActiveProvider and must conform to the same
// interface so the cache, photos handler, and UI never branch on provider type.
//
// Interface (all methods async, all return normalized place model objects):
//   - fetchPlaceById(id, options) -> place | null
//   - searchPlacesByBBox(bbox, options) -> place[]            (bbox = {minLat,minLon,maxLat,maxLon})
//   - fetchPhotos(idOrPlace, options) -> photoRef[]           (metadata only)
//   - describe() -> { id, label, cachePolicy }                (TOS/cache caveats)
//
// Security / TOS notes (documented inline):
// - No API keys are committed. Real adapters receive credentials at runtime via
//   the config hook (referrer-restricted client keys) or a reviewed serverless
//   proxy. The synthetic provider needs no credentials.
// - cachePolicy advertises what a provider permits caching. The place cache and
//   photos handler consult this (e.g. Google Places forbids caching most fields
//   beyond place_id), so adapters MUST declare honest caching limits.

import { normalizePlace, normalizePhotoRef } from "./place_model.js";

const EARTH_RADIUS_METERS = 6371000;

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeBBox(bbox) {
  if (!bbox || typeof bbox !== "object") {
    return null;
  }
  const minLat = toFiniteNumber(bbox.minLat ?? bbox.south);
  const minLon = toFiniteNumber(bbox.minLon ?? bbox.west);
  const maxLat = toFiniteNumber(bbox.maxLat ?? bbox.north);
  const maxLon = toFiniteNumber(bbox.maxLon ?? bbox.east);
  if (minLat === null || minLon === null || maxLat === null || maxLon === null) {
    return null;
  }
  if (minLat > maxLat || minLon > maxLon) {
    return null;
  }
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 || Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) {
    return null;
  }
  return { minLat, minLon, maxLat, maxLon };
}

function isPlaceInBBox(place, bbox) {
  return (
    place.lat >= bbox.minLat &&
    place.lat <= bbox.maxLat &&
    place.lon >= bbox.minLon &&
    place.lon <= bbox.maxLon
  );
}

// Deterministic 32-bit string hash (FNV-1a). Used to derive stable synthetic
// attributes from a place id so the mock provider is fully reproducible.
function hashString(value) {
  let hash = 0x811c9dc5;
  const text = String(value);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pseudoRandom(seed) {
  // Mulberry32: deterministic PRNG seeded by the place id hash.
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYNTHETIC_CATEGORIES = Object.freeze([
  "gas_station",
  "convenience_store",
  "cafe",
  "restaurant",
  "car_wash",
]);

// Build one deterministic synthetic place from an id + coordinates.
function buildSyntheticPlace(id, lat, lon, fetchedTs) {
  const seed = hashString(id);
  const rng = pseudoRandom(seed);
  const category = SYNTHETIC_CATEGORIES[seed % SYNTHETIC_CATEGORIES.length];
  const rating = Math.round((3 + rng() * 2) * 10) / 10;
  const phoneDigits = String(1000 + (seed % 9000)).padStart(4, "0");
  const photoCount = 1 + (seed % 3);

  return normalizePlace({
    id,
    name: `Synthetic ${category.replace(/_/g, " ")} ${seed % 1000}`,
    lat,
    lon,
    category,
    phone: `(909) 555-${phoneDigits}`,
    website: `https://synthetic.test/place/${id}`,
    rating,
    hours: {
      periods: [
        { day: 1, open: "0600", close: "2200" },
        { day: 0, open: "0700", close: "2100" },
      ],
      weekdayText: ["Sunday: 7:00 AM – 9:00 PM", "Monday: 6:00 AM – 10:00 PM"],
    },
    photos: Array.from({ length: photoCount }, (_, index) => ({
      ref: `${id}:photo:${index}`,
      width: 1600,
      height: 1200,
      attribution: "Synthetic Provider",
    })),
    lastFetchedTs: fetchedTs,
  });
}

// Synthetic provider: deterministic, offline, credential-free. Seeded with an
// optional fixed place list; otherwise it generates places on demand from the
// requested id/bbox so tests are reproducible without a network.
function createSyntheticPlaceProvider({
  seedPlaces = [],
  now = () => Date.now(),
  gridStepDegrees = 0.01,
  maxBBoxResults = 25,
} = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const seeded = new Map();
  for (const candidate of Array.isArray(seedPlaces) ? seedPlaces : []) {
    try {
      const place = normalizePlace(candidate);
      seeded.set(place.id, place);
    } catch {
      // Skip malformed seed entries.
    }
  }

  function describe() {
    return {
      id: "synthetic",
      label: "Synthetic Place Provider",
      cachePolicy: {
        // The synthetic provider permits caching everything; real adapters must
        // declare honest limits here.
        cacheableFields: "all",
        cacheThumbnails: true,
        maxCacheTtlMs: null,
      },
    };
  }

  async function fetchPlaceById(id, { lat, lon } = {}) {
    const key = String(id ?? "");
    if (!key) {
      return null;
    }
    if (seeded.has(key)) {
      return seeded.get(key);
    }
    // Derive deterministic coordinates from the id when none are supplied.
    const seed = hashString(key);
    const derivedLat = toFiniteNumber(lat, 34.05 + ((seed % 1000) / 1000) * 0.1);
    const derivedLon = toFiniteNumber(lon, -117.65 + (((seed >> 10) % 1000) / 1000) * 0.1);
    return buildSyntheticPlace(key, derivedLat, derivedLon, clock());
  }

  async function searchPlacesByBBox(bbox, { limit = maxBBoxResults } = {}) {
    const normalized = normalizeBBox(bbox);
    if (!normalized) {
      return [];
    }

    const results = [];
    // First include any seeded places that fall inside the bbox.
    for (const place of seeded.values()) {
      if (isPlaceInBBox(place, normalized)) {
        results.push(place);
      }
    }

    // Then fill with deterministic grid-sampled synthetic places.
    const step = Math.max(0.001, toFiniteNumber(gridStepDegrees, 0.01));
    const fetchedTs = clock();
    for (let lat = normalized.minLat; lat <= normalized.maxLat && results.length < limit; lat += step) {
      for (let lon = normalized.minLon; lon <= normalized.maxLon && results.length < limit; lon += step) {
        const cellLat = Math.round(lat / step) * step;
        const cellLon = Math.round(lon / step) * step;
        const id = `syn:${cellLat.toFixed(4)}:${cellLon.toFixed(4)}`;
        if (seeded.has(id)) {
          continue;
        }
        results.push(buildSyntheticPlace(id, Number(cellLat.toFixed(6)), Number(cellLon.toFixed(6)), fetchedTs));
      }
    }

    return results
      .slice(0, limit)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function fetchPhotos(idOrPlace) {
    const id = typeof idOrPlace === "string" ? idOrPlace : idOrPlace?.id;
    if (!id) {
      return [];
    }
    if (typeof idOrPlace === "object" && Array.isArray(idOrPlace.photoRefs) && idOrPlace.photoRefs.length > 0) {
      return idOrPlace.photoRefs.map(normalizePhotoRef).filter(Boolean);
    }
    const place = await fetchPlaceById(id);
    return place ? place.photoRefs.slice() : [];
  }

  return { describe, fetchPlaceById, searchPlacesByBBox, fetchPhotos };
}

const REQUIRED_PROVIDER_METHODS = Object.freeze(["fetchPlaceById", "searchPlacesByBBox", "fetchPhotos"]);

function isValidProvider(provider) {
  return Boolean(provider) && REQUIRED_PROVIDER_METHODS.every((method) => typeof provider[method] === "function");
}

// Runtime registry: register named providers and select the active one. A
// synthetic provider is always registered so the app works offline/in tests.
// Real adapters are registered by the host at runtime (with referrer-restricted
// keys or a serverless proxy); credentials never live in this module.
function createProviderRegistry({ defaultProvider = createSyntheticPlaceProvider() } = {}) {
  const providers = new Map();
  let activeId = null;

  function register(id, provider) {
    const key = String(id ?? "");
    if (!key) {
      throw new TypeError("provider id must be a non-empty string");
    }
    if (!isValidProvider(provider)) {
      throw new TypeError(`provider "${key}" must implement ${REQUIRED_PROVIDER_METHODS.join(", ")}`);
    }
    providers.set(key, provider);
    if (activeId === null) {
      activeId = key;
    }
    return provider;
  }

  function setActiveProvider(id) {
    const key = String(id ?? "");
    if (!providers.has(key)) {
      throw new Error(`unknown provider "${key}"`);
    }
    activeId = key;
    return providers.get(key);
  }

  function getActiveProvider() {
    return activeId ? providers.get(activeId) : null;
  }

  function getActiveProviderId() {
    return activeId;
  }

  function listProviders() {
    return Array.from(providers.keys());
  }

  // Always make a synthetic provider available under "synthetic".
  register("synthetic", defaultProvider);

  return {
    register,
    setActiveProvider,
    getActiveProvider,
    getActiveProviderId,
    listProviders,
  };
}

export {
  createSyntheticPlaceProvider,
  createProviderRegistry,
  isValidProvider,
  normalizeBBox,
  REQUIRED_PROVIDER_METHODS,
};
