// ──────────────────────────────────────────────────────────────────
//
// GOVERNANCE: This UI module renders descriptive, annotation-only
// outputs (§6 A-1..A-4). All advisory text is non-prescriptive
// and many-to-one (§6.6). Threshold-based descriptions (§5) carry
// no triggers, alerts, or implied actions. No element of this
// module constitutes decision authority (§1 I-4).
// See docs/GOVERNANCE.md and docs/CLASSIFICATION_REGISTRY.md.
//
// ──────────────────────────────────────────────────────────────────

import {
  fetchFoodPlaces,
  fetchParkingCandidates,
  fetchResidentialAnchors,
} from "./overpass.js?v=20260401-probability-contract";
import {
  buildDemandCoverageNodes,
  buildGridProbabilityHeat,
  filterOpenRestaurants,
  haversineMeters,
  PROBABILITY_HORIZON_MINUTES,
  probabilityOfGoodOrder,
  rankParking,
  topLikelyMerchantsForParking,
  timeBucket,
} from "./model.js?v=20260401-probability-contract";
import { renderModelDiagram } from "./diagram.js?v=20260401-probability-contract";
import {
  evaluateParkingCoverage,
  selectParkingSetSubmodular,
} from "./optimizer.js?v=20260401-probability-contract";
import {
  HEADING_FILTER_DEAD_ZONE_DEGREES,
  HEADING_FILTER_MIN_ROTATION_DEGREES,
  HEADING_FILTER_SMOOTHING_FACTOR,
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
  HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
  HEADING_SENSOR_SMOOTHING_MIN_BLEND,
  HEADING_SENSOR_SMOOTHING_TIME_MS,
  HEADING_SENSOR_STALE_AFTER_MS,
  getHeadingConeBandStops,
  getHeadingDeltaDegrees,
  getHeadingConeHalfAngle,
  getHeadingConeLengthMeters,
  normalizeHeadingDegrees,
} from "./heading_cone.js?v=20260410-heading-damping";
import { createHeadingRuntime } from "./heading_runtime.js?v=20260412-heading-runtime-extract";
import { createLocationRuntime } from "./location_runtime.js?v=20260412-location-runtime-extract";
import {
  fetchCurrentWeatherSignal,
  formatWeatherSourceSummary,
} from "./weather.js?v=20260410-live-weather";
import {
  fetchCensusResidentialAnchors,
  formatCensusSourceSummary,
} from "./census.js?v=20260410-census-data";
import { createMapInteractionRuntime } from "./map_interaction_runtime.js?v=20260413-map-interaction-runtime-extract";
import { createDataScoringRuntime } from "./data_scoring_runtime.js?v=20260413-data-scoring-runtime-extract";
import { createRoutingRuntime } from "./routing_runtime.js?v=20260413-routing-runtime-extract";

const APP_BUILD_ID = "20260410-nav-hotfix";
console.info("[DGM] app build", APP_BUILD_ID);

const PREDICTION_MODEL = String(window.DGM_PREDICTION_MODEL || "legacy").trim().toLowerCase();
const SHADOW_LEARNED_MODEL = Boolean(window.DGM_SHADOW_PREDICTION_MODEL);
const MAPBOX_GEOCODING_API_URL = "https://api.mapbox.com/geocoding/v5/mapbox.places";
const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const OSRM_ROUTE_API_URL = "https://router.project-osrm.org/route/v1/driving";
const NAV_REROUTE_MIN_DISTANCE_METERS = 30;
const NAV_REROUTE_MIN_INTERVAL_MS = 4000;
// Subtle pulsing animation for the current-location marker.
const BLUE_DOT_BASE_RADIUS_PX = 9;
const BLUE_DOT_BREATHING_AMPLITUDE_PX = 0.55;
const BLUE_DOT_BREATHING_CYCLE_MS = 2800;
const BLUE_DOT_RADIUS_EPSILON_PX = 0.01;
const BLUE_DOT_HALO_RADIUS_SCALE = 2.35;
const FULL_CYCLE_RADIANS = Math.PI * 2;
const COMPASS_PERMISSION_REQUEST_TIMEOUT_MS = 5000;
const HEADING_RENDER_LOOP_MAX_HZ = 30;
const HEADING_RENDER_LOOP_FRAME_INTERVAL_MS = 1000 / HEADING_RENDER_LOOP_MAX_HZ;
const HEADING_RENDER_LOOP_MAP_BEARING_SMOOTHING_TIME_MS = 240;
const HEADING_RENDER_LOOP_GPS_SMOOTHING_TIME_MS = 180;
const HEADING_RENDER_LOOP_MIN_DELTA_DEGREES = HEADING_FILTER_MIN_ROTATION_DEGREES;
const HEADING_RENDER_LOOP_MIN_LOCATION_DELTA_METERS = 0.25;
const HEADING_RENDER_LOOP_MIN_SPEED_DELTA_MPS = 0.1;
const HEADING_CONE_RENDER_SCALE_BIAS = 1.15;
const ALLOW_RELATIVE_COMPASS_ALPHA_FALLBACK = isTouchInteractionDevice();
const COMPASS_PERMISSION_REQUIRED_STATE = "required";
const COMPASS_PERMISSION_GRANTED_STATE = "granted";
const COMPASS_PERMISSION_DENIED_STATE = "denied";
const COMPASS_PERMISSION_NOT_REQUIRED_STATE = "not-required";
const COMPASS_PERMISSION_UNAVAILABLE_STATE = "unavailable";
const COMPASS_PERMISSION_STORAGE_KEY = "dgm:compass-permission-state";
const PLACE_HISTORY_STORAGE_KEY = "dgm:place-history-v1";
const PLACE_HISTORY_MAX_ENTRIES = 240;
const DEBUG_MODE_QUERY_PARAM = "debug";
const DEBUG_MODE_ENABLED_VALUE = "1";
const STAGING_SPOT_MIN_DISTANCE_METERS = 322;
const STAGING_SPOT_MAX_DISTANCE_METERS = 804;
const MICRO_CORRIDOR_MIN_DISTANCE_METERS = 90;
const MICRO_CORRIDOR_MAX_DISTANCE_METERS = 321;
const ARRIVAL_CAMERA_AUTO_DISTANCE_METERS = 260;
const ARRIVAL_CAMERA_EXIT_DISTANCE_METERS = 420;
const NAVIGATION_CAMERA_ARRIVAL_MIN_ZOOM = 16.9;
const NAVIGATION_CAMERA_ARRIVAL_MAX_ZOOM = 18.35;
const NAVIGATION_CAMERA_ARRIVAL_MIN_PITCH = 28;
const NAVIGATION_CAMERA_ARRIVAL_MAX_PITCH = 42;
const NAVIGATION_REROUTE_DELTA_MIN_DURATION_SECONDS = 18;
const NAVIGATION_REROUTE_DELTA_MIN_DISTANCE_METERS = 60;

function isCompassDebugModeEnabled() {
  if (typeof window === "undefined") {
    return false;
  }

  const searchParams = new URLSearchParams(window.location.search);
  return searchParams.get(DEBUG_MODE_QUERY_PARAM) === DEBUG_MODE_ENABLED_VALUE;
}

function isTouchInteractionDevice() {
  if (typeof window === "undefined") {
    return false;
  }

  const coarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(any-pointer: coarse)").matches
    : false;
  const touchPoints = typeof navigator !== "undefined" && Number(navigator.maxTouchPoints) > 0;
  return coarsePointer || touchPoints;
}

const COMPASS_DEBUG_MODE_ENABLED = isCompassDebugModeEnabled();
const RUNTIME_DIAGNOSTICS_ENABLED = COMPASS_DEBUG_MODE_ENABLED || isTouchInteractionDevice();

if (window.location.protocol === "file:") {
  alert(
    "This app must be opened from a local web server (not file://).\n\nRun: python -m http.server 5173\nThen open: http://localhost:5173/"
  );
}

const DEFAULT_CENTER = [-117.5931, 34.1064]; // [lng, lat] Rancho Cucamonga
const DEFAULT_ZOOM = 12;

const MAPBOX_GEOCODING_TOKEN = String(window.DASH_MAPBOX_TOKEN || "").trim();
const MAPBOX_PLACEHOLDER_TOKEN = "MAPBOX_TOKEN_HERE";
const MAPBOX_STYLE_URL = "mapbox://styles/mapbox/satellite-streets-v12";
const MAPBOX_TRAFFIC_SOURCE_URL = "mapbox://mapbox.mapbox-traffic-v1";
const MAPBOX_TRAFFIC_SOURCE_LAYER = "traffic";
const CINEMATIC_DAY_NIGHT_TRANSITION_MS = 1250;
const mapboxgl = window.mapboxgl;

function renderFatalMapError(message, kicker = "Map unavailable") {
  const host = document.getElementById("main") || document.body;
  if (!host) {
    return;
  }

  const body = document.body;
  if (body) {
    body.classList.add("has-map-fatal");
  }

  const existingOverlay = host.querySelector(".map-fatal-overlay");
  if (existingOverlay) {
    existingOverlay.remove();
  }

  const overlay = document.createElement("div");
  overlay.className = "map-fatal-overlay";

  const card = document.createElement("div");
  card.className = "map-fatal-card";

  const kickerElement = document.createElement("div");
  kickerElement.className = "map-fatal-kicker";
  kickerElement.textContent = kicker;

  const titleElement = document.createElement("div");
  titleElement.className = "map-fatal-title";
  titleElement.textContent = "Dash Gas Mash cannot load the map.";

  const copyElement = document.createElement("div");
  copyElement.className = "map-fatal-copy";
  copyElement.textContent = message;

  card.append(kickerElement, titleElement, copyElement);
  overlay.append(card);
  host.append(overlay);
}

if (!mapboxgl) {
  renderFatalMapError("Mapbox GL JS failed to load from the CDN.");
  throw new Error("Mapbox GL JS failed to load from the CDN.");
}

mapboxgl.accessToken = window.DASH_MAPBOX_TOKEN || "MAPBOX_TOKEN_HERE";

if (mapboxgl.accessToken === MAPBOX_PLACEHOLDER_TOKEN || !String(mapboxgl.accessToken).trim()) {
  renderFatalMapError("Inject window.DASH_MAPBOX_TOKEN before app.js loads.", "Mapbox token required");
  throw new Error("Mapbox token missing. Inject window.DASH_MAPBOX_TOKEN before app.js loads.");
}

const SOURCE_RESTAURANTS = "restaurants";
const SOURCE_PARKING = "parking";
const SOURCE_HEAT = "heat";
const SOURCE_SPOT = "spot";
const SOURCE_CURRENT_LOCATION = "current-location";
const SOURCE_CURRENT_LOCATION_ACCURACY = "current-location-accuracy";
const SOURCE_HEADING = "heading";
const SOURCE_ROUTE = "route";
const SOURCE_CINEMATIC_GRADE = "cinematic-grade";
const SOURCE_TRAFFIC = "traffic";

const LAYER_HEAT = "heat-layer";
const LAYER_RESTAURANTS_GLOW = "restaurants-glow-layer";
const LAYER_RESTAURANTS = "restaurants-layer";
const LAYER_PARKING_GLOW = "parking-glow-layer";
const LAYER_PARKING = "parking-layer";
const LAYER_SPOT_GLOW = "spot-glow-layer";
const LAYER_SPOT = "spot-layer";
const LAYER_SPOT_LABEL = "spot-label-layer";
const LAYER_CINEMATIC_CONTRAST = "cinematic-contrast-layer";
const LAYER_CINEMATIC_LIFT = "cinematic-lift-layer";
const LAYER_CINEMATIC_TINT = "cinematic-tint-layer";
const LAYER_TRAFFIC_CASING = "traffic-casing-layer";
const LAYER_TRAFFIC = "traffic-layer";
const LAYER_CURRENT_LOCATION_ACCURACY_GLOW = "current-location-accuracy-glow";
const LAYER_CURRENT_LOCATION_ACCURACY_FILL = "current-location-accuracy-fill";
const LAYER_CURRENT_LOCATION_ACCURACY_LINE = "current-location-accuracy-line";
const LAYER_HEADING_GLOW = "heading-glow-layer";
const LAYER_HEADING = "heading-layer";
const LAYER_HEADING_EDGE = "heading-edge-layer";
const LAYER_CURRENT_LOCATION_HALO = "current-location-halo";
const LAYER_CURRENT_LOCATION_DOT = "current-location-dot";
const LAYER_ROUTE_CASING = "route-casing-layer";
const LAYER_ROUTE = "route-layer";

const map = new mapboxgl.Map({
  container: "map",
  style: MAPBOX_STYLE_URL,
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 19,
  attributionControl: false,
});

map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-left");

if (isTouchInteractionDevice() && map.doubleClickZoom) {
  map.doubleClickZoom.disable();
}

const mapCanvasContainer = typeof map.getCanvasContainer === "function"
  ? map.getCanvasContainer()
  : null;
if (mapCanvasContainer) {
  mapCanvasContainer.addEventListener("touchstart", handleMapTouchStart, { passive: true });
  mapCanvasContainer.addEventListener("touchmove", () => {
    suppressMapTapPopupTemporarily();
  }, { passive: true });
  mapCanvasContainer.addEventListener("touchcancel", () => {
    suppressMapTapPopupTemporarily();
  }, { passive: true });
}

let lastCurrentLocation = null;
let lastCurrentLocationAccuracyMeters = null;
let lastHeatFeatures = [];
let lastSpotPoint = null;
let lastRankedParkingAll = [];
const currentBaseStyle = "hybrid";
let activeSearchAbort = null;
let activeSearchMarker = null;
let searchSequence = 0;
let searchDebounceTimer = null;
let renderedSearchResults = [];
let searchResultPressActive = false;
let searchResultPressTimer = null;
let isSearchOverlayOpen = false;
let activeRouteAbort = null;
let activeRoute = null;
let activeNavigationWatchId = null;
let lastRouteOriginForRefresh = null;
let lastRouteRefreshAt = 0;
let navigationCameraMode = "browse";
let navigationCameraModeAutoArrival = false;
let lastNavigationCameraSyncAt = 0;
let navigationVoiceEnabled = true;
let lastSpokenInstructionKey = "";
let lastNavigationStatusMessage = "";
let lastNavigationStatusTone = "info";

const restaurantById = new Map();
const parkingById = new Map();

let lastRestaurants = [];
let lastParkingCandidates = [];
let lastResidentialAnchors = [];
let lastCensusResidentialAnchors = [];
let lastCensusDataset = null;
let lastStats = null;
let lastLoadedBounds = null; // tracks the bounds used for the last successful load
let lastWeatherSignal = null;

let lastParams = {
  hour: 0,
  tauMeters: 1200,
  horizonMin: PROBABILITY_HORIZON_MINUTES,
  competitionStrength: 0.35,
  residentialDemandWeight: 0.35,
  rainBoost: 0,
  useCensusData: true,
  useLiveWeather: true,
  tipEmphasis: 0.55,
  predictionModel: PREDICTION_MODEL,
};

function getDataScoringState() {
  return {
    lastHeatFeatures,
    lastSpotPoint,
    lastRankedParkingAll,
    lastRestaurants,
    lastParkingCandidates,
    lastResidentialAnchors,
    lastCensusResidentialAnchors,
    lastCensusDataset,
    lastStats,
    lastLoadedBounds,
    lastWeatherSignal,
    lastParams,
  };
}

function setDataScoringState(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "lastHeatFeatures")) {
    lastHeatFeatures = patch.lastHeatFeatures;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastSpotPoint")) {
    lastSpotPoint = patch.lastSpotPoint;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastRankedParkingAll")) {
    lastRankedParkingAll = patch.lastRankedParkingAll;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastRestaurants")) {
    lastRestaurants = patch.lastRestaurants;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastParkingCandidates")) {
    lastParkingCandidates = patch.lastParkingCandidates;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastResidentialAnchors")) {
    lastResidentialAnchors = patch.lastResidentialAnchors;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastCensusResidentialAnchors")) {
    lastCensusResidentialAnchors = patch.lastCensusResidentialAnchors;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastCensusDataset")) {
    lastCensusDataset = patch.lastCensusDataset;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastStats")) {
    lastStats = patch.lastStats;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastLoadedBounds")) {
    lastLoadedBounds = patch.lastLoadedBounds;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastWeatherSignal")) {
    lastWeatherSignal = patch.lastWeatherSignal;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "lastParams")) {
    lastParams = patch.lastParams;
  }
}

const elHour = document.getElementById("hour");
const elHourVal = document.getElementById("hourVal");
const elTau = document.getElementById("tau");
const elTauVal = document.getElementById("tauVal");
const elGrid = document.getElementById("grid");
const elGridVal = document.getElementById("gridVal");
const elHorizon = document.getElementById("horizon");
const elHorizonVal = document.getElementById("horizonVal");
const elCompetition = document.getElementById("competition");
const elCompetitionVal = document.getElementById("competitionVal");
const elResidentialWeight = document.getElementById("residentialWeight");
const elResidentialWeightVal = document.getElementById("residentialWeightVal");
const elUseCensusData = document.getElementById("useCensusData");
const elCensusStatus = document.getElementById("censusStatus");
const elRainBoost = document.getElementById("rainBoost");
const elRainBoostVal = document.getElementById("rainBoostVal");
const elUseLiveWeather = document.getElementById("useLiveWeather");
const elWeatherStatus = document.getElementById("weatherStatus");
const elTipEmphasis = document.getElementById("tipEmphasis");
const elTipEmphasisVal = document.getElementById("tipEmphasisVal");
const elUseML = document.getElementById("useML");
const elMlBeta = document.getElementById("mlBeta");
const elMlBetaVal = document.getElementById("mlBetaVal");
const elKSpots = document.getElementById("kSpots");
const elKSpotsVal = document.getElementById("kSpotsVal");
const elLoad = document.getElementById("load");
const elShowRestaurants = document.getElementById("showRestaurants");
const elShowParking = document.getElementById("showParking");
const elParkingList = document.getElementById("parkingList");
const elSummaryCards = document.getElementById("summaryCards");
const menuButton = document.getElementById("menuToggle");
const panel = document.getElementById("panel");
const elMain = document.getElementById("main");
const elLocateMe = document.getElementById("locateMe");
const elSearchToggle = document.getElementById("searchToggle");
const elSearchOverlay = document.getElementById("searchOverlay");
const elSearchClose = document.getElementById("searchClose");
const elSearchForm = document.getElementById("searchForm");
const elSearchInput = document.getElementById("searchInput");
const elSearchButton = document.getElementById("searchButton");
const elSearchResults = document.getElementById("searchResults");

