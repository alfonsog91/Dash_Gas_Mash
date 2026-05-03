import { getPhaseCManifest } from "../phase_c_manifest.js";
import {
  applyPhaseCActivation,
  getPhaseEPerformanceGuardDisabledEffects,
} from "../phase_c_activation.js";
import {
  PHASE_E_PERFORMANCE_GUARD_EFFECTS,
  createPhaseEPerformanceMonitor,
  evaluatePhaseEPerformanceGuard,
  getAvailableGpuMemoryMb,
} from "../performance/monitor.js";

const PASS = "PASS";
const FAIL = "FAIL";
const PHASE_C_FLAGS_ALL_TRUE = Object.freeze({
  phaseCTerrain: true,
  phaseCGlobe: true,
  phaseC3dBuildings: true,
  phaseCFog: true,
  phaseCAtmosphere: true,
});

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

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function createTelemetryRecorder() {
  const events = [];
  const telemetry = (eventName, payload) => events.push({ eventName, payload });
  telemetry.events = events;
  telemetry.count = (eventName) => events.filter((entry) => entry.eventName === eventName).length;
  telemetry.last = (eventName) => events.filter((entry) => entry.eventName === eventName).at(-1) || null;
  return telemetry;
}

function createMockMap() {
  const sources = new Map([["composite", { type: "vector" }]]);
  const layers = [
    { id: "background", type: "background" },
    { id: "poi-label", type: "symbol", source: "composite", layout: { "text-field": ["get", "name"] }, metadata: { "mapbox:group": "poi labels" } },
    { id: "water-fill", type: "fill", source: "composite", metadata: { "mapbox:group": "water" } },
    { id: "park-fill", type: "fill", source: "composite", metadata: { "mapbox:group": "park landuse" } },
    { id: "road-line", type: "line", source: "composite", metadata: { "mapbox:group": "road" } },
  ];
  const calls = [];
  let terrain = null;
  let projection = { name: "mercator" };
  let fog = null;
  let light = { anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] };
  let zoom = 12;
  let pitch = 0;

  function findLayerIndex(layerId) {
    return layers.findIndex((layer) => layer.id === layerId);
  }

  return {
    calls,
    getStyle() {
      return {
        version: 8,
        sources: Object.fromEntries(sources),
        layers: layers.slice(),
      };
    },
    getSource(sourceId) {
      return sources.get(sourceId) || null;
    },
    addSource(sourceId, sourceSpec) {
      sources.set(sourceId, sourceSpec);
      calls.push({ method: "addSource", sourceId, sourceSpec });
    },
    removeSource(sourceId) {
      sources.delete(sourceId);
      calls.push({ method: "removeSource", sourceId });
    },
    getTerrain() {
      return terrain;
    },
    setTerrain(nextTerrain) {
      terrain = nextTerrain;
      calls.push({ method: "setTerrain", terrain: nextTerrain });
    },
    getProjection() {
      return projection;
    },
    setProjection(nextProjection) {
      projection = typeof nextProjection === "string" ? { name: nextProjection } : nextProjection;
      calls.push({ method: "setProjection", projection: nextProjection });
    },
    getFog() {
      return fog;
    },
    setFog(nextFog) {
      fog = nextFog;
      calls.push({ method: "setFog", fog: nextFog });
    },
    getLayer(layerId) {
      return layers.find((layer) => layer.id === layerId) || null;
    },
    addLayer(layer, beforeId) {
      const beforeIndex = beforeId ? findLayerIndex(beforeId) : -1;
      if (beforeIndex === -1) {
        layers.push(layer);
      } else {
        layers.splice(beforeIndex, 0, layer);
      }
      calls.push({ method: "addLayer", layer, beforeId });
    },
    removeLayer(layerId) {
      const layerIndex = findLayerIndex(layerId);
      if (layerIndex !== -1) {
        layers.splice(layerIndex, 1);
      }
      calls.push({ method: "removeLayer", layerId });
    },
    getLight() {
      return light;
    },
    setLight(nextLight) {
      light = nextLight;
      calls.push({ method: "setLight", light: nextLight });
    },
    getPaintProperty(layerId, propertyName) {
      return `${layerId}:${propertyName}:original`;
    },
    setPaintProperty(layerId, propertyName, propertyValue) {
      calls.push({ method: "setPaintProperty", layerId, propertyName, propertyValue });
    },
    getZoom() {
      return zoom;
    },
    getPitch() {
      return pitch;
    },
    easeTo(options) {
      zoom = options.zoom;
      pitch = options.pitch;
      calls.push({ method: "easeTo", options });
    },
    on(eventName, handler) {
      calls.push({ method: "on", eventName, handler });
    },
    off(eventName, handler) {
      calls.push({ method: "off", eventName, handler });
    },
  };
}

function withPhaseDWindow(fn) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { search: "?phaseD=true", hostname: "localhost" },
    localStorage: { getItem: () => null },
    setTimeout: (handler) => {
      handler();
      return 1;
    },
    clearTimeout: () => {},
  };

  try {
    return fn();
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
}

