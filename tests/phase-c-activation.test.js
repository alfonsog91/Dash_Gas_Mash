import { getPhaseCManifest } from "../phase_c_manifest.js";
import {
  adaptPhaseCFog,
  applyPhaseCActivation,
  applyPhaseCLighting,
  buildPhaseCBuildingsLayer,
  buildPhaseCLightOptions,
  buildPhaseCTerrainSource,
  derivePhaseCCameraOptions,
  rollbackPhaseCActivation,
  rollbackPhaseCLighting,
} from "../phase_c_activation.js";

const PASS = "PASS";
const FAIL = "FAIL";
const PHASE_C_FLAGS_ALL_FALSE = Object.freeze({
  phaseCTerrain: false,
  phaseCGlobe: false,
  phaseC3dBuildings: false,
  phaseCFog: false,
  phaseCAtmosphere: false,
});
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

function assertThrows(fn, expectedMessage, message) {
  try {
    fn();
  } catch (error) {
    assert(String(error?.message || error).includes(expectedMessage), message);
    return;
  }
  throw new Error(message);
}

function createTelemetryRecorder() {
  const events = [];
  const telemetry = (eventName, payload) => events.push({ eventName, payload });
  telemetry.events = events;
  telemetry.count = (eventName) => events.filter((entry) => entry.eventName === eventName).length;
  telemetry.last = (eventName) => events.filter((entry) => entry.eventName === eventName).at(-1) || null;
  return telemetry;
}

