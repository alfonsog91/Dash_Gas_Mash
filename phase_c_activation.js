const PHASE_C_FEATURE_ORDER = Object.freeze(["terrain", "globe", "fog", "sky", "buildings3d"]);

const PHASE_C_FLAG_BY_FEATURE = Object.freeze({
  terrain: "phaseCTerrain",
  globe: "phaseCGlobe",
  fog: "phaseCFog",
  sky: "phaseCAtmosphere",
  buildings3d: "phaseC3dBuildings",
});

const PHASE_C_ACTIVATION_EVENT_BY_FEATURE = Object.freeze({
  terrain: "map.phase_c_terrain_enabled",
  globe: "map.phase_c_globe_enabled",
  fog: "map.phase_c_fog_enabled",
  sky: "map.phase_c_sky_enabled",
  buildings3d: "map.phase_c_3d_buildings_enabled",
});

const PHASE_C_LIGHTING_ENABLED_EVENT = "map.phase_c_lighting_enabled";
const PHASE_C_LIGHTING_UNSUPPORTED_EVENT = "map.phase_c_lighting_unsupported";

const PHASE_C_ERROR_REASONS_BY_FEATURE = Object.freeze({
  terrain: ["terrain_invalid", "terrain_api_error"],
  globe: ["projection_invalid", "projection_api_error"],
  fog: ["fog_invalid", "fog_api_error"],
  sky: ["sky_invalid", "sky_api_error", "sky_unsupported"],
  buildings3d: ["buildings3d_invalid", "buildings3d_api_error"],
});

const phaseCStateByMap = new WeakMap();

class PhaseCActivationError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

function createActivationState() {
  return {
    aggregateActive: false,
    cameraActive: false,
    lightingActive: false,
    lightingUnsupportedWarningActive: false,
    previousLight: null,
    previousLightCaptured: false,
    addedTerrainSource: false,
    errorReasons: new Set(),
    featureActive: {
      terrain: false,
      globe: false,
      fog: false,
      sky: false,
      buildings3d: false,
    },
  };
}