const LOCATION_TARGET_ZOOM = 16;
const LOCATION_ANIMATION_MIN_START_ZOOM = 14;
const LOCATION_ANIMATION_MAX_DISTANCE_METERS = 5000;
const LOCATION_PAN_DURATION_SECONDS = 0.9;
const LOCATION_FLY_DURATION_MS = 850;
const LOCATION_ZOOM_STEP = 3;
const MAX_VISIBLE_ACCURACY_RADIUS_METERS = 45;
const CONTINUOUS_WATCH_TIMEOUT_MS = 30000;
const LIVE_LOCATION_WATCH_MAXIMUM_AGE_MS = 0;
const AUTO_FOLLOW_LOCATION_MIN_CENTER_OFFSET_METERS = 6;
const NAVIGATION_CAMERA_UPDATE_MIN_INTERVAL_MS = 380;
const NAVIGATION_CAMERA_MIN_BEARING_DELTA_DEGREES = HEADING_FILTER_MIN_ROTATION_DEGREES;
const NAVIGATION_CAMERA_MIN_ZOOM_DELTA = 0.12;
const NAVIGATION_CAMERA_MIN_PITCH_DELTA = 2;
const NAVIGATION_CAMERA_DRIVER_MIN_ZOOM = 15.6;
const NAVIGATION_CAMERA_DRIVER_MAX_ZOOM = 17.4;
const NAVIGATION_CAMERA_DRIVER_MIN_PITCH = 46;
const NAVIGATION_CAMERA_DRIVER_MAX_PITCH = 62;
const AUTO_FOLLOW_LOCATION_PAN_DURATION_MS = 450;
const AUTO_FOLLOW_HEADING_MIN_DELTA_DEGREES = 10;
const AUTO_FOLLOW_HEADING_ROTATION_DURATION_MS = 380;
const MAP_TOUCH_TAP_POPUP_DELAY_MS = 260;
const MAP_TOUCH_GESTURE_SUPPRESSION_MS = 420;
const POPUP_NEARBY_RESTAURANT_LIMIT = 12;

const INITIAL_LOCATION_ZOOM = 14;
const INITIAL_LOCATION_TIMEOUT_MS = 8000;

const diagramContainer = document.getElementById("diagram");
renderModelDiagram(diagramContainer);

if (elHorizon) {
  elHorizon.value = String(PROBABILITY_HORIZON_MINUTES);
  elHorizon.disabled = true;
  elHorizon.setAttribute("aria-disabled", "true");
}

let lastHeadingConeLengthMeters = null;
let lastHeadingConeLatitude = null;
let lastHeadingConeZoom = null;
let headingConeRenderMesh = null;
let dataScoringRuntime = null;
let mapInteractionRuntime = null;
let locationRuntime = null;
let headingRuntime = null;
let routingRuntime = null;

function getRoutingState() {
  return {
    activeRouteAbort,
    activeRoute,
    activeNavigationWatchId,
    lastRouteOriginForRefresh,
    lastRouteRefreshAt,
    navigationCameraMode,
    navigationCameraModeAutoArrival,
    lastNavigationCameraSyncAt,
    navigationVoiceEnabled,
    lastSpokenInstructionKey,
    lastNavigationStatusMessage,
    lastNavigationStatusTone,
  };
}

function setRoutingState(patch) {
  if (!patch || typeof patch !== "object") {
    return;
  }

  if ("activeRouteAbort" in patch) activeRouteAbort = patch.activeRouteAbort;
  if ("activeRoute" in patch) activeRoute = patch.activeRoute;
  if ("activeNavigationWatchId" in patch) activeNavigationWatchId = patch.activeNavigationWatchId;
  if ("lastRouteOriginForRefresh" in patch) lastRouteOriginForRefresh = patch.lastRouteOriginForRefresh;
  if ("lastRouteRefreshAt" in patch) lastRouteRefreshAt = patch.lastRouteRefreshAt;
  if ("navigationCameraMode" in patch) navigationCameraMode = patch.navigationCameraMode;
  if ("navigationCameraModeAutoArrival" in patch) navigationCameraModeAutoArrival = patch.navigationCameraModeAutoArrival;
  if ("lastNavigationCameraSyncAt" in patch) lastNavigationCameraSyncAt = patch.lastNavigationCameraSyncAt;
  if ("navigationVoiceEnabled" in patch) navigationVoiceEnabled = patch.navigationVoiceEnabled;
  if ("lastSpokenInstructionKey" in patch) lastSpokenInstructionKey = patch.lastSpokenInstructionKey;
  if ("lastNavigationStatusMessage" in patch) lastNavigationStatusMessage = patch.lastNavigationStatusMessage;
  if ("lastNavigationStatusTone" in patch) lastNavigationStatusTone = patch.lastNavigationStatusTone;
}

function featureCollection(features = []) {
  return { type: "FeatureCollection", features };
}

function createBoundsAdapter(south, west, north, east) {
  return {
    getSouth: () => south,
    getWest: () => west,
    getNorth: () => north,
    getEast: () => east,
    getSouthWest: () => ({ lat: south, lng: west }),
    getNorthEast: () => ({ lat: north, lng: east }),
    intersects(other) {
      return !(
        other.getWest() > east
        || other.getEast() < west
        || other.getSouth() > north
        || other.getNorth() < south
      );
    },
    contains(other) {
      return (
        other.getSouth() >= south
        && other.getWest() >= west
        && other.getNorth() <= north
        && other.getEast() <= east
      );
    },
  };
}

function mapBoundsToAdapter(bounds) {
  return createBoundsAdapter(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
}

function boundsAroundCenter(center, sizeMeters) {
  const halfSizeMeters = sizeMeters / 2;
  const latDelta = halfSizeMeters / 111320;
  const lngScale = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.1);
  const lngDelta = halfSizeMeters / (111320 * lngScale);
  return createBoundsAdapter(
    center.lat - latDelta,
    center.lng - lngDelta,
    center.lat + latDelta,
    center.lng + lngDelta
  );
}

function lngLatToObject(value) {
  if (Array.isArray(value)) {
    return { lng: Number(value[0]), lat: Number(value[1]) };
  }

  return {
    lng: Number(value.lng ?? value.lon),
    lat: Number(value.lat),
  };
}

function lngLatToArray(value) {
  const point = lngLatToObject(value);
  return [point.lng, point.lat];
}

function closeActivePopup() {
  return mapInteractionRuntime.closeActivePopup();
}

function openPopupAtLngLat(lngLat, html, popupOptions = {}) {
  return mapInteractionRuntime.openPopupAtLngLat(lngLat, html, popupOptions);
}

function closePlaceSheet() {
  return mapInteractionRuntime.closePlaceSheet();
}

function openPlaceSheet(state) {
  return mapInteractionRuntime.openPlaceSheet(state);
}

function setSourceData(sourceId, data) {
  const source = map.getSource(sourceId);
  if (source) {
    source.setData(data);
  }
}

function clearHeadingConeVisual() {
  setSourceData(SOURCE_HEADING, featureCollection());
}

function createHeadingConeRenderMesh() {
  const bandStops = getHeadingConeBandStops();
  const numArcSegments = 12;
  const features = [];
  const pointRefs = [];

  for (const [bandIndex, { startRatio, endRatio, startOpacity, endOpacity }] of bandStops.entries()) {
    const opacity = Math.max(0, Math.min(1, (startOpacity + endOpacity) / 2));

    for (let segmentIndex = 0; segmentIndex < numArcSegments; segmentIndex += 1) {
      const startAngleRatio = segmentIndex / numArcSegments;
      const endAngleRatio = (segmentIndex + 1) / numArcSegments;
      const ring = [];

      const pushPointRef = (pointSpec) => {
        const point = [0, 0];
        ring.push(point);
        pointRefs.push({ point, ...pointSpec });
      };

      if (startRatio > 0) {
        pushPointRef({ distanceRatio: startRatio, angleRatio: startAngleRatio });
        pushPointRef({ distanceRatio: endRatio, angleRatio: startAngleRatio });
        pushPointRef({ distanceRatio: endRatio, angleRatio: endAngleRatio });
        pushPointRef({ distanceRatio: startRatio, angleRatio: endAngleRatio });
        pushPointRef({ distanceRatio: startRatio, angleRatio: startAngleRatio });
      } else {
        pushPointRef({ isOrigin: true });
        pushPointRef({ distanceRatio: endRatio, angleRatio: startAngleRatio });
        pushPointRef({ distanceRatio: endRatio, angleRatio: endAngleRatio });
        pushPointRef({ isOrigin: true });
      }

      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { bandIndex, segmentIndex, opacity },
      });
    }
  }

  return {
    featureCollection: featureCollection(features),
    pointRefs,
  };
}

function getHeadingConeRenderMesh() {
  if (!headingConeRenderMesh) {
    headingConeRenderMesh = createHeadingConeRenderMesh();
  }
  return headingConeRenderMesh;
}

function getCinematicThemeHour() {
  const resolvedHour = Number(elHour?.value);
  return Number.isFinite(resolvedHour) ? resolvedHour : new Date().getHours();
}

function getCinematicTheme(hour = getCinematicThemeHour()) {
  const isNight = hour >= 18 || hour < 6;
  return isNight
    ? {
        contrastColor: "#041019",
        contrastOpacity: 0.08,
        liftColor: "#76bcff",
        liftOpacity: 0.026,
        tintColor: "#7ca8ff",
        tintOpacity: 0.11,
      }
    : {
        contrastColor: "#281307",
        contrastOpacity: 0.04,
        liftColor: "#fff0d2",
        liftOpacity: 0.05,
        tintColor: "#ffbe84",
        tintOpacity: 0.075,
      };
}

function getBasemapOverlayBeforeId() {
  const styleLayers = map.getStyle()?.layers || [];
  const firstAppLayerId = [
    LAYER_HEAT,
    LAYER_ROUTE_CASING,
    LAYER_ROUTE,
    LAYER_RESTAURANTS_GLOW,
    LAYER_RESTAURANTS,
    LAYER_PARKING_GLOW,
    LAYER_PARKING,
    LAYER_SPOT_GLOW,
    LAYER_SPOT,
    LAYER_SPOT_LABEL,
    LAYER_CURRENT_LOCATION_ACCURACY_GLOW,
    LAYER_CURRENT_LOCATION_ACCURACY_FILL,
    LAYER_CURRENT_LOCATION_ACCURACY_LINE,
    LAYER_HEADING_GLOW,
    LAYER_HEADING,
    LAYER_HEADING_EDGE,
    LAYER_CURRENT_LOCATION_HALO,
    LAYER_CURRENT_LOCATION_DOT,
  ].find((layerId) => map.getLayer(layerId));

  if (firstAppLayerId) {
    return firstAppLayerId;
  }

  return styleLayers.find((layer) => layer.type === "symbol")?.id || null;
}

function applyCinematicTheme() {
  const theme = getCinematicTheme();
  const layerPaintUpdates = [
    [LAYER_CINEMATIC_CONTRAST, "fill-color", theme.contrastColor],
    [LAYER_CINEMATIC_CONTRAST, "fill-opacity", theme.contrastOpacity],
    [LAYER_CINEMATIC_LIFT, "fill-color", theme.liftColor],
    [LAYER_CINEMATIC_LIFT, "fill-opacity", theme.liftOpacity],
    [LAYER_CINEMATIC_TINT, "fill-color", theme.tintColor],
    [LAYER_CINEMATIC_TINT, "fill-opacity", theme.tintOpacity],
  ];

  for (const [layerId, propertyName, propertyValue] of layerPaintUpdates) {
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, propertyName, propertyValue);
    }
  }
}

function syncCategoryLayerVisibility() {
  const showRestaurants = elShowRestaurants?.checked !== false;
  const showParking = elShowParking?.checked !== false;

  setLayerVisibility(LAYER_RESTAURANTS_GLOW, showRestaurants);
  setLayerVisibility(LAYER_RESTAURANTS, showRestaurants);
  setLayerVisibility(LAYER_PARKING_GLOW, showParking);
  setLayerVisibility(LAYER_PARKING, showParking);
}

function ensureHybridBaseLayers() {
  const beforeId = getBasemapOverlayBeforeId();
  const theme = getCinematicTheme();

  if (!map.getSource(SOURCE_CINEMATIC_GRADE)) {
    map.addSource(SOURCE_CINEMATIC_GRADE, {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [[
              [-180, -85],
              [180, -85],
              [180, 85],
              [-180, 85],
              [-180, -85],
            ]],
          },
          properties: {},
        }],
      },
    });
  }

  if (!map.getLayer(LAYER_CINEMATIC_CONTRAST)) {
    map.addLayer({
      id: LAYER_CINEMATIC_CONTRAST,
      type: "fill",
      source: SOURCE_CINEMATIC_GRADE,
      paint: {
        "fill-color": theme.contrastColor,
        "fill-opacity": theme.contrastOpacity,
        "fill-color-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
        "fill-opacity-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
      },
    }, beforeId);
  }

  if (!map.getLayer(LAYER_CINEMATIC_LIFT)) {
    map.addLayer({
      id: LAYER_CINEMATIC_LIFT,
      type: "fill",
      source: SOURCE_CINEMATIC_GRADE,
      paint: {
        "fill-color": theme.liftColor,
        "fill-opacity": theme.liftOpacity,
        "fill-color-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
        "fill-opacity-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
      },
    }, beforeId);
  }

  if (!map.getLayer(LAYER_CINEMATIC_TINT)) {
    map.addLayer({
      id: LAYER_CINEMATIC_TINT,
      type: "fill",
      source: SOURCE_CINEMATIC_GRADE,
      paint: {
        "fill-color": theme.tintColor,
        "fill-opacity": theme.tintOpacity,
        "fill-color-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
        "fill-opacity-transition": { duration: CINEMATIC_DAY_NIGHT_TRANSITION_MS, delay: 0 },
      },
    }, beforeId);
  }

  if (!map.getSource(SOURCE_TRAFFIC)) {
    map.addSource(SOURCE_TRAFFIC, {
      type: "vector",
      url: MAPBOX_TRAFFIC_SOURCE_URL,
    });
  }

  if (!map.getLayer(LAYER_TRAFFIC_CASING)) {
    map.addLayer({
      id: LAYER_TRAFFIC_CASING,
      type: "line",
      source: SOURCE_TRAFFIC,
      "source-layer": MAPBOX_TRAFFIC_SOURCE_LAYER,
      minzoom: 7,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": "rgba(5, 12, 19, 0.72)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.5, 11, 3.2, 16, 8.2],
        "line-opacity": 0.72,
      },
    }, beforeId);
  }

  if (!map.getLayer(LAYER_TRAFFIC)) {
    map.addLayer({
      id: LAYER_TRAFFIC,
      type: "line",
      source: SOURCE_TRAFFIC,
      "source-layer": MAPBOX_TRAFFIC_SOURCE_LAYER,
      minzoom: 7,
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
      paint: {
        "line-color": [
          "match", ["coalesce", ["get", "congestion"], "low"],
          "low", "#61f2d4",
          "moderate", "#ffc95c",
          "heavy", "#ff8a5b",
          "severe", "#ff4d88",
          "#8fd8ff",
        ],
        "line-width": ["interpolate", ["linear"], ["zoom"], 7, 1.1, 11, 2.4, 16, 6.2],
        "line-opacity": 0.9,
      },
    }, beforeId);
  }

  applyCinematicTheme();
}

function restoreMapDataSources() {
  return dataScoringRuntime.restoreMapDataSources();
}

function restoreLayersAfterStyleChange() {
  if (!map.isStyleLoaded()) return;

  ensureMapSourcesAndLayers();
  restoreMapDataSources();
  syncCategoryLayerVisibility();
  syncHeadingConeRenderLoop();
}

function renderNavigationAction(lat, lon, label = "Start route", destinationTitle = "Destination") {
  return `<div class="popup-actions"><button class="popup-action" type="button" data-route-lat="${Number(lat).toFixed(6)}" data-route-lng="${Number(lon).toFixed(6)}" data-route-title="${escapeHtml(destinationTitle)}">${escapeHtml(label)}</button></div>`;
}

function formatTagLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  return raw
    .replaceAll("_", " ")
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function isTruthyOsmTag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "yes" || normalized === "only" || normalized === "designated" || normalized === "true";
}

function getPlaceDisplayName(place) {
  return place?.tags?.name || place?.tags?.brand || "Food place";
}

function getPlaceAmenityLabel(tags) {
  return formatTagLabel(tags?.amenity || "food place");
}

function getRestaurantCuisineLabels(tags) {
  return String(tags?.cuisine || "")
    .split(/[;,]/)
    .map((entry) => formatTagLabel(entry.trim()))
    .filter(Boolean)
    .slice(0, 4);
}

function getRestaurantServiceLabels(tags) {
  const labels = [];
  if (isTruthyOsmTag(tags?.delivery)) labels.push("Delivery");
  if (isTruthyOsmTag(tags?.takeaway)) labels.push("Takeout");
  if (isTruthyOsmTag(tags?.outdoor_seating)) labels.push("Outdoor seating");
  if (isTruthyOsmTag(tags?.drive_through)) labels.push("Drive-thru");
  return labels;
}

function normalizeExternalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`;
}

function getPlaceWebsiteUrl(tags) {
  return normalizeExternalUrl(tags?.website || tags?.["contact:website"]);
}

function getPlacePhoneNumber(tags) {
  const raw = String(tags?.phone || tags?.["contact:phone"] || "").trim();
  return raw || null;
}

function getPlaceAddress(tags) {
  const streetLine = [tags?.["addr:housenumber"], tags?.["addr:street"]]
    .filter(Boolean)
    .join(" ")
    .trim();
  const localityLine = [
    tags?.["addr:city"] || tags?.["addr:suburb"],
    tags?.["addr:state"],
    tags?.["addr:postcode"],
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return [streetLine, localityLine].filter(Boolean).join(", ") || null;
}

function formatOpeningHoursText(value) {
  const raw = String(value || "").trim();
  return raw ? raw.replaceAll(";", " · ") : null;
}

function buildPlaceSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(String(query || "").trim())}`;
}

function getWebsiteDisplayLabel(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return String(url).replace(/^https?:\/\//i, "");
  }
}

function getDistanceFromCurrentLocation(lat, lon) {
  if (!lastCurrentLocation) return null;
  return formatRouteDistance(haversineMeters(lastCurrentLocation.lat, lastCurrentLocation.lng, lat, lon));
}

function renderPopupActionButton(lat, lon, label, destinationTitle, className = "") {
  return `<button class="popup-action${className ? ` ${className}` : ""}" type="button" data-route-lat="${Number(lat).toFixed(6)}" data-route-lng="${Number(lon).toFixed(6)}" data-route-title="${escapeHtml(destinationTitle)}">${escapeHtml(label)}</button>`;
}

function renderPopupActionLink(href, label, { className = "", newTab = true } = {}) {
  if (!href) return "";
  const linkAttrs = newTab ? ' target="_blank" rel="noreferrer noopener"' : "";
  return `<a class="popup-action${className ? ` ${className}` : ""}" href="${escapeHtml(href)}"${linkAttrs}>${escapeHtml(label)}</a>`;
}

function renderPopupActions(actions) {
  const content = actions.filter(Boolean).join("");
  return content ? `<div class="popup-actions popup-actions--wrap">${content}</div>` : "";
}

