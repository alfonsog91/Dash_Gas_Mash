import {
  createPlaceCache,
  createLocalStoragePlaceStorage,
} from "../../intelligence/place_cache.js";

const PASS = "PASS";
const FAIL = "FAIL";

function createLogger() {
  const logEl = typeof document !== "undefined" ? document.getElementById("log") : null;
  const entries = [];
  return {
    write(message) {
      entries.push(message);
      if (logEl) {
        logEl.textContent = `${entries.join("\n")}\n`;
      }
      console.log(message);
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

// Deterministic, injectable clock so TTL tests do not depend on wall time.
function createFakeClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  const clock = () => current;
  clock.advance = (deltaMs) => {
    current += deltaMs;
    return current;
  };
  return clock;
}

// Minimal in-memory localStorage stand-in for persistence tests.
function createFakeLocalStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _dump: () => Object.fromEntries(store),
  };
}

function makePlace(id, lat, lon, extra = {}) {
  return { id, name: `Place ${id}`, lat, lon, category: "gas_station", ...extra };
}

export function runPlaceCacheTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passed += 1;
      log.write(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`${FAIL} ${name}: ${error.message}`);
    }
  }

  return (async () => {
    log.write("DGM Phase G place cache tests");

    await runTest("put then get returns the normalized place", () => {
      const cache = createPlaceCache({ now: createFakeClock() });
      cache.putPlace(makePlace("a", 34.05, -117.65));
      const place = cache.getPlace("a");
      assert(place !== null, "stored place is retrievable");
      assertEqual(place.id, "a", "id round-trips");
      assertEqual(place.lat, 34.05, "lat round-trips");
      assertEqual(cache.getPlace("missing"), null, "unknown id returns null");
    });

    await runTest("LRU evicts the least-recently-used entry past capacity", () => {
      const cache = createPlaceCache({ maxRecords: 2, now: createFakeClock() });
      cache.putPlace(makePlace("a", 34.0, -117.0));
      cache.putPlace(makePlace("b", 34.0, -117.0));
      // Touch "a" so "b" becomes least-recently-used.
      cache.getPlace("a");
      cache.putPlace(makePlace("c", 34.0, -117.0));
      assert(cache.getPlace("b") === null, "least-recently-used entry is evicted");
      assert(cache.getPlace("a") !== null, "recently-touched entry survives");
      assert(cache.getPlace("c") !== null, "newest entry is present");
      assertEqual(cache.getMetadata().evictions, 1, "exactly one eviction is recorded");
    });

    await runTest("expired entries are not returned and are pruned", () => {
      const clock = createFakeClock();
      const cache = createPlaceCache({ ttlMs: 1000, now: clock });
      cache.putPlace(makePlace("a", 34.0, -117.0));
      clock.advance(500);
      assert(cache.getPlace("a") !== null, "entry within TTL is returned");
      clock.advance(600); // total 1100ms > 1000ms TTL
      assert(cache.getPlace("a") === null, "entry past TTL is not returned");
      assertEqual(cache.size(), 0, "expired entry is pruned on access");
      assertEqual(cache.getMetadata().expirations, 1, "expiration is recorded");
    });

    await runTest("re-putting an entry refreshes its TTL and recency", () => {
      const clock = createFakeClock();
      const cache = createPlaceCache({ ttlMs: 1000, now: clock });
      cache.putPlace(makePlace("a", 34.0, -117.0));
      clock.advance(900);
      cache.putPlace(makePlace("a", 34.0, -117.0, { name: "Refreshed" }));
      clock.advance(500); // 500ms since refresh, < TTL
      const place = cache.getPlace("a");
      assert(place !== null, "refreshed entry is still live");
      assertEqual(place.name, "Refreshed", "re-put updates the stored value");
    });

    await runTest("queryNearby returns matches sorted by distance", () => {
      const cache = createPlaceCache({ now: createFakeClock() });
      cache.putPlace(makePlace("near", 34.0500, -117.6500));
      cache.putPlace(makePlace("mid", 34.0560, -117.6500)); // ~620m north
      cache.putPlace(makePlace("far", 34.2000, -117.6500)); // ~16km north
      const results = cache.queryNearby(34.05, -117.65, 2000);
      assertDeepEqual(results.map((r) => r.place.id), ["near", "mid"], "only within-radius places returned, nearest first");
      assert(results[0].distanceMeters < results[1].distanceMeters, "results are sorted ascending by distance");
      assert(results[1].distanceMeters > 500 && results[1].distanceMeters < 800, "haversine distance is in the expected range");
    });

    await runTest("queryNearby does not disturb LRU recency", () => {
      const cache = createPlaceCache({ maxRecords: 2, now: createFakeClock() });
      cache.putPlace(makePlace("a", 34.05, -117.65));
      cache.putPlace(makePlace("b", 34.05, -117.65));
      cache.queryNearby(34.05, -117.65, 5000); // bulk read should not touch recency
      cache.putPlace(makePlace("c", 34.05, -117.65));
      // "a" was the oldest and never touched by a getPlace, so it should evict.
      assert(cache.getPlace("a") === null, "bulk query did not protect the oldest entry");
    });

    await runTest("queryNearby validates inputs", () => {
      const cache = createPlaceCache({ now: createFakeClock() });
      cache.putPlace(makePlace("a", 34.05, -117.65));
      assertDeepEqual(cache.queryNearby("x", -117.65, 1000), [], "non-numeric center returns empty");
      assertDeepEqual(cache.queryNearby(34.05, -117.65, 0), [], "non-positive radius returns empty");
    });

    await runTest("persist then hydrate round-trips through localStorage", async () => {
      const clock = createFakeClock();
      const storage = createLocalStoragePlaceStorage(createFakeLocalStorage(), "test.placeCache");
      const cacheA = createPlaceCache({ storage, now: clock });
      cacheA.putPlace(makePlace("a", 34.05, -117.65, { phone: "(909) 555-0100" }));
      cacheA.putPlace(makePlace("b", 34.06, -117.66));
      assertEqual(await cacheA.persist(), true, "persist reports success");

      const cacheB = createPlaceCache({ storage, now: clock });
      const loaded = await cacheB.hydrate();
      assertEqual(loaded, 2, "both records are hydrated");
      assertEqual(cacheB.getPlace("a").phone, "(909) 555-0100", "hydrated place retains fields");
      assertEqual(cacheB.getMetadata().storageKind, "localstorage", "storage kind is reported");
    });

    await runTest("hydrate drops snapshot rows that are already expired", async () => {
      const clock = createFakeClock();
      const storage = createLocalStoragePlaceStorage(createFakeLocalStorage(), "test.expired");
      const cacheA = createPlaceCache({ storage, ttlMs: 1000, now: clock });
      cacheA.putPlace(makePlace("a", 34.05, -117.65));
      await cacheA.persist();

      clock.advance(5000); // far past TTL
      const cacheB = createPlaceCache({ storage, ttlMs: 1000, now: clock });
      const loaded = await cacheB.hydrate();
      assertEqual(loaded, 0, "expired snapshot rows are not hydrated");
      assertEqual(cacheB.size(), 0, "cache stays empty after dropping stale rows");
    });

    await runTest("cache works with no storage configured", async () => {
      const cache = createPlaceCache({ now: createFakeClock() });
      cache.putPlace(makePlace("a", 34.05, -117.65));
      assertEqual(await cache.persist(), false, "persist is a no-op without storage");
      assertEqual(await cache.hydrate(), 0, "hydrate is a no-op without storage");
      assertEqual(cache.getMetadata().storageKind, "none", "storage kind reports none");
    });

    await runTest("invalid config is rejected", () => {
      let threw = false;
      try {
        createPlaceCache({ maxRecords: 0 });
      } catch {
        threw = true;
      }
      assert(threw, "non-positive maxRecords throws");
    });

    const result = { passed, failed };
    log.write(`Results: ${passed} passed, ${failed} failed`);
    if (typeof document !== "undefined") {
      document.title = failed === 0
        ? `All ${passed} place cache tests passed`
        : `${failed}/${passed + failed} place cache tests failed`;
    }
    return result;
  })();
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPlaceCacheTests);
}
