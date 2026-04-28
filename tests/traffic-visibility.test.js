import {
  findTrafficLayerIds,
  isTrafficLayer,
  setTrafficVisibility,
  toggleTraffic,
} from "../traffic_visibility.js";

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

function createMockMap({ failLayoutLayerIds = [] } = {}) {
  const failLayout = new Set(failLayoutLayerIds);
  const layers = [
    { id: "road-primary", type: "line", source: "composite", "source-layer": "road" },
    { id: "traffic-casing-layer", type: "line", source: "traffic", "source-layer": "traffic" },
    { id: "traffic-layer", type: "line", source: "traffic", "source-layer": "traffic" },
    { id: "building", type: "fill", source: "composite", "source-layer": "building" },
    { id: "road-congestion-live", type: "line", source: "composite", "source-layer": "road" },
  ];
  const layoutUpdates = [];
  const paintUpdates = [];
  const paintValues = new Map([
    ["traffic-layer:line-opacity", 0.82],
    ["traffic-casing-layer:line-opacity", 0.38],
  ]);

  return {
    layoutUpdates,
    paintUpdates,
    getStyle: () => ({ layers }),
    getLayer: (layerId) => layers.find((layer) => layer.id === layerId) || null,
    setLayoutProperty(layerId, propertyName, value) {
      if (failLayout.has(layerId)) {
        throw new Error(`layout failed for ${layerId}`);
      }
      layoutUpdates.push({ layerId, propertyName, value });
    },
    setPaintProperty(layerId, propertyName, value) {
      paintUpdates.push({ layerId, propertyName, value });
      paintValues.set(`${layerId}:${propertyName}`, value);
    },
    getPaintProperty(layerId, propertyName) {
      return paintValues.get(`${layerId}:${propertyName}`);
    },
  };
}

export function runTrafficVisibilityTests() {
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

  log.write("DGM traffic visibility tests");

  runTest("traffic layer predicate is specific to traffic lines", () => {
    assert(isTrafficLayer({ id: "traffic-layer", type: "line", source: "traffic" }), "traffic line is detected");
    assert(!isTrafficLayer({ id: "traffic-fill", type: "fill", source: "traffic" }), "non-line traffic layer is ignored");
    assert(!isTrafficLayer({ id: "road-primary", type: "line", source: "composite", "source-layer": "road" }), "regular road line is ignored");
  });

  runTest("findTrafficLayerIds combines explicit and inferred layers", () => {
    const map = createMockMap();
    const ids = findTrafficLayerIds(map, { explicitLayerIds: ["traffic-layer", "missing-layer"] });
    assert(ids.includes("traffic-layer"), "explicit existing traffic layer is included");
    assert(ids.includes("traffic-casing-layer"), "inferred traffic source layer is included");
    assert(ids.includes("road-congestion-live"), "inferred congestion layer is included");
    assert(!ids.includes("missing-layer"), "missing explicit layers are ignored");
  });

  runTest("setTrafficVisibility uses layout visibility", () => {
    const map = createMockMap();
    const result = setTrafficVisibility(map, true, { explicitLayerIds: ["traffic-layer"] });
    assert(result.visible === true, "result tracks requested visible state");
    assert(map.layoutUpdates.length === result.changedLayerIds.length, "layout updates are batched over discovered layers");
    assert(map.layoutUpdates.every((update) => update.propertyName === "visibility" && update.value === "visible"), "visibility is applied through layout properties");
  });

  runTest("setTrafficVisibility falls back to paint opacity", () => {
    const map = createMockMap({ failLayoutLayerIds: ["traffic-layer"] });
    const result = setTrafficVisibility(map, false, { explicitLayerIds: ["traffic-layer"], paintFallback: true });
    assert(result.fallbackLayerIds.includes("traffic-layer"), "failed layout layer uses paint fallback");
    assert(map.paintUpdates.some((update) => update.layerId === "traffic-layer" && update.propertyName === "line-opacity" && update.value === 0), "fallback hides traffic by opacity");
  });

  runTest("paint fallback restores the original opacity", () => {
    const map = createMockMap({ failLayoutLayerIds: ["traffic-layer"] });
    setTrafficVisibility(map, false, { explicitLayerIds: ["traffic-layer"], paintFallback: true });
    setTrafficVisibility(map, true, { explicitLayerIds: ["traffic-layer"], paintFallback: true });
    assert(map.paintUpdates.some((update) => update.layerId === "traffic-layer" && update.propertyName === "line-opacity" && update.value === 0.82), "fallback restores cached opacity when traffic is shown again");
  });

  runTest("toggleTraffic applies the inverse state", () => {
    const map = createMockMap();
    const result = toggleTraffic(map, true, { explicitLayerIds: ["traffic-layer"] });
    assert(result.visible === false, "toggle inverts the current visible state");
    assert(map.layoutUpdates.every((update) => update.value === "none"), "toggle hides discovered traffic layers");
  });

  runTest("telemetry hook receives visibility results", () => {
    const map = createMockMap();
    const events = [];
    setTrafficVisibility(map, true, {
      explicitLayerIds: ["traffic-layer"],
      logTelemetry: (event, payload) => events.push({ event, payload }),
    });
    assert(events.length === 1, "one telemetry event is emitted");
    assert(events[0].event === "map.traffic_visibility_changed", "telemetry event name is stable");
    assert(events[0].payload.visible === true, "telemetry includes requested state");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} traffic visibility tests passed`
      : `${failed}/${passed + failed} traffic visibility tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runTrafficVisibilityTests);
}