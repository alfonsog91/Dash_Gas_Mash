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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
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

export async function runLocationRoutingRuntimeTests() {
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`${FAIL} ${name}: ${error.message}`);
    }
  }

  await runTest("blue-dot breathing restarts after the dot is restored", () => {
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

  await runTest("blue-dot visibility tolerates a layer replacement race", () => {
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

  await runTest("routing camera options fall back when a hook returns null", () => {
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

  await runTest("navigation mode changes notify the lifecycle owner", () => {
    const routingState = { navigationCameraMode: "browse" };
    const lifecycleEvents = [];
    const runtime = createRoutingRuntime({
      getRoutingState: () => routingState,
      setRoutingState: (patch) => Object.assign(routingState, patch),
      onNavigationContextChange: (event) => lifecycleEvents.push(event),
    });

    runtime.setNavigationCameraMode("driver");
    runtime.setNavigationCameraMode("driver");

    assert(lifecycleEvents.length === 1, "only an actual mode transition emits an event");
    assert(lifecycleEvents[0].type === "mode-change", "event identifies a mode transition");
    assert(lifecycleEvents[0].previousMode === "browse", "event records the previous mode");
    assert(lifecycleEvents[0].mode === "driver", "event records the next mode");
  });

  await runTest("route request cancellation aborts and clears the owned controller", () => {
    const controller = new AbortController();
    const routingState = { activeRouteAbort: controller };
    const runtime = createRoutingRuntime({
      getRoutingState: () => routingState,
      setRoutingState: (patch) => Object.assign(routingState, patch),
    });

    assert(runtime.cancelInFlightRouteRequest() === true, "active cancellation reports work");
    assert(controller.signal.aborted, "active route request is aborted");
    assert(routingState.activeRouteAbort === null, "cancelled controller is released");
    assert(runtime.cancelInFlightRouteRequest() === false, "idle cancellation reports no work");
  });

  await runTest("late route response cannot apply after its request token is cancelled", async () => {
    const originalFetch = globalThis.fetch;
    const response = createDeferred();
    const routingState = { navigationCameraMode: "browse", activeRouteAbort: null };
    const sourceWrites = [];
    globalThis.fetch = () => response.promise;

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        getCurrentLocation: () => ({ lat: 34.05, lng: -117.65 }),
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
        setSourceData: (...args) => sourceWrites.push(args),
        featureCollection: (features = []) => ({ type: "FeatureCollection", features }),
      });

      const pendingRoute = runtime.startInAppNavigation({ lat: 34.1, lng: -117.6 });
      await Promise.resolve();
      assert(runtime.cancelInFlightRouteRequest() === true, "the pending route token is cancelled");
      response.resolve({
        ok: true,
        json: async () => ({
          routes: [{
            geometry: { type: "LineString", coordinates: [[-117.65, 34.05], [-117.6, 34.1]] },
            distance: 1000,
            duration: 300,
            legs: [],
          }],
        }),
      });

      let rejection = null;
      try {
        await pendingRoute;
      } catch (error) {
        rejection = error;
      }

      assert(rejection?.name === "AbortError", "late route completion rejects as aborted");
      assert(!routingState.activeRoute, "late route completion never replaces active route state");
      assert(sourceWrites.length === 0, "late route geometry never reaches the map source");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("newer navigation owns routing when geolocation resolves out of order", async () => {
    const originalFetch = globalThis.fetch;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const positions = [createDeferred(), createDeferred()];
    const fetchSignals = [];
    const locationWrites = [];
    let positionIndex = 0;
    const routingState = { navigationCameraMode: "browse", activeRouteAbort: null };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { geolocation: {} },
    });
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      fetchSignals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const runtime = createRoutingRuntime({
      getRoutingState: () => routingState,
      setRoutingState: (patch) => Object.assign(routingState, patch),
      getCurrentLocation: () => null,
      getCurrentPosition: () => positions[positionIndex++].promise,
      setCurrentLocationState: (point) => {
        locationWrites.push(point);
        return point;
      },
      osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
    });

    let secondEarlyError = null;
    const firstOutcome = runtime.startInAppNavigation({ lat: 34.1, lng: -117.6 })
      .then(() => null, (error) => error);
    const secondOutcome = runtime.startInAppNavigation({ lat: 34.2, lng: -117.5 })
      .then(
        () => null,
        (error) => {
          secondEarlyError = error;
          return error;
        }
      );

    try {
      positions[1].resolve({ coords: { latitude: 34.05, longitude: -117.65, accuracy: 10 } });
      await flushMicrotasks(8);
      assert(
        fetchSignals.length === 1,
        `the newer navigation begins the only route fetch (got ${fetchSignals.length}; error ${secondEarlyError?.message || "none"})`
      );

      positions[0].resolve({ coords: { latitude: 34.04, longitude: -117.66, accuracy: 10 } });
      await flushMicrotasks(8);
      assert(fetchSignals.length === 1, `late geolocation cannot resurrect the older navigation (got ${fetchSignals.length})`);
      assert(locationWrites.length === 1, "late geolocation cannot overwrite newer location state");
      assert(locationWrites[0].lat === 34.05, "only the newer navigation location is committed");
    } finally {
      runtime.cancelInFlightRouteRequest();
      globalThis.fetch = originalFetch;
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
    }

    const [firstError, secondError] = await Promise.all([firstOutcome, secondOutcome]);
    assert(firstError?.name === "AbortError", "the superseded pre-fetch navigation rejects as aborted");
    assert(secondError?.name === "AbortError", "explicit cleanup aborts the newer fetch");
  });

  await runTest("cancelled route normalizes a late provider rejection to AbortError", async () => {
    const originalFetch = globalThis.fetch;
    const response = createDeferred();
    const routingState = { navigationCameraMode: "browse", activeRouteAbort: null };
    globalThis.fetch = () => response.promise;

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        getCurrentLocation: () => ({ lat: 34.05, lng: -117.65 }),
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
      });

      const outcome = runtime.startInAppNavigation({ lat: 34.1, lng: -117.6 })
        .then(() => null, (error) => error);
      await flushMicrotasks();
      runtime.cancelInFlightRouteRequest();
      response.reject(new TypeError("provider ignored abort then failed"));

      const rejection = await outcome;
      assert(rejection?.name === "AbortError", "cancelled ownership wins over the provider error type");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("cancelled reroute preserves successful throttle state and clears pending status", async () => {
    const originalFetch = globalThis.fetch;
    const response = createDeferred();
    const previousOrigin = { lat: 34.0, lng: -117.7 };
    const routingState = {
      activeRoute: {
        destination: { lat: 34.1, lng: -117.6 },
        navigationSnapshot: {},
      },
      activeRouteAbort: null,
      lastRouteOriginForRefresh: previousOrigin,
      lastRouteRefreshAt: 100,
      lastNavigationStatusMessage: "",
      lastNavigationStatusTone: "info",
      navigationCameraMode: "driver",
    };
    globalThis.fetch = () => response.promise;

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        haversineMeters: () => 100,
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
        navRerouteMinDistanceMeters: 30,
        navRerouteMinIntervalMs: 4000,
      });

      const outcome = runtime.refreshActiveRouteFromOrigin({ lat: 34.01, lng: -117.69 }, { force: true })
        .then(() => null, (error) => error);
      await flushMicrotasks();
      assert(routingState.lastNavigationStatusMessage === "Updating route…", "reroute exposes pending status");
      runtime.cancelInFlightRouteRequest({ clearPendingStatus: true });

      response.resolve({
        ok: true,
        json: async () => ({
          routes: [{
            geometry: { type: "LineString", coordinates: [[-117.69, 34.01], [-117.6, 34.1]] },
            distance: 1000,
            duration: 300,
            legs: [],
          }],
        }),
      });
      const rejection = await outcome;

      assert(rejection?.name === "AbortError", "the late reroute rejects as aborted");
      assert(routingState.lastRouteOriginForRefresh === previousOrigin, "last successful refresh origin is preserved");
      assert(routingState.lastRouteRefreshAt === 100, "last successful refresh time is preserved");
      assert(routingState.lastNavigationStatusMessage === "", "pending reroute status is cleared");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("replacement navigation stops the old watch and ignores its queued callback", async () => {
    const originalFetch = globalThis.fetch;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const fetchSignals = [];
    const clearedWatchIds = [];
    let watchCallback = null;
    const routingState = {
      activeRoute: { destination: { lat: 34.1, lng: -117.6 } },
      activeRouteAbort: null,
      activeNavigationWatchId: null,
      lastRouteOriginForRefresh: { lat: 34.0, lng: -117.7 },
      lastRouteRefreshAt: 0,
      navigationCameraMode: "driver",
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        geolocation: {
          watchPosition(callback) {
            watchCallback = callback;
            return 7;
          },
          clearWatch(watchId) {
            clearedWatchIds.push(watchId);
          },
        },
      },
    });
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      fetchSignals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        getCurrentLocation: () => ({ lat: 34.0, lng: -117.7 }),
        setCurrentLocationState: (point) => point,
        syncHeadingFromLocation() {},
        haversineMeters: () => 100,
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
        navRerouteMinDistanceMeters: 30,
        navRerouteMinIntervalMs: 0,
      });

      runtime.ensureNavigationWatch();
      assert(routingState.activeNavigationWatchId === 7, "the old route owns a location watch");

      const replacementOutcome = runtime.startInAppNavigation({ lat: 34.2, lng: -117.5 })
        .then(() => null, (error) => error);
      await flushMicrotasks();
      const replacementSignal = fetchSignals[0];
      watchCallback({ coords: { latitude: 34.01, longitude: -117.69, accuracy: 10 } });
      await flushMicrotasks();

      assert(clearedWatchIds.includes(7), "replacement navigation clears the old watch");
      assert(fetchSignals.length === 1, "a queued old-watch callback cannot start another route request");
      assert(!replacementSignal.aborted, "the queued old-watch callback cannot cancel the replacement route");

      routingState.activeRoute = null;
      runtime.cancelInFlightRouteRequest();
      const replacementError = await replacementOutcome;
      assert(replacementError?.name === "AbortError", "test cleanup cancels the replacement request");
    } finally {
      globalThis.fetch = originalFetch;
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
    }
  });

  await runTest("a slow reroute is not replaced by each location update", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSignals = [];
    const routingState = {
      activeRoute: {
        destination: { lat: 34.1, lng: -117.6 },
        navigationSnapshot: {},
      },
      activeRouteAbort: null,
      lastRouteOriginForRefresh: { lat: 34.0, lng: -117.7 },
      lastRouteRefreshAt: 0,
      navigationCameraMode: "driver",
    };
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      fetchSignals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        haversineMeters: () => 100,
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
        navRerouteMinDistanceMeters: 30,
        navRerouteMinIntervalMs: 0,
      });

      const firstOutcome = runtime.refreshActiveRouteFromOrigin({ lat: 34.01, lng: -117.69 })
        .then(() => null, (error) => error);
      await flushMicrotasks();
      const secondOutcome = runtime.refreshActiveRouteFromOrigin({ lat: 34.02, lng: -117.68 })
        .then((result) => result, (error) => error);
      await flushMicrotasks();

      assert(fetchSignals.length === 1, `only one non-forced reroute remains in flight (got ${fetchSignals.length})`);
      assert(!fetchSignals[0].aborted, "a later location update does not abort the pending reroute");

      runtime.cancelInFlightRouteRequest();
      const [firstError, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
      assert(firstError?.name === "AbortError", "test cleanup cancels the pending reroute");
      assert(secondResult === routingState.activeRoute, "the skipped update returns the active route");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runTest("failed replacement navigation restores the previous route watch", async () => {
    const originalFetch = globalThis.fetch;
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const clearedWatchIds = [];
    let nextWatchId = 20;
    const previousRoute = { destination: { lat: 34.1, lng: -117.6 } };
    const routingState = {
      activeRoute: previousRoute,
      activeRouteAbort: null,
      activeNavigationWatchId: null,
      navigationCameraMode: "driver",
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        geolocation: {
          watchPosition() {
            nextWatchId += 1;
            return nextWatchId;
          },
          clearWatch(watchId) {
            clearedWatchIds.push(watchId);
          },
        },
      },
    });
    globalThis.fetch = async () => ({ ok: false, status: 503 });

    try {
      const runtime = createRoutingRuntime({
        getRoutingState: () => routingState,
        setRoutingState: (patch) => Object.assign(routingState, patch),
        getCurrentLocation: () => ({ lat: 34.0, lng: -117.7 }),
        osrmRouteApiUrl: "https://router.example.test/route/v1/driving",
      });

      runtime.ensureNavigationWatch();
      const previousWatchId = routingState.activeNavigationWatchId;
      let rejection = null;
      try {
        await runtime.startInAppNavigation({ lat: 34.2, lng: -117.5 });
      } catch (error) {
        rejection = error;
      }

      assert(rejection?.message === "Route request failed (503)", "replacement reports the provider failure");
      assert(routingState.activeRoute === previousRoute, "the previous route remains active");
      assert(clearedWatchIds.includes(previousWatchId), "the previous watch is disposed during replacement");
      assert(routingState.activeNavigationWatchId !== null, "a fresh watch is restored for the previous route");
      assert(routingState.activeNavigationWatchId !== previousWatchId, "the restored watch owns a new generation");
    } finally {
      globalThis.fetch = originalFetch;
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
    }
  });

  return { passed, failed };
}
