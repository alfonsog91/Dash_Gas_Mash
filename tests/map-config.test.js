import {
  DEFAULT_MAP_FEATURE_FLAGS,
  DEFAULT_MAP_KILL_SWITCHES,
  getMapRuntimeConfigSnapshot,
  isMapFeatureEnabled,
  isMapKillSwitchEnabled,
  logDgmTelemetry,
  setMapFeatureFlag,
  setMapKillSwitch,
} from "../map_config.js";

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

export function runMapConfigTests() {
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

  log.write("DGM map config tests");

  runTest("defaults keep guarded map systems enabled", () => {
    assert(DEFAULT_MAP_FEATURE_FLAGS.trafficVisibilityController === true, "traffic visibility controller defaults on");
    assert(DEFAULT_MAP_FEATURE_FLAGS.headingCompassAutoRequest === true, "heading permission trigger defaults on");
    assert(DEFAULT_MAP_KILL_SWITCHES.traffic === false, "traffic kill switch defaults off");
    assert(DEFAULT_MAP_KILL_SWITCHES.heading === false, "heading kill switch defaults off");
  });

  runTest("runtime feature flags can disable behavior", () => {
    setMapFeatureFlag("trafficVisibilityController", false, { persist: false });
    assert(!isMapFeatureEnabled("trafficVisibilityController"), "runtime feature override disables traffic controller");
    setMapFeatureFlag("trafficVisibilityController", true, { persist: false });
    assert(isMapFeatureEnabled("trafficVisibilityController"), "runtime feature override re-enables traffic controller");
  });

  runTest("runtime kill switches can disable behavior", () => {
    setMapKillSwitch("heading", true, { persist: false });
    assert(isMapKillSwitchEnabled("heading"), "heading kill switch can be enabled at runtime");
    setMapKillSwitch("heading", false, { persist: false });
    assert(!isMapKillSwitchEnabled("heading"), "heading kill switch can be cleared at runtime");
  });

  runTest("snapshot exposes rollback state", () => {
    const snapshot = getMapRuntimeConfigSnapshot();
    assert(snapshot.featureFlags.trafficVisibilityController === true, "snapshot includes traffic feature flag");
    assert(snapshot.killSwitches.heading === false, "snapshot includes heading kill switch");
  });

  runTest("telemetry hook is optional and safe", () => {
    assert(logDgmTelemetry("map_config.test", { ok: true }) === false, "missing telemetry object is a no-op");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} map config tests passed`
      : `${failed}/${passed + failed} map config tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runMapConfigTests);
}