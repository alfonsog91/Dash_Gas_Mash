import {
  DEFAULT_MAP_FEATURE_FLAGS,
  DEFAULT_MAP_KILL_SWITCHES,
  NON_CRITICAL_NEW_FEATURE_FLAGS,
  disableAllNewFeatures,
  getMapRuntimeConfigSnapshot,
  isMapFeatureEnabled,
  isMapKillSwitchEnabled,
  logDgmTelemetry,
  logMapFeatureFlagState,
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

function restoreDefaultFeatureFlags() {
  for (const [name, enabled] of Object.entries(DEFAULT_MAP_FEATURE_FLAGS)) {
    setMapFeatureFlag(name, enabled, { persist: false });
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
    assert(DEFAULT_MAP_FEATURE_FLAGS.visualPerformanceHeuristics === false, "visual performance heuristics default off");
    assert(DEFAULT_MAP_FEATURE_FLAGS.phaseCTerrain === true, "Phase D terrain default is enabled");
    assert(DEFAULT_MAP_FEATURE_FLAGS.phaseCGlobe === true, "Phase D globe default is enabled");
    assert(DEFAULT_MAP_FEATURE_FLAGS.phaseC3dBuildings === true, "Phase D buildings default is enabled");
    assert(DEFAULT_MAP_FEATURE_FLAGS.phaseCFog === true, "Phase D fog default is enabled");
    assert(DEFAULT_MAP_FEATURE_FLAGS.phaseCAtmosphere === true, "Phase D atmosphere default is enabled");
    assert(DEFAULT_MAP_KILL_SWITCHES.traffic === false, "traffic kill switch defaults off");
    assert(DEFAULT_MAP_KILL_SWITCHES.heading === false, "heading kill switch defaults off");
  });

  runTest("stored false overrides Phase D runtime defaults", () => {
    if (typeof window === "undefined" || !window.localStorage) {
      log.write("SKIP stored false overrides Phase D runtime defaults: localStorage unavailable");
      return;
    }

    const storageKey = "dgm:map-config:feature:phaseCTerrain";
    const previousValue = window.localStorage.getItem(storageKey);
    window.localStorage.setItem(storageKey, "false");
    assert(!isMapFeatureEnabled("phaseCTerrain"), "stored false disables default-on Phase D terrain");
    window.localStorage.removeItem(storageKey);
    assert(isMapFeatureEnabled("phaseCTerrain"), "removing stored override restores runtime default");
    if (previousValue !== null) {
      window.localStorage.setItem(storageKey, previousValue);
    }
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

  runTest("bulk disable leaves telemetry on and is reversible", () => {
    restoreDefaultFeatureFlags();
    const events = [];
    window.__DGM_TELEMETRY = {
      log: (event, payload) => events.push({ event, payload }),
    };

    const result = disableAllNewFeatures({ persist: false, reason: "test" });
    assert(result.disabledFeatureFlags.includes("trafficVisibilityController"), "bulk disable reports disabled traffic flag");
    assert(isMapFeatureEnabled("telemetry"), "telemetry remains enabled for observability");
    assert(NON_CRITICAL_NEW_FEATURE_FLAGS.every((name) => !isMapFeatureEnabled(name)), "all non-critical new feature flags are disabled");
    assert(events.some((entry) => entry.event === "map_config.disable_all_new_features"), "bulk disable emits telemetry");
    assert(events.at(-1).payload.reason === "test", "bulk disable telemetry includes reason");

    for (const [name, enabled] of Object.entries(result.previousFeatureFlags)) {
      setMapFeatureFlag(name, enabled, { persist: false });
    }
    delete window.__DGM_TELEMETRY;
  });

  runTest("feature flag state telemetry is optional and observable", () => {
    restoreDefaultFeatureFlags();
    const events = [];
    window.__DGM_TELEMETRY = {
      log: (event, payload) => events.push({ event, payload }),
    };

    const snapshot = logMapFeatureFlagState({ reason: "test", buildId: "unit" });
    const stateEvent = events.find((entry) => entry.event === "map.feature_flag_state");
    assert(snapshot.featureFlags.telemetry === true, "snapshot is returned to caller");
    assert(stateEvent, "feature flag state event is emitted");
    assert(stateEvent.payload.reason === "test", "state event includes reason");
    assert(stateEvent.payload.buildId === "unit", "state event includes build id");
    delete window.__DGM_TELEMETRY;
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