// Phase G bounded place cache.
//
// A small, deterministic client-side cache for normalized places. It combines:
//   - a bounded in-memory LRU (capacity = maxRecords),
//   - per-entry TTL expiry driven by an injectable clock, and
//   - optional persistence to IndexedDB (preferred) or localStorage (fallback).
//
// Design notes / approximations (documented inline):
// - Recency: getPlace() touches the LRU (moves the entry to most-recent).
//   queryNearby() is a bulk spatial read and intentionally does NOT touch the
//   LRU, so scanning the cache cannot scramble eviction order.
// - TTL is measured against the cache's own clock (now()) captured at put time,
//   not the provider's lastFetchedTs, so freshness survives provider clock skew.
//   storedAt is persisted so TTL is honored across reloads.
// - Persistence writes a bounded full snapshot (maxRecords is small). This is
//   simpler and safer than per-record IndexedDB transactions and is acceptable
//   for a client cache of this size.
// - queryNearby uses a haversine great-circle distance (spherical-earth
//   approximation; ignores ellipsoidal flattening), which is well within the
//   accuracy needed for nearby-place lookups.
// - Privacy: only bounded place metadata is cached. No raw user traces or
//   identifiers are stored.

import { normalizePlace, serializePlace, deserializePlace } from "./place_model.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const EARTH_RADIUS_METERS = 6371000;

function validatePositiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return Math.trunc(number);
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
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

// Bounded place cache. `storage` is an optional async adapter (see
// createBrowserPlaceStorage); when omitted the cache is purely in-memory.
function createPlaceCache({
  maxRecords = DEFAULT_MAX_RECORDS,
  ttlMs = DEFAULT_TTL_MS,
  storage = null,
  now = () => Date.now(),
  autoPersist = false,
} = {}) {
  const capacity = validatePositiveInteger(maxRecords, "maxRecords", DEFAULT_MAX_RECORDS);
  const ttl = validatePositiveInteger(ttlMs, "ttlMs", DEFAULT_TTL_MS);
  const clock = typeof now === "function" ? now : () => Date.now();

  // Map preserves insertion order; we use that as the LRU order (front = oldest).
  const entries = new Map();
  const stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };

  function isExpired(entry, atMs) {
    return atMs - entry.storedAt > ttl;
  }

  function scheduleAutoPersist() {
    if (!autoPersist || !storage) {
      return;
    }
    // Fire-and-forget snapshot; persistence failures must never break the cache.
    Promise.resolve()
      .then(() => persist())
      .catch(() => {});
  }

  function evictIfNeeded() {
    while (entries.size > capacity) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      entries.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  function putPlace(place) {
    const normalized = normalizePlace(place);
    const storedAt = clock();

    // Re-insert at the most-recent position.
    if (entries.has(normalized.id)) {
      entries.delete(normalized.id);
    }
    entries.set(normalized.id, { place: normalized, storedAt });
    evictIfNeeded();
    scheduleAutoPersist();
    return normalized;
  }

  function getPlace(id) {
    const key = typeof id === "string" ? id : String(id ?? "");
    const entry = entries.get(key);
    if (!entry) {
      stats.misses += 1;
      return null;
    }

    if (isExpired(entry, clock())) {
      entries.delete(key);
      stats.expirations += 1;
      stats.misses += 1;
      return null;
    }

    // Touch LRU recency.
    entries.delete(key);
    entries.set(key, entry);
    stats.hits += 1;
    return entry.place;
  }

  function removePlace(id) {
    const key = typeof id === "string" ? id : String(id ?? "");
    const existed = entries.delete(key);
    if (existed) {
      scheduleAutoPersist();
    }
    return existed;
  }

  function queryNearby(lat, lon, radiusMeters) {
    const centerLat = toFiniteNumber(lat);
    const centerLon = toFiniteNumber(lon);
    const radius = toFiniteNumber(radiusMeters);
    if (centerLat === null || centerLon === null || radius === null || radius <= 0) {
      return [];
    }

    const atMs = clock();
    const matches = [];
    for (const [key, entry] of entries) {
      if (isExpired(entry, atMs)) {
        // Prune lazily so stale rows do not accumulate.
        entries.delete(key);
        stats.expirations += 1;
        continue;
      }
      const distanceMeters = haversineMeters(centerLat, centerLon, entry.place.lat, entry.place.lon);
      if (distanceMeters <= radius) {
        matches.push({ place: entry.place, distanceMeters: round2(distanceMeters) });
      }
    }

    return matches.sort(
      (left, right) =>
        left.distanceMeters - right.distanceMeters || left.place.id.localeCompare(right.place.id)
    );
  }

  function clear() {
    entries.clear();
    scheduleAutoPersist();
  }

  function size() {
    return entries.size;
  }

  function getMetadata() {
    return {
      size: entries.size,
      maxRecords: capacity,
      ttlMs: ttl,
      storageKind: storage?.kind || "none",
      hits: stats.hits,
      misses: stats.misses,
      evictions: stats.evictions,
      expirations: stats.expirations,
    };
  }

  // Load a persisted snapshot, dropping any already-expired rows. Returns the
  // number of live records hydrated. Never throws on storage errors.
  async function hydrate() {
    if (!storage || typeof storage.load !== "function") {
      return 0;
    }

    let records = [];
    try {
      records = await storage.load();
    } catch {
      return 0;
    }

    if (!Array.isArray(records)) {
      return 0;
    }

    const atMs = clock();
    let loaded = 0;
    for (const record of records) {
      try {
        const storedAt = toFiniteNumber(record?.storedAt);
        const place = deserializePlace(record?.place ?? record);
        const effectiveStoredAt = storedAt === null ? atMs : storedAt;
        if (atMs - effectiveStoredAt > ttl) {
          continue;
        }
        if (entries.has(place.id)) {
          entries.delete(place.id);
        }
        entries.set(place.id, { place, storedAt: effectiveStoredAt });
        loaded += 1;
      } catch {
        // Skip malformed rows; a poisoned record must not block hydration.
      }
    }
    evictIfNeeded();
    return loaded;
  }

  // Persist the current live snapshot. Never throws on storage errors.
  async function persist() {
    if (!storage || typeof storage.save !== "function") {
      return false;
    }

    const records = [];
    for (const entry of entries.values()) {
      records.push({ storedAt: entry.storedAt, place: serializePlace(entry.place) });
    }

    try {
      await storage.save(records);
      return true;
    } catch {
      return false;
    }
  }

  return {
    getPlace,
    putPlace,
    removePlace,
    queryNearby,
    clear,
    size,
    getMetadata,
    hydrate,
    persist,
  };
}