export async function runPerfGuardTests() {
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

  log.write("DGM Phase E performance guard tests");

  await runTest("low desktop FPS does not trigger mobile guard", () => {
    const result = evaluatePhaseEPerformanceGuard({
      isMobile: false,
      frameDurationsMs: Array.from({ length: 6 }, () => 50),
      thresholds: { minMobileFps: 30, sustainedFrameSamples: 4 },
    });

    assert(result.active === false, "desktop low FPS does not trigger the mobile guard");
    assert(result.disabledEffects.length === 0, "no effects are disabled for desktop samples");
  });

  await runTest("sustained mobile FPS below 30 disables all non-essential polish", () => {
    const result = evaluatePhaseEPerformanceGuard({
      isMobile: true,
      frameDurationsMs: Array.from({ length: 6 }, () => 50),
      thresholds: { minMobileFps: 30, sustainedFrameSamples: 4 },
      environment: { gpuMemoryMb: 1024 },
    });

    assert(result.active === true, "mobile low FPS triggers the guard");
    assert(result.reason === "sustained_mobile_fps_below_30", "guard reason is exact");
    assert(result.averageFps === 20, "average FPS is reported");
    assert(result.averageFrameTimeMs === 50, "average frame time is reported");
    assert(result.gpuMemoryMb === 1024, "available GPU memory is preserved");
    assertDeepEqual(result.disabledEffects, Object.values(PHASE_E_PERFORMANCE_GUARD_EFFECTS), "all configured non-essential effects are disabled");
  });

  await runTest("GPU memory remains optional", () => {
    assert(getAvailableGpuMemoryMb({}) === null, "missing GPU memory stays null");
    assert(getAvailableGpuMemoryMb({ gpu: { memoryMb: 768 } }) === 768, "nested GPU memory is read when present");
  });

  await runTest("runtime monitor logs exact reason and effects once", () => {
    const telemetry = createTelemetryRecorder();
    const debugWindow = {
      innerWidth: 390,
      matchMedia: () => ({ matches: true }),
      __DGM_DEBUG: {},
    };
    const monitor = createPhaseEPerformanceMonitor({
      windowLike: debugWindow,
      telemetryEmitter: telemetry,
      shouldExposeDebug: () => true,
      thresholds: { minMobileFps: 30, sustainedFrameSamples: 4 },
    });

    [0, 50, 100, 150, 200].forEach((timestamp) => monitor.recordFrameForTest(timestamp));
    [250, 300].forEach((timestamp) => monitor.recordFrameForTest(timestamp));

    assert(telemetry.count("map.phase_e_performance_guard_triggered") === 1, "guard telemetry logs once");
    const payload = telemetry.last("map.phase_e_performance_guard_triggered").payload;
    assert(payload.reason === "sustained_mobile_fps_below_30", "telemetry reason is exact");
    assert(payload.disabledEffects.includes(PHASE_E_PERFORMANCE_GUARD_EFFECTS.DGM_TRAFFIC_STYLING), "traffic styling effect is included");
    assert(!Object.hasOwn(payload, "gpuMemoryMb"), "GPU memory is omitted when unavailable");
    assert(typeof debugWindow.__DGM_DEBUG.getPhaseEPerformanceDashboard === "function", "debug dashboard is exposed");
  });

  await runTest("Phase D tuning skips guarded heavy effects", async () => {
    await withPhaseDWindow(async () => {
      const manifest = getPhaseCManifest();
      const map = createMockMap();
      const state = {};
      const telemetry = createTelemetryRecorder();
      const guard = {
        active: true,
        reason: "sustained_mobile_fps_below_30",
        disabledEffects: Object.values(PHASE_E_PERFORMANCE_GUARD_EFFECTS),
      };

      await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, {
        buildId: "perf-guard-test",
        skipCameraPreset: true,
        performanceGuard: guard,
      });

      assertDeepEqual(getPhaseEPerformanceGuardDisabledEffects(guard), Object.values(PHASE_E_PERFORMANCE_GUARD_EFFECTS), "guard effects normalize deterministically");
      assert(state.phaseCActivation.phaseDTuning.performanceGuard.reason === "sustained_mobile_fps_below_30", "activation state records guard reason");
      assert(!map.calls.some((call) => call.method === "setFog" && call.fog?.density), "Phase D fog density tuning is skipped");
      assert(!map.calls.some((call) => call.method === "setPaintProperty" && call.propertyName === "text-opacity"), "heavy label opacity tuning is skipped");
      assert(!map.calls.some((call) => call.method === "setPaintProperty" && ["#437fcf", "#d8c16a", "#6f9f65"].includes(call.propertyValue)), "color grading is skipped");
    });
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} perf guard tests passed`
      : `${failed}/${passed + failed} perf guard tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    runPerfGuardTests().catch((error) => {
      const log = createLogger();
      log.write(`${FAIL} perf guard harness crashed: ${error.message}`);
      document.title = "Perf guard tests crashed";
    });
  });
}