function renderPopupControlButton(label, attributes, className = "") {
  const renderedAttributes = Object.entries(attributes || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([name, value]) => `${name}="${escapeHtml(String(value))}"`)
    .join(" ");
  return `<button class="popup-action${className ? ` ${className}` : ""}" type="button" ${renderedAttributes}>${escapeHtml(label)}</button>`;
}

function renderRoutePopupHtml(route) {
  if (!route?.destination) {
    return "";
  }

  const snapshot = route.navigationSnapshot || buildNavigationSnapshot(route);
  const primaryStep = snapshot.primaryStep;
  const destinationScore = snapshot.destinationScore;
  const nextInstruction = primaryStep ? buildRouteStepInstruction(primaryStep) : "Route ready";
  const nextTurnMeta = primaryStep
    ? `${formatRouteDistance(primaryStep.distance)} to next turn`
    : `${formatRouteDistance(route.distanceMeters)} remaining`;
  const routeStatusText = lastNavigationStatusMessage
    ? `${lastNavigationStatusTone === "error" ? "Issue: " : ""}${lastNavigationStatusMessage}`
    : "";
  const stepFacts = route.steps.slice(0, 3).map((step, index) => ({
    label: index === 0 ? "Now" : `${index + 1}`,
    value: `${buildRouteStepInstruction(step)} · ${formatRouteDistance(step.distance)}`,
  }));

  return `
<div class="popup-sheet popup-friendly">
  <div class="popup-header">
    <div class="popup-kicker">Route</div>
    <div class="popup-title">${escapeHtml(route.destination.title || "Destination")}</div>
    <div class="popup-subtitle">${escapeHtml(nextInstruction)}</div>
  </div>

  ${renderPopupMetricGrid([
    renderPopupMetricCard("Remaining", formatRouteDistance(route.distanceMeters), `${formatRouteDuration(route.durationSeconds)} left`),
    renderPopupMetricCard("Arrive by", formatArrivalClock(route.durationSeconds), nextTurnMeta),
    renderPopupMetricCard("Camera", getNavigationCameraModeLabel(), navigationCameraMode === "overview" ? "Full route in view" : "Popup-first navigation"),
    destinationScore
      ? renderPopupMetricCard("Arrival field", formatProbabilityRange(getProbabilityLow(destinationScore), getProbabilityHigh(destinationScore)), describeSignal(getProbabilityMid(destinationScore)))
      : renderPopupMetricCard("Arrival field", "Route only", "Refresh the field to bring back DGM scoring"),
  ])}

  ${renderPopupActions([
    renderPopupControlButton("Drive", { "data-route-camera-mode": "driver" }, navigationCameraMode === "driver" ? "popup-action--primary" : ""),
    renderPopupControlButton("Arrival", { "data-route-camera-mode": "arrival" }, navigationCameraMode === "arrival" ? "popup-action--primary" : ""),
    renderPopupControlButton("Overview", { "data-route-camera-mode": "overview" }, navigationCameraMode === "overview" ? "popup-action--primary" : ""),
    renderPopupControlButton(navigationVoiceEnabled ? "Voice on" : "Voice off", { "data-route-voice-toggle": "true" }),
    renderPopupControlButton("Clear route", { "data-route-clear": "true" }, "popup-action--secondary"),
  ])}

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">Route read</div>
      <div class="popup-section-meta">${escapeHtml(getNavigationCameraModeLabel())}</div>
    </div>
    ${routeStatusText ? `<div class="popup-detail">${escapeHtml(routeStatusText)}</div>` : ""}
    <div class="popup-detail">${escapeHtml(snapshot.arrivalSummary || "Route is active.")}</div>
    ${route.rerouteDelta ? `<div class="popup-detail">${escapeHtml(`${route.rerouteDelta.headline} · ${route.rerouteDelta.detail}`)}</div>` : ""}
    ${renderPopupFactRows(stepFacts)}
  </section>
</div>`;
}

function syncRoutePopup(route, { forceOpen = false } = {}) {
  return mapInteractionRuntime.syncRoutePopup(route, { forceOpen });
}

function renderPopupChips(items) {
  const chips = items.filter(Boolean).slice(0, 8);
  return chips.length
    ? `<div class="popup-chip-row">${chips.map((item) => `<span class="popup-chip">${escapeHtml(item)}</span>`).join("")}</div>`
    : "";
}

function renderPopupFactRows(facts) {
  const rows = facts
    .filter((fact) => fact && fact.value)
    .map(({ label, value, href, newTab = true }) => {
      const linkAttrs = newTab ? ' target="_blank" rel="noreferrer noopener"' : "";
      const renderedValue = href
        ? `<a class="popup-fact-link" href="${escapeHtml(href)}"${linkAttrs}>${escapeHtml(value)}</a>`
        : escapeHtml(value);
      return `
        <div class="popup-fact-row">
          <span class="popup-fact-label">${escapeHtml(label)}</span>
          <span class="popup-fact-value">${renderedValue}</span>
        </div>`;
    })
    .join("");

  return rows ? `<div class="popup-facts">${rows}</div>` : "";
}

function renderPopupMetricCard(label, value, detail) {
  if (!value) return "";
  return `
    <article class="popup-metric-card">
      <div class="popup-metric-label">${escapeHtml(label)}</div>
      <div class="popup-metric-value">${escapeHtml(value)}</div>
      ${detail ? `<div class="popup-metric-detail">${escapeHtml(detail)}</div>` : ""}
    </article>`;
}

function renderPopupMetricGrid(cards) {
  const content = cards.filter(Boolean).join("");
  return content ? `<div class="popup-metric-grid">${content}</div>` : "";
}

function renderNearbyRestaurantsList(likely) {
  if (!likely.length) {
    return '<div class="popup-empty">No nearby restaurants were found in this view.</div>';
  }

  const items = likely.map((restaurant, index) => {
    const wrapperStart = restaurant.id
      ? `<button type="button" class="popup-nearby-item popup-nearby-item--button" data-place-sheet-restaurant-id="${escapeHtml(String(restaurant.id))}">`
      : '<article class="popup-nearby-item">';
    const wrapperEnd = restaurant.id ? '</button>' : '</article>';

    return `
      ${wrapperStart}
        <div class="popup-nearby-rank">${index + 1}</div>
        <div class="popup-nearby-copy">
          <div class="popup-nearby-name">${escapeHtml(restaurant.name)}</div>
          <div class="popup-nearby-meta">${escapeHtml(formatTagLabel(restaurant.amenity))} · ${restaurant.distMeters} m away</div>
        </div>
      ${wrapperEnd}`;
  }).join("");

  return `
    <div class="popup-nearby-list">
      ${items}
    </div>`;
}

function buildPopupScoringParams(tauMeters, hour) {
  return {
    tauMeters,
    hour,
    horizonMin: lastParams.horizonMin,
    competitionStrength: lastParams.competitionStrength,
    residentialAnchors: lastResidentialAnchors,
    residentialDemandWeight: lastParams.residentialDemandWeight,
    rainBoost: lastParams.rainBoost,
    tipEmphasis: lastParams.tipEmphasis,
    predictionModel: lastParams.predictionModel,
    lambdaRef: lastStats?.lambdaRef,
    useML: lastParams.useML,
    mlBeta: lastParams.mlBeta,
  };
}

function getPopupPointScore(latlng, restaurants, tauMeters, hour) {
  if (!restaurants?.length) return null;

  return probabilityOfGoodOrder(
    { lat: latlng.lat, lon: latlng.lng ?? latlng.lon },
    restaurants,
    lastParkingCandidates,
    buildPopupScoringParams(tauMeters, hour)
  );
}

function formatCompactRank(score) {
  const percentile = percentileFromSorted(getProbabilityMid(score), lastStats?.scoreSamplesSorted);
  if (percentile === null) return "Unranked";
  if (percentile >= 90) return `Top ${Math.max(1, 100 - percentile)}%`;
  if (percentile >= 70) return "Above avg";
  if (percentile >= 40) return "Mid pack";
  return "Lower tier";
}

function renderRestaurantPopupHtml(restaurant) {
  const tags = restaurant?.tags ?? {};
  const name = getPlaceDisplayName(restaurant);
  const amenityLabel = getPlaceAmenityLabel(tags);
  const cuisineLabels = getRestaurantCuisineLabels(tags);
  const serviceLabels = getRestaurantServiceLabels(tags);
  const address = getPlaceAddress(tags);
  const openingHours = formatOpeningHoursText(tags?.opening_hours);
  const phoneNumber = getPlacePhoneNumber(tags);
  const websiteUrl = getPlaceWebsiteUrl(tags);
  const currentDistance = getDistanceFromCurrentLocation(restaurant.lat, restaurant.lon);
  const areaScore = lastStats
    ? getPopupPointScore({ lat: restaurant.lat, lon: restaurant.lon }, lastRestaurants, lastParams.tauMeters, lastParams.hour)
    : null;
  const subtitle = [amenityLabel, cuisineLabels[0] || null].filter(Boolean).join(" · ");

  return `
<div class="popup-sheet popup-friendly">
  <div class="popup-header">
    <div class="popup-kicker">Restaurant</div>
    <div class="popup-title">${escapeHtml(name)}</div>
    ${subtitle ? `<div class="popup-subtitle">${escapeHtml(subtitle)}</div>` : ""}
  </div>

  ${renderPopupChips([...cuisineLabels, ...serviceLabels])}

  ${renderPopupMetricGrid([
    currentDistance ? renderPopupMetricCard("From you", currentDistance, "Straight-line distance") : "",
    areaScore ? renderPopupMetricCard("Nearby field", formatProbabilityRange(getProbabilityLow(areaScore), getProbabilityHigh(areaScore)), "10-minute hold strength") : "",
    websiteUrl
      ? renderPopupMetricCard("Website", getWebsiteDisplayLabel(websiteUrl), "Official source")
      : openingHours
        ? renderPopupMetricCard("Hours", "Listed", "See overview below")
        : "",
  ])}

  ${renderPopupActions([
    renderPopupActionButton(restaurant.lat, restaurant.lon, "Route here", name, "popup-action--primary"),
    websiteUrl ? renderPopupActionLink(websiteUrl, "Website") : "",
    renderPopupActionLink(buildPlaceSearchUrl(`${name} menu`), "Menu"),
    renderPopupActionLink(buildPlaceSearchUrl(`${name} reviews`), "Reviews"),
    phoneNumber ? renderPopupActionLink(`tel:${encodeURIComponent(phoneNumber)}`, "Call", { className: "popup-action--secondary", newTab: false }) : "",
  ])}

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">Overview</div>
      <div class="popup-section-meta">${escapeHtml(amenityLabel)}</div>
    </div>
    ${renderPopupFactRows([
      cuisineLabels.length ? { label: "Cuisine", value: cuisineLabels.join(", ") } : null,
      address ? { label: "Address", value: address } : null,
      openingHours ? { label: "Hours", value: openingHours } : null,
      phoneNumber ? { label: "Phone", value: phoneNumber, href: `tel:${encodeURIComponent(phoneNumber)}`, newTab: false } : null,
      websiteUrl ? { label: "Website", value: getWebsiteDisplayLabel(websiteUrl), href: websiteUrl } : null,
    ])}
  </section>

  ${areaScore ? `
    <section class="popup-section">
      <div class="popup-section-head">
        <div class="popup-section-title">Area context</div>
        <div class="popup-section-meta">${escapeHtml(formatCompactRank(areaScore))}</div>
      </div>
      <div class="popup-detail">${escapeHtml(describeSignal(getProbabilityMid(areaScore)))}</div>
      <div class="popup-detail">${escapeHtml(formatRelativeRank(areaScore))}</div>
      ${renderExplainabilityDetails(areaScore)}
    </section>` : ""}
</div>`;
}

function stopNavigationSpeech() {
  return routingRuntime.stopNavigationSpeech();
}

function updateNavigationVoiceButton() {
  return routingRuntime.updateNavigationVoiceButton();
}

function formatRouteDistance(distanceMeters) {
  return routingRuntime.formatRouteDistance(distanceMeters);
}

function formatRouteDuration(durationSeconds) {
  return routingRuntime.formatRouteDuration(durationSeconds);
}

function formatCompactRouteDuration(durationSeconds) {
  return routingRuntime.formatCompactRouteDuration(durationSeconds);
}

function buildRouteBounds(coordinates) {
  return routingRuntime.buildRouteBounds(coordinates);
}

function fitRouteToView(route) {
  return routingRuntime.fitRouteToView(route);
}

function clearRouteOverlay() {
  return routingRuntime.clearRouteOverlay();
}

function setNavigationStatus(message, tone = "info") {
  return routingRuntime.setNavigationStatus(message, tone);
}

function findRestaurantByDestination(destination, maxDistanceMeters = 40) {
  const lat = Number(destination?.lat);
  const lng = Number(destination?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return Array.from(restaurantById.values()).find((restaurant) => (
    haversineMeters(lat, lng, restaurant.lat, restaurant.lon) <= maxDistanceMeters
  )) || null;
}

function resolveNavigationDestinationState(destination) {
  if (destination?.placeState) {
    return { ...destination.placeState };
  }

  const restaurant = findRestaurantByDestination(destination);
  if (restaurant) {
    return buildRestaurantSheetState(restaurant);
  }

  return buildSpotSheetState({ lat: destination.lat, lng: destination.lng });
}

function getNavigationDestinationState(route) {
  if (!route?.destination) {
    return null;
  }

  const baseState = route.destinationState || resolveNavigationDestinationState(route.destination);
  const freshScore = lastStats
    ? getPopupPointScore({ lat: route.destination.lat, lon: route.destination.lng }, lastRestaurants, lastParams.tauMeters, lastParams.hour)
    : baseState?.score ?? null;

  return {
    ...baseState,
    title: route.destination.title || baseState?.title || "Destination",
    lat: route.destination.lat,
    lng: route.destination.lng,
    score: freshScore,
    routeSummary: {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
    },
    routeStatus: "ready",
    routeError: "",
  };
}

function formatArrivalClock(durationSeconds) {
  return routingRuntime.formatArrivalClock(durationSeconds);
}

function getNavigationCameraModeLabel() {
  return routingRuntime.getNavigationCameraModeLabel();
}

function setNavigationCameraMode(mode, { auto = false } = {}) {
  return routingRuntime.setNavigationCameraMode(mode, { auto });
}

function isNavigationFollowCameraActive() {
  return routingRuntime.isNavigationFollowCameraActive();
}

function getNavigationCameraPitch(mode = navigationCameraMode, speedMetersPerSecond = 0, remainingDistanceMeters = 0) {
  return routingRuntime.getNavigationCameraPitch(mode, speedMetersPerSecond, remainingDistanceMeters);
}

function getNavigationCameraZoom(mode = navigationCameraMode, speedMetersPerSecond = 0, nextStepDistanceMeters = 0, remainingDistanceMeters = 0) {
  return routingRuntime.getNavigationCameraZoom(mode, speedMetersPerSecond, nextStepDistanceMeters, remainingDistanceMeters);
}

function syncNavigationCameraModeForRoute(route) {
  return routingRuntime.syncNavigationCameraModeForRoute(route);
}

function getMapBearingHeading() {
  return routingRuntime.getMapBearingHeading();
}

function syncActiveNavigationCamera({
  latlng = lastCurrentLocation,
  heading = headingRuntime?.getStoredHeading() ?? null,
  speed = headingRuntime?.getStoredSpeed() ?? null,
  force = false,
  allowBearing = true,
} = {}) {
  return routingRuntime.syncActiveNavigationCamera({
    latlng,
    heading,
    speed,
    force,
    allowBearing,
  });
}

function focusActiveNavigationCamera({ force = false, mode = "driver" } = {}) {
  return routingRuntime.focusActiveNavigationCamera({ force, mode });
}

function showActiveRouteArrivalView() {
  return routingRuntime.showActiveRouteArrivalView();
}

function showActiveRouteOverview() {
  return routingRuntime.showActiveRouteOverview();
}

function resetNavigationCamera() {
  return routingRuntime.resetNavigationCamera();
}


function getPrimaryRouteStep(route) {
  return routingRuntime.getPrimaryRouteStep(route);
}

function getArrivalRouteStep(route) {
  return routingRuntime.getArrivalRouteStep(route);
}

function getFinalTurnRouteStep(route) {
  return routingRuntime.getFinalTurnRouteStep(route);
}

function getRouteApproachSegment(route) {
  return routingRuntime.getRouteApproachSegment(route);
}

function getRouteSegmentBearingDegrees(start, end) {
  return routingRuntime.getRouteSegmentBearingDegrees(start, end);
}

function getRouteCoordinateBearing(coordinates, { fromEnd = false } = {}) {
  return routingRuntime.getRouteCoordinateBearing(coordinates, { fromEnd });
}

function getRouteStepBearingDegrees(step) {
  return routingRuntime.getRouteStepBearingDegrees(step);
}

function getRouteCameraBearing(route, mode = navigationCameraMode) {
  return routingRuntime.getRouteCameraBearing(route, mode);
}

function getRouteCameraAnchor(route, mode = navigationCameraMode) {
  return routingRuntime.getRouteCameraAnchor(route, mode);
}

function getPlanarVectorMeters(fromLatLng, toLatLng) {
  return routingRuntime.getPlanarVectorMeters(fromLatLng, toLatLng);
}

function getApproachRelativeSide(approachStart, approachEnd, point) {
  return routingRuntime.getApproachRelativeSide(approachStart, approachEnd, point);
}

function formatRelativeSideLabel(side) {
  return routingRuntime.formatRelativeSideLabel(side);
}

function getArrivalSideFromModifier(modifier) {
  return routingRuntime.getArrivalSideFromModifier(modifier);
}

function getTurnDeltaDegrees(bearingBefore, bearingAfter) {
  return routingRuntime.getTurnDeltaDegrees(bearingBefore, bearingAfter);
}


function buildRouteStepInstruction(step) {
  return routingRuntime.buildRouteStepInstruction(step);
}

function getNavigationTurnComplexity(step) {
  return routingRuntime.getNavigationTurnComplexity(step);
}

function buildRouteApproachProfile(route, destinationState, { pickupFriction, stagingCandidate, microCandidate } = {}) {
  return routingRuntime.buildRouteApproachProfile(route, destinationState, {
    pickupFriction,
    stagingCandidate,
    microCandidate,
  });
}

function buildNavigationArrivalReadiness({
  route,
  destinationScore,
  pickupFriction,
  stagingCandidate,
  microCandidate,
  approachProfile,
}) {
  return routingRuntime.buildNavigationArrivalReadiness({
    route,
    destinationScore,
    pickupFriction,
    stagingCandidate,
    microCandidate,
    approachProfile,
  });
}


function getParkingCandidateIdentity(candidate) {
  return routingRuntime.getParkingCandidateIdentity(candidate);
}

function formatRouteDurationDelta(durationSeconds) {
  return routingRuntime.formatRouteDurationDelta(durationSeconds);
}

function formatRouteDistanceDelta(distanceMeters) {
  return routingRuntime.formatRouteDistanceDelta(distanceMeters);
}

function buildNavigationSnapshot(route) {
  return routingRuntime.buildNavigationSnapshot(route);
}

function buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot) {
  return routingRuntime.buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot);
}

