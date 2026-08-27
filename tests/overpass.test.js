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
