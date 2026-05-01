import { restoreStyleState } from "../style_state.js";

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

function createMockMap({ failLayoutLayerIds = [], failPaintLayerIds = [] } = {}) {
  const layers = new Map([
    ["restaurants", { id: "restaurants" }],
    ["parking", { id: "parking" }],
    ["traffic", { id: "traffic" }],
  ]);
  const failLayout = new Set(failLayoutLayerIds);
  const failPaint = new Set(failPaintLayerIds);
  return {
    layoutUpdates: [],
    paintUpdates: [],
    getLayer: (layerId) => layers.get(layerId) || null,
    setLayoutProperty(layerId, propertyName, value) {
      if (failLayout.has(layerId)) {
        throw new Error(`layout failed for ${layerId}`);
      }
      this.layoutUpdates.push({ layerId, propertyName, value });
    },
    setPaintProperty(layerId, propertyName, value) {
      if (failPaint.has(layerId)) {
        throw new Error(`paint failed for ${layerId}`);
      }
      this.paintUpdates.push({ layerId, propertyName, value });
    },
  };
}

export function runStyleStateTests() {
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

  log.write("DGM style state tests");

  runTest("restores visibility without adding layers", () => {
    const map = createMockMap();
    const result = restoreStyleState(map, {
      visibility: {
        restaurants: false,
        parking: true,
      },
    });

    assert(result.changedLayoutProperties.length === 2, "two layout properties restored");
    assert(map.layoutUpdates.some((update) => update.layerId === "restaurants" && update.value === "none"), "restaurants hidden");
    assert(map.layoutUpdates.some((update) => update.layerId === "parking" && update.value === "visible"), "parking shown");
    assert(typeof map.addLayer === "undefined", "mock map exposes no addLayer path");
  });

  runTest("restores paint properties safely", () => {
    const map = createMockMap();
    const result = restoreStyleState(map, {
      paint: {
        traffic: { "line-opacity": 0.4 },
      },
    });

    assert(result.changedPaintProperties.length === 1, "one paint property restored");
    assert(map.paintUpdates[0].propertyName === "line-opacity", "paint property name preserved");
  });

  runTest("reports missing layers and failed updates", () => {
    const map = createMockMap({ failLayoutLayerIds: ["traffic"] });
    const result = restoreStyleState(map, {
      visibility: {
        traffic: true,
        missing: true,
      },
    });

    assert(result.missingLayerIds.includes("missing"), "missing layer is reported");
    assert(result.failedUpdates.some((update) => update.layerId === "traffic"), "failed layout update is reported");
  });

  runTest("emits style reload telemetry when provided", () => {
    const map = createMockMap();
    const events = [];
    restoreStyleState(map, {
      visibility: { restaurants: true },
    }, {
      logTelemetry: (event, payload) => events.push({ event, payload }),
      telemetryPayload: { baseStyle: "standard" },
    });

    assert(events.length === 1, "one telemetry event emitted");
    assert(events[0].event === "map.style_reload_restored", "telemetry event name is stable");
    assert(events[0].payload.baseStyle === "standard", "telemetry includes caller payload");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} style state tests passed`
      : `${failed}/${passed + failed} style state tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runStyleStateTests);
}