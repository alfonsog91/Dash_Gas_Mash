import { createDataScoringRuntime } from "../data_scoring_runtime.js";

const PASS = "PASS";
const FAIL = "FAIL";

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

function createBounds() {
  return {
    getSouthWest: () => ({ lat: 34.0, lng: -117.7 }),
    getNorthEast: () => ({ lat: 34.1, lng: -117.6 }),
    intersects: () => true,
    contains: () => true,
  };
}

function createInput(value, checked = false) {
  return {
    value: String(value),
    checked,
    disabled: false,
    setAttribute() {},
  };
}

function createLateResponseRuntime({ mapMoving = false } = {}) {
  const state = {};
  const signals = [];
  const sourceWrites = [];
  const food = createDeferred();
  const parking = createDeferred();
  const residential = createDeferred();
  const bounds = createBounds();
  const loadButton = { disabled: false, textContent: "Load / Refresh for current view" };

  const delayedFetch = (deferred) => (_queryBounds, signal) => {
    signals.push(signal);
    return deferred.promise;
  };

  const runtime = createDataScoringRuntime({
    getMap: () => ({
      getBounds: () => bounds,
      getCenter: () => ({ lat: 34.05, lng: -117.65 }),
      isMoving: () => mapMoving,
    }),
    getLastCurrentLocation: () => null,
    getDataState: () => state,
    setDataState: (patch) => Object.assign(state, patch),
    restaurantById: new Map(),
    parkingById: new Map(),
    featureCollection: (features = []) => ({ type: "FeatureCollection", features }),
    setSourceData: (sourceId, data) => sourceWrites.push({ sourceId, data }),
    setLayerVisibility() {},
    getShowRestaurantsChecked: () => true,
    getShowParkingChecked: () => true,
    lngLatToObject: (point) => point,
    mapBoundsToAdapter: (value) => value,
    haversineMeters: () => 1000,
    probabilityHorizonMinutes: 10,
    predictionModel: "legacy",
    fetchFoodPlaces: delayedFetch(food),
    fetchParkingCandidates: delayedFetch(parking),
    fetchResidentialAnchors: delayedFetch(residential),
    filterOpenRestaurants: (restaurants) => restaurants,
    loadButton,
    hourElement: createInput(12),
    tauElement: createInput(1200),
    gridElement: createInput(250),
    competitionElement: createInput(0.5),
    residentialWeightElement: createInput(0.4),
    useCensusDataElement: createInput(0, false),
    rainBoostElement: createInput(0),
    useLiveWeatherElement: createInput(0, false),
    tipEmphasisElement: createInput(0.5),
    useMlElement: createInput(0, false),
    mlBetaElement: createInput(0),
    kSpotsElement: createInput(3),
    restaurantSourceId: "restaurants",
    parkingSourceId: "parking",
    heatSourceId: "heat",
    spotSourceId: "spot",
    restaurantLayerId: "restaurant-layer",
    parkingLayerId: "parking-layer",
  });

  return {
    food,
    loadButton,
    parking,
    residential,
    runtime,
    signals,
    sourceWrites,
    state,
  };
}

export async function runDataScoringRuntimeTests() {
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

  await runTest("late Overpass results after a map move are discarded by generation", async () => {
    const fixture = createLateResponseRuntime();
    assert(typeof fixture.runtime.getLoadGeneration === "function", "runtime exposes its load generation");
    assert(typeof fixture.runtime.invalidatePendingLoad === "function", "runtime exposes map-move invalidation");

    const pendingLoad = fixture.runtime.loadForView();
    const requestGeneration = fixture.runtime.getLoadGeneration();
    assert(requestGeneration === 1, "the in-flight load owns generation 1");
    assert(fixture.signals.length === 3, "all Overpass operations share the load lifecycle");

    const mapMoveGeneration = fixture.runtime.invalidatePendingLoad("map-move");
    assert(mapMoveGeneration === 2, "map movement advances the generation");
    assert(fixture.signals.every((signal) => signal.aborted), "map movement aborts all in-flight signals");

    fixture.food.resolve([{ id: "stale-food", lat: 34.05, lon: -117.65, tags: {} }]);
    fixture.parking.resolve([{ id: "stale-parking", lat: 34.05, lon: -117.65, tags: {} }]);
    fixture.residential.resolve([{ id: "stale-home", lat: 34.05, lon: -117.65, tags: {} }]);

    const result = await pendingLoad;
    assert(result.status === "discarded", "the late response reports discarded status");
    assert(result.generation === requestGeneration, "the result identifies its stale generation");
    assert(result.currentGeneration === mapMoveGeneration, "the result identifies the newer map generation");
    assert(!Object.hasOwn(fixture.state, "lastRestaurants"), "stale restaurants never overwrite state");
    assert(!Object.hasOwn(fixture.state, "lastParkingCandidates"), "stale parking never overwrites state");
    assert(!Object.hasOwn(fixture.state, "lastStats"), "stale derived statistics never overwrite state");
    assert(!Object.hasOwn(fixture.state, "lastParams"), "stale parameters never overwrite state");
    assert(fixture.sourceWrites.length === 0, "an invalidated load preserves existing map sources");
    assert(fixture.loadButton.disabled === false, "cancellation restores the load control");
  });

  await runTest("a provider failure aborts pending siblings before releasing the load", async () => {
    const fixture = createLateResponseRuntime();
    const pendingLoad = fixture.runtime.loadForView();
    fixture.food.reject(new Error("food provider failed"));

    let rejection = null;
    try {
      await pendingLoad;
    } catch (error) {
      rejection = error;
    }

    assert(rejection?.message === "food provider failed", "the original provider failure is preserved");
    assert(fixture.signals.length === 3, "all sibling providers joined the shared load");
    assert(fixture.signals.every((signal) => signal.aborted), "the failed load aborts every sibling signal");

    fixture.parking.resolve([]);
    fixture.residential.resolve([]);
  });

  await runTest("a load completed during camera motion cannot apply transitional bounds", async () => {
    const fixture = createLateResponseRuntime({ mapMoving: true });
    const pendingLoad = fixture.runtime.loadForView();
    fixture.food.resolve([]);
    fixture.parking.resolve([]);
    fixture.residential.resolve([]);

    const result = await pendingLoad;
    assert(result.status === "discarded", "mid-motion data is discarded");
    assert(!Object.hasOwn(fixture.state, "lastParams"), "mid-motion parameters never apply");
    assert(fixture.sourceWrites.length === 0, "mid-motion data never reaches map sources");
  });

  console.log(`Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runDataScoringRuntimeTests);
}
