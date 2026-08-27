import { fetchFoodPlaces } from "../overpass.js";

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

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createBounds() {
  return {
    getSouth: () => 34.0,
    getWest: () => -117.7,
    getNorth: () => 34.1,
    getEast: () => -117.6,
  };
}

export async function runOverpassTests() {
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

  log.write("DGM Overpass response validation tests");

  await runTest("rejects successful JSON without an elements array", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ status: "ok" }),
    });

    try {
      let rejection = null;
      try {
        await fetchFoodPlaces(createBounds());
      } catch (error) {
        rejection = error;
      }

      assert(rejection instanceof Error, "malformed successful JSON must reject");
      assert(rejection.message.includes("elements array"), "rejection identifies the missing elements array");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("propagates abort without retrying another endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const controller = new AbortController();
    let fetchCalls = 0;
    globalThis.fetch = async (_url, { signal }) => {
      fetchCalls += 1;
      if (signal.aborted) {
        throw signal.reason;
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };

    try {
      const pendingFetch = fetchFoodPlaces({
        getSouth: () => 34.2,
        getWest: () => -117.8,
        getNorth: () => 34.3,
        getEast: () => -117.7,
      }, controller.signal);
      controller.abort();

      let rejection = null;
      try {
        await pendingFetch;
      } catch (error) {
        rejection = error;
      }

      assert(rejection?.name === "AbortError", "the caller receives AbortError");
      assert(fetchCalls === 1, "an aborted request is not retried");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("cancelled late JSON cannot overwrite a newer cache entry", async () => {
    const originalFetch = globalThis.fetch;
    const staleJson = createDeferred();
    const controller = new AbortController();
    let fetchCalls = 0;
    const bounds = {
      getSouth: () => 34.4,
      getWest: () => -118.0,
      getNorth: () => 34.5,
      getEast: () => -117.9,
    };
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: fetchCalls === 1
          ? () => staleJson.promise
          : async () => ({ elements: [{ type: "node", id: "new", lat: 34.45, lon: -117.95 }] }),
      };
    };

    try {
      const staleOutcome = fetchFoodPlaces(bounds, controller.signal)
        .then(() => null, (error) => error);
      await Promise.resolve();
      controller.abort();

      const freshResult = await fetchFoodPlaces(bounds);
      staleJson.resolve({ elements: [{ type: "node", id: "old", lat: 34.44, lon: -117.96 }] });
      const staleError = await staleOutcome;
      const cachedResult = await fetchFoodPlaces(bounds);

      assert(staleError?.name === "AbortError", "the cancelled late response rejects as aborted");
      assert(freshResult[0]?.id === "node/new", "the newer response is returned");
      assert(cachedResult[0]?.id === "node/new", "the cancelled response cannot replace newer cache data");
      assert(fetchCalls === 2, "the third request reads the newer cache entry");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} Overpass tests passed`
      : `${failed}/${passed + failed} Overpass tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runOverpassTests);
}
