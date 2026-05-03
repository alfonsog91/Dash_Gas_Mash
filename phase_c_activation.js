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
const PHASE_D_TUNING_QUERY_PARAM = "phaseD";
const PHASE_D_TUNING_STORAGE_KEY = "DGM_PHASE_D_TUNING";
const PHASE_D_TERRAIN_EXAGGERATION = 0.85;
const PHASE_D_LIGHT_SPEC = Object.freeze({
  position: Object.freeze([1.15, 210, 30]),
  intensity: 0.7,
});
const PHASE_D_BUILDING_AMBIENT_INTENSITY = 0.6;
const PHASE_D_BUILDING_LOD_THROTTLE_MS = 200;
const PHASE_D_BUILDING_LOD_DEBOUNCE_MS = 80;
const PHASE_D_FOG_SPEC = Object.freeze({
  range: Object.freeze([0.5, 10]),
  color: "#f6fbff",
  density: 0.002,
});
const PHASE_D_CAMERA_TUNING_PARAMETERS = Object.freeze({
  pitchMin: 35,
  pitchMax: 62,
  programmaticTransitionEasing: 0.22,
});
const PHASE_D_SKY_PAINT_PROPERTIES = Object.freeze([
  ["sky-type", "gradient"],
  ["sky-gradient", Object.freeze([
    "interpolate",
    Object.freeze(["linear"]),
    Object.freeze(["sky-radial-progress"]),
    0,
    "#87CEEB",
    1,
    "#E6F2FF",
  ])],
  ["sky-gradient-center", Object.freeze([0, 0])],
  ["sky-gradient-radius", 90],
]);
const PHASE_D_POI_TEXT_OPACITY = Object.freeze(["step", Object.freeze(["zoom"]), 0, 13, 1]);
const PHASE_D_POI_TEXT_PAINT_PROPERTIES = Object.freeze([
  ["text-opacity", PHASE_D_POI_TEXT_OPACITY],
  ["text-color", "#111"],
  ["text-halo-color", "#fff"],
  ["text-halo-width", 1],
]);
const PHASE_D_COLOR_GRADE = Object.freeze({
  water: "#437fcf",
  road: "#d8c16a",
  park: "#6f9f65",
});

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
    phaseDTuning: {},
  };
}