function createMockMap({ supportsSkyLayer = true, supportsLight = true, throwSkyLayer = false, validateLayers = true } = {}) {
  const sources = new Map([["composite", { type: "vector" }]]);
  const layers = [
    { id: "background", type: "background" },
    { id: "road-label", type: "symbol", layout: { "text-field": ["get", "name"] } },
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

  function validateLayer(layer) {
    if (!validateLayers) {
      return;
    }

    if (!layer?.id || !layer.type) {
      throw new Error("invalid layer shape");
    }

    if (layer.type === "fill-extrusion") {
      assertDeepEqual(
        layer.paint?.["fill-extrusion-height"],
        [
          "interpolate",
          ["linear"],
          ["zoom"],
          15,
          0,
          16,
          ["to-number", ["coalesce", ["get", "height"], ["get", "building:height"], 0]],
        ],
        "building height expression is valid and zoom-gated"
      );
      assertDeepEqual(
        layer.paint?.["fill-extrusion-base"],
        ["to-number", ["coalesce", ["get", "min_height"], ["get", "building:min_height"], 0]],
        "building base expression is valid"
      );
    }

    if (layer.type === "sky") {
      assert(layer.paint?.["sky-type"] === "atmosphere", "sky layer uses atmosphere paint type");
      assert(Number.isFinite(layer.paint?.["sky-atmosphere-sun-intensity"]), "sky sun intensity is finite");
    }
  }

  return {
    calls,
    supportsSkyLayer,
    get terrain() {
      return terrain;
    },
    get projection() {
      return projection;
    },
    get fog() {
      return fog;
    },
    get light() {
      return light;
    },
    get zoom() {
      return zoom;
    },
    get pitch() {
      return pitch;
    },
    isStyleLoaded() {
      return true;
    },
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
      if (sources.has(sourceId)) {
        throw new Error(`duplicate source ${sourceId}`);
      }
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
      if ((!supportsSkyLayer || throwSkyLayer) && layer?.type === "sky") {
        throw new Error("sky unsupported");
      }
      if (findLayerIndex(layer.id) !== -1) {
        throw new Error(`duplicate layer ${layer.id}`);
      }
      validateLayer(layer);
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
    getZoom() {
      return zoom;
    },
    easeTo(options) {
      zoom = options.zoom;
      pitch = options.pitch;
      calls.push({ method: "easeTo", options });
    },
    ...(supportsLight ? {
      getLight() {
        return light;
      },
      setLight(nextLight) {
        light = nextLight;
        calls.push({ method: "setLight", light: nextLight });
      },
    } : {}),
  };
}

function omitFlag(flags, flagName) {
  return {
    ...flags,
    [flagName]: false,
  };
}

function getCallCount(map, methodName) {
  return map.calls.filter((call) => call.method === methodName).length;
}

function getManifestWithInvalidFog() {
  const manifest = getPhaseCManifest();
  return {
    ...manifest,
    fog: {
      ...manifest.fog,
      range: [1, Number.POSITIVE_INFINITY],
    },
  };
}

export async function runPhaseCActivationTests() {
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

  log.write("DGM Phase C activation tests");

  await runTest("fog adapter hyphenates keys and validates numbers", () => {
    const manifest = getPhaseCManifest();
    const adaptedFog = adaptPhaseCFog(manifest.fog);
    assertDeepEqual(adaptedFog.range, manifest.fog.range, "fog range is copied");
    assert(adaptedFog["high-color"] === manifest.fog.highColor, "highColor is hyphenated");
    assert(adaptedFog["space-color"] === manifest.fog.spaceColor, "spaceColor is hyphenated");
    assert(adaptedFog["star-intensity"] === manifest.fog.starIntensity, "starIntensity is hyphenated");
    assert(adaptedFog["horizon-blend"] === manifest.fog.horizonBlend, "horizonBlend is hyphenated");
    assertThrows(
      () => adaptPhaseCFog({ ...manifest.fog, range: [0.5] }),
      "fog_invalid",
      "invalid fog range throws"
    );
  });

  await runTest("terrain source spec includes url and tileSize", () => {
    const manifest = getPhaseCManifest();
    const sourceSpec = buildPhaseCTerrainSource(manifest.terrain);
    assertDeepEqual(sourceSpec, {
      type: "raster-dem",
      url: manifest.terrain.sourceUrl,
      tileSize: manifest.terrain.tileSize,
    }, "terrain source spec matches Mapbox raster-dem shape");
  });

  await runTest("buildings layer includes required extrusion expressions", () => {
    const manifest = getPhaseCManifest();
    const layerSpec = buildPhaseCBuildingsLayer(manifest.buildings3d);
    assert(layerSpec.type === "fill-extrusion", "buildings layer is fill-extrusion");
    assert(layerSpec.paint["fill-extrusion-vertical-gradient"] === true, "vertical gradient gives supported depth styling");
    assertDeepEqual(
      layerSpec.paint["fill-extrusion-height"],
      [
        "interpolate",
        ["linear"],
        ["zoom"],
        manifest.buildings3d.minZoom,
        0,
        manifest.buildings3d.minZoom + 1,
        ["to-number", ["coalesce", ["get", "height"], ["get", "building:height"], 0]],
      ],
      "height expression is zoom-gated and preserves fallback"
    );
    assertDeepEqual(
      layerSpec.paint["fill-extrusion-base"],
      ["to-number", ["coalesce", ["get", "min_height"], ["get", "building:min_height"], 0]],
      "base expression matches required fallback"
    );
  });

  await runTest("lighting builder provides conservative Mapbox light spec", () => {
    const manifest = getPhaseCManifest();
    const lightSpec = buildPhaseCLightOptions(manifest);
    assert(lightSpec.anchor === "map", "default light anchor is map-based for sun direction");
    assert(typeof lightSpec.color === "string", "default light color is provided");
    assert(lightSpec.intensity > 0 && lightSpec.intensity <= 1, "light intensity is bounded");
    assertDeepEqual(lightSpec.position, [1.15, 210, 35], "default light position is deterministic");
  });

  await runTest("camera derivation clamps zoom and preserves pitch duration", () => {
    const manifest = getPhaseCManifest();
    const cameraOptions = derivePhaseCCameraOptions(manifest.camera, 12);
    assert(cameraOptions.pitch === manifest.camera.pitchDegrees, "pitch comes from manifest");
    assert(cameraOptions.duration === manifest.camera.transitionDurationMs, "duration comes from manifest");
    assert(cameraOptions.zoom === 11.5, "zoom applies offset");
    assert(
      derivePhaseCCameraOptions(manifest.camera, -50).zoom === manifest.camera.globeZoomMin,
      "zoom clamps to minimum"
    );
    assert(
      derivePhaseCCameraOptions(manifest.camera, 50).zoom === manifest.camera.globeZoomMax,
      "zoom clamps to maximum"
    );
  });

  await runTest("activation occurs only when flags are true", async () => {
    const manifest = getPhaseCManifest();
    const inactiveMap = createMockMap();
    const inactiveTelemetry = createTelemetryRecorder();
    await applyPhaseCActivation(inactiveMap, manifest, PHASE_C_FLAGS_ALL_FALSE, inactiveTelemetry, {}, { buildId: "test" });
    assert(inactiveMap.calls.length === 0, "false flags do not call Mapbox APIs");
    assert(inactiveTelemetry.events.length === 0, "false flags do not emit telemetry");

    const activeMap = createMockMap();
    const activeTelemetry = createTelemetryRecorder();
    await applyPhaseCActivation(activeMap, manifest, PHASE_C_FLAGS_ALL_TRUE, activeTelemetry, {}, { buildId: "test" });
    assert(activeMap.getSource(manifest.terrain.sourceId), "terrain source is added");
    assert(activeMap.terrain?.source === manifest.terrain.sourceId, "terrain is enabled");
    assert(activeMap.projection.name === manifest.projection.globe, "globe projection is enabled");
    assert(activeMap.fog?.["high-color"] === manifest.fog.highColor, "fog is adapted and enabled");
    assert(activeMap.getLayer(manifest.sky.layerId), "sky layer is inserted");
    assert(activeMap.getLayer(manifest.buildings3d.layerId), "3D buildings layer is inserted");
    assertDeepEqual(activeMap.light, buildPhaseCLightOptions(manifest), "lighting is enabled as aggregate visual behavior");
    assert(activeMap.pitch === manifest.camera.pitchDegrees, "camera preset is applied");
  });

  await runTest("activation is idempotent across readiness cycles", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap();
    const telemetry = createTelemetryRecorder();
    const state = {};
    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });

    assert(getCallCount(map, "addSource") === 1, "terrain source is not duplicated");
    assert(
      getCallCount(map, "addLayer") === 2,
      "sky and buildings layers are inserted once each"
    );
    assert(getCallCount(map, "setLight") === 1, "lighting is not duplicated");
    assert(telemetry.count("map.phase_c_terrain_enabled") === 1, "terrain telemetry emits once");
    assert(telemetry.count("map.phase_c_globe_enabled") === 1, "globe telemetry emits once");
    assert(telemetry.count("map.phase_c_fog_enabled") === 1, "fog telemetry emits once");
    assert(telemetry.count("map.phase_c_sky_enabled") === 1, "sky telemetry emits once");
    assert(telemetry.count("map.phase_c_3d_buildings_enabled") === 1, "building telemetry emits once");
    assert(telemetry.count("map.phase_c_lighting_enabled") === 1, "lighting telemetry emits once");
    assert(telemetry.count("map.phase_c_camera_preset_applied") === 1, "camera telemetry emits once");
  });

  await runTest("camera preset can be skipped during active follow states", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap();
    const telemetry = createTelemetryRecorder();
    const state = {};
    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, {
      buildId: "test",
      skipCameraPreset: true,
    });

    assert(getCallCount(map, "easeTo") === 0, "camera preset is skipped when unsafe");
    assert(telemetry.count("map.phase_c_camera_preset_applied") === 0, "skipped camera emits no preset telemetry");

    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
    assert(getCallCount(map, "easeTo") === 0, "camera preset does not run later in same aggregate activation");
  });

  await runTest("telemetry supports function emitters and prefers them", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap();
    const events = [];
    const telemetry = (eventName, payload) => events.push({ eventName, payload, shape: "function" });
    telemetry.emit = (eventName, payload) => events.push({ eventName, payload, shape: "emit" });

    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCTerrain: true }, telemetry, {}, { buildId: "test" });
    assert(events.length > 0, "function telemetry receives events");
    assert(events.every((entry) => entry.shape === "function"), "function form is preferred");
  });

  await runTest("telemetry supports object emitters", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap();
    const events = [];
    const telemetry = {
      emit: (eventName, payload) => events.push({ eventName, payload }),
    };

    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCTerrain: true }, telemetry, {}, { buildId: "test" });
    assert(events.some((entry) => entry.eventName === "map.phase_c_terrain_enabled"), "object emitter receives activation event");
  });

  await runTest("partial deactivation reconciles each flag without rollback telemetry", async () => {
    const manifest = getPhaseCManifest();
    const cases = [
      { flagName: "phaseCTerrain", eventName: "map.phase_c_terrain_enabled", removalMethod: "setTerrain" },
      { flagName: "phaseCGlobe", eventName: "map.phase_c_globe_enabled", removalMethod: "setProjection" },
      { flagName: "phaseCFog", eventName: "map.phase_c_fog_enabled", removalMethod: "setFog" },
      { flagName: "phaseCAtmosphere", eventName: "map.phase_c_sky_enabled", removalMethod: "removeLayer" },
      { flagName: "phaseC3dBuildings", eventName: "map.phase_c_3d_buildings_enabled", removalMethod: "removeLayer" },
    ];

    for (const partialCase of cases) {
      const map = createMockMap();
      const telemetry = createTelemetryRecorder();
      const state = {};
      await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
      const callsBeforeDeactivation = getCallCount(map, partialCase.removalMethod);
      await applyPhaseCActivation(map, manifest, omitFlag(PHASE_C_FLAGS_ALL_TRUE, partialCase.flagName), telemetry, state, { buildId: "test" });
      assert(
        getCallCount(map, partialCase.removalMethod) > callsBeforeDeactivation,
        `${partialCase.flagName} performs a partial deactivation call`
      );
      assert(telemetry.count("map.phase_c_rollback") === 0, `${partialCase.flagName} does not emit rollback telemetry`);
      await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
      assert(telemetry.count(partialCase.eventName) === 2, `${partialCase.flagName} reactivation emits once after deactivation`);
    }
  });

  await runTest("full rollback telemetry emits only once per aggregate transition", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap();
    const telemetry = createTelemetryRecorder();
    const state = {};

    await rollbackPhaseCActivation(map, manifest, telemetry, state, { buildId: "test" });
    assert(telemetry.count("map.phase_c_rollback") === 0, "rollback before activation is a no-op");

    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
    await rollbackPhaseCActivation(map, manifest, telemetry, state, { buildId: "test" });
    await rollbackPhaseCActivation(map, manifest, telemetry, state, { buildId: "test" });
    assert(telemetry.count("map.phase_c_rollback") === 1, "duplicate rollback calls do not re-emit");
    assert(map.terrain === null, "terrain is cleared on rollback");
    assert(map.projection.name === manifest.projection.fallback, "projection returns to fallback");
    assert(map.fog === null, "fog is cleared on rollback");
    assert(!map.getLayer(manifest.sky.layerId), "sky layer is removed on rollback");
    assert(!map.getLayer(manifest.buildings3d.layerId), "3D buildings layer is removed on rollback");
    assertDeepEqual(map.light, { anchor: "viewport", color: "#ffffff", intensity: 0.5, position: [1.15, 210, 30] }, "lighting is restored on rollback");

    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCFog: true }, telemetry, state, { buildId: "test" });
    await rollbackPhaseCActivation(map, manifest, telemetry, state, { buildId: "test" });
    assert(telemetry.count("map.phase_c_rollback") === 2, "rollback re-emits after a new aggregate activation");
  });

  await runTest("lighting unsupported warning is deterministic and idempotent", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap({ supportsLight: false });
    const telemetry = createTelemetryRecorder();
    const state = {};

    await applyPhaseCLighting(map, manifest, telemetry, state, { buildId: "test" });
    await applyPhaseCLighting(map, manifest, telemetry, state, { buildId: "test" });
    assert(getCallCount(map, "setLight") === 0, "missing setLight is not called");
    assert(telemetry.count("map.phase_c_lighting_unsupported") === 1, "unsupported lighting warning emits once");
    assert(telemetry.last("map.phase_c_lighting_unsupported").payload.reason === "setLight_unavailable", "unsupported reason is deterministic");
    assert(telemetry.count("map.phase_c_lighting_enabled") === 1, "lighting transition telemetry emits once");

    await rollbackPhaseCLighting(map, state);
    await applyPhaseCLighting(map, manifest, telemetry, state, { buildId: "test" });
    assert(telemetry.count("map.phase_c_lighting_unsupported") === 2, "warning re-emits after rollback transition");
  });

  await runTest("activation errors are deterministic and de-duplicated", async () => {
    const manifest = getManifestWithInvalidFog();
    const map = createMockMap();
    const telemetry = createTelemetryRecorder();
    const state = {};

    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCFog: true }, telemetry, state, { buildId: "test" });
    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCFog: true }, telemetry, state, { buildId: "test" });
    assert(telemetry.count("map.phase_c_activation_error") === 1, "same validation error emits once");
    assert(telemetry.last("map.phase_c_activation_error").payload.reason === "fog_invalid", "error reason is deterministic");
  });

  await runTest("sky unsupported emits one error and continues safely", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap({ supportsSkyLayer: false });
    const telemetry = createTelemetryRecorder();
    const state = {};

    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCAtmosphere: true }, telemetry, state, { buildId: "test" });
    await applyPhaseCActivation(map, manifest, { ...PHASE_C_FLAGS_ALL_FALSE, phaseCAtmosphere: true }, telemetry, state, { buildId: "test" });
    assert(!map.getLayer(manifest.sky.layerId), "unsupported sky is not inserted");
    assert(telemetry.count("map.phase_c_activation_error") === 1, "sky unsupported error is emitted once");
    assert(telemetry.last("map.phase_c_activation_error").payload.reason === "sky_unsupported", "sky unsupported reason is deterministic");
  });

  await runTest("sky insertion failure does not block later visual activation", async () => {
    const manifest = getPhaseCManifest();
    const map = createMockMap({ throwSkyLayer: true });
    const telemetry = createTelemetryRecorder();
    const state = {};

    await applyPhaseCActivation(map, manifest, PHASE_C_FLAGS_ALL_TRUE, telemetry, state, { buildId: "test" });
    assert(!map.getLayer(manifest.sky.layerId), "failed sky layer is not inserted");
    assert(map.getLayer(manifest.buildings3d.layerId), "buildings still activate after sky fallback");
    assertDeepEqual(map.light, buildPhaseCLightOptions(manifest), "lighting still activates after sky fallback");
    assert(telemetry.last("map.phase_c_activation_error").payload.reason === "sky_unsupported", "sky insertion failure is deterministic");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} Phase C activation tests passed`
      : `${failed}/${passed + failed} Phase C activation tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    runPhaseCActivationTests().catch((error) => {
      const log = createLogger();
      log.write(`${FAIL} Phase C activation harness crashed: ${error.message}`);
      document.title = "Phase C activation tests crashed";
    });
  });
}
