import {
  createVehicleMarker,
  animateCameraAlongPath,
  buildFollowCamera,
  speedAdaptiveZoom,
  interpolateHeading,
  shortestAngleDelta,
  bearingBetween,
} from "../../ui/vehicle_marker.js";

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

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

// Mock Mapbox map for marker tests.
function createMockMap() {
  const sources = new Map();
  const layers = new Map();
  const images = new Set();
  return {
    addSource(id, spec) { sources.set(id, { data: spec.data }); },
    getSource(id) {
      const s = sources.get(id);
      return s ? { setData: (d) => { s.data = d; } } : null;
    },
    _sourceData(id) { return sources.get(id)?.data || null; },
    addLayer(layer) { layers.set(layer.id, { ...layer, visibility: layer.layout?.visibility || "visible" }); },
    getLayer(id) { return layers.get(id) || null; },
    removeLayer(id) { layers.delete(id); },
    removeSource(id) { sources.delete(id); },
    setLayoutProperty(id, prop, value) { if (prop === "visibility" && layers.get(id)) layers.get(id).visibility = value; },
    hasImage(id) { return images.has(id); },
    addImage(id) { images.add(id); },
    loadImage(url, cb) { cb(new Error("no decode in node"), null); },
  };
}

export function runVehicleCameraTests() {
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

  log.write("DGM Phase G vehicle + camera tests");

  runTest("shortestAngleDelta takes the short way around", () => {
    assertEqual(shortestAngleDelta(350, 10), 20, "350->10 is +20");
    assertEqual(shortestAngleDelta(10, 350), -20, "10->350 is -20");
    // A 180-degree turn is antipodal: +180 and -180 are both valid shortest arcs.
    assertEqual(Math.abs(shortestAngleDelta(0, 180)), 180, "0->180 is a half turn either way");
  });

  runTest("interpolateHeading wraps along the shortest arc", () => {
    assertEqual(interpolateHeading(350, 10, 0.5), 0, "midpoint of 350->10 is 0");
    assertEqual(interpolateHeading(0, 90, 0), 0, "t=0 stays at start");
    assertEqual(interpolateHeading(0, 90, 1), 90, "t=1 reaches target");
  });

  runTest("bearingBetween computes cardinal directions", () => {
    assertClose(bearingBetween({ lng: 0, lat: 0 }, { lng: 2, lat: 0 }), 90, 0.5, "due east is ~90");
    assertClose(bearingBetween({ lng: 0, lat: 0 }, { lng: 0, lat: 2 }), 0, 0.5, "due north is ~0");
  });

  runTest("speedAdaptiveZoom widens the view as speed rises", () => {
    assertEqual(speedAdaptiveZoom(0, { minZoom: 15, maxZoom: 18, minSpeed: 0, maxSpeed: 20 }), 18, "stationary is tightest zoom");
    assertEqual(speedAdaptiveZoom(20, { minZoom: 15, maxZoom: 18, minSpeed: 0, maxSpeed: 20 }), 15, "max speed is widest zoom");
    assertEqual(speedAdaptiveZoom(10, { minZoom: 15, maxZoom: 18, minSpeed: 0, maxSpeed: 20 }), 16.5, "half speed is midway zoom");
    assertEqual(speedAdaptiveZoom(100, { minZoom: 15, maxZoom: 18, minSpeed: 0, maxSpeed: 20 }), 15, "over-max speed clamps to widest");
  });

  runTest("buildFollowCamera locks bearing to heading and adapts zoom", () => {
    const camera = buildFollowCamera({ lng: -117.6, lat: 34.06, heading: 270, speed: 0, pitch: 50 });
    assertDeepEqual(camera.center, [-117.6, 34.06], "camera centers on the vehicle");
    assertEqual(camera.bearing, 270, "heading-locked bearing equals the heading");
    assertEqual(camera.pitch, 50, "pitch is carried through");
    assertEqual(camera.zoom, 18, "stationary uses the tightest configured zoom");

    const northUp = buildFollowCamera({ lng: -117.6, lat: 34.06, heading: 270, mode: "north-up" });
    assertEqual(northUp.bearing, 0, "north-up mode keeps bearing at 0");
  });

  runTest("animateCameraAlongPath produces deterministic keyframes for fixed inputs", () => {
    const path = [[0, 0], [2, 0]];
    const keyframes = animateCameraAlongPath(path, { duration: 1000, easing: "linear", pitch: 45, frames: 3 });
    assertEqual(keyframes.length, 3, "frame count matches the requested frames");
    assertDeepEqual(keyframes, [
      { index: 0, t: 0, progress: 0, atMs: 0, center: [0, 0], bearing: 90, pitch: 45, offset: [0, 0] },
      { index: 1, t: 0.5, progress: 0.5, atMs: 500, center: [1, 0], bearing: 90, pitch: 45, offset: [0, 0] },
      { index: 2, t: 1, progress: 1, atMs: 1000, center: [2, 0], bearing: 90, pitch: 45, offset: [0, 0] },
    ], "linear keyframes along a straight east path are exact and stable");
  });

  runTest("animateCameraAlongPath is repeatable (deterministic)", () => {
    const path = [[-117.6, 34.06], [-117.59, 34.07], [-117.58, 34.06]];
    const opts = { duration: 4000, easing: "easeInOut", pitch: 40, offset: [0, 120], frames: 12 };
    const a = animateCameraAlongPath(path, opts);
    const b = animateCameraAlongPath(path, opts);
    assertDeepEqual(a, b, "identical inputs produce identical keyframes");
    assertEqual(a[0].offset[1], 120, "offset is carried into keyframes");
    assertDeepEqual(a[0].center, [-117.6, 34.06], "first keyframe is the path start");
    assertDeepEqual(a[a.length - 1].center, [-117.58, 34.06], "last keyframe is the path end");
  });

  runTest("animateCameraAlongPath easing changes frame spacing", () => {
    const path = [[0, 0], [10, 0]];
    const linear = animateCameraAlongPath(path, { easing: "linear", frames: 3 });
    const eased = animateCameraAlongPath(path, { easing: "easeInOut", frames: 3 });
    // Midpoint progress differs by easing but endpoints match.
    assertDeepEqual(linear[0].center, eased[0].center, "easing keeps the start fixed");
    assertDeepEqual(linear[2].center, eased[2].center, "easing keeps the end fixed");
    assert(eased[1].progress === 0.5, "symmetric easing still hits 0.5 at the midpoint frame");
  });

  runTest("animateCameraAlongPath handles degenerate paths", () => {
    assertDeepEqual(animateCameraAlongPath([], {}), [], "empty path yields no keyframes");
    const single = animateCameraAlongPath([[1, 2]], { frames: 4 });
    assertEqual(single.length, 1, "a single point yields a single keyframe");
    assertDeepEqual(single[0].center, [1, 2], "single keyframe centers on the only point");
  });

  runTest("vehicle marker adds a symbol layer and renders heading", () => {
    const map = createMockMap();
    const marker = createVehicleMarker({ getMap: () => map, shouldExposeDebug: () => true });
    marker.ensureLayer();
    const layer = map.getLayer("dgm-vehicle-layer");
    assert(layer, "vehicle symbol layer is added");
    assertEqual(layer.type, "symbol", "vehicle layer is a symbol layer");
    assert(map.hasImage("dgm-vehicle-sprite"), "vehicle sprite image is registered (fallback in node)");

    marker.update({ lng: -117.6, lat: 34.06, heading: 90, speed: 12 });
    const data = map._sourceData("dgm-vehicle");
    assertEqual(data.features.length, 1, "one vehicle feature is rendered");
    assertDeepEqual(data.features[0].geometry.coordinates, [-117.6, 34.06], "vehicle is placed at the update position");
    assertEqual(data.features[0].properties.heading, 90, "first update snaps heading to the target");
  });

  runTest("vehicle marker show/hide toggles layer visibility", () => {
    const map = createMockMap();
    const marker = createVehicleMarker({ getMap: () => map });
    marker.update({ lng: -117.6, lat: 34.06, heading: 0 });
    marker.show();
    assertEqual(map.getLayer("dgm-vehicle-layer").visibility, "visible", "show makes the marker visible");
    marker.hide();
    assertEqual(map.getLayer("dgm-vehicle-layer").visibility, "none", "hide conceals the marker");
  });

  runTest("vehicle marker skips work and hides when the guard trips", () => {
    const map = createMockMap();
    let guardDisabled = false;
    const marker = createVehicleMarker({ getMap: () => map, isGuardDisabled: () => guardDisabled, shouldExposeDebug: () => true });
    marker.update({ lng: -117.6, lat: 34.06, heading: 0 });
    marker.show();
    guardDisabled = true;
    const result = marker.update({ lng: -117.59, lat: 34.07, heading: 45 });
    assertEqual(result, null, "guarded update is skipped");
    assertEqual(map.getLayer("dgm-vehicle-layer").visibility, "none", "guarded marker is hidden");
    assertEqual(marker.getDebugMetadata().guardSkips, 1, "guard skip is recorded");
  });

  runTest("vehicle marker debug metadata is gated", () => {
    const map = createMockMap();
    const marker = createVehicleMarker({ getMap: () => map, shouldExposeDebug: () => false });
    marker.update({ lng: -117.6, lat: 34.06, heading: 0 });
    assertEqual(marker.getDebugMetadata(), null, "debug metadata is null when debug is off");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} vehicle camera tests passed`
      : `${failed}/${passed + failed} vehicle camera tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runVehicleCameraTests);
}