function getWindowLike() {
  return typeof window !== "undefined" ? window : null;
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

function getPhaseCActivationSnapshot(state = {}) {
  if (isObject(state?.phaseCActivation)) {
    return state.phaseCActivation;
  }

  if (isObject(state) && typeof state.aggregateActive === "boolean") {
    return state;
  }

  return null;
}

function isPhaseCAggregateActive(state = {}) {
  return getPhaseCActivationSnapshot(state)?.aggregateActive === true;
}

function isPhaseDQueryParamEnabled(windowLike = getWindowLike()) {
  try {
    return new URLSearchParams(windowLike?.location?.search || "").get(PHASE_D_TUNING_QUERY_PARAM) === "true";
  } catch {
    return false;
  }
}

function isPhaseDLocalStorageEnabled(windowLike = getWindowLike()) {
  try {
    return windowLike?.localStorage?.getItem(PHASE_D_TUNING_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function isPhaseDTuningRequested(windowLike = getWindowLike()) {
  return isPhaseDQueryParamEnabled(windowLike) || isPhaseDLocalStorageEnabled(windowLike);
}

function isPhaseDTuningEnabled(state = {}, windowLike = getWindowLike()) {
  return isPhaseCAggregateActive(state) && isPhaseDTuningRequested(windowLike);
}

function isLocalhostDebugHost(windowLike = getWindowLike()) {
  const hostname = String(windowLike?.location?.hostname || "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function shouldExposePhaseDDebug(windowLike = getWindowLike()) {
  return isPhaseDTuningRequested(windowLike) || isLocalhostDebugHost(windowLike);
}

function getPhaseDCameraTuningParameters(state = {}, windowLike = getWindowLike()) {
  if (!isPhaseDTuningEnabled(state, windowLike)) {
    return null;
  }

  return { ...PHASE_D_CAMERA_TUNING_PARAMETERS };
}

function buildExponentialProgrammaticEasing(programmaticTransitionEasing) {
  const strength = 1 + clamp(Number(programmaticTransitionEasing) || 0, 0.01, 1) * 8;
  const denominator = 1 - Math.exp(-strength);
  return (progress) => {
    const t = clamp(Number(progress) || 0, 0, 1);
    return denominator > 0 ? (1 - Math.exp(-strength * t)) / denominator : t;
  };
}

function applyPhaseDProgrammaticCameraSmoothing(cameraOptions = {}, tuningParameters = null) {
  if (!isObject(cameraOptions) || !isObject(tuningParameters)) {
    return cameraOptions;
  }

  const nextOptions = {
    ...cameraOptions,
    easing: buildExponentialProgrammaticEasing(tuningParameters.programmaticTransitionEasing),
  };

  if (isFiniteNumber(nextOptions.pitch)) {
    nextOptions.pitch = clamp(nextOptions.pitch, tuningParameters.pitchMin, tuningParameters.pitchMax);
  }

  return nextOptions;
}

function getPhaseDTuningState(activationState) {
  if (!isObject(activationState?.phaseDTuning)) {
    activationState.phaseDTuning = {};
  }

  if (!(activationState.phaseDTuning.paintProperties instanceof Map)) {
    activationState.phaseDTuning.paintProperties = new Map();
  }

  return activationState.phaseDTuning;
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

function buildPhaseDBuildingOpacityExpression(manifestBuildings3d, pitchOpacityScale = 1) {
  validateBuildingsManifest(manifestBuildings3d);
  const targetOpacity = clamp(manifestBuildings3d.fillOpacity * pitchOpacityScale, 0, 1);
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    manifestBuildings3d.minZoom - 0.25,
    0,
    manifestBuildings3d.minZoom + 0.45,
    targetOpacity * 0.42,
    manifestBuildings3d.minZoom + 1.25,
    targetOpacity,
  ];
}

function buildPhaseDBuildingHeightExpression(manifestBuildings3d, pitchHeightScale = 1) {
  validateBuildingsManifest(manifestBuildings3d);
  const heightExpression = ["to-number", ["coalesce", ["get", "height"], ["get", "building:height"], 0]];
  const heightScale = clamp(pitchHeightScale, 0.65, 1.2);
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    manifestBuildings3d.minZoom - 0.15,
    0,
    manifestBuildings3d.minZoom + 0.75,
    ["*", heightExpression, heightScale * 0.72],
    manifestBuildings3d.minZoom + 1.45,
    ["*", heightExpression, heightScale],
  ];
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

function terrainMatchesExaggeration(map, sourceId, exaggeration) {
  const terrain = getCurrentTerrain(map);
  return Boolean(terrain
    && terrain.source === sourceId
    && terrain.exaggeration === exaggeration);
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

function lightHasPhaseDValues(map) {
  const currentLight = getCurrentLight(map);
  return Boolean(currentLight
    && currentLight.intensity === PHASE_D_LIGHT_SPEC.intensity
    && Array.isArray(currentLight.position)
    && JSON.stringify(currentLight.position) === JSON.stringify(PHASE_D_LIGHT_SPEC.position));
}

function getPaintPropertyCacheKey(layerId, propertyName) {
  return `${layerId}:${propertyName}`;
}

function getStyleLayerSignature(layer) {
  return [
    layer?.id,
    layer?.source,
    layer?.["source-layer"],
    layer?.metadata?.["mapbox:group"],
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function isPhaseDPoiLabelLayer(layer) {
  if (!layer?.id || layer.type !== "symbol" || !layer.layout?.["text-field"]) {
    return false;
  }

  return /poi|point-of-interest|landmark|airport|transit|station|maki|natural-label|place-label/.test(
    getStyleLayerSignature(layer)
  );
}

function isPhaseDWaterLayer(layer) {
  return (layer?.type === "fill" || layer?.type === "line")
    && /water|marine|ocean|river|lake|canal|stream/.test(getStyleLayerSignature(layer));
}

function isPhaseDRoadLayer(layer) {
  return layer?.type === "line"
    && /road|street|motorway|highway|bridge|tunnel|path|rail|runway|ferry/.test(getStyleLayerSignature(layer))
    && !/traffic|congestion/.test(getStyleLayerSignature(layer));
}

function isPhaseDParkLayer(layer) {
  return layer?.type === "fill"
    && /park|landcover|landuse|grass|wood|forest|scrub|pitch|golf|leisure|recreation|cemetery/.test(
      getStyleLayerSignature(layer)
    );
}

function setPhaseDPaintProperty(map, activationState, layerId, propertyName, propertyValue) {
  if (!layerExists(map, layerId, "paint_api_error") || typeof map?.setPaintProperty !== "function") {
    return false;
  }

  const tuningState = getPhaseDTuningState(activationState);
  const cacheKey = getPaintPropertyCacheKey(layerId, propertyName);
  if (!tuningState.paintProperties.has(cacheKey)) {
    let previousValue = null;
    if (typeof map.getPaintProperty === "function") {
      try {
        previousValue = cloneJsonValue(map.getPaintProperty(layerId, propertyName));
      } catch {
        previousValue = null;
      }
    }
    tuningState.paintProperties.set(cacheKey, { layerId, propertyName, previousValue });
  }

  try {
    map.setPaintProperty(layerId, propertyName, propertyValue);
    return true;
  } catch {
    return false;
  }
}

function restorePhaseDPaintProperty(map, activationState, layerId, propertyName) {
  const tuningState = getPhaseDTuningState(activationState);
  const cacheKey = getPaintPropertyCacheKey(layerId, propertyName);
  const cachedValue = tuningState.paintProperties.get(cacheKey);
  if (!cachedValue) {
    return false;
  }

  tuningState.paintProperties.delete(cacheKey);
  if (!layerExists(map, layerId, "paint_api_error") || typeof map?.setPaintProperty !== "function") {
    return false;
  }

  try {
    map.setPaintProperty(layerId, propertyName, cachedValue.previousValue);
    return true;
  } catch {
    return false;
  }
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

function rollbackPhaseDTerrainTuning(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  if (!tuningState.terrainActive) {
    return;
  }

  const manifestTerrain = manifest?.terrain;
  validateTerrainManifest(manifestTerrain);
  if (sourceExists(map, manifestTerrain.sourceId, "terrain_api_error")
    && !terrainMatches(map, manifestTerrain)) {
    callMapApi(map, "setTerrain", [{
      source: manifestTerrain.sourceId,
      exaggeration: manifestTerrain.exaggeration,
    }], "terrain_api_error");
  }
  tuningState.terrainActive = false;
}

function applyPhaseDTerrainTuning(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  if (!isPhaseDTuningEnabled(activationState)) {
    rollbackPhaseDTerrainTuning(map, manifest, activationState);
    return;
  }

  if (activationState.featureActive.terrain !== true) {
    tuningState.terrainActive = false;
    return;
  }

  const manifestTerrain = manifest?.terrain;
  validateTerrainManifest(manifestTerrain);
  if (!sourceExists(map, manifestTerrain.sourceId, "terrain_api_error")) {
    return;
  }

  if (!terrainMatchesExaggeration(map, manifestTerrain.sourceId, PHASE_D_TERRAIN_EXAGGERATION)) {
    callMapApi(map, "setTerrain", [{
      source: manifestTerrain.sourceId,
      exaggeration: PHASE_D_TERRAIN_EXAGGERATION,
    }], "terrain_api_error");
  }
  tuningState.terrainActive = true;
}

function applyPhaseDTuning(map, manifest, activationState) {
  applyPhaseDTerrainTuning(map, manifest, activationState);
  applyPhaseDLightingTuning(map, manifest, activationState);
  applyPhaseDBuildingLodTuning(map, manifest, activationState);
  applyPhaseDSkyFogTuning(map, manifest, activationState);
  applyPhaseDLabelTuning(map, activationState);
  applyPhaseDColorGrading(map, activationState);
}

function rollbackPhaseDLightingTuning(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  if (tuningState.lightActive && typeof map?.setLight === "function") {
    try {
      map.setLight(tuningState.previousLight || buildPhaseCLightOptions(manifest));
    } catch {
      // Phase C rollback still owns the emergency lighting reset path.
    }
  }

  tuningState.lightActive = false;
  tuningState.previousLight = null;
  const buildingLayerId = manifest?.buildings3d?.layerId;
  if (isNonEmptyString(buildingLayerId)) {
    restorePhaseDPaintProperty(map, activationState, buildingLayerId, "fill-extrusion-ambient-occlusion-intensity");
  }
}

function applyPhaseDLightingTuning(map, manifest, activationState) {
  if (!isPhaseDTuningEnabled(activationState)) {
    rollbackPhaseDLightingTuning(map, manifest, activationState);
    return;
  }

  const tuningState = getPhaseDTuningState(activationState);
  if (typeof map?.setLight === "function") {
    if (!tuningState.lightActive) {
      tuningState.previousLight = getCurrentLight(map);
    }
    if (!lightHasPhaseDValues(map)) {
      callMapApi(map, "setLight", [cloneJsonValue(PHASE_D_LIGHT_SPEC)], "lighting_api_error");
    }
    tuningState.lightActive = true;
  }

  const buildingLayerId = manifest?.buildings3d?.layerId;
  if (activationState.featureActive.buildings3d === true && isNonEmptyString(buildingLayerId)) {
    setPhaseDPaintProperty(
      map,
      activationState,
      buildingLayerId,
      "fill-extrusion-ambient-occlusion-intensity",
      PHASE_D_BUILDING_AMBIENT_INTENSITY
    );
  }
}

function getPhaseDBuildingPitchScales(map) {
  const pitch = typeof map?.getPitch === "function" ? Number(map.getPitch()) || 0 : 0;
  const normalizedPitch = clamp(pitch / 62, 0, 1);
  return {
    opacityScale: clamp(0.72 + normalizedPitch * 0.28, 0.72, 1),
    heightScale: clamp(0.82 + normalizedPitch * 0.22, 0.82, 1.04),
  };
}

function clearPhaseDBuildingLodTimer(tuningState) {
  if (tuningState.buildingLodTimer === null || tuningState.buildingLodTimer === undefined) {
    return;
  }

  const windowLike = getWindowLike();
  const clearTimer = typeof windowLike?.clearTimeout === "function"
    ? windowLike.clearTimeout.bind(windowLike)
    : typeof clearTimeout === "function"
      ? clearTimeout
      : null;
  clearTimer?.(tuningState.buildingLodTimer);
  tuningState.buildingLodTimer = null;
}

function schedulePhaseDBuildingLodUpdate(tuningState, update) {
  clearPhaseDBuildingLodTimer(tuningState);
  const windowLike = getWindowLike();
  const setTimer = typeof windowLike?.setTimeout === "function"
    ? windowLike.setTimeout.bind(windowLike)
    : typeof setTimeout === "function"
      ? setTimeout
      : null;

  if (!setTimer) {
    update();
    return;
  }

  tuningState.buildingLodTimer = setTimer(() => {
    tuningState.buildingLodTimer = null;
    update();
  }, PHASE_D_BUILDING_LOD_DEBOUNCE_MS);
}

function rollbackPhaseDBuildingLodTuning(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  clearPhaseDBuildingLodTimer(tuningState);

  if (tuningState.buildingLodMoveHandler && typeof map?.off === "function") {
    map.off("move", tuningState.buildingLodMoveHandler);
  }

  tuningState.buildingLodMoveHandler = null;
  tuningState.buildingLodLastAppliedAt = 0;

  const buildingLayerId = manifest?.buildings3d?.layerId;
  if (isNonEmptyString(buildingLayerId)) {
    restorePhaseDPaintProperty(map, activationState, buildingLayerId, "fill-extrusion-opacity");
    restorePhaseDPaintProperty(map, activationState, buildingLayerId, "fill-extrusion-height");
  }
}

function applyPhaseDBuildingLodPaint(map, manifest, activationState) {
  const manifestBuildings3d = manifest?.buildings3d;
  validateBuildingsManifest(manifestBuildings3d);

  if (activationState.featureActive.buildings3d !== true) {
    return false;
  }

  if (!layerExists(map, manifestBuildings3d.layerId, "buildings3d_api_error")) {
    return false;
  }

  const pitchScales = getPhaseDBuildingPitchScales(map);
  const opacityApplied = setPhaseDPaintProperty(
    map,
    activationState,
    manifestBuildings3d.layerId,
    "fill-extrusion-opacity",
    buildPhaseDBuildingOpacityExpression(manifestBuildings3d, pitchScales.opacityScale)
  );
  const heightApplied = setPhaseDPaintProperty(
    map,
    activationState,
    manifestBuildings3d.layerId,
    "fill-extrusion-height",
    buildPhaseDBuildingHeightExpression(manifestBuildings3d, pitchScales.heightScale)
  );

  return opacityApplied || heightApplied;
}

function ensurePhaseDBuildingLodMoveHandler(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  if (tuningState.buildingLodMoveHandler || typeof map?.on !== "function") {
    return;
  }

  const update = () => {
    if (!isPhaseDTuningEnabled(activationState) || activationState.featureActive.buildings3d !== true) {
      rollbackPhaseDBuildingLodTuning(map, manifest, activationState);
      return;
    }

    tuningState.buildingLodLastAppliedAt = Date.now();
    applyPhaseDBuildingLodPaint(map, manifest, activationState);
  };

  tuningState.buildingLodMoveHandler = () => {
    const now = Date.now();
    if (now - (tuningState.buildingLodLastAppliedAt || 0) >= PHASE_D_BUILDING_LOD_THROTTLE_MS) {
      clearPhaseDBuildingLodTimer(tuningState);
      update();
      return;
    }

    schedulePhaseDBuildingLodUpdate(tuningState, update);
  };

  map.on("move", tuningState.buildingLodMoveHandler);
}

function applyPhaseDBuildingLodTuning(map, manifest, activationState) {
  if (!isPhaseDTuningEnabled(activationState) || activationState.featureActive.buildings3d !== true) {
    rollbackPhaseDBuildingLodTuning(map, manifest, activationState);
    return;
  }

  if (applyPhaseDBuildingLodPaint(map, manifest, activationState)) {
    ensurePhaseDBuildingLodMoveHandler(map, manifest, activationState);
  }
}

function buildPhaseDFogSpec({ includeDensity = true } = {}) {
  const fogSpec = {
    range: [...PHASE_D_FOG_SPEC.range],
    color: PHASE_D_FOG_SPEC.color,
  };

  if (includeDensity) {
    fogSpec.density = PHASE_D_FOG_SPEC.density;
  }

  return fogSpec;
}

function rollbackPhaseDSkyFogTuning(map, manifest, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  if (tuningState.fogActive && typeof map?.setFog === "function") {
    try {
      map.setFog(tuningState.previousFog || adaptPhaseCFog(manifest?.fog));
    } catch {
      // Phase C rollback owns the final fog reset path.
    }
  }
  tuningState.fogActive = false;
  tuningState.previousFog = null;

  const skyLayerId = manifest?.sky?.layerId;
  if (isNonEmptyString(skyLayerId)) {
    for (const [propertyName] of PHASE_D_SKY_PAINT_PROPERTIES) {
      restorePhaseDPaintProperty(map, activationState, skyLayerId, propertyName);
    }
  }
}

function applyPhaseDFogTuning(map, manifest, activationState) {
  if (activationState.featureActive.fog !== true || typeof map?.setFog !== "function") {
    return;
  }

  const tuningState = getPhaseDTuningState(activationState);
  if (!tuningState.fogActive) {
    tuningState.previousFog = getCurrentFog(map);
  }

  try {
    map.setFog(buildPhaseDFogSpec({ includeDensity: true }));
  } catch {
    callMapApi(map, "setFog", [buildPhaseDFogSpec({ includeDensity: false })], "fog_api_error");
  }
  tuningState.fogActive = true;
}

function applyPhaseDSkyTuning(map, manifest, activationState) {
  const skyLayerId = manifest?.sky?.layerId;
  if (activationState.featureActive.sky !== true || !isNonEmptyString(skyLayerId)) {
    return;
  }

  for (const [propertyName, propertyValue] of PHASE_D_SKY_PAINT_PROPERTIES) {
    setPhaseDPaintProperty(map, activationState, skyLayerId, propertyName, cloneJsonValue(propertyValue));
  }
}

function applyPhaseDSkyFogTuning(map, manifest, activationState) {
  if (!isPhaseDTuningEnabled(activationState)) {
    rollbackPhaseDSkyFogTuning(map, manifest, activationState);
    return;
  }

  applyPhaseDFogTuning(map, manifest, activationState);
  applyPhaseDSkyTuning(map, manifest, activationState);
}

function rollbackPhaseDLabelTuning(map, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  const layerIds = Array.isArray(tuningState.labelLayerIds) ? tuningState.labelLayerIds : [];
  for (const layerId of layerIds) {
    for (const [propertyName] of PHASE_D_POI_TEXT_PAINT_PROPERTIES) {
      restorePhaseDPaintProperty(map, activationState, layerId, propertyName);
    }
  }
  tuningState.labelLayerIds = [];
}

function applyPhaseDLabelTuning(map, activationState) {
  if (!isPhaseDTuningEnabled(activationState)) {
    rollbackPhaseDLabelTuning(map, activationState);
    return;
  }

  const tuningState = getPhaseDTuningState(activationState);
  const poiLayers = getMapStyleLayers(map, "paint_api_error").filter(isPhaseDPoiLabelLayer);
  tuningState.labelLayerIds = poiLayers.map((layer) => layer.id);

  for (const layer of poiLayers) {
    for (const [propertyName, propertyValue] of PHASE_D_POI_TEXT_PAINT_PROPERTIES) {
      setPhaseDPaintProperty(map, activationState, layer.id, propertyName, cloneJsonValue(propertyValue));
    }
  }
}

function getPhaseDColorPaintUpdate(layer) {
  if (isPhaseDWaterLayer(layer)) {
    return [layer.type === "line" ? "line-color" : "fill-color", PHASE_D_COLOR_GRADE.water];
  }

  if (isPhaseDRoadLayer(layer)) {
    return ["line-color", PHASE_D_COLOR_GRADE.road];
  }

  if (isPhaseDParkLayer(layer)) {
    return ["fill-color", PHASE_D_COLOR_GRADE.park];
  }

  return null;
}

function rollbackPhaseDColorGrading(map, activationState) {
  const tuningState = getPhaseDTuningState(activationState);
  const paintUpdates = Array.isArray(tuningState.colorPaintUpdates) ? tuningState.colorPaintUpdates : [];
  for (const { layerId, propertyName } of paintUpdates) {
    restorePhaseDPaintProperty(map, activationState, layerId, propertyName);
  }
  tuningState.colorPaintUpdates = [];
}

function applyPhaseDColorGrading(map, activationState) {
  if (!isPhaseDTuningEnabled(activationState)) {
    rollbackPhaseDColorGrading(map, activationState);
    return;
  }

  const tuningState = getPhaseDTuningState(activationState);
  const paintUpdates = [];
  for (const layer of getMapStyleLayers(map, "paint_api_error")) {
    const paintUpdate = getPhaseDColorPaintUpdate(layer);
    if (!paintUpdate) {
      continue;
    }

    const [propertyName, propertyValue] = paintUpdate;
    if (setPhaseDPaintProperty(map, activationState, layer.id, propertyName, propertyValue)) {
      paintUpdates.push({ layerId: layer.id, propertyName });
    }
  }
  tuningState.colorPaintUpdates = paintUpdates;
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

function applyCameraPreset(map, manifest, activationState = null) {
  const currentZoom = callMapApi(map, "getZoom", [], "camera_api_error");
  const cameraOptions = derivePhaseCCameraOptions(manifest?.camera, currentZoom);
  callMapApi(map, "easeTo", [applyPhaseDProgrammaticCameraSmoothing(
    cameraOptions,
    getPhaseDCameraTuningParameters(activationState)
  )], "camera_api_error");
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
  getPhaseDTuningState(activationState).terrainActive = false;
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

  try {
    applyPhaseDTuning(map, manifest, activationState);
  } catch (error) {
    emitActivationError(activationState, telemetryEmitter, buildId, getErrorReason(error));
    return;
  }

  if (!wasAggregateActive && activationState.aggregateActive && !activationState.cameraActive && options?.skipCameraPreset !== true) {
    try {
      applyCameraPreset(map, manifest, activationState);
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
  activationState.phaseDTuning = {};
  activationState.errorReasons.clear();

  emitTelemetry(telemetryEmitter, "map.phase_c_rollback", {
    buildId,
    rolledBack: true,
  });
}

export {
  adaptPhaseCFog,
  applyPhaseDProgrammaticCameraSmoothing,
  applyPhaseCActivation,
  applyPhaseCLighting,
  buildPhaseCBuildingsLayer,
  buildPhaseCLightOptions,
  buildPhaseCTerrainSource,
  derivePhaseCCameraOptions,
  getPhaseDCameraTuningParameters,
  isPhaseCAggregateActive,
  isPhaseDTuningEnabled,
  shouldExposePhaseDDebug,
  rollbackPhaseCActivation,
  rollbackPhaseCLighting,
};