function getActivationState(map, callerState = {}) {
  if (!map || (typeof map !== "object" && typeof map !== "function")) {
    throw new PhaseCActivationError("map_invalid");
  }

  let activationState = phaseCStateByMap.get(map);
  if (!activationState) {
    activationState = createActivationState();
    phaseCStateByMap.set(map, activationState);
  }

  if (callerState && typeof callerState === "object") {
    try {
      callerState.phaseCActivation = activationState;
    } catch {
      // Caller-provided state is optional; a non-extensible object should not break activation.
    }
  }

  return activationState;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function throwInvalid(reason) {
  throw new PhaseCActivationError(reason);
}

function throwApiError(reason) {
  throw new PhaseCActivationError(reason);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function emitTelemetry(telemetryEmitter, eventName, payload) {
  try {
    if (typeof telemetryEmitter === "function") {
      telemetryEmitter(eventName, payload);
      return true;
    }

    if (telemetryEmitter && typeof telemetryEmitter.emit === "function") {
      telemetryEmitter.emit(eventName, payload);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function emitActivationError(activationState, telemetryEmitter, buildId, reason) {
  const normalizedReason = isNonEmptyString(reason) ? reason : "unknown_error";
  if (activationState.errorReasons.has(normalizedReason)) {
    return false;
  }

  activationState.errorReasons.add(normalizedReason);
  emitTelemetry(telemetryEmitter, "map.phase_c_activation_error", {
    buildId,
    reason: normalizedReason,
    activated: false,
  });
  return true;
}

function clearFeatureErrors(activationState, featureName) {
  for (const reason of PHASE_C_ERROR_REASONS_BY_FEATURE[featureName] || []) {
    activationState.errorReasons.delete(reason);
  }
}

function normalizeFlags(flags) {
  const sourceFlags = isObject(flags) ? flags : {};
  return Object.fromEntries(
    PHASE_C_FEATURE_ORDER.map((featureName) => [
      PHASE_C_FLAG_BY_FEATURE[featureName],
      sourceFlags[PHASE_C_FLAG_BY_FEATURE[featureName]] === true,
    ])
  );
}

function hasAnyPhaseCFlag(flags) {
  return PHASE_C_FEATURE_ORDER.some((featureName) => flags[PHASE_C_FLAG_BY_FEATURE[featureName]] === true);
}

function updateAggregateState(activationState) {
  activationState.aggregateActive = activationState.cameraActive
    || activationState.lightingActive
    || PHASE_C_FEATURE_ORDER.some((featureName) => activationState.featureActive[featureName]);
}

function validateTerrainManifest(manifestTerrain) {
  if (!isObject(manifestTerrain)
    || !isNonEmptyString(manifestTerrain.sourceId)
    || !isNonEmptyString(manifestTerrain.sourceUrl)
    || !isFiniteNumber(manifestTerrain.tileSize)
    || manifestTerrain.tileSize <= 0
    || !isFiniteNumber(manifestTerrain.exaggeration)) {
    throwInvalid("terrain_invalid");
  }
}

function validateProjectionManifest(manifestProjection) {
  if (!isObject(manifestProjection)
    || !isNonEmptyString(manifestProjection.globe)
    || !isNonEmptyString(manifestProjection.fallback)) {
    throwInvalid("projection_invalid");
  }
}

function validateFogManifest(manifestFog) {
  if (!isObject(manifestFog)
    || !Array.isArray(manifestFog.range)
    || manifestFog.range.length !== 2
    || !isFiniteNumber(manifestFog.range[0])
    || !isFiniteNumber(manifestFog.range[1])
    || manifestFog.range[0] >= manifestFog.range[1]
    || !isNonEmptyString(manifestFog.color)
    || !isNonEmptyString(manifestFog.highColor)
    || !isNonEmptyString(manifestFog.spaceColor)
    || !isFiniteNumber(manifestFog.starIntensity)
    || !isFiniteNumber(manifestFog.horizonBlend)) {
    throwInvalid("fog_invalid");
  }
}

function validateSkyManifest(manifestSky) {
  if (!isObject(manifestSky)
    || !isNonEmptyString(manifestSky.layerId)
    || !isNonEmptyString(manifestSky.type)
    || !isFiniteNumber(manifestSky.sunIntensity)) {
    throwInvalid("sky_invalid");
  }
}

function validateBuildingsManifest(manifestBuildings3d) {
  if (!isObject(manifestBuildings3d)
    || !isNonEmptyString(manifestBuildings3d.layerId)
    || !isNonEmptyString(manifestBuildings3d.sourceLayer)
    || !isFiniteNumber(manifestBuildings3d.minZoom)
    || !isNonEmptyString(manifestBuildings3d.fillColor)
    || !isFiniteNumber(manifestBuildings3d.fillOpacity)
    || manifestBuildings3d.fillOpacity < 0
    || manifestBuildings3d.fillOpacity > 1) {
    throwInvalid("buildings3d_invalid");
  }
}

function validateCameraManifest(manifestCamera, currentZoom) {
  if (!isObject(manifestCamera)
    || !isFiniteNumber(manifestCamera.pitchDegrees)
    || !isFiniteNumber(manifestCamera.zoomOffset)
    || !isFiniteNumber(manifestCamera.globeZoomMin)
    || !isFiniteNumber(manifestCamera.globeZoomMax)
    || manifestCamera.globeZoomMin > manifestCamera.globeZoomMax
    || !isFiniteNumber(manifestCamera.transitionDurationMs)
    || !isFiniteNumber(currentZoom)) {
    throwInvalid("camera_invalid");
  }
}

// Converts manifest camelCase fog keys to Mapbox style-spec hyphenated keys.
function adaptPhaseCFog(manifestFog) {
  validateFogManifest(manifestFog);
  return {
    range: [manifestFog.range[0], manifestFog.range[1]],
    color: manifestFog.color,
    "high-color": manifestFog.highColor,
    "space-color": manifestFog.spaceColor,
    "star-intensity": manifestFog.starIntensity,
    "horizon-blend": manifestFog.horizonBlend,
  };
}

// Narrows the terrain manifest to the raster-dem source shape Mapbox expects.
function buildPhaseCTerrainSource(manifestTerrain) {
  validateTerrainManifest(manifestTerrain);
  return {
    type: "raster-dem",
    url: manifestTerrain.sourceUrl,
    tileSize: manifestTerrain.tileSize,
  };
}

// Builds a Mapbox fill-extrusion layer while preserving height fallbacks.
function buildPhaseCBuildingsLayer(manifestBuildings3d) {
  validateBuildingsManifest(manifestBuildings3d);
  const heightExpression = ["to-number", ["coalesce", ["get", "height"], ["get", "building:height"], 0]];
  const baseExpression = ["to-number", ["coalesce", ["get", "min_height"], ["get", "building:min_height"], 0]];
  return {
    id: manifestBuildings3d.layerId,
    type: "fill-extrusion",
    source: "composite",
    "source-layer": manifestBuildings3d.sourceLayer,
    minzoom: manifestBuildings3d.minZoom,
    paint: {
      "fill-extrusion-color": manifestBuildings3d.fillColor,
      "fill-extrusion-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        manifestBuildings3d.minZoom,
        0,
        manifestBuildings3d.minZoom + 1,
        manifestBuildings3d.fillOpacity,
      ],
      "fill-extrusion-height": [
        "interpolate",
        ["linear"],
        ["zoom"],
        manifestBuildings3d.minZoom,
        0,
        manifestBuildings3d.minZoom + 1,
        heightExpression,
      ],
      "fill-extrusion-base": baseExpression,
      "fill-extrusion-vertical-gradient": true,
    },
  };
}

function cloneJsonValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeLightPosition(position) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(isFiniteNumber)) {
    return [1.15, 210, 35];
  }

  return [
    clamp(position[0], 0, 10),
    clamp(position[1], 0, 360),
    clamp(position[2], 0, 180),
  ];
}

function buildPhaseCLightOptions(manifest) {
  const manifestLight = isObject(manifest?.light) ? manifest.light : {};
  const anchor = manifestLight.anchor === "map" || manifestLight.anchor === "viewport"
    ? manifestLight.anchor
    : "map";

  // Mapbox GL JS v2 exposes one style light; these defaults keep extrusion depth subtle.
  return {
    anchor,
    color: isNonEmptyString(manifestLight.color) ? manifestLight.color : "#fff4dc",
    intensity: isFiniteNumber(manifestLight.intensity) ? clamp(manifestLight.intensity, 0, 1) : 0.55,
    position: normalizeLightPosition(manifestLight.position),
  };
}

function derivePhaseCCameraOptions(manifestCamera, currentZoom) {
  validateCameraManifest(manifestCamera, currentZoom);
  return {
    pitch: manifestCamera.pitchDegrees,
    zoom: clamp(
      currentZoom + manifestCamera.zoomOffset,
      manifestCamera.globeZoomMin,
      manifestCamera.globeZoomMax
    ),
    duration: manifestCamera.transitionDurationMs,
  };
}

function buildPhaseCSkyLayer(manifestSky) {
  validateSkyManifest(manifestSky);
  return {
    id: manifestSky.layerId,
    type: "sky",
    paint: {
      "sky-type": manifestSky.type,
      "sky-atmosphere-sun-intensity": manifestSky.sunIntensity,
    },
  };
}

function callMapApi(map, methodName, args, reason) {
  if (!map || typeof map[methodName] !== "function") {
    throwApiError(reason);
  }

  try {
    return map[methodName](...args);
  } catch {
    throwApiError(reason);
  }
}

function getMapStyleLayers(map, reason) {
  if (!map || typeof map.getStyle !== "function") {
    throwApiError(reason);
  }

  try {
    const style = map.getStyle();
    return Array.isArray(style?.layers) ? style.layers : [];
  } catch {
    throwApiError(reason);
  }
}

function sourceExists(map, sourceId, reason) {
  return Boolean(callMapApi(map, "getSource", [sourceId], reason));
}

function layerExists(map, layerId, reason) {
  return Boolean(callMapApi(map, "getLayer", [layerId], reason));
}

function getCurrentTerrain(map) {
  if (!map || typeof map.getTerrain !== "function") {
    return null;
  }

  try {
    return map.getTerrain();
  } catch {
    return null;
  }
}

function terrainMatches(map, manifestTerrain) {
  const terrain = getCurrentTerrain(map);
  return Boolean(terrain
    && terrain.source === manifestTerrain.sourceId
    && terrain.exaggeration === manifestTerrain.exaggeration);
}

function getCurrentProjectionName(map) {
  if (!map || typeof map.getProjection !== "function") {
    return null;
  }

  try {
    const projection = map.getProjection();
    return typeof projection === "string" ? projection : projection?.name || null;
  } catch {
    return null;
  }
}

function getCurrentFog(map) {
  if (!map || typeof map.getFog !== "function") {
    return null;
  }

  try {
    return map.getFog();
  } catch {
    return null;
  }
}

function getCurrentLight(map) {
  if (map && typeof map.getLight === "function") {
    try {
      return cloneJsonValue(map.getLight());
    } catch {
      return null;
    }
  }

  if (map && typeof map.getStyle === "function") {
    try {
      return cloneJsonValue(map.getStyle()?.light || null);
    } catch {
      return null;
    }
  }

  return null;
}

function fogMatches(map, adaptedFog) {
  const currentFog = getCurrentFog(map);
  if (!currentFog) {
    return false;
  }

  return JSON.stringify(currentFog) === JSON.stringify(adaptedFog);
}

function lightMatches(map, lightSpec) {
  const currentLight = getCurrentLight(map);
  return Boolean(currentLight) && JSON.stringify(currentLight) === JSON.stringify(lightSpec);
}

function supportsSkyInsertion(map, manifestSky) {
  validateSkyManifest(manifestSky);
  if (!map || map.supportsSkyLayer === false || map.__phaseCSupportsSky === false) {
    return false;
  }

  if (typeof map.addLayer !== "function" || typeof map.getLayer !== "function" || typeof map.getStyle !== "function") {
    return false;
  }

  try {
    const style = map.getStyle();
    return Boolean(style && Array.isArray(style.layers));
  } catch {
    return false;
  }
}

function findSafeLayerInsertionPoint(map, reason) {
  const styleLayers = getMapStyleLayers(map, reason);
  const firstTextSymbolLayer = styleLayers.find((layer) => layer?.type === "symbol" && layer.layout?.["text-field"]);
  if (firstTextSymbolLayer?.id) {
    return firstTextSymbolLayer.id;
  }

  return styleLayers.find((layer) => layer?.type === "symbol")?.id || null;
}

function activateTerrain(map, manifest, activationState) {
  const manifestTerrain = manifest?.terrain;
  const sourceSpec = buildPhaseCTerrainSource(manifestTerrain);
  if (!sourceExists(map, manifestTerrain.sourceId, "terrain_api_error")) {
    callMapApi(map, "addSource", [manifestTerrain.sourceId, sourceSpec], "terrain_api_error");
    activationState.addedTerrainSource = true;
  }

  if (!terrainMatches(map, manifestTerrain)) {
    callMapApi(map, "setTerrain", [{
      source: manifestTerrain.sourceId,
      exaggeration: manifestTerrain.exaggeration,
    }], "terrain_api_error");
  }
}

function activateProjection(map, manifest) {
  const manifestProjection = manifest?.projection;
  validateProjectionManifest(manifestProjection);
  if (getCurrentProjectionName(map) !== manifestProjection.globe) {
    callMapApi(map, "setProjection", [manifestProjection.globe], "projection_api_error");
  }
}

function activateFog(map, manifest) {
  const adaptedFog = adaptPhaseCFog(manifest?.fog);
  if (!fogMatches(map, adaptedFog)) {
    callMapApi(map, "setFog", [adaptedFog], "fog_api_error");
  }
}

function activateSky(map, manifest) {
  const manifestSky = manifest?.sky;
  const skyLayer = buildPhaseCSkyLayer(manifestSky);
  if (!supportsSkyInsertion(map, manifestSky)) {
    return false;
  }

  if (!layerExists(map, manifestSky.layerId, "sky_api_error")) {
    try {
      map.addLayer(skyLayer);
    } catch {
      return false;
    }
  }

  return true;
}

function activateBuildings(map, manifest) {
  const manifestBuildings3d = manifest?.buildings3d;
  const layerSpec = buildPhaseCBuildingsLayer(manifestBuildings3d);
  if (!layerExists(map, manifestBuildings3d.layerId, "buildings3d_api_error")) {
    const beforeId = findSafeLayerInsertionPoint(map, "buildings3d_api_error");
    if (beforeId) {
      callMapApi(map, "addLayer", [layerSpec, beforeId], "buildings3d_api_error");
    } else {
      callMapApi(map, "addLayer", [layerSpec], "buildings3d_api_error");
    }
  }
}

function emitLightingUnsupported(activationState, telemetryEmitter, buildId) {
  if (activationState.lightingUnsupportedWarningActive) {
    return;
  }

  activationState.lightingUnsupportedWarningActive = true;
  emitTelemetry(telemetryEmitter, PHASE_C_LIGHTING_UNSUPPORTED_EVENT, {
    buildId,
    reason: "setLight_unavailable",
    activated: false,
  });
}

function activateLighting(map, manifest, activationState, telemetryEmitter, buildId) {
  const lightSpec = buildPhaseCLightOptions(manifest);
  const wasActive = activationState.lightingActive;

  if (!map || typeof map.setLight !== "function") {
    emitLightingUnsupported(activationState, telemetryEmitter, buildId);
    activationState.lightingActive = true;
    updateAggregateState(activationState);
    if (!wasActive) {
      emitTelemetry(telemetryEmitter, PHASE_C_LIGHTING_ENABLED_EVENT, {
        buildId,
        activated: true,
      });
    }
    return;
  }

  if (!activationState.previousLightCaptured) {
    activationState.previousLight = getCurrentLight(map);
    activationState.previousLightCaptured = true;
  }

  if (!lightMatches(map, lightSpec)) {
    callMapApi(map, "setLight", [lightSpec], "lighting_api_error");
  }

  activationState.lightingActive = true;
  activationState.lightingUnsupportedWarningActive = false;
  activationState.errorReasons.delete("lighting_api_error");
  updateAggregateState(activationState);
  if (!wasActive) {
    emitTelemetry(telemetryEmitter, PHASE_C_LIGHTING_ENABLED_EVENT, {
      buildId,
      activated: true,
    });
  }
}

async function applyPhaseCLighting(map, manifest, telemetryEmitter, state = {}, options = {}) {
  const buildId = options?.buildId ?? null;
  let activationState;

  try {
    activationState = getActivationState(map, state);
    activateLighting(map, manifest, activationState, telemetryEmitter, buildId);
  } catch (error) {
    const fallbackState = activationState || createActivationState();
    emitActivationError(fallbackState, telemetryEmitter, buildId, getErrorReason(error));
  }
}

function applyCameraPreset(map, manifest) {
  const currentZoom = callMapApi(map, "getZoom", [], "camera_api_error");
  const cameraOptions = derivePhaseCCameraOptions(manifest?.camera, currentZoom);
  callMapApi(map, "easeTo", [cameraOptions], "camera_api_error");
}

async function rollbackPhaseCLighting(map, state = {}, options = {}) {
  let activationState;

  try {
    activationState = getActivationState(map, state);
  } catch {
    return;
  }

  if (activationState.previousLightCaptured && map && typeof map.setLight === "function") {
    try {
      map.setLight(activationState.previousLight || options.clearLightSpec || {});
    } catch {
      // Lighting rollback should not block emergency visual rollback for other features.
    }
  }

  activationState.lightingActive = false;
  activationState.lightingUnsupportedWarningActive = false;
  activationState.previousLight = null;
  activationState.previousLightCaptured = false;
  activationState.errorReasons.delete("lighting_api_error");
  updateAggregateState(activationState);
}

function removeTerrain(map, manifest, activationState, reason) {
  const manifestTerrain = manifest?.terrain;
  validateTerrainManifest(manifestTerrain);
  callMapApi(map, "setTerrain", [null], reason);
  if (activationState.addedTerrainSource && sourceExists(map, manifestTerrain.sourceId, reason)) {
    callMapApi(map, "removeSource", [manifestTerrain.sourceId], reason);
  }
  activationState.addedTerrainSource = false;
}

function removeProjection(map, manifest, reason) {
  const manifestProjection = manifest?.projection;
  validateProjectionManifest(manifestProjection);
  if (getCurrentProjectionName(map) !== manifestProjection.fallback) {
    callMapApi(map, "setProjection", [manifestProjection.fallback], reason);
  }
}

function removeFog(map, reason) {
  callMapApi(map, "setFog", [null], reason);
}

function removeSky(map, manifest, reason) {
  const manifestSky = manifest?.sky;
  validateSkyManifest(manifestSky);
  if (layerExists(map, manifestSky.layerId, reason)) {
    callMapApi(map, "removeLayer", [manifestSky.layerId], reason);
  }
}

function removeBuildings(map, manifest, reason) {
  const manifestBuildings3d = manifest?.buildings3d;
  validateBuildingsManifest(manifestBuildings3d);
  if (layerExists(map, manifestBuildings3d.layerId, reason)) {
    callMapApi(map, "removeLayer", [manifestBuildings3d.layerId], reason);
  }
}

function deactivateFeature(map, manifest, activationState, featureName) {
  if (featureName === "terrain") {
    removeTerrain(map, manifest, activationState, "terrain_api_error");
  } else if (featureName === "globe") {
    removeProjection(map, manifest, "projection_api_error");
  } else if (featureName === "fog") {
    removeFog(map, "fog_api_error");
  } else if (featureName === "sky") {
    removeSky(map, manifest, "sky_api_error");
  } else if (featureName === "buildings3d") {
    removeBuildings(map, manifest, "buildings3d_api_error");
  }

  activationState.featureActive[featureName] = false;
  clearFeatureErrors(activationState, featureName);
  updateAggregateState(activationState);
}

function activateFeature(map, manifest, activationState, featureName) {
  if (featureName === "terrain") {
    activateTerrain(map, manifest, activationState);
  } else if (featureName === "globe") {
    activateProjection(map, manifest);
  } else if (featureName === "fog") {
    activateFog(map, manifest);
  } else if (featureName === "sky") {
    return activateSky(map, manifest);
  } else if (featureName === "buildings3d") {
    activateBuildings(map, manifest);
  }

  return true;
}

function getErrorReason(error) {
  return error instanceof PhaseCActivationError && isNonEmptyString(error.reason)
    ? error.reason
    : "unknown_error";
}

async function applyPhaseCActivation(map, manifest, flags, telemetryEmitter, state = {}, options = {}) {
  const buildId = options?.buildId ?? null;
  let activationState;

  try {
    activationState = getActivationState(map, state);
  } catch (error) {
    const fallbackState = createActivationState();
    emitActivationError(fallbackState, telemetryEmitter, buildId, getErrorReason(error));
    return;
  }

  const phaseCFlags = normalizeFlags(flags);
  if (!hasAnyPhaseCFlag(phaseCFlags)) {
    return;
  }

  const wasAggregateActive = activationState.aggregateActive;

  for (const featureName of PHASE_C_FEATURE_ORDER) {
    const flagName = PHASE_C_FLAG_BY_FEATURE[featureName];
    if (phaseCFlags[flagName] || !activationState.featureActive[featureName]) {
      continue;
    }

    try {
      deactivateFeature(map, manifest, activationState, featureName);
    } catch (error) {
      emitActivationError(activationState, telemetryEmitter, buildId, getErrorReason(error));
      return;
    }
  }

  for (const featureName of PHASE_C_FEATURE_ORDER) {
    const flagName = PHASE_C_FLAG_BY_FEATURE[featureName];
    if (!phaseCFlags[flagName]) {
      continue;
    }

    const wasActive = activationState.featureActive[featureName];
    try {
      const activated = activateFeature(map, manifest, activationState, featureName);
      if (!activated) {
        activationState.featureActive[featureName] = false;
        emitActivationError(activationState, telemetryEmitter, buildId, "sky_unsupported");
        continue;
      }

      activationState.featureActive[featureName] = true;
      clearFeatureErrors(activationState, featureName);
      updateAggregateState(activationState);
      if (!wasActive) {
        emitTelemetry(telemetryEmitter, PHASE_C_ACTIVATION_EVENT_BY_FEATURE[featureName], {
          buildId,
          activated: true,
        });
      }
    } catch (error) {
      emitActivationError(activationState, telemetryEmitter, buildId, getErrorReason(error));
      return;
    }
  }

  await applyPhaseCLighting(map, manifest, telemetryEmitter, state, { buildId });

  if (!wasAggregateActive && activationState.aggregateActive && !activationState.cameraActive && options?.skipCameraPreset !== true) {
    try {
      applyCameraPreset(map, manifest);
      activationState.cameraActive = true;
      updateAggregateState(activationState);
      emitTelemetry(telemetryEmitter, "map.phase_c_camera_preset_applied", {
        buildId,
        activated: true,
      });
    } catch (error) {
      emitActivationError(activationState, telemetryEmitter, buildId, getErrorReason(error));
    }
  }
}

async function rollbackPhaseCActivation(map, manifest, telemetryEmitter, state = {}, options = {}) {
  const buildId = options?.buildId ?? null;
  let activationState;

  try {
    activationState = getActivationState(map, state);
  } catch (error) {
    const fallbackState = createActivationState();
    emitActivationError(fallbackState, telemetryEmitter, buildId, getErrorReason(error));
    return;
  }

  updateAggregateState(activationState);
  if (!activationState.aggregateActive) {
    return;
  }

  try {
    removeTerrain(map, manifest, activationState, "terrain_api_error");
    removeProjection(map, manifest, "projection_api_error");
    removeFog(map, "fog_api_error");
    removeSky(map, manifest, "sky_api_error");
    removeBuildings(map, manifest, "buildings3d_api_error");
    await rollbackPhaseCLighting(map, state);
  } catch (error) {
    emitActivationError(activationState, telemetryEmitter, buildId, getErrorReason(error));
    return;
  }

  for (const featureName of PHASE_C_FEATURE_ORDER) {
    activationState.featureActive[featureName] = false;
  }
  activationState.cameraActive = false;
  activationState.aggregateActive = false;
  activationState.errorReasons.clear();

  emitTelemetry(telemetryEmitter, "map.phase_c_rollback", {
    buildId,
    rolledBack: true,
  });
}

export {
  adaptPhaseCFog,
  applyPhaseCActivation,
  applyPhaseCLighting,
  buildPhaseCBuildingsLayer,
  buildPhaseCLightOptions,
  buildPhaseCTerrainSource,
  derivePhaseCCameraOptions,
  rollbackPhaseCActivation,
  rollbackPhaseCLighting,
};
