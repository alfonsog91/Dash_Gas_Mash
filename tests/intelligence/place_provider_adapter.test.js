import {
  createSyntheticPlaceProvider,
  createProviderRegistry,
  isValidProvider,
  normalizeBBox,
} from "../../intelligence/place_provider_adapter.js";
import { isValidPlace } from "../../intelligence/place_model.js";

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

function assertThrows(fn, message) {
  let thrown = false;
  try {
    fn();
  } catch {
    thrown = true;
  }
  assert(thrown, message);
}

const FIXED_CLOCK = () => 1_700_000_000_000;

const SEED_BBOX = Object.freeze({ minLat: 34.04, minLon: -117.66, maxLat: 34.06, maxLon: -117.64 });

export function runPlaceProviderAdapterTests() {
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
    log.write("DGM Phase G place provider adapter tests");

    await runTest("fetchPlaceById returns a normalized place", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const place = await provider.fetchPlaceById("test-1", { lat: 34.05, lon: -117.65 });
      assert(isValidPlace(place), "returned place passes model validation");
      assertEqual(place.id, "test-1", "id is preserved");
      assertEqual(place.lat, 34.05, "supplied latitude is used");
      assertEqual(place.lastFetchedTs, 1_700_000_000_000, "fetch timestamp comes from the injected clock");
    });

    await runTest("synthetic provider is fully deterministic", async () => {
      const a = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const b = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const first = await a.fetchPlaceById("repro", { lat: 34.05, lon: -117.65 });
      const second = await b.fetchPlaceById("repro", { lat: 34.05, lon: -117.65 });
      assertEqual(JSON.stringify(first), JSON.stringify(second), "identical ids/coords produce identical places");
    });

    await runTest("fetchPlaceById returns null for an empty id", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      assertEqual(await provider.fetchPlaceById(""), null, "empty id returns null");
    });

    await runTest("seeded places are returned by id", async () => {
      const provider = createSyntheticPlaceProvider({
        now: FIXED_CLOCK,
        seedPlaces: [{ id: "seed-1", name: "Seeded Spot", lat: 34.05, lon: -117.65, category: "cafe" }],
      });
      const place = await provider.fetchPlaceById("seed-1");
      assertEqual(place.name, "Seeded Spot", "seeded place is returned verbatim");
    });

    await runTest("searchPlacesByBBox returns normalized places within the bbox", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const results = await provider.searchPlacesByBBox(SEED_BBOX, { limit: 10 });
      assert(results.length > 0, "bbox search returns results");
      assert(results.length <= 10, "results respect the limit");
      assert(results.every((place) => isValidPlace(place)), "all results pass model validation");
      assert(
        results.every((place) => place.lat >= SEED_BBOX.minLat && place.lat <= SEED_BBOX.maxLat),
        "all results fall within the bbox latitude range"
      );
    });

    await runTest("searchPlacesByBBox is deterministic and sorted by id", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const first = await provider.searchPlacesByBBox(SEED_BBOX, { limit: 8 });
      const second = await provider.searchPlacesByBBox(SEED_BBOX, { limit: 8 });
      assertEqual(JSON.stringify(first), JSON.stringify(second), "repeated searches are identical");
      const ids = first.map((place) => place.id);
      assertEqual(JSON.stringify(ids), JSON.stringify([...ids].sort()), "results are sorted by id");
    });

    await runTest("searchPlacesByBBox rejects an invalid bbox", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      assertEqual((await provider.searchPlacesByBBox({ minLat: 5, maxLat: 1, minLon: 0, maxLon: 1 })).length, 0, "inverted bbox returns no results");
      assertEqual((await provider.searchPlacesByBBox(null)).length, 0, "null bbox returns no results");
    });

    await runTest("fetchPhotos returns bounded photo metadata", async () => {
      const provider = createSyntheticPlaceProvider({ now: FIXED_CLOCK });
      const photos = await provider.fetchPhotos("photo-test");
      assert(Array.isArray(photos), "photos is an array");
      assert(photos.length >= 1, "at least one photo ref is returned");
      assert(photos.every((photo) => typeof photo.ref === "string" && photo.ref.length > 0), "each photo carries a ref");
      assert(photos.every((photo) => !("dataUrl" in photo)), "photo refs hold metadata only, not bytes");
    });

    await runTest("describe advertises a cache policy", () => {
      const provider = createSyntheticPlaceProvider();
      const description = provider.describe();
      assertEqual(description.id, "synthetic", "provider id is reported");
      assert(description.cachePolicy && typeof description.cachePolicy === "object", "a cache policy is advertised");
    });

    await runTest("isValidProvider enforces the interface", () => {
      assert(isValidProvider(createSyntheticPlaceProvider()) === true, "synthetic provider is valid");
      assert(isValidProvider({ fetchPlaceById: () => {} }) === false, "partial provider is invalid");
      assert(isValidProvider(null) === false, "null is invalid");
    });

    await runTest("registry registers synthetic by default and supports selection", () => {
      const registry = createProviderRegistry();
      assert(registry.listProviders().includes("synthetic"), "synthetic provider is registered by default");
      assertEqual(registry.getActiveProviderId(), "synthetic", "synthetic is active by default");

      const custom = createSyntheticPlaceProvider();
      registry.register("custom", custom);
      registry.setActiveProvider("custom");
      assertEqual(registry.getActiveProviderId(), "custom", "active provider can be switched");
      assertEqual(registry.getActiveProvider(), custom, "active provider instance is returned");
    });

    await runTest("registry rejects invalid providers and unknown selection", () => {
      const registry = createProviderRegistry();
      assertThrows(() => registry.register("bad", { fetchPlaceById: () => {} }), "incomplete provider is rejected");
      assertThrows(() => registry.register("", createSyntheticPlaceProvider()), "empty id is rejected");
      assertThrows(() => registry.setActiveProvider("missing"), "unknown provider selection throws");
    });

    await runTest("normalizeBBox accepts compass aliases", () => {
      const normalized = normalizeBBox({ south: 34.0, west: -117.7, north: 34.1, east: -117.6 });
      assertEqual(JSON.stringify(normalized), JSON.stringify({ minLat: 34.0, minLon: -117.7, maxLat: 34.1, maxLon: -117.6 }), "south/west/north/east map to bbox fields");
    });

    const result = { passed, failed };
    log.write(`Results: ${passed} passed, ${failed} failed`);
    if (typeof document !== "undefined") {
      document.title = failed === 0
        ? `All ${passed} place provider adapter tests passed`
        : `${failed}/${passed + failed} place provider adapter tests failed`;
    }
    return result;
  })();
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPlaceProviderAdapterTests);
}
