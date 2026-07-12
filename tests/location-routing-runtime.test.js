import { createLocationRuntime } from "../location_runtime.js";
import { createRoutingRuntime } from "../routing_runtime.js";

const PASS = "PASS";
const FAIL = "FAIL";
const DOT_LAYER_ID = "current-location-dot";
const HALO_LAYER_ID = "current-location-halo";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function withWindowLike(windowLike, callback) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  const previousWindow = globalThis.window;
  globalThis.window = windowLike;

  try {
    return callback();
  } finally {
    if (hadWindow) {
      globalThis.window = previousWindow;
    } else {
      delete globalThis.window;
    }
  }
}

function createAnimationWindow() {
  const frames = new Map();
  let nextFrameId = 0;
  return {
    frames,
    requestAnimationFrame(callback) {
      const frameId = ++nextFrameId;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelAnimationFrame(frameId) {
      frames.delete(frameId);
    },
    addEventListener() {},
  };
}

function runNextAnimationFrame(windowLike, timestampMs) {
  const iterator = windowLike.frames.entries().next();
  assert(!iterator.done, "an animation frame is pending");
  const [frameId, callback] = iterator.value;
  windowLike.frames.delete(frameId);
  callback(timestampMs);
}

function createBlueDotMap({ throwDotLayoutMutation = false } = {}) {
  const layerIds = new Set([DOT_LAYER_ID, HALO_LAYER_ID]);
  const layoutUpdates = [];
  const paintUpdates = [];

  return {
    layoutUpdates,
    paintUpdates,
    getLayer(layerId) {
      return layerIds.has(layerId) ? { id: layerId } : null;
    },
    setLayoutProperty(layerId, propertyName, value) {
      if (throwDotLayoutMutation && layerId === DOT_LAYER_ID) {
        throw new Error("layer was replaced during style update");
      }
      layoutUpdates.push({ layerId, propertyName, value });
    },
    setPaintProperty(layerId, propertyName, value) {
      paintUpdates.push({ layerId, propertyName, value });
    },
  };
}

function createBlueDotRuntime(map) {
  return createLocationRuntime({
    getMap: () => map,
    lngLatToObject: (value) => value,
    currentLocationDotLayerId: DOT_LAYER_ID,
    currentLocationHaloLayerId: HALO_LAYER_ID,
    blueDotBaseRadiusPx: 6,
    blueDotBreathingAmplitudePx: 2,
    blueDotBreathingCycleMs: 1000,
    blueDotRadiusEpsilonPx: 0.01,
    blueDotHaloRadiusScale: 2,
    fullCycleRadians: Math.PI * 2,
  });
}

class MockLngLatBounds {
  constructor(southWest, northEast) {
    this.coordinates = [southWest, northEast];
  }

  extend(coordinate) {
    this.coordinates.push(coordinate);
    return this;
  }
}

export function runLocationRoutingRuntimeTests() {
  let passed = 0;
  let failed = 0;

  function runTest(name, fn) {
    try {
      fn();
      passed += 1;
      console.log(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`${FAIL} ${name}: ${error.message}`);
    }
  }

  runTest("blue-dot breathing restarts after the dot is restored", () => {
    const animationWindow = createAnimationWindow();
    const map = createBlueDotMap();

    withWindowLike(animationWindow, () => {
      const runtime = createBlueDotRuntime(map);
      runtime.startBlueDotBreathingAnimation();
      assert(animationWindow.frames.size === 1, "initial breathing frame is scheduled");

      runNextAnimationFrame(animationWindow, 250);
      assert(map.paintUpdates.length === 2, "initial frame updates the dot and halo radii");
      assert(animationWindow.frames.size === 1, "breathing schedules its next frame");

      runtime.hideDot();
      assert(animationWindow.frames.size === 0, "hiding the dot cancels the pending breathing frame");
      assert(
        map.layoutUpdates.some((update) => update.layerId === DOT_LAYER_ID && update.value === "none"),
        "hiding the dot updates dot visibility"
      );

      runtime.showDot();
      assert(animationWindow.frames.size === 1, "showing the dot schedules a new breathing frame");
      assert(
        map.layoutUpdates.some((update) => update.layerId === DOT_LAYER_ID && update.value === "visible"),
        "showing the dot restores dot visibility"
      );
    });
  });

  runTest("blue-dot visibility tolerates a layer replacement race", () => {
    const animationWindow = createAnimationWindow();
    const map = createBlueDotMap({ throwDotLayoutMutation: true });

    withWindowLike(animationWindow, () => {
      const runtime = createBlueDotRuntime(map);
      runtime.hideDot();
      assert(
        map.layoutUpdates.some((update) => update.layerId === HALO_LAYER_ID && update.value === "none"),
        "halo visibility still updates when the dot layer mutation fails"
      );
    });
  });

  runTest("routing camera options fall back when a hook returns null", () => {
    let fitBoundsCall = null;
    const map = {
      fitBounds(bounds, options) {
        fitBoundsCall = { bounds, options };
      },
    };
    const runtime = createRoutingRuntime({
      mapboxgl: { LngLatBounds: MockLngLatBounds },
      getMap: () => map,
      getProgrammaticCameraOptions: () => null,
    });

    runtime.fitRouteToView({
      geometry: {
        coordinates: [[-117.7, 34.1], [-117.6, 34.2]],
      },
    });

    assert(fitBoundsCall, "route fitting calls map.fitBounds");
    assert(fitBoundsCall.options.duration === 850, "fallback preserves route camera duration");
    assert(fitBoundsCall.options.maxZoom === 16, "fallback preserves route camera max zoom");
  });

  return { passed, failed };
}