function speakNavigationInstruction(route, { force = false } = {}) {
  return routingRuntime.speakNavigationInstruction(route, { force });
}

function setNavigationVoiceEnabled(isEnabled) {
  return routingRuntime.setNavigationVoiceEnabled(isEnabled);
}

function renderNavigationCard(route) {
  return routingRuntime.renderNavigationCard(route);
}

async function fetchDrivingRoute(origin, destination, { signal } = {}) {
  return routingRuntime.fetchDrivingRoute(origin, destination, { signal });
}

function setCurrentLocationState(latlng, accuracyMeters, { openPopup = true } = {}) {
  return locationRuntime.setCurrentLocationState(latlng, accuracyMeters, { openPopup });
}

function stopNavigationWatch() {
  return routingRuntime.stopNavigationWatch();
}

function updateHeadingCone(latlng, heading, speed) {
  const resolvedLatLng = lngLatToObject(latlng);
  const resolvedHeading = normalizeHeadingDegrees(heading);
  if (!resolvedLatLng || resolvedHeading === null) {
    clearHeadingConeVisual();
    return false;
  }

  const halfAngle = getHeadingConeHalfAngle(
    typeof speed === "number" && Number.isFinite(speed)
      ? speed
      : headingRuntime?.getStoredSpeed() ?? null
  );
  const coneLengthMeters = getCachedHeadingConeLengthMeters(resolvedLatLng.lat);
  if (!(typeof coneLengthMeters === "number" && Number.isFinite(coneLengthMeters) && coneLengthMeters > 0)) {
    clearHeadingConeVisual();
    return false;
  }

  const renderMesh = getHeadingConeRenderMesh();
  const latScale = 1 / 111320;
  const lngScale = 1 / (111320 * Math.max(Math.cos((resolvedLatLng.lat * Math.PI) / 180), 0.1));
  const projectConePoint = (distanceMeters, angleDeg) => {
    const angleRad = (angleDeg * Math.PI) / 180;
    return [
      resolvedLatLng.lng + distanceMeters * Math.sin(angleRad) * lngScale,
      resolvedLatLng.lat + distanceMeters * Math.cos(angleRad) * latScale,
    ];
  };

  for (const pointRef of renderMesh.pointRefs) {
    if (pointRef.isOrigin) {
      pointRef.point[0] = resolvedLatLng.lng;
      pointRef.point[1] = resolvedLatLng.lat;
      continue;
    }

    const distanceMeters = coneLengthMeters * pointRef.distanceRatio;
    const angleDeg = resolvedHeading - halfAngle + (2 * halfAngle * pointRef.angleRatio);
    const [nextLng, nextLat] = projectConePoint(distanceMeters, angleDeg);
    pointRef.point[0] = nextLng;
    pointRef.point[1] = nextLat;
  }

  setSourceData(SOURCE_HEADING, renderMesh.featureCollection);
  return true;
}

function getCachedHeadingConeLengthMeters(latitude) {
  const zoom = map.getZoom();
  if (zoom !== lastHeadingConeZoom || latitude !== lastHeadingConeLatitude) {
    lastHeadingConeZoom = zoom;
    lastHeadingConeLatitude = latitude;
    lastHeadingConeLengthMeters = getHeadingConeLengthMeters(
      latitude,
      zoom,
      HEADING_CONE_LENGTH_PIXELS * HEADING_CONE_RENDER_SCALE_BIAS
    );
  }
  return lastHeadingConeLengthMeters;
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function readPlaceHistoryStore() {
  if (!canUseLocalStorage()) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(PLACE_HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePlaceHistoryStore(store) {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    const entries = Object.entries(store || {})
      .sort((left, right) => (right?.[1]?.lastOpenedAt ?? 0) - (left?.[1]?.lastOpenedAt ?? 0))
      .slice(0, PLACE_HISTORY_MAX_ENTRIES);
    window.localStorage.setItem(PLACE_HISTORY_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore storage failures and keep runtime behavior intact.
  }
}

function getPlaceHistoryEntry(placeKey) {
  if (!placeKey) {
    return null;
  }

  const entry = readPlaceHistoryStore()[placeKey];
  return entry && typeof entry === "object" ? entry : null;
}

function touchPlaceHistoryEntry(state, { incrementOpen = true, incrementRoute = false } = {}) {
  if (!state?.key) {
    return null;
  }

  const store = readPlaceHistoryStore();
  const now = Date.now();
  const nextEntry = {
    openCount: 0,
    routeCount: 0,
    firstSeenAt: now,
    lastOpenedAt: now,
    lastRouteAt: null,
    kind: state.kind,
    title: state.title,
    subtitle: state.subtitle || "",
    ...(store[state.key] || {}),
  };

  nextEntry.kind = state.kind;
  nextEntry.title = state.title;
  nextEntry.subtitle = state.subtitle || "";
  nextEntry.lastOpenedAt = now;
  if (incrementOpen) {
    nextEntry.openCount = Number(nextEntry.openCount || 0) + 1;
  }
  if (incrementRoute) {
    nextEntry.routeCount = Number(nextEntry.routeCount || 0) + 1;
    nextEntry.lastRouteAt = now;
  }

  store[state.key] = nextEntry;
  writePlaceHistoryStore(store);
  return nextEntry;
}

function formatRelativeTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return "Not yet";
  }

  const elapsedMs = Math.max(0, Date.now() - timestampMs);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < hourMs) {
    return `${Math.max(1, Math.round(elapsedMs / minuteMs))} min ago`;
  }

  if (elapsedMs < dayMs) {
    return `${Math.max(1, Math.round(elapsedMs / hourMs))} hr ago`;
  }

  return `${Math.max(1, Math.round(elapsedMs / dayMs))} day ago`;
}

function describeFamiliarityEntry(entry) {
  const openCount = Number(entry?.openCount || 0);
  const routeCount = Number(entry?.routeCount || 0);

  if (routeCount >= 6 || openCount >= 14) {
    return {
      label: "Highly familiar",
      detail: "You revisit this place enough that DGM should keep surfacing your local context here.",
    };
  }

  if (routeCount >= 2 || openCount >= 5) {
    return {
      label: "Familiar",
      detail: "You have enough local history here for side-by-side comparisons to start becoming useful.",
    };
  }

  return {
    label: "Fresh read",
    detail: "This place is still mostly a live field read, not a habit-driven one.",
  };
}

function startBlueDotBreathingAnimation() {
  return locationRuntime.startBlueDotBreathingAnimation();
}

function startContinuousLocationWatch() {
  return locationRuntime.startContinuousLocationWatch();
}

async function refreshActiveRouteFromOrigin(origin, options = {}) {
  return routingRuntime.refreshActiveRouteFromOrigin(origin, options);
}

function ensureNavigationWatch() {
  return routingRuntime.ensureNavigationWatch();
}

async function ensureNavigationOrigin() {
  return routingRuntime.ensureNavigationOrigin();
}

async function startInAppNavigation(destination, options = {}) {
  return routingRuntime.startInAppNavigation(destination, options);
}

function clearInAppNavigation() {
  return routingRuntime.clearInAppNavigation();
}

function setSearchResultsExpanded(isExpanded) {
  if (!elSearchResults) return;
  elSearchResults.classList.toggle("has-results", Boolean(isExpanded));
  elSearchResults.setAttribute("aria-hidden", String(!isExpanded));
}

function clearSearchInteractionState() {
  searchResultPressActive = false;
  if (searchResultPressTimer) {
    clearTimeout(searchResultPressTimer);
    searchResultPressTimer = null;
  }
}

function noteSearchResultsInteraction() {
  searchResultPressActive = true;
  if (searchResultPressTimer) {
    clearTimeout(searchResultPressTimer);
  }
  searchResultPressTimer = setTimeout(() => {
    searchResultPressActive = false;
    searchResultPressTimer = null;
  }, 250);
}

function clearActiveSearchMarker() {
  if (activeSearchMarker) {
    activeSearchMarker.remove();
    activeSearchMarker = null;
  }
}

function splitSearchDisplayName(displayName) {
  const pieces = String(displayName || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    title: pieces[0] || String(displayName || "").trim() || "Search result",
    subtitle: pieces.slice(1).join(", ") || "Mapped location",
  };
}

function clearSearchResults() {
  if (!elSearchResults) return;
  renderedSearchResults = [];
  clearSearchInteractionState();
  elSearchResults.innerHTML = "";
  setSearchResultsExpanded(false);
}

function setSearchOverlayOpen(isOpen, { focusInput = false, restoreFocus = false } = {}) {
  if (!elSearchOverlay || !elSearchToggle) return;

  isSearchOverlayOpen = Boolean(isOpen);
  elSearchOverlay.hidden = !isSearchOverlayOpen;
  elSearchOverlay.style.display = isSearchOverlayOpen ? "grid" : "none";
  elSearchOverlay.style.pointerEvents = isSearchOverlayOpen ? "auto" : "none";
  elSearchOverlay.setAttribute("aria-hidden", String(!isSearchOverlayOpen));
  elSearchToggle.setAttribute("aria-expanded", String(isSearchOverlayOpen));

  if (!isSearchOverlayOpen) {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (activeSearchAbort) {
      activeSearchAbort.abort();
      activeSearchAbort = null;
    }
    clearSearchResults();
    if (document.activeElement === elSearchInput) {
      elSearchInput.blur();
    }
    if (restoreFocus) {
      elSearchToggle.focus();
    }
    return;
  }

  if (focusInput && elSearchInput) {
    window.requestAnimationFrame(() => {
      elSearchInput.focus();
      elSearchInput.select();
    });
  }
}

function openSearchOverlay() {
  setSearchOverlayOpen(true, { focusInput: true });
}

function closeSearchOverlay(options) {
  setSearchOverlayOpen(false, options);
}

function isKeyboardActivationClick(event) {
  return event?.type === "click" && event.detail === 0;
}

function addPreferredPressHandler(element, handler) {
  if (!element) return;

  element.addEventListener("pointerdown", (event) => {
    if (typeof event.button === "number" && event.button !== 0) {
      return;
    }
    event.preventDefault();
    handler(event);
  });

  element.addEventListener("click", (event) => {
    if (!isKeyboardActivationClick(event)) {
      return;
    }
    handler(event);
  });
}

function renderSearchResults(results) {
  if (!elSearchResults) return;
  renderedSearchResults = Array.isArray(results) ? results : [];

  if (!renderedSearchResults.length) {
    clearSearchResults();
    return;
  }

  elSearchResults.innerHTML = renderedSearchResults
    .map((result, index) => `
      <button class="search-result" type="button" data-index="${index}" role="option">
        <span class="search-result-title">${escapeHtml(result.title)}</span>
        ${result.subtitle ? `<span class="search-result-meta">${escapeHtml(result.subtitle)}</span>` : ""}
      </button>
    `)
    .join("");
  setSearchResultsExpanded(true);
}

function normalizeMapboxMatch(rawMatch) {
  const coordinates = Array.isArray(rawMatch?.center)
    ? rawMatch.center
    : rawMatch?.geometry?.coordinates;
  const displayName = String(rawMatch?.place_name ?? rawMatch?.properties?.label ?? rawMatch?.text ?? "").trim();
  const { title, subtitle } = splitSearchDisplayName(displayName);

  return {
    lat: Number(coordinates?.[1]),
    lng: Number(coordinates?.[0]),
    title,
    subtitle,
    label: displayName || title,
  };
}

function normalizeNominatimMatch(rawMatch) {
  const displayName = String(rawMatch?.display_name ?? "").trim();
  const { title, subtitle } = splitSearchDisplayName(displayName);

  return {
    lat: Number(rawMatch?.lat),
    lng: Number(rawMatch?.lon),
    title,
    subtitle,
    label: displayName || title,
  };
}

async function fetchMapboxMatches(query, { limit = 5, signal } = {}) {
  const searchUrl = new URL(`${MAPBOX_GEOCODING_API_URL}/${encodeURIComponent(query)}.json`);
  searchUrl.searchParams.set("access_token", MAPBOX_GEOCODING_TOKEN);
  searchUrl.searchParams.set("autocomplete", "true");
  searchUrl.searchParams.set("limit", String(limit));
  searchUrl.searchParams.set("language", "en");
  searchUrl.searchParams.set("types", "address,poi,place,locality,neighbourhood,street");

  const center = map.getCenter();
  if (Number.isFinite(center?.lng) && Number.isFinite(center?.lat)) {
    searchUrl.searchParams.set("proximity", `${center.lng},${center.lat}`);
  }

  const response = await fetch(searchUrl, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Search failed (${response.status})`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.features)
    ? payload.features
      .map(normalizeMapboxMatch)
      .filter((match) => Number.isFinite(match.lat) && Number.isFinite(match.lng))
    : [];
}

async function fetchNominatimMatches(query, { limit = 5, signal } = {}) {
  const searchUrl = new URL(NOMINATIM_SEARCH_URL);
  searchUrl.searchParams.set("format", "jsonv2");
  searchUrl.searchParams.set("limit", String(limit));
  searchUrl.searchParams.set("q", query);

  const response = await fetch(searchUrl, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Search failed (${response.status})`);
  }

  const payload = await response.json();
  return Array.isArray(payload)
    ? payload.map(normalizeNominatimMatch).filter((match) => Number.isFinite(match.lat) && Number.isFinite(match.lng))
    : [];
}

async function fetchSearchMatches(query, { limit = 5, signal } = {}) {
  try {
    const primaryMatches = await fetchMapboxMatches(query, { limit, signal });
    if (primaryMatches.length) {
      return primaryMatches;
    }
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn("Mapbox geocoding failed; falling back to Nominatim.", error);
  }

  return fetchNominatimMatches(query, { limit, signal });
}

async function updateSearchSuggestions(query) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 3) {
    if (activeSearchAbort) activeSearchAbort.abort();
    clearSearchResults();
    return;
  }

  if (activeSearchAbort) activeSearchAbort.abort();
  activeSearchAbort = new AbortController();
  const requestId = ++searchSequence;

  try {
    const matches = await fetchSearchMatches(trimmed, { limit: 5, signal: activeSearchAbort.signal });
    if (requestId !== searchSequence) return;
    renderSearchResults(matches);
  } catch (error) {
    if (error?.name === "AbortError") return;
    console.error(error);
    clearSearchResults();
  }
}

function scheduleSearchSuggestions(query) {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  searchDebounceTimer = setTimeout(() => {
    updateSearchSuggestions(query).catch((error) => console.error(error));
  }, 180);
}

function renderSearchPopupHtml(match) {
  const subtitle = match.subtitle && match.subtitle !== match.title
    ? `<div class="popup-detail">${escapeHtml(match.subtitle)}</div>`
    : "";

  return `<div class="popup-friendly"><b>${escapeHtml(match.title)}</b>${subtitle}${renderNavigationAction(match.lat, match.lng, lastCurrentLocation ? "Refresh route" : "Start route", match.title)}</div>`;
}

function focusSearchMatch(match) {
  const lat = Number(match.lat);
  const lng = Number(match.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return;
  }

  clearActiveSearchMarker();

  map.flyTo({
    center: [lng, lat],
    zoom: Math.max(map.getZoom(), 15),
    duration: 900,
    essential: true,
  });

  const marker = new mapboxgl.Marker({ color: "#ffbf45" })
    .setLngLat([lng, lat])
    .addTo(map);
  activeSearchMarker = marker;

  const popup = openPopupAtLngLat(
    { lat, lng },
    renderSearchPopupHtml(match),
    { closeButton: true }
  );

  if (lastCurrentLocation) {
    startInAppNavigation({ lat, lng, title: match.title }).catch((error) => {
      console.error(error);
      setNavigationStatus(error?.message ?? String(error), "error");
    });
  }
}

async function searchAddress(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return;
  const [match] = await fetchSearchMatches(trimmed, { limit: 1 });
  if (!match) {
    throw new Error("No matching address found.");
  }
  clearSearchResults();
  if (elSearchInput) {
    elSearchInput.value = match.label || match.title;
  }
  focusSearchMatch(match);
}

function selectRenderedSearchResult(index) {
  const match = renderedSearchResults[Number(index)];
  if (!match) return;

  clearSearchInteractionState();
  clearSearchResults();
  if (elSearchInput) {
    elSearchInput.value = match.label || match.title;
  }
  focusSearchMatch(match);
  closeSearchOverlay();
}

function setLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;

  map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
}

function createCirclePolygonFeature(latlng, radiusMeters, steps = 48) {
  const center = lngLatToObject(latlng);
  const coordinates = [];

  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    const dx = Math.cos(angle) * radiusMeters;
    const dy = Math.sin(angle) * radiusMeters;
    const lat = center.lat + (dy / 111320);
    const lngScale = Math.max(Math.cos((center.lat * Math.PI) / 180), 0.1);
    const lng = center.lng + (dx / (111320 * lngScale));
    coordinates.push([lng, lat]);
  }

  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [coordinates],
    },
    properties: {},
  };
}

