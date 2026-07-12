import {
  createPlaceSearch,
  boundingBoxAround,
  pickNearest,
} from "../../intelligence/place_search.js";
import { createSyntheticPlaceProvider } from "../../intelligence/place_provider_adapter.js";

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

// Manual scheduler: tasks fire only when flush() is called, so debounce timing
// is fully deterministic in tests.
function createManualScheduler() {
  let nextId = 1;
  const tasks = new Map();
  return {
    schedule(fn) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, fn);
      return id;
    },
    cancel(id) {
      tasks.delete(id);
    },
    flush() {
      const fns = Array.from(tasks.values());
      tasks.clear();
      fns.forEach((fn) => fn());
    },
    pending() {
      return tasks.size;
    },
  };
}

// Provider spy wrapping the synthetic provider to count fetches.
function createSpyProvider() {
  const inner = createSyntheticPlaceProvider({ now: () => 1_700_000_000_000 });
  const counts = { fetchPlaceById: 0, searchPlacesByBBox: 0, fetchPhotos: 0 };
  return {
    counts,
    describe: inner.describe,
    async fetchPlaceById(id, options) {
      counts.fetchPlaceById += 1;
      return inner.fetchPlaceById(id, options);
    },
    async searchPlacesByBBox(bbox, options) {
      counts.searchPlacesByBBox += 1;
      return inner.searchPlacesByBBox(bbox, options);
    },
    async fetchPhotos(idOrPlace, options) {
      counts.fetchPhotos += 1;
      return inner.fetchPhotos(idOrPlace, options);
    },
  };
}

const RANCHO_BBOX = Object.freeze({ minLat: 34.04, minLon: -117.66, maxLat: 34.06, maxLon: -117.64 });