// Snapshot-based localStorage adapter. Stores the whole cache under one key as
// JSON. Suitable as the IndexedDB fallback for small, bounded caches.
function createLocalStoragePlaceStorage(localStorageLike, namespace = "dgm.placeCache") {
  if (!localStorageLike || typeof localStorageLike.getItem !== "function") {
    return null;
  }
  const key = String(namespace);

  return {
    kind: "localstorage",
    async load() {
      const raw = localStorageLike.getItem(key);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    },
    async save(records) {
      localStorageLike.setItem(key, JSON.stringify(Array.isArray(records) ? records : []));
    },
    async clear() {
      localStorageLike.removeItem(key);
    },
  };
}

// Snapshot-based IndexedDB adapter (browser-only, best-effort). Stores the whole
// cache as a single record. Returns null when IndexedDB is unavailable so the
// caller can fall back to localStorage.
function createIndexedDbPlaceStorage(indexedDbLike, { dbName = "dgmPlaceCache", storeName = "snapshot", key = "places" } = {}) {
  if (!indexedDbLike || typeof indexedDbLike.open !== "function") {
    return null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDbLike.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("indexeddb open failed"));
    });
  }

  function runTransaction(mode, operate) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          let result;
          try {
            result = operate(store);
          } catch (error) {
            reject(error);
            return;
          }
          tx.oncomplete = () => {
            db.close();
            resolve(result && typeof result.then === "function" ? result : result?.result);
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error || new Error("indexeddb transaction failed"));
          };
        })
    );
  }

  return {
    kind: "indexeddb",
    async load() {
      const value = await runTransaction("readonly", (store) => store.get(key));
      return Array.isArray(value) ? value : [];
    },
    async save(records) {
      await runTransaction("readwrite", (store) => store.put(Array.isArray(records) ? records : [], key));
    },
    async clear() {
      await runTransaction("readwrite", (store) => store.delete(key));
    },
  };
}

// Pick the best available storage adapter: IndexedDB preferred, localStorage
// fallback, then null (in-memory only). Safe to call in Node (returns null).
function createBrowserPlaceStorage({
  indexedDB = typeof globalThis !== "undefined" ? globalThis.indexedDB : null,
  localStorage = typeof globalThis !== "undefined" ? globalThis.localStorage : null,
  namespace = "dgm.placeCache",
} = {}) {
  const idb = createIndexedDbPlaceStorage(indexedDB, { dbName: namespace });
  if (idb) {
    return idb;
  }
  return createLocalStoragePlaceStorage(localStorage, namespace);
}

export {
  createPlaceCache,
  createLocalStoragePlaceStorage,
  createIndexedDbPlaceStorage,
  createBrowserPlaceStorage,
  DEFAULT_MAX_RECORDS,
  DEFAULT_TTL_MS,
};
