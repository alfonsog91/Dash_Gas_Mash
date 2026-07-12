import { normalizeCoord } from "../coordinates.js";

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

export function runCoordinateTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  function runTest(name, fn) {
    try {
      fn();
      passed += 1;
      log.write(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`${FAIL} ${name}: ${error.message}`);
    }
  }

  log.write("DGM coordinate normalization tests");

  runTest("accepts lat and lng", () => {
    const coord = normalizeCoord({ lat: "34.1064", lng: "-117.5931" });
    assert(coord?.lat === 34.1064, "lat is numeric");
    assert(coord.lng === -117.5931 && coord.lon === -117.5931, "lng and lon aliases are populated");
  });

  runTest("accepts lat and lon", () => {
    const coord = normalizeCoord({ lat: 34.1064, lon: -117.5931 });
    assert(coord?.lng === -117.5931, "lon normalizes to lng");
  });

  runTest("accepts latitude and longitude", () => {
    const coord = normalizeCoord({ latitude: 34.1064, longitude: -117.5931 });
    assert(coord?.lat === 34.1064 && coord.lng === -117.5931, "long-form coordinate keys normalize");
  });

  runTest("rejects non-finite coordinates", () => {
    assert(normalizeCoord({ lat: Number.NaN, lng: -117.5931 }) === null, "NaN latitude rejected");
    assert(normalizeCoord({ lat: 34.1064, lng: Infinity }) === null, "infinite longitude rejected");
  });

  runTest("rejects out-of-range coordinates", () => {
    assert(normalizeCoord({ lat: 91, lng: -117.5931 }) === null, "latitude above range rejected");
    assert(normalizeCoord({ lat: 34.1064, lng: -181 }) === null, "longitude below range rejected");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} coordinate tests passed`
      : `${failed}/${passed + failed} coordinate tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runCoordinateTests);
}