export function runPlaceSearchTests() {
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
    log.write("DGM Phase G place search tests");

    await runTest("boundingBoxAround builds a centered bbox", () => {
      const bbox = boundingBoxAround(34.05, -117.65, 60);
      assert(bbox.minLat < 34.05 && bbox.maxLat > 34.05, "latitude band brackets the center");
      assert(bbox.minLon < -117.65 && bbox.maxLon > -117.65, "longitude band brackets the center");
    });

    await runTest("pickNearest returns the closest place", () => {
      const nearest = pickNearest(
        [
          { id: "far", lat: 34.2, lon: -117.65 },
          { id: "near", lat: 34.051, lon: -117.65 },
        ],
        34.05,
        -117.65
      );
      assertEqual(nearest.id, "near", "closest place is selected");
    });

    await runTest("map click triggers a provider lookup and opens the card", async () => {
      const scheduler = createManualScheduler();
      const provider = createSpyProvider();
      let opened = null;
      const search = createPlaceSearch({
        getProvider: () => provider,
        onPlace: (place) => { opened = place; },
        scheduler,
      });

      const promise = search.requestByClick({ id: "poi-1", lat: 34.05, lon: -117.65 });
      assertEqual(scheduler.pending(), 1, "a debounced task is scheduled");
      scheduler.flush();
      const result = await promise;

      assert(result.place !== null, "a place is resolved from the click");
      assertEqual(result.superseded, false, "the only click is not superseded");
      assertEqual(provider.counts.fetchPlaceById, 1, "provider is queried once by id");
      assert(opened !== null && opened.id === "poi-1", "the place card open callback fires");
    });

    await runTest("debouncing prevents duplicate fetches from rapid clicks", async () => {
      const scheduler = createManualScheduler();
      const provider = createSpyProvider();
      const search = createPlaceSearch({ getProvider: () => provider, scheduler });

      const first = search.requestByClick({ id: "poi-1", lat: 34.05, lon: -117.65 });
      const second = search.requestByClick({ id: "poi-1", lat: 34.05, lon: -117.65 });
      const third = search.requestByClick({ id: "poi-1", lat: 34.05, lon: -117.65 });
      assertEqual(scheduler.pending(), 1, "only the latest click remains scheduled");

      scheduler.flush();
      const [r1, r2, r3] = await Promise.all([first, second, third]);

      assertEqual(r1.superseded, true, "first rapid click is superseded");
      assertEqual(r2.superseded, true, "second rapid click is superseded");
      assertEqual(r3.superseded, false, "final click resolves with a place");
      assertEqual(provider.counts.fetchPlaceById, 1, "exactly one provider fetch occurs for rapid clicks");
      assertEqual(search.getDiagnostics().fetches, 1, "diagnostics record a single fetch");
    });

    await runTest("click without an id falls back to a bbox search", async () => {
      const scheduler = createManualScheduler();
      const provider = createSpyProvider();
      const search = createPlaceSearch({ getProvider: () => provider, scheduler });

      const promise = search.requestByClick({ lat: 34.05, lon: -117.65 });
      scheduler.flush();
      const result = await promise;

      assert(result.place !== null, "a nearby place is resolved via bbox search");
      assertEqual(provider.counts.searchPlacesByBBox, 1, "bbox search is used when no id is supplied");
      assertEqual(provider.counts.fetchPlaceById, 0, "no id lookup is attempted without an id");
    });

    await runTest("cache-first lookup avoids a provider fetch", async () => {
      const scheduler = createManualScheduler();
      const provider = createSpyProvider();
      const seededPlace = await provider.fetchPlaceById("cached-1", { lat: 34.05, lon: -117.65 });
      provider.counts.fetchPlaceById = 0; // reset after seeding
      const cache = {
        store: new Map([["cached-1", seededPlace]]),
        getPlace(id) { return this.store.get(id) || null; },
        putPlace(place) { this.store.set(place.id, place); },
      };
      const search = createPlaceSearch({ getProvider: () => provider, cache, scheduler });

      const promise = search.requestByClick({ id: "cached-1", lat: 34.05, lon: -117.65 });
      scheduler.flush();
      const result = await promise;

      assertEqual(result.fromCache, true, "result is served from cache");
      assertEqual(provider.counts.fetchPlaceById, 0, "provider is not queried on a cache hit");
      assertEqual(search.getDiagnostics().cacheHits, 1, "diagnostics record the cache hit");
    });

    await runTest("searchPlaces filters by name/category substring", async () => {
      const provider = createSpyProvider();
      const search = createPlaceSearch({ getProvider: () => provider });

      const all = await search.searchPlaces("", RANCHO_BBOX);
      assert(all.length > 0, "empty query returns all bbox results");

      const filtered = await search.searchPlaces("gas", RANCHO_BBOX);
      assert(
        filtered.every((place) => /gas/i.test(place.name) || /gas/i.test(place.category)),
        "filtered results all match the query"
      );
      assert(filtered.length <= all.length, "filtering never increases the result count");
    });

    await runTest("searchPlaces returns empty without a bbox", async () => {
      const provider = createSpyProvider();
      const search = createPlaceSearch({ getProvider: () => provider });
      const results = await search.searchPlaces("gas", null);
      assertEqual(results.length, 0, "missing bbox yields no results");
    });

    await runTest("onPlace subscribers can be added and removed", async () => {
      const scheduler = createManualScheduler();
      const provider = createSpyProvider();
      const search = createPlaceSearch({ getProvider: () => provider, scheduler });

      let count = 0;
      const unsubscribe = search.onPlace(() => { count += 1; });
      const first = search.requestByClick({ id: "poi-1", lat: 34.05, lon: -117.65 });
      scheduler.flush();
      await first;
      assertEqual(count, 1, "subscriber is notified on resolution");

      unsubscribe();
      const second = search.requestByClick({ id: "poi-2", lat: 34.05, lon: -117.65 });
      scheduler.flush();
      await second;
      assertEqual(count, 1, "removed subscriber is not notified");
    });

    await runTest("createPlaceSearch validates its provider accessor", () => {
      let threw = false;
      try {
        createPlaceSearch({});
      } catch {
        threw = true;
      }
      assert(threw, "missing getProvider throws");
    });

    const result = { passed, failed };
    log.write(`Results: ${passed} passed, ${failed} failed`);
    if (typeof document !== "undefined") {
      document.title = failed === 0
        ? `All ${passed} place search tests passed`
        : `${failed}/${passed + failed} place search tests failed`;
    }
    return result;
  })();
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPlaceSearchTests);
}