function ensureMapSourcesAndLayers() {
  ensureHybridBaseLayers();

  if (map.getSource(SOURCE_RESTAURANTS)) {
    syncCategoryLayerVisibility();
    applyCinematicTheme();
    return;
  }

  map.addSource(SOURCE_RESTAURANTS, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_PARKING, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_HEAT, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_SPOT, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_CURRENT_LOCATION, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_CURRENT_LOCATION_ACCURACY, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_HEADING, { type: "geojson", data: featureCollection() });
  map.addSource(SOURCE_ROUTE, { type: "geojson", data: featureCollection() });

  map.addLayer({
    id: LAYER_HEAT,
    type: "heatmap",
    source: SOURCE_HEAT,
    maxzoom: 17,
    paint: {
      "heatmap-weight": ["coalesce", ["get", "intensity"], 0],
      "heatmap-intensity": 1,
      "heatmap-radius": 24,
      "heatmap-opacity": 0.82,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(0, 229, 255, 0)",
        0.15, "rgba(30, 238, 255, 0.35)",
        0.36, "#00ecff",
        0.6, "#4da8ff",
        0.8, "#7b47ff",
        1, "#bb49ff",
      ],
    },
  });

  map.addLayer({
    id: LAYER_ROUTE_CASING,
    type: "line",
    source: SOURCE_ROUTE,
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "rgba(11, 15, 23, 0.82)",
      "line-width": 10,
      "line-opacity": 0.92,
    },
  });

  map.addLayer({
    id: LAYER_ROUTE,
    type: "line",
    source: SOURCE_ROUTE,
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#7fd4f8",
      "line-width": 6,
      "line-opacity": 0.96,
    },
  });

  map.addLayer({
    id: LAYER_RESTAURANTS_GLOW,
    type: "circle",
    source: SOURCE_RESTAURANTS,
    paint: {
      "circle-radius": 10,
      "circle-color": "#ff944a",
      "circle-opacity": 0.28,
      "circle-blur": 0.84,
    },
  });

  map.addLayer({
    id: LAYER_RESTAURANTS,
    type: "circle",
    source: SOURCE_RESTAURANTS,
    paint: {
      "circle-radius": 4.6,
      "circle-color": "#ffb25d",
      "circle-stroke-color": "#fff0d1",
      "circle-stroke-width": 1.2,
      "circle-opacity": 0.96,
    },
  });

  map.addLayer({
    id: LAYER_PARKING_GLOW,
    type: "circle",
    source: SOURCE_PARKING,
    paint: {
      "circle-radius": 12,
      "circle-color": "#5cf2ff",
      "circle-opacity": 0.24,
      "circle-blur": 0.82,
    },
  });

  map.addLayer({
    id: LAYER_PARKING,
    type: "circle",
    source: SOURCE_PARKING,
    paint: {
      "circle-radius": 7,
      "circle-color": "#64eeff",
      "circle-stroke-color": "#f1feff",
      "circle-stroke-width": 2.1,
      "circle-opacity": 0.78,
    },
  });

  map.addLayer({
    id: LAYER_SPOT_GLOW,
    type: "circle",
    source: SOURCE_SPOT,
    paint: {
      "circle-radius": 18,
      "circle-color": "#8e72ff",
      "circle-opacity": 0.2,
      "circle-blur": 0.86,
    },
  });

  map.addLayer({
    id: LAYER_SPOT,
    type: "circle",
    source: SOURCE_SPOT,
    paint: {
      "circle-radius": 8.8,
      "circle-color": "#f8fbff",
      "circle-stroke-color": "#110d1f",
      "circle-stroke-width": 2.4,
      "circle-opacity": 0.98,
    },
  });

  map.addLayer({
    id: LAYER_SPOT_LABEL,
    type: "symbol",
    source: SOURCE_SPOT,
    layout: {
      "text-field": ["coalesce", ["get", "label"], "Best Spot"],
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      "text-size": 11,
      "text-letter-spacing": 0.06,
      "text-offset": [0, 1.55],
      "text-anchor": "top",
      "text-allow-overlap": true,
    },
    paint: {
      "text-color": "#f3fbff",
      "text-halo-color": "rgba(9, 16, 28, 0.92)",
      "text-halo-width": 1.6,
      "text-halo-blur": 0.4,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_ACCURACY_GLOW,
    type: "line",
    source: SOURCE_CURRENT_LOCATION_ACCURACY,
    paint: {
      "line-color": "#69f3ff",
      "line-width": 5,
      "line-opacity": 0.22,
      "line-blur": 1.1,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_ACCURACY_FILL,
    type: "fill",
    source: SOURCE_CURRENT_LOCATION_ACCURACY,
    paint: {
      "fill-color": "#3af0ff",
      "fill-opacity": 0.12,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_ACCURACY_LINE,
    type: "line",
    source: SOURCE_CURRENT_LOCATION_ACCURACY,
    paint: {
      "line-color": "#b8fcff",
      "line-width": 1.4,
      "line-opacity": 0.72,
    },
  });

  map.addLayer({
    id: LAYER_HEADING_GLOW,
    type: "fill",
    source: SOURCE_HEADING,
    paint: {
      "fill-color": "#9ad9ff",
      "fill-opacity": ["*", ["coalesce", ["get", "opacity"], 0], 0.68],
    },
  });

  map.addLayer({
    id: LAYER_HEADING,
    type: "fill",
    source: SOURCE_HEADING,
    paint: {
      "fill-color": "#57bcff",
      "fill-opacity": ["coalesce", ["get", "opacity"], 0],
    },
  });

  map.addLayer({
    id: LAYER_HEADING_EDGE,
    type: "line",
    source: SOURCE_HEADING,
    layout: {
      "line-cap": "round",
      "line-join": "round",
    },
    paint: {
      "line-color": "#eefbff",
      "line-width": 1.4,
      "line-opacity": ["*", ["coalesce", ["get", "opacity"], 0], 0.72],
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_HALO,
    type: "circle",
    source: SOURCE_CURRENT_LOCATION,
    paint: {
      "circle-radius": BLUE_DOT_BASE_RADIUS_PX * BLUE_DOT_HALO_RADIUS_SCALE,
      "circle-color": "#56f0ff",
      "circle-opacity": 0.34,
      "circle-blur": 0.8,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_DOT,
    type: "circle",
    source: SOURCE_CURRENT_LOCATION,
    paint: {
      "circle-radius": BLUE_DOT_BASE_RADIUS_PX,
      "circle-color": "#61f6ff",
      "circle-stroke-color": "#08131d",
      "circle-stroke-width": 3.2,
      "circle-opacity": 0.98,
    },
  });

  bindMapInteractionLayerEvents();
  syncCategoryLayerVisibility();
  applyCinematicTheme();
}

function setHourDefaults() {
  const now = new Date();
  elHour.value = String(now.getHours());
}

function updateLabels() {
  const hour = Number(elHour.value);
  const bucket = timeBucket(hour);

  elHourVal.textContent = `${hour}:00 · ${bucket.label}`;
  elTauVal.textContent = `${elTau.value} m`;
  elGridVal.textContent = `${elGrid.value} m`;
  elHorizonVal.textContent = `${PROBABILITY_HORIZON_MINUTES} min fixed`;
  elCompetitionVal.textContent = `${Number(elCompetition.value).toFixed(2)}`;
  elResidentialWeightVal.textContent = `${Number(elResidentialWeight.value).toFixed(2)}`;
  elRainBoostVal.textContent = `${Math.round(Number(elRainBoost.value) * 100)}%`;
  elTipEmphasisVal.textContent = `${Number(elTipEmphasis.value).toFixed(2)}`;
  elMlBetaVal.textContent = `${Number(elMlBeta.value).toFixed(1)}`;
  elKSpotsVal.textContent = `${Number(elKSpots.value)}`;
  applyCinematicTheme();
}

dataScoringRuntime = createDataScoringRuntime({
  getMap: () => map,
  getLastCurrentLocation: () => lastCurrentLocation,
  getLastCurrentLocationAccuracyMeters: () => lastCurrentLocationAccuracyMeters,
  getActiveRoute: () => activeRoute,
  getDataState: getDataScoringState,
  setDataState: setDataScoringState,
  getDataStatusElement: () => document.getElementById("dataStatus"),
  restaurantById,
  parkingById,
  featureCollection,
  setSourceData,
  createCirclePolygonFeature,
  maxVisibleAccuracyRadiusMeters: MAX_VISIBLE_ACCURACY_RADIUS_METERS,
  refreshHeadingConeFromState,
  setLayerVisibility,
  getShowRestaurantsChecked: () => elShowRestaurants.checked,
  getShowParkingChecked: () => elShowParking.checked,
  lngLatToObject,
  mapBoundsToAdapter,
  boundsAroundCenter,
  haversineMeters,
  closeActivePopup,
  getProbabilityLow,
  getProbabilityHigh,
  getProbabilityMid,
  formatProbabilityRange,
  formatRelativeRank,
  describeSignal,
  describePickup,
  escapeHtml,
  timeBucket,
  probabilityHorizonMinutes: PROBABILITY_HORIZON_MINUTES,
  predictionModel: PREDICTION_MODEL,
  shadowLearnedModelEnabled: SHADOW_LEARNED_MODEL,
  fetchFoodPlaces,
  fetchParkingCandidates,
  fetchResidentialAnchors,
  fetchCensusResidentialAnchors,
  fetchCurrentWeatherSignal,
  formatCensusSourceSummary,
  formatWeatherSourceSummary,
  filterOpenRestaurants,
  buildGridProbabilityHeat,
  rankParking,
  buildDemandCoverageNodes,
  selectParkingSetSubmodular,
  evaluateParkingCoverage,
  updateLabels,
  loadButton: elLoad,
  hourElement: elHour,
  tauElement: elTau,
  gridElement: elGrid,
  competitionElement: elCompetition,
  residentialWeightElement: elResidentialWeight,
  useCensusDataElement: elUseCensusData,
  censusStatusElement: elCensusStatus,
  rainBoostElement: elRainBoost,
  useLiveWeatherElement: elUseLiveWeather,
  weatherStatusElement: elWeatherStatus,
  tipEmphasisElement: elTipEmphasis,
  useMlElement: elUseML,
  mlBetaElement: elMlBeta,
  kSpotsElement: elKSpots,
  parkingListElement: elParkingList,
  summaryCardsElement: elSummaryCards,
  restaurantSourceId: SOURCE_RESTAURANTS,
  parkingSourceId: SOURCE_PARKING,
  heatSourceId: SOURCE_HEAT,
  spotSourceId: SOURCE_SPOT,
  currentLocationSourceId: SOURCE_CURRENT_LOCATION,
  currentLocationAccuracySourceId: SOURCE_CURRENT_LOCATION_ACCURACY,
  routeSourceId: SOURCE_ROUTE,
  restaurantLayerId: LAYER_RESTAURANTS,
  parkingLayerId: LAYER_PARKING,
});

routingRuntime = createRoutingRuntime({
  mapboxgl,
  getMap: () => map,
  getRoutingState,
  setRoutingState,
  getCurrentLocation: () => lastCurrentLocation,
  getHeadingRuntime: () => headingRuntime,
  lngLatToObject,
  normalizeHeadingDegrees,
  getHeadingDeltaDegrees,
  featureCollection,
  setSourceData,
  routeSourceId: SOURCE_ROUTE,
  haversineMeters,
  clamp01,
  closePlaceSheet,
  closeActivePopup,
  hasActiveRoutePopup: () => mapInteractionRuntime?.hasActiveRoutePopup() ?? false,
  syncRoutePopup: (route, options) => mapInteractionRuntime?.syncRoutePopup(route, options),
  consumeShouldOpenRoutePopupOnNextRender: () => mapInteractionRuntime?.consumeShouldOpenRoutePopupOnNextRender() ?? false,
  clearRoutePopupState: () => mapInteractionRuntime?.resetRoutePopupState(),
  setShouldOpenRoutePopupOnNextRender: (isEnabled) => mapInteractionRuntime?.setShouldOpenRoutePopupOnNextRender(isEnabled),
  setCurrentLocationState,
  syncHeadingFromLocation,
  describeGeolocationError,
  getCurrentPosition,
  getNavigationDestinationState,
  resolveNavigationDestinationState,
  getPickupFrictionDetails,
  getCompetitionPressureDetails,
  buildParkingCandidateInsights,
  getParkingCandidateLabel,
  getDirectionLabel,
  formatProbabilityDelta,
  formatProbabilityRange,
  getProbabilityLow,
  getProbabilityHigh,
  getProbabilityMid,
  describeSignal,
  osrmRouteApiUrl: OSRM_ROUTE_API_URL,
  navRerouteMinDistanceMeters: NAV_REROUTE_MIN_DISTANCE_METERS,
  navRerouteMinIntervalMs: NAV_REROUTE_MIN_INTERVAL_MS,
  arrivalCameraAutoDistanceMeters: ARRIVAL_CAMERA_AUTO_DISTANCE_METERS,
  arrivalCameraExitDistanceMeters: ARRIVAL_CAMERA_EXIT_DISTANCE_METERS,
  navigationCameraArrivalMinZoom: NAVIGATION_CAMERA_ARRIVAL_MIN_ZOOM,
  navigationCameraArrivalMaxZoom: NAVIGATION_CAMERA_ARRIVAL_MAX_ZOOM,
  navigationCameraArrivalMinPitch: NAVIGATION_CAMERA_ARRIVAL_MIN_PITCH,
  navigationCameraArrivalMaxPitch: NAVIGATION_CAMERA_ARRIVAL_MAX_PITCH,
  navigationCameraDriverMinZoom: NAVIGATION_CAMERA_DRIVER_MIN_ZOOM,
  navigationCameraDriverMaxZoom: NAVIGATION_CAMERA_DRIVER_MAX_ZOOM,
  navigationCameraDriverMinPitch: NAVIGATION_CAMERA_DRIVER_MIN_PITCH,
  navigationCameraDriverMaxPitch: NAVIGATION_CAMERA_DRIVER_MAX_PITCH,
  navigationCameraUpdateMinIntervalMs: NAVIGATION_CAMERA_UPDATE_MIN_INTERVAL_MS,
  navigationCameraMinBearingDeltaDegrees: NAVIGATION_CAMERA_MIN_BEARING_DELTA_DEGREES,
  navigationCameraMinPitchDelta: NAVIGATION_CAMERA_MIN_PITCH_DELTA,
  navigationCameraMinZoomDelta: NAVIGATION_CAMERA_MIN_ZOOM_DELTA,
  autoFollowLocationMinCenterOffsetMeters: AUTO_FOLLOW_LOCATION_MIN_CENTER_OFFSET_METERS,
  navigationRerouteDeltaMinDurationSeconds: NAVIGATION_REROUTE_DELTA_MIN_DURATION_SECONDS,
  navigationRerouteDeltaMinDistanceMeters: NAVIGATION_REROUTE_DELTA_MIN_DISTANCE_METERS,
  liveLocationWatchMaximumAgeMs: LIVE_LOCATION_WATCH_MAXIMUM_AGE_MS,
  stagingSpotMinDistanceMeters: STAGING_SPOT_MIN_DISTANCE_METERS,
  stagingSpotMaxDistanceMeters: STAGING_SPOT_MAX_DISTANCE_METERS,
  microCorridorMinDistanceMeters: MICRO_CORRIDOR_MIN_DISTANCE_METERS,
  microCorridorMaxDistanceMeters: MICRO_CORRIDOR_MAX_DISTANCE_METERS,
});

function updateCensusUi() {
  return dataScoringRuntime.updateCensusUi();
}

function updateWeatherUi() {
  return dataScoringRuntime.updateWeatherUi();
}

setHourDefaults();
updateLabels();
updateCensusUi();
updateWeatherUi();

elHour.addEventListener("input", updateLabels);
elTau.addEventListener("input", updateLabels);
elGrid.addEventListener("input", updateLabels);
elHorizon.addEventListener("input", updateLabels);
elCompetition.addEventListener("input", updateLabels);
elResidentialWeight.addEventListener("input", updateLabels);
if (elUseCensusData) {
  elUseCensusData.addEventListener("change", updateCensusUi);
}
elRainBoost.addEventListener("input", updateLabels);
if (elUseLiveWeather) {
  elUseLiveWeather.addEventListener("change", updateWeatherUi);
}
elTipEmphasis.addEventListener("input", updateLabels);
elUseML.addEventListener("change", updateLabels);
elMlBeta.addEventListener("input", updateLabels);
elKSpots.addEventListener("input", updateLabels);

elShowRestaurants.addEventListener("change", () => {
  setLayerVisibility(LAYER_RESTAURANTS_GLOW, elShowRestaurants.checked);
  setLayerVisibility(LAYER_RESTAURANTS, elShowRestaurants.checked);
});

elShowParking.addEventListener("change", () => {
  setLayerVisibility(LAYER_PARKING_GLOW, elShowParking.checked);
  setLayerVisibility(LAYER_PARKING, elShowParking.checked);
});

function checkDataFreshness() {
  return dataScoringRuntime.checkDataFreshness();
}

function syncPanelState(isOpen) {
  return mapInteractionRuntime.syncPanelState(isOpen);
}

function closePanelIfOpen() {
  return mapInteractionRuntime.closePanelIfOpen();
}

function togglePanel() {
  return mapInteractionRuntime.togglePanel();
}

mapInteractionRuntime = createMapInteractionRuntime({
  mapboxgl,
  getMap: () => map,
  getElMain: () => elMain,
  getPanel: () => panel,
  getMenuButton: () => menuButton,
  lngLatToArray,
  getActiveRoute: () => activeRoute,
  getLastCurrentLocation: () => lastCurrentLocation,
  getLastCurrentLocationAccuracyMeters: () => lastCurrentLocationAccuracyMeters,
  getNavigationVoiceEnabled: () => navigationVoiceEnabled,
  restaurantById,
  parkingById,
  renderRestaurantPopupHtml,
  renderParkingPopupHtml: (parking, name) => renderParkingPopupHtml(parking, name, lastRestaurants, lastParams.tauMeters, lastParams.hour),
  renderRoutePopupHtml,
  renderPlaceSheetHtml,
  buildRestaurantSheetState,
  buildSpotSheetState,
  buildPlaceSheetComparable,
  touchPlaceHistoryEntry,
  fetchDrivingRoute,
  startInAppNavigation,
  setNavigationStatus,
  setNavigationVoiceEnabled,
  clearInAppNavigation,
  showActiveRouteOverview,
  showActiveRouteArrivalView,
  focusActiveNavigationCamera,
  openStatsPopupAtLatLng,
  setNavigationCameraMode,
  setCurrentLocationFollowEnabled,
  setSpotMarker,
  escapeHtml,
  isTouchInteractionDevice,
  mapTouchTapPopupDelayMs: MAP_TOUCH_TAP_POPUP_DELAY_MS,
  mapTouchGestureSuppressionMs: MAP_TOUCH_GESTURE_SUPPRESSION_MS,
  layerRestaurantId: LAYER_RESTAURANTS,
  layerParkingId: LAYER_PARKING,
  layerCurrentLocationHaloId: LAYER_CURRENT_LOCATION_HALO,
  layerCurrentLocationDotId: LAYER_CURRENT_LOCATION_DOT,
});

function hasActiveRoutePopup() {
  return mapInteractionRuntime.hasActiveRoutePopup();
}

function consumeShouldOpenRoutePopupOnNextRender() {
  return mapInteractionRuntime.consumeShouldOpenRoutePopupOnNextRender();
}

function setShouldOpenRoutePopupOnNextRender(isEnabled) {
  return mapInteractionRuntime.setShouldOpenRoutePopupOnNextRender(isEnabled);
}

function clearRoutePopupState() {
  return mapInteractionRuntime.resetRoutePopupState();
}

function bindMapInteractionLayerEvents() {
  return mapInteractionRuntime.bindLayerInteractionEvents();
}

locationRuntime = createLocationRuntime({
  initialIsFollowingCurrentLocation: true,
  locateMeElement: elLocateMe,
  getMap: () => map,
  getCurrentLocation: () => lastCurrentLocation,
  getCurrentLocationAccuracyMeters: () => lastCurrentLocationAccuracyMeters,
  setCurrentLocationData(currentLngLat, accuracyRadius) {
    lastCurrentLocation = currentLngLat;
    lastCurrentLocationAccuracyMeters = accuracyRadius;
  },
  lngLatToObject,
  lngLatToArray,
  featureCollection,
  setSourceData,
  createCirclePolygonFeature,
  currentLocationSourceId: SOURCE_CURRENT_LOCATION,
  currentLocationAccuracySourceId: SOURCE_CURRENT_LOCATION_ACCURACY,
  maxVisibleAccuracyRadiusMeters: MAX_VISIBLE_ACCURACY_RADIUS_METERS,
  haversineMeters,
  hasActiveRoute: () => Boolean(activeRoute),
  syncActiveNavigationCamera,
  openPopupAtLngLat,
  closePanelIfOpen,
  refreshHeadingConeFromState,
  syncHeadingFromLocation,
  clearLocationError: () => headingRuntime?.clearLocationError(),
  notifyLocationError: (message) => headingRuntime?.notifyLocationError(message),
  alertUser: (message) => alert(message),
  currentLocationDotLayerId: LAYER_CURRENT_LOCATION_DOT,
  currentLocationHaloLayerId: LAYER_CURRENT_LOCATION_HALO,
  blueDotBaseRadiusPx: BLUE_DOT_BASE_RADIUS_PX,
  blueDotBreathingAmplitudePx: BLUE_DOT_BREATHING_AMPLITUDE_PX,
  blueDotBreathingCycleMs: BLUE_DOT_BREATHING_CYCLE_MS,
  blueDotRadiusEpsilonPx: BLUE_DOT_RADIUS_EPSILON_PX,
  blueDotHaloRadiusScale: BLUE_DOT_HALO_RADIUS_SCALE,
  fullCycleRadians: FULL_CYCLE_RADIANS,
  continuousWatchTimeoutMs: CONTINUOUS_WATCH_TIMEOUT_MS,
  liveLocationWatchMaximumAgeMs: LIVE_LOCATION_WATCH_MAXIMUM_AGE_MS,
  initialLocationTimeoutMs: INITIAL_LOCATION_TIMEOUT_MS,
  initialLocationZoom: INITIAL_LOCATION_ZOOM,
  locationTargetZoom: LOCATION_TARGET_ZOOM,
  locationAnimationMinStartZoom: LOCATION_ANIMATION_MIN_START_ZOOM,
  locationAnimationMaxDistanceMeters: LOCATION_ANIMATION_MAX_DISTANCE_METERS,
  locationFlyDurationMs: LOCATION_FLY_DURATION_MS,
  locationPanDurationSeconds: LOCATION_PAN_DURATION_SECONDS,
  locationZoomStep: LOCATION_ZOOM_STEP,
  autoFollowLocationMinCenterOffsetMeters: AUTO_FOLLOW_LOCATION_MIN_CENTER_OFFSET_METERS,
  autoFollowLocationPanDurationMs: AUTO_FOLLOW_LOCATION_PAN_DURATION_MS,
});

function setCurrentLocationFollowEnabled(isEnabled) {
  return locationRuntime.setCurrentLocationFollowEnabled(isEnabled);
}

function syncMapToCurrentLocation(latlng, options) {
  return locationRuntime.syncMapToCurrentLocation(latlng, options);
}

function syncMapBearingToHeading(heading, { force = false } = {}) {
  if (!activeRoute) {
    return;
  }

  syncActiveNavigationCamera({ heading, force, allowBearing: false });
}

headingRuntime = createHeadingRuntime({
  appBuildId: APP_BUILD_ID,
  compassDebugModeEnabled: COMPASS_DEBUG_MODE_ENABLED,
  runtimeDiagnosticsEnabled: RUNTIME_DIAGNOSTICS_ENABLED,
  allowRelativeCompassAlphaFallback: ALLOW_RELATIVE_COMPASS_ALPHA_FALLBACK,
  compassPermissionRequestTimeoutMs: COMPASS_PERMISSION_REQUEST_TIMEOUT_MS,
  compassPermissionStorageKey: COMPASS_PERMISSION_STORAGE_KEY,
  headingSensorMaxWebkitCompassAccuracyDegrees: HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
  headingSensorStaleAfterMs: HEADING_SENSOR_STALE_AFTER_MS,
  headingSensorSmoothingTimeMs: HEADING_SENSOR_SMOOTHING_TIME_MS,
  headingSensorSmoothingMinBlend: HEADING_SENSOR_SMOOTHING_MIN_BLEND,
  headingGpsFallbackSmoothingTimeMs: HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
  headingFilterSmoothingFactor: HEADING_FILTER_SMOOTHING_FACTOR,
  headingFilterDeadZoneDegrees: HEADING_FILTER_DEAD_ZONE_DEGREES,
  headingFilterMinRotationDegrees: HEADING_FILTER_MIN_ROTATION_DEGREES,
  headingRenderLoopFrameIntervalMs: HEADING_RENDER_LOOP_FRAME_INTERVAL_MS,
  headingRenderLoopMapBearingSmoothingTimeMs: HEADING_RENDER_LOOP_MAP_BEARING_SMOOTHING_TIME_MS,
  headingRenderLoopGpsSmoothingTimeMs: HEADING_RENDER_LOOP_GPS_SMOOTHING_TIME_MS,
  headingRenderLoopMinDeltaDegrees: HEADING_RENDER_LOOP_MIN_DELTA_DEGREES,
  headingRenderLoopMinLocationDeltaMeters: HEADING_RENDER_LOOP_MIN_LOCATION_DELTA_METERS,
  headingRenderLoopMinSpeedDeltaMps: HEADING_RENDER_LOOP_MIN_SPEED_DELTA_MPS,
  isTouchInteractionDevice,
  getMap: () => map,
  getMapBearing: () => {
    if (!map || typeof map.getBearing !== "function") {
      return null;
    }

    return normalizeHeadingDegrees(map.getBearing());
  },
  getMapZoom: () => (map && typeof map.getZoom === "function" ? map.getZoom() : null),
  isHeadingConeRenderTargetActive: () => Boolean(
    map
    && typeof map.getLayer === "function"
    && typeof map.getSource === "function"
    && map.getLayer(LAYER_HEADING)
    && map.getSource(SOURCE_HEADING)
  ),
  getCurrentLocation: () => lastCurrentLocation,
  getCurrentLocationAccuracyMeters: () => lastCurrentLocationAccuracyMeters,
  getIsFollowingCurrentLocation: () => locationRuntime.getIsFollowingCurrentLocation(),
  getBaseStyle: () => currentBaseStyle,
  getRouteActive: () => Boolean(activeRoute),
  getDataLoaded: () => Boolean(lastLoadedBounds && lastStats),
  lngLatToObject,
  haversineMeters,
  renderHeadingCone: updateHeadingCone,
  clearHeadingCone: clearHeadingConeVisual,
  syncMapBearingToHeading,
  searchToggleElement: elSearchToggle,
  locateMeElement: elLocateMe,
  compassPermissionStates: {
    required: COMPASS_PERMISSION_REQUIRED_STATE,
    granted: COMPASS_PERMISSION_GRANTED_STATE,
    denied: COMPASS_PERMISSION_DENIED_STATE,
    notRequired: COMPASS_PERMISSION_NOT_REQUIRED_STATE,
    unavailable: COMPASS_PERMISSION_UNAVAILABLE_STATE,
  },
});

function ensureCompassUi() {
  return headingRuntime.ensureCompassUi();
}

function installCompassPermissionAutoRequest() {
  return headingRuntime.installCompassPermissionAutoRequest();
}

function refreshHeadingConeFromState(nowMs) {
  return headingRuntime.refreshHeadingConeFromState(nowMs);
}

function syncHeadingFromLocation(latlng, gpsHeading, speed, options) {
  return headingRuntime.syncHeadingFromLocation(latlng, gpsHeading, speed, options);
}

function startHeadingConeRenderLoop() {
  return headingRuntime.startHeadingConeRenderLoop();
}

function syncHeadingConeRenderLoop() {
  return headingRuntime.syncHeadingConeRenderLoop();
}

function startDeviceOrientationWatch() {
  return headingRuntime.startDeviceOrientationWatch();
}

function installRuntimeDebugSurface() {
  return headingRuntime.installRuntimeDebugSurface({ loadForView, locateUser });
}

function suppressMapTapPopupTemporarily(durationMs = MAP_TOUCH_GESTURE_SUPPRESSION_MS) {
  return mapInteractionRuntime.suppressMapTapPopupTemporarily(durationMs);
}

function handleMapTouchStart() {
  return mapInteractionRuntime.handleMapTouchStart();
}

function scheduleMapTapPopup(lngLat) {
  return mapInteractionRuntime.scheduleMapTapPopup(lngLat);
}

function handleManualMapCameraStart(event) {
  return mapInteractionRuntime.handleManualMapCameraStart(event);
}

function handleMapBackgroundClick(event) {
  return mapInteractionRuntime.handleMapBackgroundClick(event);
}

function describeGeolocationError(error) {
  return locationRuntime.describeGeolocationError(error);
}

function showCurrentLocation(latlng, accuracyMeters) {
  const currentLngLat = locationRuntime.showCurrentLocation(latlng, accuracyMeters);
  if (activeRoute?.destination) {
    refreshActiveRouteFromOrigin(currentLngLat, { fitToRoute: false, force: true }).catch((error) => console.error(error));
  }
  return currentLngLat;
}

function getCurrentPosition(options = {}) {
  return locationRuntime.getCurrentPosition(options);
}

async function centerMapOnInitialLocationOnce() {
  return locationRuntime.centerMapOnInitialLocationOnce();
}

async function locateUser() {
  return locationRuntime.locateUser();
}

function openStatsPopupAtLatLng(latlng) {
  if (!latlng) return;

  closePanelIfOpen();
  openSpotSheet(latlng);
}

function latlngToObject(value) {
  return lngLatToObject(value);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function formatPercent(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

function getProbabilityLow(score) {
  return clamp01(score?.pGood_low ?? score?.pGood ?? 0);
}

function getProbabilityMid(score) {
  return clamp01(score?.pGood_mid ?? score?.pGood ?? 0);
}

function getProbabilityHigh(score) {
  return clamp01(score?.pGood_high ?? score?.pGood ?? 0);
}

function formatProbabilityRange(low, high) {
  return `${formatPercent(low)} - ${formatPercent(high)}`;
}

function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }

  return lo;
}

function percentileFromSorted(value, sorted) {
  if (!sorted?.length) return null;
  const rank = upperBound(sorted, value);
  return Math.round((100 * rank) / sorted.length);
}

function describeSignal(score) {
  if (score >= 0.75) return "Excellent area — strong local demand support";
  if (score >= 0.58) return "Good area — solid nearby demand";
  if (score >= 0.42) return "Decent area — moderate demand support";
  if (score >= 0.25) return "Thin area — demand support is limited";
  return "Weak area — very little nearby demand support";
}

function describePickup(distanceMeters) {
  if (distanceMeters <= 250) return `~${distanceMeters}m to nearest merchant — very quick pickup`;
  if (distanceMeters <= 500) return `~${distanceMeters}m avg pickup — short drive`;
  if (distanceMeters <= 900) return `~${distanceMeters}m avg pickup — moderate drive`;
  return `~${distanceMeters}m avg pickup — longer drive`;
}

function describeStability(score) {
  const n = Math.round(score.effectiveMerchants ?? 0);

  if (n < 1.5 || (score.stabilityWidth ?? 1) > 0.34) {
    return `Shaky — only ~${n} merchant(s) contributing, score could swing a lot`;
  }

  if (n < 3 || (score.stabilityWidth ?? 1) > 0.24) {
    return `Somewhat reliable — ~${n} merchants, but still limited`;
  }

  if (n < 6 || (score.stabilityWidth ?? 1) > 0.16) {
    return `Fairly stable — ~${n} merchants backing this score`;
  }

  return `Very stable — ~${n} merchants, score is well-supported`;
}

function formatRelativeRank(score) {
  const percentile = percentileFromSorted(getProbabilityMid(score), lastStats?.scoreSamplesSorted);
  if (percentile === null) return "Rank unavailable — load data first";
  if (percentile >= 90) return `Top ${100 - percentile}% — one of the best spots on the map`;
  if (percentile >= 70) return `Better than ${percentile}% of spots — above average`;
  if (percentile >= 40) return `Middle of the pack — ${percentile}% ranked lower`;
  return `Bottom half — only ${percentile}% of spots score lower`;
}

function describeAdvisory(advisory) {
  return advisory === "hold"
    ? "✅ Hold — worth waiting here"
    : "↻ Rotate — try a different spot";
}

function describeProbabilityBand(score) {
  const merchantCount = Math.round(score?.effectiveMerchants ?? 0);
  const width = Math.max(0, getProbabilityHigh(score) - getProbabilityLow(score));

  if (merchantCount < 2 || width >= 0.28) {
    return `Wide range — limited support behind this estimate (about ${merchantCount} effective merchants).`;
  }

  if (merchantCount < 4 || width >= 0.18) {
    return "Moderate range — the estimate has some support, but conditions can still move it.";
  }

  return "Tighter range — the visible merchant field is giving a steadier estimate.";
}

function renderExplainabilityDetails(score) {
  const explain = score?.explain ?? {};
  return [
    explain.merchantShare,
    explain.residentialShare,
    explain.relativeIntensity,
    explain.rainLiftPercent,
  ]
    .filter(Boolean)
    .map((text) => `<div class="popup-detail">${escapeHtml(text)}</div>`)
    .join("");
}

function renderSignalBarsHtml(signals, bucketLabel) {
  const bars = [
    { key: "I", label: "Avg ticket size", tip: "How expensive nearby restaurants tend to be (correlates with tips)", value: signals.I, color: "#7fe8b0" },
    { key: "M", label: "Restaurant density", tip: "How many restaurants are within range", value: signals.M, color: "#9ad3ff" },
    { key: "R", label: "Proximity", tip: "How close the nearest merchants are", value: signals.R, color: "#c4b5fd" },
    { key: "D", label: "Crowding (bad)", tip: "How many other parking spots are nearby (more = more competition)", value: signals.D, color: "#f87171" },
  ];

  const rows = bars.map(b =>
    `<div class="sig-row" title="${escapeHtml(b.tip)}"><span class="sig-label">${b.label}</span><span class="sig-track"><span class="sig-fill" style="width:${Math.round(b.value * 100)}%;background:${b.color}"></span></span><span class="sig-val">${Math.round(b.value * 100)}%</span></div>`
  ).join("");

  return `<div class="sig-bars"><div class="sig-header">What makes this spot score the way it does (${escapeHtml(bucketLabel)})</div>${rows}</div>`;
}

function renderParkingPopupHtml(p, name, restaurants, tauMeters, hour) {
  const likely = topLikelyMerchantsForParking(p, restaurants, tauMeters, hour, POPUP_NEARBY_RESTAURANT_LIMIT);
  const bucketLabel = lastStats?.timeBucketLabel ?? timeBucket(hour).label;

  return `
<div class="popup-sheet popup-friendly">
  <div class="popup-header">
    <div class="popup-kicker">Parking</div>
    <div class="popup-title">${escapeHtml(name)}</div>
    <div class="popup-subtitle">${escapeHtml(describeSignal(getProbabilityMid(p)))}</div>
  </div>

  <div class="popup-score">${formatProbabilityRange(getProbabilityLow(p), getProbabilityHigh(p))}<span class="popup-score-label"> 10-minute probability of a good order</span></div>
  <div class="popup-explain">${escapeHtml(formatRelativeRank(p))}</div>

  ${renderPopupMetricGrid([
    renderPopupMetricCard("Rank", formatCompactRank(p), formatRelativeRank(p)),
    renderPopupMetricCard("Pickup", formatRouteDistance(p.expectedDistMeters), describePickup(p.expectedDistMeters)),
    renderPopupMetricCard("Stability", `${Math.round(p.effectiveMerchants ?? 0)} merchants`, describeStability(p)),
  ])}

  ${renderPopupActions([
    renderPopupActionButton(p.lat, p.lon, "Route here", name, "popup-action--primary"),
  ])}

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">Why this spot rates well</div>
      <div class="popup-section-meta">${escapeHtml(bucketLabel)}</div>
    </div>
    <div class="popup-detail">Uncertainty band (λ ±30%): ${formatProbabilityRange(getProbabilityLow(p), getProbabilityHigh(p))} · ${escapeHtml(describeProbabilityBand(p))}</div>
    <div class="popup-detail">${escapeHtml(describePickup(p.expectedDistMeters))}</div>
    ${renderExplainabilityDetails(p)}
    ${renderSignalBarsHtml(p.signals, bucketLabel)}
  </section>

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">Closest restaurants</div>
      <div class="popup-section-meta">Top ${likely.length}</div>
    </div>
    ${renderNearbyRestaurantsList(likely)}
  </section>
</div>
`;
}

function renderSpotPopupHtml(latlng, restaurants, tauMeters, hour) {
  const r = getPopupPointScore(latlng, restaurants, tauMeters, hour);

  const likely = topLikelyMerchantsForParking(
    { lat: latlng.lat, lon: latlng.lng, tags: { name: "Selected spot" } },
    restaurants,
    tauMeters,
    hour,
    POPUP_NEARBY_RESTAURANT_LIMIT
  );
  const bucketLabel = lastStats?.timeBucketLabel ?? timeBucket(hour).label;
  const warning = lastStats === null
    ? '<div class="popup-banner popup-banner--warn">Load or refresh the current view to calibrate this stat ping against the visible field.</div>'
    : "";

  return `
<div class="popup-sheet popup-friendly">
  <div class="popup-header">
    <div class="popup-kicker">Stat ping</div>
    <div class="popup-title">Selected spot</div>
    <div class="popup-subtitle">${escapeHtml(describeSignal(getProbabilityMid(r)))} for the next 10 minutes</div>
  </div>

  ${warning}
  <div class="popup-score">${formatProbabilityRange(getProbabilityLow(r), getProbabilityHigh(r))}<span class="popup-score-label"> chance of landing a strong order soon</span></div>
  <div class="popup-explain">${escapeHtml(describeAdvisory(r.advisory))}</div>

  ${renderPopupMetricGrid([
    renderPopupMetricCard("Field rank", formatCompactRank(r), formatRelativeRank(r)),
    renderPopupMetricCard("Avg pickup", formatRouteDistance(r.expectedDistMeters), describePickup(r.expectedDistMeters)),
    renderPopupMetricCard("Nearby support", `${Math.round(r.effectiveMerchants ?? 0)} merchants`, describeStability(r)),
  ])}

  ${renderPopupActions([
    renderPopupActionButton(latlng.lat, latlng.lng, "Route here", "Selected spot", "popup-action--primary"),
  ])}

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">How DGM reads this spot</div>
      <div class="popup-section-meta">${escapeHtml(bucketLabel)}</div>
    </div>
    <div class="popup-detail">Expected range this hour: ${formatProbabilityRange(getProbabilityLow(r), getProbabilityHigh(r))} · ${escapeHtml(describeProbabilityBand(r))}</div>
    <div class="popup-detail">Pickup read: ${escapeHtml(describePickup(r.expectedDistMeters))}</div>
    ${renderExplainabilityDetails(r)}
    ${renderSignalBarsHtml(r.signals, bucketLabel)}
  </section>

  <section class="popup-section">
    <div class="popup-section-head">
      <div class="popup-section-title">Closest restaurants</div>
      <div class="popup-section-meta">Top ${likely.length}</div>
    </div>
    ${renderNearbyRestaurantsList(likely)}
  </section>
</div>
`;
}

function buildRestaurantSheetState(restaurant) {
  const tags = restaurant?.tags ?? {};
  const name = getPlaceDisplayName(restaurant);
  const amenityLabel = getPlaceAmenityLabel(tags);
  const cuisineLabels = getRestaurantCuisineLabels(tags);
  const serviceLabels = getRestaurantServiceLabels(tags);
  const address = getPlaceAddress(tags);
  const openingHours = formatOpeningHoursText(tags?.opening_hours);
  const phoneNumber = getPlacePhoneNumber(tags);
  const websiteUrl = getPlaceWebsiteUrl(tags);
  const score = lastStats
    ? getPopupPointScore({ lat: restaurant.lat, lon: restaurant.lon }, lastRestaurants, lastParams.tauMeters, lastParams.hour)
    : null;

  return {
    kind: "restaurant",
    key: `restaurant:${restaurant.id}`,
    title: name,
    subtitle: [amenityLabel, cuisineLabels[0] || null].filter(Boolean).join(" · "),
    lat: restaurant.lat,
    lng: restaurant.lon,
    tags,
    score,
    chips: [...cuisineLabels, ...serviceLabels],
    amenityLabel,
    address,
    openingHours,
    phoneNumber,
    websiteUrl,
    currentDistance: getDistanceFromCurrentLocation(restaurant.lat, restaurant.lon),
    likely: topLikelyMerchantsForParking(restaurant, lastRestaurants, lastParams.tauMeters, lastParams.hour, POPUP_NEARBY_RESTAURANT_LIMIT),
  };
}

function buildSpotSheetState(latlng) {
  const point = latlngToObject(latlng);
  const score = getPopupPointScore(point, lastRestaurants, lastParams.tauMeters, lastParams.hour);

  return {
    kind: "spot",
    key: `spot:${point.lat.toFixed(5)}:${point.lng.toFixed(5)}`,
    title: "Selected spot",
    subtitle: score ? describeSignal(getProbabilityMid(score)) : "Custom field analysis",
    lat: point.lat,
    lng: point.lng,
    tags: {},
    score,
    chips: ["Stat ping", "10-minute read"],
    currentDistance: getDistanceFromCurrentLocation(point.lat, point.lng),
    likely: topLikelyMerchantsForParking(
      { lat: point.lat, lon: point.lng, tags: { name: "Selected spot" } },
      lastRestaurants,
      lastParams.tauMeters,
      lastParams.hour,
      POPUP_NEARBY_RESTAURANT_LIMIT
    ),
    warning: lastStats === null
      ? "Load or refresh the current view to calibrate this stat ping against the visible field."
      : "",
  };
}

function buildPlaceSheetComparable(state) {
  return {
    key: state.key,
    kind: state.kind,
    title: state.title,
    subtitle: state.subtitle,
    lat: state.lat,
    lng: state.lng,
    score: state.score,
    tags: state.tags ?? {},
    currentDistance: state.currentDistance || getDistanceFromCurrentLocation(state.lat, state.lng),
    routeSummary: state.routeSummary ?? null,
    routeStatus: state.routeStatus || (state.routeSummary ? "ready" : "unavailable"),
    routeError: state.routeError || "",
    history: state.history || getPlaceHistoryEntry(state.key),
  };
}

function findBestNearbyParkingCandidate(lat, lng, maxDistanceMeters = 550) {
  return Array.from(parkingById.values())
    .map((candidate) => ({
      candidate,
      distanceMeters: Math.round(haversineMeters(lat, lng, candidate.lat, candidate.lon)),
    }))
    .filter(({ distanceMeters }) => distanceMeters <= maxDistanceMeters)
    .sort((left, right) => {
      const byScore = getProbabilityMid(right.candidate) - getProbabilityMid(left.candidate);
      if (Math.abs(byScore) > 0.0001) {
        return byScore;
      }
      return left.distanceMeters - right.distanceMeters;
    })[0] ?? null;
}

function describeDemandMixCard(score) {
  const merchantShare = clamp01(score?.merchantShare ?? 0);
  const residentialShare = clamp01(score?.residentialShare ?? 0);

  if (merchantShare >= 0.68) {
    return {
      value: "Merchant-led",
      detail: `${formatPercent(merchantShare)} of the field is coming from nearby restaurants right now.`,
    };
  }

  if (residentialShare >= 0.42) {
    return {
      value: "Residential cushion",
      detail: `${formatPercent(residentialShare)} of the field is home-driven, which usually smooths out spikes.`,
    };
  }

  return {
    value: "Balanced mix",
    detail: `${formatPercent(merchantShare)} merchant pull and ${formatPercent(residentialShare)} residential support are both contributing.`,
  };
}

function describeCrowdingCard(score) {
  const crowding = clamp01(score?.signals?.D ?? score?.competitionIntensity ?? 0);

  if (crowding >= 0.7) {
    return {
      value: "Heavy",
      detail: "Parking density is high here, so the score is fighting more likely driver competition.",
    };
  }

  if (crowding >= 0.45) {
    return {
      value: "Moderate",
      detail: "There is some competition pressure nearby, but it is not overwhelming the field.",
    };
  }

  return {
    value: "Light",
    detail: "Competition pressure is relatively low around this spot right now.",
  };
}

function describeSupportDepthCard(score) {
  const merchants = Math.round(score?.effectiveMerchants ?? 0);

  if (merchants >= 6 && (score?.stabilityWidth ?? 1) <= 0.16) {
    return {
      value: `${merchants} merchants`,
      detail: "This read is well-supported by a deeper nearby merchant field.",
    };
  }

  if (merchants >= 3) {
    return {
      value: `${merchants} merchants`,
      detail: "There is enough nearby support to trust the signal, but it can still swing.",
    };
  }

  return {
    value: `${merchants} merchants`,
    detail: "This read is thin. A couple of store changes could move it quickly.",
  };
}

function formatRouteSummaryValue(routeSummary, routeStatus) {
  if (routeStatus === "loading") return "Calculating";
  if (routeStatus === "unavailable") return "Need location";
  if (routeStatus === "error") return "Unavailable";
  if (!routeSummary) return "Unavailable";
  return formatRouteDuration(routeSummary.durationSeconds);
}

function formatRouteSummaryDetail(routeSummary, routeStatus, routeError = "") {
  if (routeStatus === "loading") return "Fetching drive time from your current location.";
  if (routeStatus === "unavailable") return "Turn on location to estimate drive time.";
  if (routeStatus === "error") return routeError || "No drivable route was returned for this place.";
  if (!routeSummary) return "Route summary unavailable.";
  return `${formatRouteDistance(routeSummary.distanceMeters)} drive distance`;
}

function renderRouteMetricCard(subject) {
  return renderPopupMetricCard(
    "Drive",
    formatRouteSummaryValue(subject?.routeSummary, subject?.routeStatus),
    formatRouteSummaryDetail(subject?.routeSummary, subject?.routeStatus, subject?.routeError)
  );
}

function getDirectionLabel(fromLatLng, toLatLng) {
  const dy = Number(toLatLng?.lat ?? 0) - Number(fromLatLng?.lat ?? 0);
  const avgLatRad = (((Number(fromLatLng?.lat ?? 0) + Number(toLatLng?.lat ?? 0)) / 2) * Math.PI) / 180;
  const dx = (Number(toLatLng?.lng ?? 0) - Number(fromLatLng?.lng ?? 0)) * Math.cos(avgLatRad);
  const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
  const normalized = (angle + 360) % 360;
  const directions = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return directions[Math.round(normalized / 45) % directions.length];
}

function getParkingCandidateLabel(candidate) {
  return candidate?.tags?.name || candidate?.tags?.operator || "Visible parking";
}

function formatProbabilityDelta(delta) {
  if (!Number.isFinite(delta)) {
    return "score delta unavailable";
  }

  const deltaPoints = Math.round(Math.abs(delta) * 100);
  if (deltaPoints === 0) {
    return "field is effectively tied";
  }

  return `${delta > 0 ? "+" : "-"}${deltaPoints} pts versus here`;
}

function getParkingSuitabilityScore(candidate, anchorDistanceMeters = 0) {
  const fieldStrength = getProbabilityMid(candidate);
  const competitionRelief = 1 - clamp01(candidate?.signals?.D ?? candidate?.competitionIntensity ?? 0);
  const stability = 1 - clamp01((candidate?.stabilityWidth ?? 0.18) / 0.35);
  const distanceEase = 1 - clamp01(anchorDistanceMeters / STAGING_SPOT_MAX_DISTANCE_METERS);
  return clamp01(0.46 * fieldStrength + 0.22 * competitionRelief + 0.18 * stability + 0.14 * distanceEase);
}

function findNearestRankedParkingCandidate(lat, lng, maxDistanceMeters = 480) {
  return lastRankedParkingAll
    .map((candidate) => ({
      candidate,
      distanceMeters: Math.round(haversineMeters(lat, lng, candidate.lat, candidate.lon)),
    }))
    .filter(({ distanceMeters }) => distanceMeters <= maxDistanceMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters)[0] ?? null;
}

function getPickupFrictionDetails(state) {
  if (!state?.score) {
    return null;
  }

  const nearestParking = findNearestRankedParkingCandidate(state.lat, state.lng);
  const pickupDistanceFactor = clamp01(((state.score.expectedDistMeters ?? 0) - 120) / 700);
  const crowdFactor = clamp01(state.score?.signals?.D ?? state.score?.competitionIntensity ?? 0);
  const parkingFactor = nearestParking ? clamp01(nearestParking.distanceMeters / 360) : 1;
  const tags = state.tags ?? {};
  let serviceEase = 0;
  if (tags.drive_through === "yes") serviceEase += 0.18;
  if (tags.takeaway === "yes" || tags.takeaway === "only") serviceEase += 0.12;
  if (tags.delivery === "yes" || tags.delivery === "only") serviceEase += 0.08;

  const friction = clamp01(0.46 * pickupDistanceFactor + 0.32 * crowdFactor + 0.22 * parkingFactor - serviceEase);
  let label = "Easy";
  if (friction >= 0.72) {
    label = "High friction";
  } else if (friction >= 0.5) {
    label = "Sticky";
  } else if (friction >= 0.28) {
    label = "Manageable";
  }

  const parkingText = nearestParking
    ? `${nearestParking.distanceMeters} m to the nearest visible parking option.`
    : "No visible parking option is currently loaded around this place.";

  return {
    score: friction,
    value: `${Math.round(friction * 100)}/100`,
    label,
    detail: `${parkingText} ${describePickup(state.score.expectedDistMeters)}`,
    nearestParking,
  };
}

function getCompetitionPressureDetails(score) {
  if (!score) {
    return null;
  }

  const crowding = clamp01(score?.signals?.D ?? score?.competitionIntensity ?? 0);
  const density = clamp01((score?.nearbyMerchants ?? score?.effectiveMerchants ?? 0) / 8);
  const pressure = clamp01(0.68 * crowding + 0.32 * density);
  let label = "Low";
  if (pressure >= 0.72) {
    label = "High";
  } else if (pressure >= 0.42) {
    label = "Moderate";
  }

  return {
    score: pressure,
    value: `${Math.round(pressure * 100)}/100`,
    label,
    detail: label === "High"
      ? "This field is crowded enough that waiting discipline matters more than raw merchant count."
      : label === "Moderate"
        ? "Competition is present, but the spot is still carrying enough support to be usable."
        : "Competition pressure is relatively calm here right now.",
  };
}

function buildParkingCandidateInsights(
  state,
  { minDistanceMeters = STAGING_SPOT_MIN_DISTANCE_METERS, maxDistanceMeters = STAGING_SPOT_MAX_DISTANCE_METERS, limit = 3 } = {}
) {
  if (!state?.score || !lastRankedParkingAll.length) {
    return [];
  }

  return lastRankedParkingAll
    .map((candidate) => {
      const distanceMeters = Math.round(haversineMeters(state.lat, state.lng, candidate.lat, candidate.lon));
      const suitability = getParkingSuitabilityScore(candidate, distanceMeters);
      const probabilityDelta = getProbabilityMid(candidate) - getProbabilityMid(state.score);
      return {
        candidate,
        distanceMeters,
        suitability,
        probabilityDelta,
        direction: getDirectionLabel(state, { lat: candidate.lat, lng: candidate.lon }),
      };
    })
    .filter(({ distanceMeters }) => distanceMeters >= minDistanceMeters && distanceMeters <= maxDistanceMeters)
    .sort((left, right) => {
      if (Math.abs(right.suitability - left.suitability) > 0.0001) {
        return right.suitability - left.suitability;
      }
      return right.probabilityDelta - left.probabilityDelta;
    })
    .slice(0, limit);
}

function renderParkingCandidateInsightList(items, emptyMessage) {
  if (!items.length) {
    return `<div class="popup-empty">${escapeHtml(emptyMessage)}</div>`;
  }

  return `
    <div class="popup-nearby-list">
      ${items.map((item, index) => `
        <article class="popup-nearby-item">
          <div class="popup-nearby-rank">${index + 1}</div>
          <div class="popup-nearby-copy">
            <div class="popup-nearby-name">${escapeHtml(getParkingCandidateLabel(item.candidate))}</div>
            <div class="popup-nearby-meta">${escapeHtml(`${item.distanceMeters} m ${item.direction} · suitability ${Math.round(item.suitability * 100)}/100`)}</div>
            <div class="popup-nearby-meta">${escapeHtml(`${formatProbabilityRange(getProbabilityLow(item.candidate), getProbabilityHigh(item.candidate))} · ${formatProbabilityDelta(item.probabilityDelta)}`)}</div>
          </div>
        </article>`).join("")}
    </div>`;
}

function renderPlaceSheetHistorySection(state) {
  const history = state.history || getPlaceHistoryEntry(state.key);
  const familiarity = describeFamiliarityEntry(history);

  return `
    <div class="popup-banner popup-banner--accent">Stored locally only. DGM uses this history for clarity and familiarity, not for prediction.</div>
    ${renderPopupMetricGrid([
      renderPopupMetricCard("Familiarity", familiarity.label, familiarity.detail),
      renderPopupMetricCard("Opens", `${Number(history?.openCount || 0)}`, `Last viewed ${formatRelativeTimestamp(history?.lastOpenedAt)}`),
      renderPopupMetricCard("Routes", `${Number(history?.routeCount || 0)}`, history?.lastRouteAt ? `Last routed ${formatRelativeTimestamp(history.lastRouteAt)}` : "You have not launched navigation from here yet."),
    ])}
    ${renderPopupFactRows([
      { label: "First seen", value: formatRelativeTimestamp(history?.firstSeenAt) },
      { label: "Last opened", value: formatRelativeTimestamp(history?.lastOpenedAt) },
      { label: "Last routed", value: formatRelativeTimestamp(history?.lastRouteAt) },
    ])}`;
}

function renderPlaceSheetCompareButton(state, compareBaseline) {
  const buttonLabel = compareBaseline?.key === state.key
    ? "Pick second place"
    : compareBaseline
      ? "Replace baseline"
      : "Start compare";

  return `<button type="button" class="popup-action popup-action--secondary" data-place-sheet-compare="set">${escapeHtml(buttonLabel)}</button>`;
}

function renderPlaceSheetHero(state) {
  if (!state.score) {
    return `
      <div class="place-sheet-hero place-sheet-hero--empty">
        <div class="place-sheet-hero-value">Field refresh needed</div>
        <div class="place-sheet-hero-label">Load or refresh the current view to calibrate this location against the live map.</div>
      </div>`;
  }

  return `
    <div class="place-sheet-hero">
      <div class="place-sheet-hero-value">${formatProbabilityRange(getProbabilityLow(state.score), getProbabilityHigh(state.score))}</div>
      <div class="place-sheet-hero-label">${escapeHtml(state.kind === "restaurant" ? "Nearby 10-minute field" : "10-minute probability of a good order")}</div>
      <div class="place-sheet-hero-detail">${escapeHtml(state.kind === "restaurant" ? formatRelativeRank(state.score) : describeAdvisory(state.score.advisory))}</div>
    </div>`;
}

function renderPlaceSheetOverviewSection(state, compareBaseline) {
  if (state.kind === "restaurant") {
    return `
      ${renderPopupMetricGrid([
        state.currentDistance ? renderPopupMetricCard("From you", state.currentDistance, "Straight-line distance") : "",
        renderRouteMetricCard(state),
        state.score ? renderPopupMetricCard("Nearby field", formatProbabilityRange(getProbabilityLow(state.score), getProbabilityHigh(state.score)), "10-minute hold strength") : "",
        state.websiteUrl
          ? renderPopupMetricCard("Website", getWebsiteDisplayLabel(state.websiteUrl), "Official source")
          : state.openingHours
            ? renderPopupMetricCard("Hours", "Listed", "See the overview below")
            : "",
      ])}

      ${renderPopupActions([
        renderPopupActionButton(state.lat, state.lng, "Route here", state.title, "popup-action--primary"),
        renderPlaceSheetCompareButton(state, compareBaseline),
        state.websiteUrl ? renderPopupActionLink(state.websiteUrl, "Website") : "",
        renderPopupActionLink(buildPlaceSearchUrl(`${state.title} menu`), "Menu"),
        renderPopupActionLink(buildPlaceSearchUrl(`${state.title} reviews`), "Reviews"),
        state.phoneNumber ? renderPopupActionLink(`tel:${encodeURIComponent(state.phoneNumber)}`, "Call", { className: "popup-action--secondary", newTab: false }) : "",
      ])}

      ${renderPopupFactRows([
        state.address ? { label: "Address", value: state.address } : null,
        state.openingHours ? { label: "Hours", value: state.openingHours } : null,
        state.phoneNumber ? { label: "Phone", value: state.phoneNumber, href: `tel:${encodeURIComponent(state.phoneNumber)}`, newTab: false } : null,
        state.websiteUrl ? { label: "Website", value: getWebsiteDisplayLabel(state.websiteUrl), href: state.websiteUrl } : null,
      ])}`;
  }

  return `
    ${state.warning ? `<div class="popup-banner popup-banner--warn">${escapeHtml(state.warning)}</div>` : ""}
    ${renderPopupMetricGrid([
      state.score ? renderPopupMetricCard("Rank", formatCompactRank(state.score), formatRelativeRank(state.score)) : "",
      renderRouteMetricCard(state),
      state.score ? renderPopupMetricCard("Pickup", formatRouteDistance(state.score.expectedDistMeters), describePickup(state.score.expectedDistMeters)) : "",
      state.score ? renderPopupMetricCard("Stability", `${Math.round(state.score.effectiveMerchants ?? 0)} merchants`, describeStability(state.score)) : "",
      state.currentDistance ? renderPopupMetricCard("From you", state.currentDistance, "Straight-line distance") : "",
    ])}

    ${renderPopupActions([
      renderPopupActionButton(state.lat, state.lng, "Route here", state.title, "popup-action--primary"),
      renderPlaceSheetCompareButton(state, compareBaseline),
    ])}

    ${renderPopupFactRows([
      { label: "Coordinates", value: `${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}` },
      { label: "Visible restaurants", value: `${lastRestaurants.length}` },
      { label: "Model window", value: `${PROBABILITY_HORIZON_MINUTES} minutes` },
    ])}`;
}

function renderPlaceSheetDgmSection(state) {
  if (!state.score) {
    return '<div class="popup-empty">Refresh the current view to unlock DGM-only field intelligence for this place.</div>';
  }

  const demandMix = describeDemandMixCard(state.score);
  const crowding = describeCrowdingCard(state.score);
  const supportDepth = describeSupportDepthCard(state.score);
  const nearbyHold = findBestNearbyParkingCandidate(state.lat, state.lng);
  const nearbyHoldCard = nearbyHold
    ? renderPopupMetricCard(
      "Best nearby hold",
      nearbyHold.candidate.tags?.name || nearbyHold.candidate.tags?.operator || "Visible parking",
      `${nearbyHold.distanceMeters} m away · ${formatProbabilityRange(getProbabilityLow(nearbyHold.candidate), getProbabilityHigh(nearbyHold.candidate))}`
    )
    : renderPopupMetricCard("Best nearby hold", "None visible", "Zoom or refresh to expose visible parking candidates nearby.");

  return `
    ${renderPopupMetricGrid([
      renderPopupMetricCard(
        "Wait bias",
        state.score.advisory === "hold" ? "Wait here" : "Rotate soon",
        state.kind === "restaurant" ? "Restaurant-centered field read" : "Spot-centered field read"
      ),
      renderPopupMetricCard("Support depth", supportDepth.value, supportDepth.detail),
      renderPopupMetricCard("Demand mix", demandMix.value, demandMix.detail),
      renderPopupMetricCard("Crowding", crowding.value, crowding.detail),
      nearbyHoldCard,
    ])}

    <div class="popup-detail">Uncertainty band (λ ±30%): ${formatProbabilityRange(getProbabilityLow(state.score), getProbabilityHigh(state.score))} · ${escapeHtml(describeProbabilityBand(state.score))}</div>
    <div class="popup-detail">${escapeHtml(describePickup(state.score.expectedDistMeters))}</div>
    ${renderExplainabilityDetails(state.score)}
    ${renderSignalBarsHtml(state.score.signals, lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label)}`;
}

function renderPlaceSheetParkingSection(state) {
  if (!state.score) {
    return '<div class="popup-empty">Refresh the current view to unlock parking and staging analysis.</div>';
  }

  const pickupFriction = getPickupFrictionDetails(state);
  const nearestParking = pickupFriction?.nearestParking;
  const stagingCandidates = buildParkingCandidateInsights(state, {
    minDistanceMeters: STAGING_SPOT_MIN_DISTANCE_METERS,
    maxDistanceMeters: STAGING_SPOT_MAX_DISTANCE_METERS,
    limit: 3,
  });
  const bestStaging = stagingCandidates[0] || null;

  return `
    ${renderPopupMetricGrid([
      pickupFriction ? renderPopupMetricCard("Pickup friction", pickupFriction.label, `${pickupFriction.value} · ${pickupFriction.detail}`) : "",
      nearestParking
        ? renderPopupMetricCard("Nearest parking", `${nearestParking.distanceMeters} m`, getParkingCandidateLabel(nearestParking.candidate))
        : renderPopupMetricCard("Nearest parking", "Not visible", "Zoom or refresh to expose nearby parking candidates."),
      bestStaging
        ? renderPopupMetricCard(
          "Best staging hold",
          getParkingCandidateLabel(bestStaging.candidate),
          `${bestStaging.distanceMeters} m ${bestStaging.direction} · suitability ${Math.round(bestStaging.suitability * 100)}/100`
        )
        : renderPopupMetricCard("Best staging hold", "Not visible", "No scored hold was found in the 0.2–0.5 mile band."),
    ])}
    ${renderParkingCandidateInsightList(
      stagingCandidates,
      "No scored staging hold is currently visible in the 0.2–0.5 mile band around this place."
    )}`;
}

function renderPlaceSheetCompetitionSection(state) {
  if (!state.score) {
    return '<div class="popup-empty">Refresh the current view to unlock competition pressure and stability analysis.</div>';
  }

  const pressure = getCompetitionPressureDetails(state.score);
  const supportDepth = describeSupportDepthCard(state.score);
  const crowding = describeCrowdingCard(state.score);

  return `
    ${renderPopupMetricGrid([
      pressure ? renderPopupMetricCard("Pressure index", pressure.label, `${pressure.value} · ${pressure.detail}`) : "",
      renderPopupMetricCard("Support depth", supportDepth.value, supportDepth.detail),
      renderPopupMetricCard("Crowding", crowding.value, crowding.detail),
    ])}
    <div class="popup-detail">${escapeHtml(describeProbabilityBand(state.score))}</div>
    ${renderSignalBarsHtml(state.score.signals, lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label)}`;
}

function renderPlaceSheetAlternativesSection(state) {
  const microCorridors = buildParkingCandidateInsights(state, {
    minDistanceMeters: MICRO_CORRIDOR_MIN_DISTANCE_METERS,
    maxDistanceMeters: MICRO_CORRIDOR_MAX_DISTANCE_METERS,
    limit: 3,
  });
  const merchantAlternatives = (state.likely || []).slice(0, 4);

  return `
    <div class="popup-banner">Micro-corridor suggestions are short shifts in position that can improve stability, access, or staging quality without copying any proprietary routing behavior.</div>
    ${renderParkingCandidateInsightList(
      microCorridors,
      "No short-shift micro-corridor improvement is currently visible around this place."
    )}
    <section class="popup-section">
      <div class="popup-section-head">
        <div class="popup-section-title">Nearby merchants</div>
        <div class="popup-section-meta">Top ${merchantAlternatives.length || 0}</div>
      </div>
      ${renderNearbyRestaurantsList(merchantAlternatives)}
    </section>`;
}

function renderPlaceSheetComparisonCard(subject, label, isWinner = false) {
  const pickupFriction = getPickupFrictionDetails(subject);
  return `
    <article class="place-sheet-compare-card${isWinner ? ' is-winner' : ''}">
      <div class="place-sheet-compare-label">${escapeHtml(label)}</div>
      <div class="place-sheet-compare-title">${escapeHtml(subject.title)}</div>
      ${subject.subtitle ? `<div class="place-sheet-compare-subtitle">${escapeHtml(subject.subtitle)}</div>` : ""}
      <div class="place-sheet-compare-range">${subject.score ? formatProbabilityRange(getProbabilityLow(subject.score), getProbabilityHigh(subject.score)) : "Unavailable"}</div>
      <div class="place-sheet-compare-detail">${escapeHtml(subject.score ? describeSignal(getProbabilityMid(subject.score)) : "Refresh the current view to score this place.")}</div>
      ${subject.currentDistance ? `<div class="place-sheet-compare-meta">From you: ${escapeHtml(subject.currentDistance)}</div>` : ""}
      <div class="place-sheet-compare-meta">Drive: ${escapeHtml(formatRouteSummaryValue(subject.routeSummary, subject.routeStatus))}${subject.routeSummary ? ` · ${escapeHtml(formatRouteDistance(subject.routeSummary.distanceMeters))}` : ""}</div>
      ${subject.score ? `<div class="place-sheet-compare-meta">Pickup: ${escapeHtml(describePickup(subject.score.expectedDistMeters))}</div>` : ""}
      ${pickupFriction ? `<div class="place-sheet-compare-meta">Friction: ${escapeHtml(`${pickupFriction.label} (${pickupFriction.value})`)}</div>` : ""}
    </article>`;
}

function getPlaceSheetComparisonSummary(current, baseline) {
  if (!current.score || !baseline.score) {
    return `${current.title} and ${baseline.title} are saved for comparison. Refresh the current view to unlock the full score read.`;
  }

  if (current.routeSummary && baseline.routeSummary) {
    const routeDeltaMinutes = Math.round((current.routeSummary.durationSeconds - baseline.routeSummary.durationSeconds) / 60);
    if (Math.abs(routeDeltaMinutes) >= 2) {
      const faster = routeDeltaMinutes < 0 ? current : baseline;
      const slower = routeDeltaMinutes < 0 ? baseline : current;
      return `${faster.title} is about ${Math.abs(routeDeltaMinutes)} min faster to drive than ${slower.title} from your current position.`;
    }
  }

  const delta = getProbabilityMid(current.score) - getProbabilityMid(baseline.score);
  const deltaPoints = Math.round(Math.abs(delta) * 100);

  if (deltaPoints < 4) {
    const pickupDelta = (baseline.score.expectedDistMeters ?? 0) - (current.score.expectedDistMeters ?? 0);
    if (Math.abs(pickupDelta) >= 120) {
      const faster = pickupDelta > 0 ? current : baseline;
      return `${current.title} and ${baseline.title} are close on raw score. ${faster.title} has the quicker pickup field right now.`;
    }
    return `${current.title} and ${baseline.title} are close on raw field score. Use pickup speed and route convenience to break the tie.`;
  }

  const winner = delta > 0 ? current : baseline;
  const loser = delta > 0 ? baseline : current;
  return `${winner.title} projects about ${deltaPoints} points stronger than ${loser.title} on the current 10-minute field.`;
}

function renderPlaceSheetCompareSection(state, compareBaseline) {
  if (!compareBaseline) {
    return `
      <div class="popup-empty">Save this place as your baseline, then tap any other restaurant dot or stat ping to compare them side by side.</div>
      ${renderPopupActions([renderPlaceSheetCompareButton(state, compareBaseline)])}`;
  }

  const current = buildPlaceSheetComparable(state);
  if (compareBaseline.key === current.key) {
    return `
      <div class="popup-banner">Baseline locked on ${escapeHtml(current.title)}. Tap another restaurant dot or stat ping on the map to complete the comparison.</div>
      <div class="place-sheet-compare-grid">
        ${renderPlaceSheetComparisonCard(compareBaseline, "Baseline")}
      </div>
      ${renderPopupActions([
        '<button type="button" class="popup-action popup-action--secondary" data-place-sheet-compare="clear">Clear baseline</button>',
      ])}`;
  }

  const baselineMid = getProbabilityMid(compareBaseline.score);
  const currentMid = getProbabilityMid(current.score);

  return `
    <div class="popup-banner popup-banner--accent">${escapeHtml(getPlaceSheetComparisonSummary(current, compareBaseline))}</div>
    <div class="place-sheet-compare-grid">
      ${renderPlaceSheetComparisonCard(current, "Current", currentMid >= baselineMid)}
      ${renderPlaceSheetComparisonCard(compareBaseline, "Baseline", baselineMid > currentMid)}
    </div>
    ${renderPopupActions([
      renderPlaceSheetCompareButton(state, compareBaseline),
      '<button type="button" class="popup-action popup-action--secondary" data-place-sheet-compare="clear">Clear baseline</button>',
    ])}`;
}

function renderPlaceSheetHtml(state, compareBaseline = null) {
  const navItems = [
    { id: "placeSheetOverview", label: "Overview" },
    { id: "placeSheetField", label: "Field" },
    { id: "placeSheetParking", label: "Parking" },
    { id: "placeSheetCompetition", label: "Competition" },
    { id: "placeSheetAlternatives", label: "Alternatives" },
    { id: "placeSheetHistory", label: "History" },
    { id: "placeSheetCompare", label: "Compare" },
  ];
  const placeType = state.kind === "restaurant" ? "Restaurant intelligence" : "Stat ping intelligence";

  return `
    <div class="place-sheet-grabber" aria-hidden="true"></div>
    <div class="place-sheet-head">
      <div>
        <div class="popup-kicker">${escapeHtml(placeType)}</div>
        <h2 class="place-sheet-title" id="placeSheetTitle">${escapeHtml(state.title)}</h2>
        ${state.subtitle ? `<div class="popup-subtitle">${escapeHtml(state.subtitle)}</div>` : ""}
      </div>
      <button type="button" class="place-sheet-close" aria-label="Close place sheet" data-place-sheet-close>Close</button>
    </div>

    ${renderPopupChips(state.chips || [])}
    ${renderPlaceSheetHero(state)}

    <nav class="place-sheet-nav" aria-label="Place sheet sections">
      ${navItems.map((item) => `<button type="button" class="place-sheet-nav-pill" data-place-sheet-scroll="${item.id}">${escapeHtml(item.label)}</button>`).join("")}
    </nav>

    <section class="place-sheet-section" id="placeSheetOverview">
      <div class="popup-section-head">
        <div class="popup-section-title">Overview</div>
        <div class="popup-section-meta">${escapeHtml(state.kind === "restaurant" ? state.amenityLabel : "Custom selection")}</div>
      </div>
      ${renderPlaceSheetOverviewSection(state, compareBaseline)}
    </section>

    <section class="place-sheet-section" id="placeSheetField">
      <div class="popup-section-head">
        <div class="popup-section-title">Field</div>
        <div class="popup-section-meta">${escapeHtml(lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label)}</div>
      </div>
      ${renderPlaceSheetDgmSection(state)}
    </section>

    <section class="place-sheet-section" id="placeSheetParking">
      <div class="popup-section-head">
        <div class="popup-section-title">Parking</div>
        <div class="popup-section-meta">Staging and access</div>
      </div>
      ${renderPlaceSheetParkingSection(state)}
    </section>

    <section class="place-sheet-section" id="placeSheetCompetition">
      <div class="popup-section-head">
        <div class="popup-section-title">Competition</div>
        <div class="popup-section-meta">Pressure and stability</div>
      </div>
      ${renderPlaceSheetCompetitionSection(state)}
    </section>

    <section class="place-sheet-section" id="placeSheetAlternatives">
      <div class="popup-section-head">
        <div class="popup-section-title">Alternatives</div>
        <div class="popup-section-meta">Micro-corridors and merchants</div>
      </div>
      ${renderPlaceSheetAlternativesSection(state)}
    </section>

    <section class="place-sheet-section" id="placeSheetHistory">
      <div class="popup-section-head">
        <div class="popup-section-title">History</div>
        <div class="popup-section-meta">Local-only familiarity</div>
      </div>
      ${renderPlaceSheetHistorySection(state)}
    </section>

    <section class="place-sheet-section" id="placeSheetCompare">
      <div class="popup-section-head">
        <div class="popup-section-title">Compare mode</div>
        <div class="popup-section-meta">Baseline vs current</div>
      </div>
      ${renderPlaceSheetCompareSection(state, compareBaseline)}
    </section>`;
}

function openRestaurantSheet(restaurant) {
  return mapInteractionRuntime.openRestaurantSheet(restaurant);
}

function openSpotSheet(latlng) {
  return mapInteractionRuntime.openSpotSheet(latlng);
}

function setSpotMarker(latlng) {
  const point = latlngToObject(latlng);
  lastSpotPoint = point;

  setSourceData(SOURCE_SPOT, featureCollection([{
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [point.lng, point.lat],
    },
    properties: {
      label: "Best Spot",
    },
  }]));

  return point;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadForView() {
  return dataScoringRuntime.loadForView();
}

installRuntimeDebugSurface();

elLoad.addEventListener("click", () => {
  loadForView().catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err?.message ?? String(err)}`);
  });
});

if (elLocateMe) {
  elLocateMe.addEventListener("click", () => {
    locateUser();
  });
}

addPreferredPressHandler(menuButton, () => {
  togglePanel();
});

addPreferredPressHandler(elSearchToggle, () => {
    if (isSearchOverlayOpen) {
      closeSearchOverlay();
      return;
    }

    openSearchOverlay();
});

addPreferredPressHandler(elSearchClose, () => {
  closeSearchOverlay({ restoreFocus: true });
});

if (elSearchOverlay) {
  elSearchOverlay.addEventListener("pointerdown", (event) => {
    if (event.target !== elSearchOverlay) return;
    event.preventDefault();
    closeSearchOverlay({ restoreFocus: true });
  });
}

if (elSearchForm && elSearchInput && elSearchButton) {
  elSearchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearSearchResults();
    const query = elSearchInput.value;
    if (!String(query).trim()) return;

    elSearchButton.disabled = true;
    elSearchButton.textContent = "Searching…";

    try {
      await searchAddress(query);
      closeSearchOverlay();
    } catch (error) {
      console.error(error);
      alert(error?.message ?? String(error));
    } finally {
      elSearchButton.disabled = false;
      elSearchButton.textContent = "Search";
    }
  });

  elSearchInput.addEventListener("input", () => {
    scheduleSearchSuggestions(elSearchInput.value);
  });

  elSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchOverlay({ restoreFocus: true });
    }
  });

  elSearchInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (searchResultPressActive) return;
      if (!isSearchOverlayOpen) return;
      clearSearchResults();
    }, 120);
  });

  elSearchInput.addEventListener("focus", () => {
    if (elSearchResults?.innerHTML.trim()) {
      setSearchResultsExpanded(true);
    }
  });
}

if (elSearchResults) {
  const markInteraction = () => noteSearchResultsInteraction();

  elSearchResults.addEventListener("pointerdown", markInteraction);
  elSearchResults.addEventListener("touchstart", markInteraction, { passive: true });
  elSearchResults.addEventListener("click", (event) => {
    const button = event.target.closest(".search-result");
    if (!button || !elSearchResults.contains(button)) return;
    event.preventDefault();
    selectRenderedSearchResult(button.dataset.index);
  });
}

map.on("moveend", checkDataFreshness);
map.on("zoom", refreshHeadingConeFromState);
map.on("rotate", refreshHeadingConeFromState);
map.on("dragstart", handleManualMapCameraStart);
map.on("rotatestart", handleManualMapCameraStart);
map.on("zoomstart", handleManualMapCameraStart);

map.on("click", handleMapBackgroundClick);

map.on("load", () => {
  ensureMapSourcesAndLayers();
  restoreMapDataSources();
  ensureCompassUi();
  installCompassPermissionAutoRequest();
  startContinuousLocationWatch();
  startDeviceOrientationWatch();
  startBlueDotBreathingAnimation();
  startHeadingConeRenderLoop();

  if (panel) {
    panel.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  }

  map.resize();

  setTimeout(async () => {
    map.resize();

    await centerMapOnInitialLocationOnce();

    loadForView().catch((err) => {
      console.error(err);
      alert(`Failed to load map data: ${err?.message ?? String(err)}`);
    });
  }, 250);
});

map.on("style.load", () => {
  restoreLayersAfterStyleChange();
});

map.on("styledata", () => {
  restoreLayersAfterStyleChange();
});
