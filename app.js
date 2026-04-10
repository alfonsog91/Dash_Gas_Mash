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
  isMipAvailable,
  optimizeParkingSet,
  selectParkingSetSubmodular,
} from "./optimizer.js?v=20260401-probability-contract";
import {
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
  HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
  HEADING_SENSOR_SMOOTHING_MIN_BLEND,
  HEADING_SENSOR_SMOOTHING_TIME_MS,
  HEADING_SENSOR_STALE_AFTER_MS,
  getDeviceOrientationReading,
  getHeadingBlendFactor,
  getHeadingConeBandStops,
  getHeadingDeltaDegrees,
  getHeadingConeHalfAngle,
  getHeadingConeLengthMeters,
  hasFreshHeadingSensorData,
  interpolateHeadingDegrees,
  normalizeHeadingDegrees,
} from "./heading_cone.js?v=20260410-mobile-motion";
import {
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
} from "./heading_runtime.js";
import {
  fetchCurrentWeatherSignal,
  formatWeatherSourceSummary,
} from "./weather.js?v=20260410-live-weather";
import {
  fetchCensusResidentialAnchors,
  formatCensusSourceSummary,
} from "./census.js?v=20260410-census-data";

const APP_BUILD_ID = "20260410-mobile-motion";
console.info("[DGM] app build", APP_BUILD_ID);

const PREDICTION_MODEL = String(window.DGM_PREDICTION_MODEL || "legacy").trim().toLowerCase();
const SHADOW_LEARNED_MODEL = Boolean(window.DGM_SHADOW_PREDICTION_MODEL);
const MAPTILER_GEOCODING_API_URL = "https://api.maptiler.com/geocoding";
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
const HEADING_RENDER_LOOP_MAX_HZ = 30;
const HEADING_RENDER_LOOP_FRAME_INTERVAL_MS = 1000 / HEADING_RENDER_LOOP_MAX_HZ;
const HEADING_RENDER_LOOP_MAP_BEARING_SMOOTHING_TIME_MS = 140;
const HEADING_RENDER_LOOP_GPS_SMOOTHING_TIME_MS = 180;
const HEADING_RENDER_LOOP_MIN_DELTA_DEGREES = 0.5;
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
const DEBUG_MODE_QUERY_PARAM = "debug";
const DEBUG_MODE_ENABLED_VALUE = "1";

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

if (window.location.protocol === "file:") {
  alert(
    "This app must be opened from a local web server (not file://).\n\nRun: python -m http.server 5173\nThen open: http://localhost:5173/"
  );
}

const DEFAULT_CENTER = [-117.5931, 34.1064]; // [lng, lat] Rancho Cucamonga
const DEFAULT_ZOOM = 12;

const MAPTILER_API_KEY = String(window.DASH_MAPTILER_KEY || "").trim();
const STREET_STYLE_ID = String(window.DASH_MAPTILER_STYLE_ID || "basic-v2").trim();
const MAP_STYLE_URL = MAPTILER_API_KEY
  ? `https://api.maptiler.com/maps/${encodeURIComponent(STREET_STYLE_ID)}/style.json?key=${encodeURIComponent(MAPTILER_API_KEY)}`
  : "https://demotiles.maplibre.org/style.json";
const SATELLITE_STYLE = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    },
  },
  layers: [
    {
      id: "satellite-base",
      type: "raster",
      source: "satellite",
      minzoom: 0,
      maxzoom: 22,
    },
  ],
};

const SOURCE_RESTAURANTS = "restaurants";
const SOURCE_PARKING = "parking";
const SOURCE_HEAT = "heat";
const SOURCE_SPOT = "spot";
const SOURCE_CURRENT_LOCATION = "current-location";
const SOURCE_CURRENT_LOCATION_ACCURACY = "current-location-accuracy";
const SOURCE_HEADING = "heading";
const SOURCE_ROUTE = "route";

const LAYER_HEAT = "heat-layer";
const LAYER_RESTAURANTS = "restaurants-layer";
const LAYER_PARKING = "parking-layer";
const LAYER_SPOT = "spot-layer";
const LAYER_CURRENT_LOCATION_ACCURACY_FILL = "current-location-accuracy-fill";
const LAYER_CURRENT_LOCATION_ACCURACY_LINE = "current-location-accuracy-line";
const LAYER_HEADING_GLOW = "heading-glow-layer";
const LAYER_HEADING = "heading-layer";
const LAYER_HEADING_EDGE = "heading-edge-layer";
const LAYER_CURRENT_LOCATION_HALO = "current-location-halo";
const LAYER_CURRENT_LOCATION_DOT = "current-location-dot";
const LAYER_ROUTE_CASING = "route-casing-layer";
const LAYER_ROUTE = "route-layer";

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE_URL,
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 19,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

if (isTouchInteractionDevice() && map.doubleClickZoom) {
  map.doubleClickZoom.disable();
}

let activePopup = null;
let activeAbort = null;
let lastCurrentLocation = null;
let lastCurrentLocationAccuracyMeters = null;
let lastHeatFeatures = [];
let lastSpotPoint = null;
let currentBaseStyle = "map";
let hasBoundLayerEvents = false;
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
let navigationVoiceEnabled = true;
let lastSpokenInstructionKey = "";

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
const elUseMIP = document.getElementById("useMIP");
const elKSpots = document.getElementById("kSpots");
const elKSpotsVal = document.getElementById("kSpotsVal");
const elMinSep = document.getElementById("minSep");
const elMinSepVal = document.getElementById("minSepVal");
const elLoad = document.getElementById("load");
const elShowRestaurants = document.getElementById("showRestaurants");
const elShowParking = document.getElementById("showParking");
const elParkingList = document.getElementById("parkingList");
const elSummaryCards = document.getElementById("summaryCards");
const menuButton = document.getElementById("menuToggle");
const panel = document.getElementById("panel");
const elLocateMe = document.getElementById("locateMe");
const elSearchToggle = document.getElementById("searchToggle");
const elSearchOverlay = document.getElementById("searchOverlay");
const elSearchClose = document.getElementById("searchClose");
const elSearchForm = document.getElementById("searchForm");
const elSearchInput = document.getElementById("searchInput");
const elSearchButton = document.getElementById("searchButton");
const elSearchResults = document.getElementById("searchResults");
const elStreetMode = document.getElementById("streetMode");
const elSatelliteMode = document.getElementById("satelliteMode");
const elNavigationCard = document.getElementById("navigationCard");
const elNavigationBanner = document.getElementById("navigationBanner");
const elNavigationBannerInstruction = document.getElementById("navigationBannerInstruction");
const elNavigationBannerMeta = document.getElementById("navigationBannerMeta");
const elNavigationTitle = document.getElementById("navigationTitle");
const elNavigationMeta = document.getElementById("navigationMeta");
const elNavigationStatus = document.getElementById("navigationStatus");
const elNavigationSteps = document.getElementById("navigationSteps");
const elNavigationRecenter = document.getElementById("navigationRecenter");
const elNavigationClear = document.getElementById("navigationClear");
const elNavigationVoice = document.getElementById("navigationVoice");

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
const AUTO_FOLLOW_LOCATION_PAN_DURATION_MS = 450;

const INITIAL_LOCATION_ZOOM = 14;
const INITIAL_LOCATION_TIMEOUT_MS = 8000;

const diagramContainer = document.getElementById("diagram");
renderModelDiagram(diagramContainer);

if (elHorizon) {
  elHorizon.value = String(PROBABILITY_HORIZON_MINUTES);
  elHorizon.disabled = true;
  elHorizon.setAttribute("aria-disabled", "true");
}

let isLocating = false;
let hasRequestedInitialLocation = false;
let activeContinuousWatchId = null;
let lastKnownHeading = null;
let lastKnownHeadingSource = null;
let lastKnownHeadingSpeed = null;
let lastSensorHeading = null;
let lastSensorHeadingAt = null;
let lastSensorEventAt = null;
let lastSensorEventWallClockMs = null;
let lastRawSensorHeading = null;
let lastSensorHeadingAccuracy = null;
let lastSensorHeadingKind = null;
let lastHeadingRenderAt = null;
let hasStartedDeviceOrientationWatch = false;
let hasStartedBlueDotBreathingAnimation = false;
let hasStartedHeadingConeRenderLoop = false;
let blueDotBreathingAnimationFrame = null;
let headingConeRenderLoopFrame = null;
let lastHeadingConeLoopFrameAt = null;
let lastHeadingConeLoopTickAt = null;
let lastHeadingConeLoopHeading = null;
let lastBlueDotBreathingRadius = null;
let lastHeadingConeLengthMeters = null;
let lastHeadingConeLatitude = null;
let lastHeadingConeZoom = null;
let headingConeRenderMesh = null;
let lastRenderedHeadingConeHeading = null;
let lastRenderedHeadingConeLocation = null;
let lastRenderedHeadingConeSpeed = null;
let lastRenderedHeadingConeZoom = null;
let compassPermissionState = readStoredCompassPermissionState() || COMPASS_PERMISSION_UNAVAILABLE_STATE;
let isCompassPermissionRequestPending = false;
let hasInstalledCompassPermissionAutoRequest = false;
let hasTriggeredCompassPermissionAutoRequest = false;
let compassUiRoot = null;
let compassDebugToggleButton = null;
let compassDebugOverlay = null;
let compassDebugOverlayBody = null;
let isCompassDebugOverlayVisible = COMPASS_DEBUG_MODE_ENABLED;
let isFollowingCurrentLocation = isTouchInteractionDevice();

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
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
}

function openPopupAtLngLat(lngLat, html, popupOptions = {}) {
  closeActivePopup();

  const popup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    className: "dgm-popup",
    maxWidth: "360px",
    offset: 12,
    ...popupOptions,
  })
    .setLngLat(lngLatToArray(lngLat))
    .setHTML(html)
    .addTo(map);

  const popupElement = popup.getElement();
  const popupActionHandler = (event) => {
    const routeButton = event.target.closest("[data-route-lat][data-route-lng]");
    if (!routeButton || !popupElement.contains(routeButton)) return;

    event.preventDefault();

    startInAppNavigation({
      lat: Number(routeButton.dataset.routeLat),
      lng: Number(routeButton.dataset.routeLng),
      title: routeButton.dataset.routeTitle || "Destination",
    }).catch((error) => {
      console.error(error);
      setNavigationStatus(error?.message ?? String(error), "error");
    });
  };

  popupElement.addEventListener("click", popupActionHandler);

  popup.on("close", () => {
    popupElement.removeEventListener("click", popupActionHandler);
    if (activePopup === popup) {
      activePopup = null;
    }
  });

  activePopup = popup;

  return activePopup;
}

function setSourceData(sourceId, data) {
  const source = map.getSource(sourceId);
  if (source) {
    source.setData(data);
  }
}

function clearHeadingConeVisual() {
  if (
    lastRenderedHeadingConeHeading === null
    && lastRenderedHeadingConeLocation === null
    && lastRenderedHeadingConeSpeed === null
    && lastRenderedHeadingConeZoom === null
  ) {
    return;
  }

  setSourceData(SOURCE_HEADING, featureCollection());
  lastHeadingConeLoopHeading = null;
  lastRenderedHeadingConeHeading = null;
  lastRenderedHeadingConeLocation = null;
  lastRenderedHeadingConeSpeed = null;
  lastRenderedHeadingConeZoom = null;
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

function syncModeButtons() {
  if (elStreetMode) {
    const isActive = currentBaseStyle === "map";
    elStreetMode.classList.toggle("is-active", isActive);
    elStreetMode.setAttribute("aria-pressed", String(isActive));
  }

  if (elSatelliteMode) {
    const isActive = currentBaseStyle === "satellite";
    elSatelliteMode.classList.toggle("is-active", isActive);
    elSatelliteMode.setAttribute("aria-pressed", String(isActive));
  }
}

function restoreMapDataSources() {
  setSourceData(SOURCE_RESTAURANTS, featureCollection(Array.from(restaurantById.values()).map((restaurant) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [restaurant.lon, restaurant.lat],
    },
    properties: { id: restaurant.id },
  }))));

  setSourceData(SOURCE_PARKING, featureCollection(Array.from(parkingById.values()).map((parking) => ({
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [parking.lon, parking.lat],
    },
    properties: { id: parking.id },
  }))));

  setSourceData(SOURCE_HEAT, featureCollection(lastHeatFeatures));

  if (lastSpotPoint) {
    setSourceData(SOURCE_SPOT, featureCollection([{
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lastSpotPoint.lng, lastSpotPoint.lat],
      },
      properties: {},
    }]));
  } else {
    setSourceData(SOURCE_SPOT, featureCollection());
  }

  if (lastCurrentLocation) {
    const accuracyRadius = Math.max(Number(lastCurrentLocationAccuracyMeters) || 0, 12);
    if (accuracyRadius <= MAX_VISIBLE_ACCURACY_RADIUS_METERS) {
      const accuracyFeature = createCirclePolygonFeature(lastCurrentLocation, accuracyRadius);
      accuracyFeature.properties = { accuracyMeters: accuracyRadius };
      setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection([accuracyFeature]));
    } else {
      setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection());
    }

    setSourceData(SOURCE_CURRENT_LOCATION, featureCollection([{
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lastCurrentLocation.lng, lastCurrentLocation.lat],
      },
      properties: { accuracyMeters: accuracyRadius },
    }]));
  } else {
    setSourceData(SOURCE_CURRENT_LOCATION, featureCollection());
    setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection());
  }

  refreshHeadingConeFromState();

  if (activeRoute?.geometry?.coordinates?.length) {
    setSourceData(SOURCE_ROUTE, featureCollection([{
      type: "Feature",
      geometry: activeRoute.geometry,
      properties: {},
    }]));
  } else {
    setSourceData(SOURCE_ROUTE, featureCollection());
  }

  setLayerVisibility(LAYER_RESTAURANTS, elShowRestaurants.checked);
  setLayerVisibility(LAYER_PARKING, elShowParking.checked);
}

function applyBaseStyle(mode) {
  if (mode === currentBaseStyle) return;
  currentBaseStyle = mode;
  syncModeButtons();
  map.setStyle(mode === "satellite" ? SATELLITE_STYLE : MAP_STYLE_URL);
}

function renderNavigationAction(lat, lon, label = "Start route", destinationTitle = "Destination") {
  return `<div class="popup-actions"><button class="popup-action" type="button" data-route-lat="${Number(lat).toFixed(6)}" data-route-lng="${Number(lon).toFixed(6)}" data-route-title="${escapeHtml(destinationTitle)}">${escapeHtml(label)}</button></div>`;
}

function stopNavigationSpeech() {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

function updateNavigationVoiceButton() {
  if (!elNavigationVoice) return;
  if (!("speechSynthesis" in window)) {
    elNavigationVoice.textContent = "Voice unavailable";
    elNavigationVoice.disabled = true;
    elNavigationVoice.setAttribute("aria-pressed", "false");
    return;
  }

  elNavigationVoice.disabled = false;
  elNavigationVoice.textContent = navigationVoiceEnabled ? "Voice on" : "Voice off";
  elNavigationVoice.setAttribute("aria-pressed", String(navigationVoiceEnabled));
}

function formatRouteDistance(distanceMeters) {
  const meters = Math.max(0, Number(distanceMeters) || 0);
  if (meters >= 1609.344) {
    return `${(meters / 1609.344).toFixed(meters >= 16093 ? 0 : 1)} mi`;
  }
  return `${Math.round(meters)} m`;
}

function formatRouteDuration(durationSeconds) {
  const totalMinutes = Math.max(1, Math.round((Number(durationSeconds) || 0) / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${totalMinutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function buildRouteBounds(coordinates) {
  if (!coordinates?.length) return null;
  const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
  for (const coordinate of coordinates) {
    bounds.extend(coordinate);
  }
  return bounds;
}

function fitRouteToView(route) {
  const bounds = buildRouteBounds(route?.geometry?.coordinates);
  if (!bounds) return;

  map.fitBounds(bounds, {
    padding: { top: 180, right: 32, bottom: 220, left: 32 },
    duration: 850,
    maxZoom: 16,
  });
}

function clearRouteOverlay() {
  setSourceData(SOURCE_ROUTE, featureCollection());
}

function setNavigationCardVisible(isVisible) {
  if (!elNavigationCard) return;
  elNavigationCard.hidden = !isVisible;
  elNavigationCard.classList.toggle("is-active", Boolean(isVisible));
}

function setNavigationStatus(message, tone = "info") {
  if (!elNavigationStatus) return;
  const text = String(message || "").trim();
  elNavigationStatus.textContent = text;
  elNavigationStatus.dataset.tone = tone;
  elNavigationStatus.hidden = !text;
}

function getPrimaryRouteStep(route) {
  if (!route?.steps?.length) return null;
  return route.steps.find((step) => Number(step?.distance) > 15) || route.steps[0] || null;
}

function buildRouteStepInstruction(step) {
  const maneuver = step?.maneuver || {};
  const type = String(maneuver.type || "continue");
  const modifier = String(maneuver.modifier || "").replace(/_/g, " ");
  const road = step?.name ? ` on ${step.name}` : "";

  if (maneuver.instruction) return maneuver.instruction;

  switch (type) {
    case "depart":
      return `Head ${modifier || "out"}${road}`.trim();
    case "arrive":
      return "Arrive at your destination";
    case "turn":
      return `Turn ${modifier}${road}`.trim();
    case "merge":
      return `Merge${road}`.trim();
    case "fork":
      return `Keep ${modifier || "ahead"}${road}`.trim();
    case "roundabout":
    case "rotary":
      return `Enter the roundabout${road}`.trim();
    case "end of road":
      return `At the end of the road, turn ${modifier}${road}`.trim();
    default:
      return `Continue ${modifier}${road}`.trim();
  }
}

function speakNavigationInstruction(route, { force = false } = {}) {
  if (!navigationVoiceEnabled || !("speechSynthesis" in window)) return;
  const primaryStep = getPrimaryRouteStep(route);
  if (!primaryStep) return;

  const instruction = buildRouteStepInstruction(primaryStep);
  const distanceText = formatRouteDistance(primaryStep.distance);
  const speechKey = instruction;
  if (!force && speechKey === lastSpokenInstructionKey) {
    return;
  }

  lastSpokenInstructionKey = speechKey;
  stopNavigationSpeech();

  const utterance = new SpeechSynthesisUtterance(`${instruction}. In ${distanceText}.`);
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function setNavigationVoiceEnabled(isEnabled) {
  navigationVoiceEnabled = Boolean(isEnabled);
  updateNavigationVoiceButton();

  if (!navigationVoiceEnabled) {
    stopNavigationSpeech();
    return;
  }

  if (activeRoute) {
    speakNavigationInstruction(activeRoute, { force: true });
  }
}

function renderNavigationCard(route) {
  if (!elNavigationCard || !elNavigationTitle || !elNavigationMeta || !elNavigationSteps) return;

  const primaryStep = getPrimaryRouteStep(route);
  if (elNavigationBanner) {
    elNavigationBanner.hidden = false;
  }
  if (elNavigationBannerInstruction) {
    elNavigationBannerInstruction.textContent = primaryStep
      ? buildRouteStepInstruction(primaryStep)
      : "Route ready";
  }
  if (elNavigationBannerMeta) {
    elNavigationBannerMeta.textContent = primaryStep
      ? `${formatRouteDistance(primaryStep.distance)} to next turn`
      : `${formatRouteDistance(route.distanceMeters)} remaining`;
  }

  elNavigationTitle.textContent = route.destination.title || "Route";
  elNavigationMeta.textContent = `${formatRouteDistance(route.distanceMeters)} · ${formatRouteDuration(route.durationSeconds)}`;
  elNavigationSteps.innerHTML = route.steps.length
    ? route.steps.map((step, index) => `
      <li class="navigation-step">
        <span class="navigation-step-index">${index + 1}</span>
        <div class="navigation-step-body">
          <div class="navigation-step-text">${escapeHtml(buildRouteStepInstruction(step))}</div>
          <div class="navigation-step-meta">${escapeHtml(formatRouteDistance(step.distance))}</div>
        </div>
      </li>
    `).join("")
    : `<li class="navigation-step navigation-step--empty"><div class="navigation-step-body"><div class="navigation-step-text">Route ready.</div></div></li>`;

  setNavigationCardVisible(true);
  setNavigationStatus("", "info");
  updateNavigationVoiceButton();
  speakNavigationInstruction(route);
}

async function fetchDrivingRoute(origin, destination, { signal } = {}) {
  const routeUrl = new URL(`${OSRM_ROUTE_API_URL}/${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`);
  routeUrl.searchParams.set("alternatives", "false");
  routeUrl.searchParams.set("overview", "full");
  routeUrl.searchParams.set("steps", "true");
  routeUrl.searchParams.set("geometries", "geojson");

  const response = await fetch(routeUrl, {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Route request failed (${response.status})`);
  }

  const payload = await response.json();
  const route = payload?.routes?.[0];
  if (!route?.geometry?.coordinates?.length) {
    throw new Error("No drivable route was returned for that destination.");
  }

  return {
    geometry: route.geometry,
    distanceMeters: Number(route.distance) || 0,
    durationSeconds: Number(route.duration) || 0,
    steps: Array.isArray(route.legs)
      ? route.legs.flatMap((leg) => Array.isArray(leg.steps) ? leg.steps : [])
      : [],
  };
}

function setCurrentLocationState(latlng, accuracyMeters, { openPopup = true } = {}) {
  const currentLngLat = lngLatToObject(latlng);

  const accuracyRadius = Math.max(Number(accuracyMeters) || 0, 12);
  lastCurrentLocation = currentLngLat;
  lastCurrentLocationAccuracyMeters = accuracyRadius;

  if (accuracyRadius <= MAX_VISIBLE_ACCURACY_RADIUS_METERS) {
    const accuracyFeature = createCirclePolygonFeature(currentLngLat, accuracyRadius);
    accuracyFeature.properties = { accuracyMeters: accuracyRadius };
    setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection([accuracyFeature]));
  } else {
    setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection());
  }

  setSourceData(SOURCE_CURRENT_LOCATION, featureCollection([{
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [currentLngLat.lng, currentLngLat.lat],
    },
    properties: { accuracyMeters: accuracyRadius },
  }]));

  refreshHeadingConeWithEffectiveHeading(currentLngLat, lastKnownHeadingSpeed);
  syncMapToCurrentLocation(currentLngLat);

  if (openPopup) {
    openPopupAtLngLat(currentLngLat, `You are here<br/><span class="mono">Accuracy ±${Math.round(accuracyRadius)} m</span>`);
  }

  return currentLngLat;
}

function stopNavigationWatch() {
  if (activeNavigationWatchId === null) return;
  if (navigator.geolocation?.clearWatch) {
    navigator.geolocation.clearWatch(activeNavigationWatchId);
  }
  activeNavigationWatchId = null;
}

function updateHeadingCone(latlng, heading, speed) {
  const resolvedLatLng = lngLatToObject(latlng);
  const resolvedHeading = normalizeHeadingDegrees(heading);
  if (!resolvedLatLng || resolvedHeading === null) {
    clearHeadingConeVisual();
    return;
  }

  const halfAngle = getHeadingConeHalfAngle(
    typeof speed === "number" && Number.isFinite(speed)
      ? speed
      : lastKnownHeadingSpeed
  );
  const coneLengthMeters = getCachedHeadingConeLengthMeters(resolvedLatLng.lat);
  if (!(typeof coneLengthMeters === "number" && Number.isFinite(coneLengthMeters) && coneLengthMeters > 0)) {
    clearHeadingConeVisual();
    return;
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
  lastHeadingConeLoopHeading = resolvedHeading;
  lastRenderedHeadingConeHeading = resolvedHeading;
  lastRenderedHeadingConeLocation = { ...resolvedLatLng };
  lastRenderedHeadingConeSpeed = typeof speed === "number" && Number.isFinite(speed)
    ? Math.max(0, speed)
    : 0;
  lastRenderedHeadingConeZoom = map.getZoom();
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

function getHeadingNowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function getCompassPermissionRequestTarget() {
  if (typeof window === "undefined") {
    return null;
  }

  const orientationEvent = window.DeviceOrientationEvent;
  if (!orientationEvent || typeof orientationEvent.requestPermission !== "function") {
    return null;
  }

  return orientationEvent;
}

function canPersistCompassPermissionState(state) {
  return (
    state === COMPASS_PERMISSION_GRANTED_STATE
    || state === COMPASS_PERMISSION_DENIED_STATE
    || state === COMPASS_PERMISSION_NOT_REQUIRED_STATE
    || state === COMPASS_PERMISSION_UNAVAILABLE_STATE
  );
}

function readStoredCompassPermissionState() {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }

  try {
    const storedState = window.localStorage.getItem(COMPASS_PERMISSION_STORAGE_KEY);
    return canPersistCompassPermissionState(storedState) ? storedState : null;
  } catch {
    return null;
  }
}

function writeStoredCompassPermissionState(state) {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    if (canPersistCompassPermissionState(state)) {
      window.localStorage.setItem(COMPASS_PERMISSION_STORAGE_KEY, state);
    } else {
      window.localStorage.removeItem(COMPASS_PERMISSION_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures and keep runtime behavior intact.
  }
}

function getResolvedCompassPermissionState() {
  return resolveCompassPermissionState({
    hasDeviceOrientationEvent: typeof window !== "undefined" && Boolean(window.DeviceOrientationEvent),
    canRequestPermission: Boolean(getCompassPermissionRequestTarget()),
    permissionState: compassPermissionState,
    requiredState: COMPASS_PERMISSION_REQUIRED_STATE,
    grantedState: COMPASS_PERMISSION_GRANTED_STATE,
    deniedState: COMPASS_PERMISSION_DENIED_STATE,
    notRequiredState: COMPASS_PERMISSION_NOT_REQUIRED_STATE,
    unavailableState: COMPASS_PERMISSION_UNAVAILABLE_STATE,
  });
}

function formatCompassTimestamp(timestampMs) {
  if (!(typeof timestampMs === "number" && Number.isFinite(timestampMs))) {
    return "none";
  }

  return new Date(timestampMs).toISOString().slice(11, 23);
}

function formatCompassHeadingValue(heading) {
  if (!(typeof heading === "number" && Number.isFinite(heading))) {
    return "none";
  }

  return `${heading.toFixed(1)}°`;
}

function getHeadingSourceLabel(source) {
  if (source === "sensor") {
    return "sensor";
  }

  if (source === "gps") {
    return "GPS";
  }

  if (source === "bearing" || source === "map-bearing") {
    return "bearing";
  }

  return "none";
}

function updateCompassDebugOverlay(nowMs = getHeadingNowMs(), headingState = getHeadingState(nowMs)) {
  if (!compassDebugOverlayBody) {
    return;
  }

  const permissionState = getResolvedCompassPermissionState();
  const accuracyText = typeof lastSensorHeadingAccuracy === "number" && Number.isFinite(lastSensorHeadingAccuracy)
    ? ` (${lastSensorHeadingAccuracy.toFixed(1)}° acc)`
    : "";
  const eventAgeText = typeof lastSensorEventAt === "number" && Number.isFinite(lastSensorEventAt)
    ? ` (${Math.round(Math.max(0, nowMs - lastSensorEventAt))} ms ago)`
    : "";

  compassDebugOverlayBody.textContent = [
    `permission: ${permissionState}`,
    `last event: ${formatCompassTimestamp(lastSensorEventWallClockMs)}${eventAgeText}`,
    `raw heading: ${formatCompassHeadingValue(lastRawSensorHeading)}${accuracyText}`,
    `source: ${getHeadingSourceLabel(headingState?.source)}`,
    `sensor kind: ${lastSensorHeadingKind || "none"}`,
  ].join("\n");
}

function syncCompassUi(nowMs = getHeadingNowMs()) {
  if (!compassUiRoot || !compassDebugToggleButton || !compassDebugOverlay) {
    return;
  }

  compassPermissionState = getResolvedCompassPermissionState();
  compassDebugOverlay.hidden = !isCompassDebugOverlayVisible;
  compassDebugToggleButton.textContent = isCompassDebugOverlayVisible ? "Hide Debug" : "Show Debug";
  compassDebugToggleButton.setAttribute("aria-pressed", String(isCompassDebugOverlayVisible));
  updateCompassDebugOverlay(nowMs);
}

function setCompassPermissionState(nextState, nowMs = getHeadingNowMs()) {
  compassPermissionState = nextState;
  writeStoredCompassPermissionState(nextState);
  syncCompassUi(nowMs);
}

function ensureCompassUi() {
  if (typeof document === "undefined" || compassUiRoot || !COMPASS_DEBUG_MODE_ENABLED) {
    return;
  }

  compassUiRoot = document.createElement("div");
  Object.assign(compassUiRoot.style, {
    position: "fixed",
    top: "12px",
    left: "12px",
    zIndex: "12",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "8px",
    maxWidth: "min(82vw, 280px)",
    pointerEvents: "none",
  });

  compassDebugToggleButton = document.createElement("button");
  compassDebugToggleButton.type = "button";
  Object.assign(compassDebugToggleButton.style, {
    pointerEvents: "auto",
    border: "0",
    borderRadius: "999px",
    padding: "8px 12px",
    fontSize: "12px",
    fontWeight: "600",
    color: "#eef6ff",
    background: "rgba(8, 17, 29, 0.82)",
    boxShadow: "0 8px 20px rgba(8, 17, 29, 0.22)",
  });
  compassDebugToggleButton.addEventListener("click", () => {
    isCompassDebugOverlayVisible = !isCompassDebugOverlayVisible;
    syncCompassUi();
  });

  compassDebugOverlay = document.createElement("div");
  Object.assign(compassDebugOverlay.style, {
    pointerEvents: "auto",
    minWidth: "220px",
    padding: "10px 12px",
    borderRadius: "14px",
    background: "rgba(8, 17, 29, 0.82)",
    color: "#eef6ff",
    boxShadow: "0 12px 28px rgba(8, 17, 29, 0.28)",
    backdropFilter: "blur(10px)",
  });

  const compassDebugTitle = document.createElement("div");
  compassDebugTitle.textContent = "Compass Debug";
  Object.assign(compassDebugTitle.style, {
    marginBottom: "6px",
    fontSize: "12px",
    fontWeight: "700",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  });

  compassDebugOverlayBody = document.createElement("pre");
  Object.assign(compassDebugOverlayBody.style, {
    margin: "0",
    fontSize: "11px",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  });

  compassDebugOverlay.append(compassDebugTitle, compassDebugOverlayBody);
  compassUiRoot.append(compassDebugToggleButton, compassDebugOverlay);
  document.body.append(compassUiRoot);
  syncCompassUi();
}

async function requestCompassPermissionFromUserGesture() {
  ensureCompassUi();

  const requestTarget = getCompassPermissionRequestTarget();
  if (!requestTarget) {
    const nextState = typeof window !== "undefined" && window.DeviceOrientationEvent
      ? COMPASS_PERMISSION_NOT_REQUIRED_STATE
      : COMPASS_PERMISSION_UNAVAILABLE_STATE;
    setCompassPermissionState(nextState);
    startDeviceOrientationWatch();
    return nextState;
  }

  if (isCompassPermissionRequestPending) {
    return compassPermissionState;
  }

  isCompassPermissionRequestPending = true;
  syncCompassUi();

  try {
    const permissionResult = await requestTarget.requestPermission();
    if (permissionResult === COMPASS_PERMISSION_GRANTED_STATE) {
      setCompassPermissionState(COMPASS_PERMISSION_GRANTED_STATE);
      startDeviceOrientationWatch();
      syncHeadingConeRenderLoop();
      return COMPASS_PERMISSION_GRANTED_STATE;
    }

    setCompassPermissionState(COMPASS_PERMISSION_DENIED_STATE);
    return COMPASS_PERMISSION_DENIED_STATE;
  } catch (error) {
    setCompassPermissionState(COMPASS_PERMISSION_DENIED_STATE);
    throw error;
  } finally {
    isCompassPermissionRequestPending = false;
    syncCompassUi();
  }
}

function requestCompassPermissionOnFirstGesture() {
  if (hasTriggeredCompassPermissionAutoRequest || isCompassPermissionRequestPending) {
    return;
  }

  if (getResolvedCompassPermissionState() !== COMPASS_PERMISSION_REQUIRED_STATE) {
    return;
  }

  hasTriggeredCompassPermissionAutoRequest = true;
  requestCompassPermissionFromUserGesture().catch((error) => {
    console.warn("[DGM] Compass permission request failed:", error);
  });
}

function installCompassPermissionAutoRequest() {
  if (typeof document === "undefined" || hasInstalledCompassPermissionAutoRequest) {
    return;
  }

  hasInstalledCompassPermissionAutoRequest = true;
  const handleFirstGesture = () => {
    requestCompassPermissionOnFirstGesture();
  };

  document.addEventListener("touchstart", handleFirstGesture, {
    capture: true,
    once: true,
    passive: true,
  });

  if (elSearchToggle) {
    elSearchToggle.addEventListener("pointerdown", handleFirstGesture, {
      capture: true,
      once: true,
    });
  }

  if (elLocateMe) {
    elLocateMe.addEventListener("click", handleFirstGesture, {
      capture: true,
      once: true,
    });
  }

  if (map && typeof map.once === "function") {
    map.once("click", handleFirstGesture);
  }
}

function getMapBearingHeading() {
  if (!map || typeof map.getBearing !== "function") {
    return null;
  }

  return normalizeHeadingDegrees(map.getBearing());
}

function getHeadingState(nowMs = getHeadingNowMs()) {
  return resolveEffectiveHeadingState({
    storedHeading: lastKnownHeading,
    storedHeadingSource: lastKnownHeadingSource,
    storedSpeed: lastKnownHeadingSpeed,
    sensorHeading: lastSensorHeading,
    sensorHeadingAt: lastSensorHeadingAt,
    nowMs,
    mapBearing: getMapBearingHeading(),
    maxSensorAgeMs: HEADING_SENSOR_STALE_AFTER_MS,
  });
}

function getHeadingRenderLoopSmoothingTimeMs(source) {
  if (source === "sensor") {
    return HEADING_SENSOR_SMOOTHING_TIME_MS;
  }

  if (source === "gps") {
    return HEADING_RENDER_LOOP_GPS_SMOOTHING_TIME_MS;
  }

  return HEADING_RENDER_LOOP_MAP_BEARING_SMOOTHING_TIME_MS;
}

function shouldRenderHeadingConeFrame(latlng, heading, speed) {
  if (!lastRenderedHeadingConeLocation || lastRenderedHeadingConeHeading === null) {
    return true;
  }

  if (map.getZoom() !== lastRenderedHeadingConeZoom) {
    return true;
  }

  const headingDelta = getHeadingDeltaDegrees(heading, lastRenderedHeadingConeHeading);
  if (!Number.isFinite(headingDelta) || headingDelta >= HEADING_RENDER_LOOP_MIN_DELTA_DEGREES) {
    return true;
  }

  const movedMeters = haversineMeters(
    latlng.lat,
    latlng.lng,
    lastRenderedHeadingConeLocation.lat,
    lastRenderedHeadingConeLocation.lng
  );
  if (movedMeters >= HEADING_RENDER_LOOP_MIN_LOCATION_DELTA_METERS) {
    return true;
  }

  const resolvedSpeed = typeof speed === "number" && Number.isFinite(speed)
    ? Math.max(0, speed)
    : 0;
  return Math.abs(resolvedSpeed - (lastRenderedHeadingConeSpeed ?? 0)) >= HEADING_RENDER_LOOP_MIN_SPEED_DELTA_MPS;
}

function renderHeadingConeFrame(nowMs = getHeadingNowMs()) {
  const currentLocation = lastCurrentLocation;
  const headingState = getHeadingState(nowMs);
  updateCompassDebugOverlay(nowMs, headingState);
  const targetHeading = normalizeHeadingDegrees(headingState.effectiveHeading);

  if (!currentLocation || targetHeading === null) {
    clearHeadingConeVisual();
    return null;
  }

  const elapsedMs = lastHeadingConeLoopTickAt === null
    ? getHeadingRenderLoopSmoothingTimeMs(headingState.source)
    : Math.max(0, nowMs - lastHeadingConeLoopTickAt);
  lastHeadingConeLoopTickAt = nowMs;

  const nextHeading = interpolateHeadingDegrees(
    lastHeadingConeLoopHeading ?? lastRenderedHeadingConeHeading ?? targetHeading,
    targetHeading,
    getHeadingBlendFactor(
      elapsedMs,
      getHeadingRenderLoopSmoothingTimeMs(headingState.source),
      headingState.source === "sensor" ? HEADING_SENSOR_SMOOTHING_MIN_BLEND : 0
    )
  );
  const resolvedHeading = normalizeHeadingDegrees(nextHeading);
  if (resolvedHeading === null) {
    clearHeadingConeVisual();
    return null;
  }

  lastHeadingConeLoopHeading = resolvedHeading;
  if (shouldRenderHeadingConeFrame(currentLocation, resolvedHeading, headingState.storedSpeed)) {
    updateHeadingCone(currentLocation, resolvedHeading, headingState.storedSpeed);
  }

  return resolvedHeading;
}

function updateStoredHeadingSpeed(speed) {
  if (typeof speed === "number" && Number.isFinite(speed)) {
    lastKnownHeadingSpeed = Math.max(0, speed);
  }
  return lastKnownHeadingSpeed;
}

function applyHeadingUpdate(
  nextHeading,
  {
    latlng = lastCurrentLocation,
    speed = lastKnownHeadingSpeed,
    nowMs = getHeadingNowMs(),
    timeConstantMs = HEADING_SENSOR_SMOOTHING_TIME_MS,
    minBlend = 0,
    source = lastKnownHeadingSource || "stored",
  } = {}
) {
  const normalizedHeading = normalizeHeadingDegrees(nextHeading);
  if (normalizedHeading === null) return null;

  const elapsedMs = lastHeadingRenderAt === null
    ? timeConstantMs
    : Math.max(0, nowMs - lastHeadingRenderAt);
  const resolvedHeading = interpolateHeadingDegrees(
    lastKnownHeading,
    normalizedHeading,
    getHeadingBlendFactor(elapsedMs, timeConstantMs, minBlend)
  );

  lastKnownHeading = resolvedHeading;
  lastKnownHeadingSource = source;
  lastHeadingRenderAt = nowMs;
  updateStoredHeadingSpeed(speed);
  if (latlng) {
    updateHeadingCone(latlng, resolvedHeading, lastKnownHeadingSpeed);
  } else {
    lastKnownHeading = resolvedHeading;
  }

  return resolvedHeading;
}

function getEffectiveHeading(nowMs = getHeadingNowMs()) {
  return getHeadingState(nowMs).effectiveHeading;
}

function refreshHeadingConeWithEffectiveHeading(latlng, speed, nowMs = getHeadingNowMs()) {
  const resolvedLatLng = latlng ? lngLatToObject(latlng) : null;
  const effectiveHeading = getEffectiveHeading(nowMs);
  const resolvedSpeed = updateStoredHeadingSpeed(speed);
  if (resolvedLatLng && effectiveHeading !== null) {
    updateHeadingCone(resolvedLatLng, effectiveHeading, resolvedSpeed);
    return effectiveHeading;
  }

  clearHeadingConeVisual();
  return effectiveHeading;
}

function refreshHeadingConeFromState(nowMs = getHeadingNowMs()) {
  refreshHeadingConeWithEffectiveHeading(lastCurrentLocation, lastKnownHeadingSpeed, nowMs);
}

function getRuntimeDebugState(nowMs = getHeadingNowMs()) {
  return {
    appBuildId: APP_BUILD_ID,
    currentLocation: lastCurrentLocation ? { ...lastCurrentLocation } : null,
    currentLocationAccuracyMeters: lastCurrentLocationAccuracyMeters,
    compassPermissionState: getResolvedCompassPermissionState(),
    lastSensorEventWallClockMs,
    lastRawSensorHeading,
    lastSensorHeadingAccuracy,
    lastSensorHeadingKind,
    heading: getHeadingState(nowMs),
    baseStyle: currentBaseStyle,
    routeActive: Boolean(activeRoute),
    dataLoaded: Boolean(lastLoadedBounds && lastStats),
  };
}

function installRuntimeDebugSurface() {
  if (typeof window === "undefined") return;

  window.DGM_RUNTIME = {
    map,
    getState: () => getRuntimeDebugState(),
    getHeadingState: () => getHeadingState(getHeadingNowMs()),
    refreshHeadingCone: () => {
      refreshHeadingConeFromState();
      return getHeadingState(getHeadingNowMs());
    },
    renderHeadingConeFrame: () => renderHeadingConeFrame(getHeadingNowMs()),
    loadForView,
    locateUser,
    startHeadingConeRenderLoop,
    startDeviceOrientationWatch,
  };
}

function syncHeadingFromLocation(latlng, gpsHeading, speed, nowMs = getHeadingNowMs()) {
  updateStoredHeadingSpeed(speed);

  if (lastSensorHeading !== null && hasFreshHeadingSensorData(lastSensorHeadingAt, nowMs, HEADING_SENSOR_STALE_AFTER_MS)) {
    return refreshHeadingConeWithEffectiveHeading(latlng, lastKnownHeadingSpeed, nowMs);
  }

  const normalizedGpsHeading = normalizeHeadingDegrees(gpsHeading);
  if (normalizedGpsHeading === null) {
    lastKnownHeading = null;
    lastKnownHeadingSource = null;
    return refreshHeadingConeWithEffectiveHeading(latlng, lastKnownHeadingSpeed, nowMs);
  }

  return applyHeadingUpdate(normalizedGpsHeading, {
    latlng,
    speed,
    nowMs,
    timeConstantMs: HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
    source: "gps",
  });
}

function getBlueDotBreathingRadius(timestampMs = 0) {
  const phase = (timestampMs % BLUE_DOT_BREATHING_CYCLE_MS) / BLUE_DOT_BREATHING_CYCLE_MS;
  const pulse = 0.5 - 0.5 * Math.cos(phase * FULL_CYCLE_RADIANS);
  return BLUE_DOT_BASE_RADIUS_PX + BLUE_DOT_BREATHING_AMPLITUDE_PX * pulse;
}

function getBlueDotHaloRadius(baseRadius) {
  return baseRadius * BLUE_DOT_HALO_RADIUS_SCALE;
}

function stopBlueDotBreathingAnimation() {
  if (blueDotBreathingAnimationFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(blueDotBreathingAnimationFrame);
    blueDotBreathingAnimationFrame = null;
  }
}

function startBlueDotBreathingAnimation() {
  if (hasStartedBlueDotBreathingAnimation || typeof window === "undefined") return;
  hasStartedBlueDotBreathingAnimation = true;
  const tick = (timestampMs) => {
    const nextRadius = getBlueDotBreathingRadius(timestampMs);
    if (
      map.getLayer(LAYER_CURRENT_LOCATION_DOT)
      && (
        lastBlueDotBreathingRadius === null
        || Math.abs(nextRadius - lastBlueDotBreathingRadius) >= BLUE_DOT_RADIUS_EPSILON_PX
      )
    ) {
      lastBlueDotBreathingRadius = nextRadius;
      if (map.getLayer(LAYER_CURRENT_LOCATION_HALO)) {
        map.setPaintProperty(
          LAYER_CURRENT_LOCATION_HALO,
          "circle-radius",
          getBlueDotHaloRadius(nextRadius)
        );
      }
      map.setPaintProperty(LAYER_CURRENT_LOCATION_DOT, "circle-radius", nextRadius);
    }
    blueDotBreathingAnimationFrame = window.requestAnimationFrame(tick);
  };
  blueDotBreathingAnimationFrame = window.requestAnimationFrame(tick);
  window.addEventListener("beforeunload", stopBlueDotBreathingAnimation, { once: true });
}

function stopHeadingConeRenderLoop() {
  if (headingConeRenderLoopFrame !== null && typeof window !== "undefined") {
    window.cancelAnimationFrame(headingConeRenderLoopFrame);
    headingConeRenderLoopFrame = null;
  }

  lastHeadingConeLoopFrameAt = null;
  lastHeadingConeLoopTickAt = null;
}

function isHeadingConeRenderLoopActive() {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return false;
  }

  if (typeof document !== "undefined" && !isHeadingRenderLoopDocumentActive(document)) {
    return false;
  }

  return Boolean(
    map
    && typeof map.getLayer === "function"
    && typeof map.getSource === "function"
    && map.getLayer(LAYER_HEADING)
    && map.getSource(SOURCE_HEADING)
  );
}

function queueHeadingConeRenderLoop() {
  if (headingConeRenderLoopFrame !== null || !isHeadingConeRenderLoopActive()) {
    return;
  }

  headingConeRenderLoopFrame = window.requestAnimationFrame((timestampMs) => {
    headingConeRenderLoopFrame = null;

    if (!isHeadingConeRenderLoopActive()) {
      stopHeadingConeRenderLoop();
      return;
    }

    if (
      lastHeadingConeLoopFrameAt !== null
      && timestampMs - lastHeadingConeLoopFrameAt < HEADING_RENDER_LOOP_FRAME_INTERVAL_MS
    ) {
      queueHeadingConeRenderLoop();
      return;
    }

    lastHeadingConeLoopFrameAt = timestampMs;
    renderHeadingConeFrame(getHeadingNowMs());
    queueHeadingConeRenderLoop();
  });
}

function syncHeadingConeRenderLoop() {
  if (!isHeadingConeRenderLoopActive()) {
    stopHeadingConeRenderLoop();
    return;
  }

  if (lastHeadingConeLoopHeading === null) {
    lastHeadingConeLoopHeading = lastRenderedHeadingConeHeading;
  }

  queueHeadingConeRenderLoop();
}

function startHeadingConeRenderLoop() {
  if (hasStartedHeadingConeRenderLoop || typeof window === "undefined") {
    return;
  }

  hasStartedHeadingConeRenderLoop = true;
  const handleLoopActivityChange = () => {
    if (isHeadingConeRenderLoopActive()) {
      lastHeadingConeLoopFrameAt = null;
      lastHeadingConeLoopTickAt = null;
      syncHeadingConeRenderLoop();
      return;
    }

    stopHeadingConeRenderLoop();
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleLoopActivityChange);
  }

  window.addEventListener("focus", handleLoopActivityChange);
  window.addEventListener("blur", handleLoopActivityChange);
  window.addEventListener("beforeunload", stopHeadingConeRenderLoop, { once: true });
  handleLoopActivityChange();
}

function startDeviceOrientationWatch() {
  if (typeof window === "undefined") return;

  ensureCompassUi();

  if (!window.DeviceOrientationEvent) {
    setCompassPermissionState(COMPASS_PERMISSION_UNAVAILABLE_STATE);
    return;
  }

  const resolvedPermissionState = getResolvedCompassPermissionState();
  if (
    resolvedPermissionState === COMPASS_PERMISSION_REQUIRED_STATE
    || resolvedPermissionState === COMPASS_PERMISSION_DENIED_STATE
  ) {
    setCompassPermissionState(resolvedPermissionState);
    return;
  }

  if (hasStartedDeviceOrientationWatch) {
    setCompassPermissionState(resolvedPermissionState);
    return;
  }

  hasStartedDeviceOrientationWatch = true;
  const onOrientationChange = (event) => {
    const sensorReading = getDeviceOrientationReading(event, {
      maxWebkitCompassAccuracyDegrees: HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
      allowRelativeAlphaFallback: ALLOW_RELATIVE_COMPASS_ALPHA_FALLBACK,
    });

    const nowMs = getHeadingNowMs();
    lastSensorEventAt = nowMs;
    lastSensorEventWallClockMs = Date.now();
    lastRawSensorHeading = normalizeHeadingDegrees(sensorReading.rawHeading);
    lastSensorHeadingAccuracy = typeof sensorReading.accuracy === "number" && Number.isFinite(sensorReading.accuracy)
      ? sensorReading.accuracy
      : null;
    lastSensorHeadingKind = sensorReading.source;

    if (sensorReading.heading !== null) {
      lastSensorHeading = sensorReading.heading;
      lastSensorHeadingAt = nowMs;
    }

    updateCompassDebugOverlay(nowMs);
  };

  window.addEventListener("deviceorientationabsolute", onOrientationChange, { passive: true });
  window.addEventListener("deviceorientation", onOrientationChange, { passive: true });
  setCompassPermissionState(resolvedPermissionState);
}

function startContinuousLocationWatch() {
  if (activeContinuousWatchId !== null || !navigator.geolocation) return;

  activeContinuousWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
      setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
      syncHeadingFromLocation(latlng, position.coords.heading, position.coords.speed);
    },
    (error) => {
      console.warn("[DGM] Continuous location watch error:", error.code, error.message);
    },
    {
      enableHighAccuracy: true,
      timeout: CONTINUOUS_WATCH_TIMEOUT_MS,
      maximumAge: LIVE_LOCATION_WATCH_MAXIMUM_AGE_MS,
    }
  );
}

async function refreshActiveRouteFromOrigin(origin, options = {}) {
  if (!activeRoute?.destination) return null;
  const now = Date.now();
  const shouldThrottle = !options.force;
  const movedEnough = !lastRouteOriginForRefresh
    || haversineMeters(
      lastRouteOriginForRefresh.lat,
      lastRouteOriginForRefresh.lng,
      origin.lat,
      origin.lng
    ) >= NAV_REROUTE_MIN_DISTANCE_METERS;

  if (shouldThrottle) {
    if (!movedEnough) return activeRoute;
    if (now - lastRouteRefreshAt < NAV_REROUTE_MIN_INTERVAL_MS) return activeRoute;
  }

  lastRouteOriginForRefresh = origin;
  lastRouteRefreshAt = now;
  setNavigationStatus("Updating route…", "info");

  if (activeRouteAbort) {
    activeRouteAbort.abort();
  }

  activeRouteAbort = new AbortController();
  const routeResult = await fetchDrivingRoute(origin, activeRoute.destination, { signal: activeRouteAbort.signal });

  activeRoute = {
    ...routeResult,
    origin,
    destination: activeRoute.destination,
  };

  setSourceData(SOURCE_ROUTE, featureCollection([{
    type: "Feature",
    geometry: routeResult.geometry,
    properties: {},
  }]));

  renderNavigationCard(activeRoute);

  if (options.fitToRoute) {
    fitRouteToView(activeRoute);
  }

  return activeRoute;
}

function ensureNavigationWatch() {
  if (!navigator.geolocation || activeNavigationWatchId !== null || !activeRoute?.destination) return;

  activeNavigationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const origin = setCurrentLocationState(
        { lat: position.coords.latitude, lng: position.coords.longitude },
        position.coords.accuracy,
        { openPopup: false }
      );

      refreshActiveRouteFromOrigin(origin, { fitToRoute: false }).catch((error) => {
        if (error?.name === "AbortError") return;
        console.error(error);
        setNavigationStatus(error?.message ?? String(error), "error");
      });
    },
    (error) => {
      setNavigationStatus(describeGeolocationError(error), "error");
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: LIVE_LOCATION_WATCH_MAXIMUM_AGE_MS,
    }
  );
}

async function ensureNavigationOrigin() {
  if (lastCurrentLocation) return lastCurrentLocation;
  if (!navigator.geolocation) {
    throw new Error("Enable location to start an in-app route.");
  }

  const position = await getCurrentPosition();
  return setCurrentLocationState(
    { lat: position.coords.latitude, lng: position.coords.longitude },
    position.coords.accuracy,
    { openPopup: false }
  );
}

async function startInAppNavigation(destination, options = {}) {
  const resolvedDestination = {
    lat: Number(destination?.lat),
    lng: Number(destination?.lng),
    title: String(destination?.title || "Destination"),
  };

  if (!Number.isFinite(resolvedDestination.lat) || !Number.isFinite(resolvedDestination.lng)) {
    throw new Error("Destination coordinates are invalid.");
  }

  setNavigationCardVisible(true);
  if (elNavigationTitle) elNavigationTitle.textContent = resolvedDestination.title;
  if (elNavigationMeta) elNavigationMeta.textContent = "";
  if (elNavigationSteps) elNavigationSteps.innerHTML = "";
  setNavigationStatus(lastCurrentLocation ? "Calculating route…" : "Locating you…", "info");

  const origin = await ensureNavigationOrigin();

  if (activeRouteAbort) {
    activeRouteAbort.abort();
  }

  activeRouteAbort = new AbortController();
  const routeResult = await fetchDrivingRoute(origin, resolvedDestination, { signal: activeRouteAbort.signal });

  activeRoute = {
    ...routeResult,
    origin,
    destination: resolvedDestination,
  };
  lastRouteOriginForRefresh = origin;
  lastRouteRefreshAt = Date.now();

  setSourceData(SOURCE_ROUTE, featureCollection([{
    type: "Feature",
    geometry: routeResult.geometry,
    properties: {},
  }]));

  renderNavigationCard(activeRoute);
  ensureNavigationWatch();

  if (options.fitToRoute !== false) {
    fitRouteToView(activeRoute);
  }

  return activeRoute;
}

function clearInAppNavigation() {
  if (activeRouteAbort) {
    activeRouteAbort.abort();
    activeRouteAbort = null;
  }
  stopNavigationWatch();
  stopNavigationSpeech();
  activeRoute = null;
  lastRouteOriginForRefresh = null;
  lastRouteRefreshAt = 0;
  lastSpokenInstructionKey = "";
  clearRouteOverlay();
  setNavigationStatus("", "info");
  if (elNavigationBanner) elNavigationBanner.hidden = true;
  if (elNavigationBannerInstruction) elNavigationBannerInstruction.textContent = "";
  if (elNavigationBannerMeta) elNavigationBannerMeta.textContent = "";
  if (elNavigationSteps) elNavigationSteps.innerHTML = "";
  if (elNavigationMeta) elNavigationMeta.textContent = "";
  if (elNavigationTitle) elNavigationTitle.textContent = "";
  setNavigationCardVisible(false);
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

function normalizeMapTilerMatch(rawMatch) {
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

async function fetchMapTilerMatches(query, { limit = 5, signal } = {}) {
  const searchUrl = new URL(`${MAPTILER_GEOCODING_API_URL}/${encodeURIComponent(query)}.json`);
  searchUrl.searchParams.set("key", MAPTILER_API_KEY);
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
      .map(normalizeMapTilerMatch)
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
  if (MAPTILER_API_KEY) {
    try {
      const primaryMatches = await fetchMapTilerMatches(query, { limit, signal });
      if (primaryMatches.length) {
        return primaryMatches;
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.warn("MapTiler geocoding failed; falling back to Nominatim.", error);
    }
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

  const marker = new maplibregl.Marker({ color: "#ffbf45" })
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
  if (map.getSource(SOURCE_RESTAURANTS)) return;

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
      "heatmap-radius": 22,
      "heatmap-opacity": 0.85,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(45,108,223,0)",
        0.1, "#2d6cdf",
        0.35, "#00d4ff",
        0.55, "#fff1a8",
        0.75, "#ff9b3d",
        1, "#ff3b3b",
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
    id: LAYER_RESTAURANTS,
    type: "circle",
    source: SOURCE_RESTAURANTS,
    paint: {
      "circle-radius": 4,
      "circle-color": "#ffbf45",
      "circle-stroke-color": "#ffe59a",
      "circle-stroke-width": 1,
      "circle-opacity": 0.85,
    },
  });

  map.addLayer({
    id: LAYER_PARKING,
    type: "circle",
    source: SOURCE_PARKING,
    paint: {
      "circle-radius": 7,
      "circle-color": "#2d6cdf",
      "circle-stroke-color": "#9ad3ff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.7,
    },
  });

  map.addLayer({
    id: LAYER_SPOT,
    type: "circle",
    source: SOURCE_SPOT,
    paint: {
      "circle-radius": 9,
      "circle-color": "#b18bff",
      "circle-stroke-color": "#f4f1ff",
      "circle-stroke-width": 2,
      "circle-opacity": 0.75,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_ACCURACY_FILL,
    type: "fill",
    source: SOURCE_CURRENT_LOCATION_ACCURACY,
    paint: {
      "fill-color": "#2d6cdf",
      "fill-opacity": 0.1,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_ACCURACY_LINE,
    type: "line",
    source: SOURCE_CURRENT_LOCATION_ACCURACY,
    paint: {
      "line-color": "#a7e3ff",
      "line-width": 1,
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
      "circle-radius": getBlueDotHaloRadius(BLUE_DOT_BASE_RADIUS_PX),
      "circle-color": "#6dcdff",
      "circle-opacity": 0.34,
      "circle-blur": 0.68,
    },
  });

  map.addLayer({
    id: LAYER_CURRENT_LOCATION_DOT,
    type: "circle",
    source: SOURCE_CURRENT_LOCATION,
    paint: {
      "circle-radius": BLUE_DOT_BASE_RADIUS_PX,
      "circle-color": "#1da8ff",
      "circle-stroke-color": "#f7fdff",
      "circle-stroke-width": 3.6,
      "circle-opacity": 0.98,
    },
  });

  if (!hasBoundLayerEvents) {
    hasBoundLayerEvents = true;

    for (const layerId of [LAYER_RESTAURANTS, LAYER_PARKING, LAYER_CURRENT_LOCATION_DOT]) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    map.on("click", LAYER_RESTAURANTS, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;

      const restaurant = restaurantById.get(feature.properties?.id);
      if (!restaurant) return;

      const name = restaurant.tags?.name || restaurant.tags?.brand || "Food place";
      const amenity = restaurant.tags?.amenity || "";
      openPopupAtLngLat(event.lngLat, `<div class="popup-friendly"><b>${escapeHtml(name)}</b><div class="popup-detail">${escapeHtml(amenity)}</div>${renderNavigationAction(restaurant.lat, restaurant.lon, "Route here", name)}</div>`, { closeButton: true });
    });

    map.on("click", LAYER_PARKING, (event) => {
      const feature = event.features?.[0];
      if (!feature) return;

      const parking = parkingById.get(feature.properties?.id);
      if (!parking) return;

      const name = parking.tags?.name || parking.tags?.operator || "Parking";
      openPopupAtLngLat(event.lngLat, renderParkingPopupHtml(parking, name, lastRestaurants, lastParams.tauMeters, lastParams.hour));
    });

    map.on("click", LAYER_CURRENT_LOCATION_DOT, () => {
      if (!lastCurrentLocation) return;
      openPopupAtLngLat(lastCurrentLocation, `You are here<br/><span class="mono">Accuracy ±${Math.round(Number(lastCurrentLocationAccuracyMeters) || 0)} m</span>`);
    });
  }
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
  elMinSepVal.textContent = `${Number(elMinSep.value)} m`;
}

function setWeatherStatus(message) {
  if (!elWeatherStatus) return;
  elWeatherStatus.textContent = String(message || "").trim();
}

function setCensusStatus(message) {
  if (!elCensusStatus) return;
  elCensusStatus.textContent = String(message || "").trim();
}

function updateCensusUi() {
  const useCensusData = elUseCensusData ? Boolean(elUseCensusData.checked) : false;
  if (!useCensusData) {
    lastCensusResidentialAnchors = [];
    lastCensusDataset = null;
    setCensusStatus("Census tract anchors off. Using OSM residential anchors only.");
    return;
  }

  setCensusStatus(
    lastCensusResidentialAnchors.length
      ? formatCensusSourceSummary(lastCensusDataset, lastCensusResidentialAnchors)
      : "Static Census tract anchors for the default Rancho/Ontario region will be blended into residential demand when they overlap the current view."
  );
}

function updateWeatherUi() {
  const useLiveWeather = elUseLiveWeather ? Boolean(elUseLiveWeather.checked) : false;

  if (elRainBoost) {
    elRainBoost.disabled = useLiveWeather;
    elRainBoost.setAttribute("aria-disabled", String(useLiveWeather));
  }

  if (useLiveWeather) {
    setWeatherStatus(
      lastWeatherSignal
        ? formatWeatherSourceSummary(lastWeatherSignal)
        : "Live weather will be fetched from Open-Meteo on refresh. If it fails, the manual rain lift slider remains the fallback."
    );
    return;
  }

  lastWeatherSignal = null;
  setWeatherStatus("Live weather off. Using the manual rain lift slider.");
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
elUseMIP.addEventListener("change", updateLabels);
elKSpots.addEventListener("input", updateLabels);
elMinSep.addEventListener("input", updateLabels);

elShowRestaurants.addEventListener("change", () => {
  setLayerVisibility(LAYER_RESTAURANTS, elShowRestaurants.checked);
});

elShowParking.addEventListener("change", () => {
  setLayerVisibility(LAYER_PARKING, elShowParking.checked);
});

function clampQueryBounds(originalBounds) {
  // Overpass frequently 504s on large bounding boxes.
  // Clamp to a square around the center to keep queries light.
  const sw = originalBounds.getSouthWest();
  const ne = originalBounds.getNorthEast();
  const diagMeters = haversineMeters(sw.lat, sw.lng, ne.lat, ne.lng);
  const maxDiagMeters = 12000; // ~12 km diagonal
  if (diagMeters <= maxDiagMeters) return originalBounds;

  // Show a persistent badge instead of a one-shot alert (m6).
  setDataStatus("Query area clamped to ~12 km diagonal — zoom in for full coverage", "warn");

  const center = lngLatToObject(map.getCenter());
  return boundsAroundCenter(center, maxDiagMeters / 2);
}

// --- Data-freshness UI helpers (C2 / m6) ---

function setDataStatus(msg, level) {
  const el = document.getElementById("dataStatus");
  if (!el) return;

  el.textContent = msg;
  el.className = msg ? `data-status data-status--${level}` : "";
}

function checkDataFreshness() {
  if (!lastLoadedBounds || !lastStats) {
    setDataStatus("", "");
    return;
  }

  const current = mapBoundsToAdapter(map.getBounds());

  if (!lastLoadedBounds.intersects(current)) {
    setDataStatus("Data stale — reload for this area", "warn");
  } else if (!lastLoadedBounds.contains(current)) {
    setDataStatus("View extends beyond loaded data — reload to refresh edges", "info");
  } else {
    setDataStatus("OSM data loaded for this view", "ok");
  }
}

function clearLayers() {
  restaurantById.clear();
  parkingById.clear();
  lastResidentialAnchors = [];
  lastCensusResidentialAnchors = [];
  lastCensusDataset = null;
  lastHeatFeatures = [];
  lastSpotPoint = null;

  setSourceData(SOURCE_RESTAURANTS, featureCollection());
  setSourceData(SOURCE_PARKING, featureCollection());
  setSourceData(SOURCE_HEAT, featureCollection());
  setSourceData(SOURCE_SPOT, featureCollection());

  closeActivePopup();

  elParkingList.innerHTML = "";
  if (elSummaryCards) elSummaryCards.innerHTML = "";

  lastLoadedBounds = null;
  setDataStatus("", "");
}

function syncPanelState(isOpen) {
  if (!panel) return;

  panel.classList.toggle("open", isOpen);

  if (menuButton) {
    menuButton.setAttribute("aria-expanded", String(isOpen));
  }

  setTimeout(() => {
    if (map) map.resize();
  }, 250);
}

function closePanelIfOpen() {
  if (!panel?.classList.contains("open")) return false;

  syncPanelState(false);
  closeActivePopup();
  return true;
}

function setLocateButtonState(isLoading) {
  if (!elLocateMe) return;

  isLocating = isLoading;
  elLocateMe.disabled = isLoading;
  elLocateMe.setAttribute("aria-busy", String(isLoading));
  elLocateMe.textContent = isLoading ? "..." : "ME";
}

function setCurrentLocationFollowEnabled(isEnabled) {
  isFollowingCurrentLocation = Boolean(isEnabled);
}

function syncMapToCurrentLocation(latlng, { force = false } = {}) {
  if (!isFollowingCurrentLocation || !latlng || !map) {
    return;
  }

  const resolvedLatLng = lngLatToObject(latlng);
  const mapCenter = map.getCenter();
  const centerOffsetMeters = haversineMeters(
    mapCenter.lat,
    mapCenter.lng,
    resolvedLatLng.lat,
    resolvedLatLng.lng
  );

  if (!force && centerOffsetMeters < AUTO_FOLLOW_LOCATION_MIN_CENTER_OFFSET_METERS) {
    return;
  }

  map.easeTo({
    center: [resolvedLatLng.lng, resolvedLatLng.lat],
    duration: force ? LOCATION_FLY_DURATION_MS : AUTO_FOLLOW_LOCATION_PAN_DURATION_MS,
  });
}

function describeGeolocationError(error) {
  if (!error) return "Unable to determine your location.";
  if (error.code === error.PERMISSION_DENIED) return "Location access was denied. Enable location permission and try again.";
  if (error.code === error.POSITION_UNAVAILABLE) return "Your current position is unavailable right now. Try again in a moment.";
  if (error.code === error.TIMEOUT) return "Location lookup timed out. Try again with a stronger signal.";
  return error.message || "Unable to determine your location.";
}

function showCurrentLocation(latlng, accuracyMeters) {
  const currentLngLat = setCurrentLocationState(latlng, accuracyMeters, { openPopup: true });
  if (activeRoute?.destination) {
    refreshActiveRouteFromOrigin(currentLngLat, { fitToRoute: false, force: true }).catch((error) => console.error(error));
  }
  return currentLngLat;
}

function shouldAnimateLocate(latlng) {
  return map.getZoom() >= LOCATION_ANIMATION_MIN_START_ZOOM
    && haversineMeters(map.getCenter().lat, map.getCenter().lng, latlng.lat, latlng.lng) <= LOCATION_ANIMATION_MAX_DISTANCE_METERS;
}

function animateZoomToTarget(targetZoom, onComplete) {
  const currentZoom = map.getZoom();

  if (currentZoom >= targetZoom) {
    onComplete();
    return;
  }

  const nextZoom = Math.min(targetZoom, currentZoom + LOCATION_ZOOM_STEP);

  map.once("zoomend", () => {
    animateZoomToTarget(targetZoom, onComplete);
  });

  map.easeTo({ zoom: nextZoom, duration: 400 });
}

function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported in this browser."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 60000,
      ...options,
    });
  });
}

function clampMapZoom(zoom) {
  const minZoom = Number.isFinite(map.getMinZoom()) ? map.getMinZoom() : 0;
  const maxZoom = Number.isFinite(map.getMaxZoom()) ? map.getMaxZoom() : zoom;
  return Math.max(minZoom, Math.min(maxZoom, zoom));
}

async function centerMapOnInitialLocationOnce() {
  if (hasRequestedInitialLocation) return;
  hasRequestedInitialLocation = true;

  if (!navigator.geolocation) return;

  try {
    const position = await getCurrentPosition({
      enableHighAccuracy: false,
      timeout: INITIAL_LOCATION_TIMEOUT_MS,
      maximumAge: 300000,
    });

    map.jumpTo({
      center: [position.coords.longitude, position.coords.latitude],
      zoom: clampMapZoom(INITIAL_LOCATION_ZOOM),
    });
  } catch (error) {
    console.info("Initial geolocation unavailable.", error);
  }
}

async function locateUser() {
  if (isLocating) return;

  // If continuous tracking already has a known position, just recenter — no new GPS call needed.
  if (lastCurrentLocation) {
    setCurrentLocationFollowEnabled(true);
    closePanelIfOpen();
    const latlng = { lat: lastCurrentLocation.lat, lng: lastCurrentLocation.lng };
    const targetZoom = clampMapZoom(LOCATION_TARGET_ZOOM);
    const animateLocate = shouldAnimateLocate(latlng);
    if (animateLocate) {
      map.flyTo({ center: [latlng.lng, latlng.lat], zoom: targetZoom, duration: LOCATION_FLY_DURATION_MS });
    } else {
      map.once("moveend", () => {
        animateZoomToTarget(targetZoom, () => {});
      });
      map.easeTo({ center: [latlng.lng, latlng.lat], duration: LOCATION_PAN_DURATION_SECONDS * 1000 });
    }
    return;
  }

  if (!navigator.geolocation) {
    alert("Geolocation is not supported in this browser.");
    return;
  }

  setLocateButtonState(true);

  try {
    const position = await getCurrentPosition();
    const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
    setCurrentLocationFollowEnabled(true);

    const animateLocate = shouldAnimateLocate(latlng);
    const targetZoom = clampMapZoom(LOCATION_TARGET_ZOOM);

    closePanelIfOpen();
    setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
    syncHeadingFromLocation(latlng, position.coords.heading, position.coords.speed);

    if (animateLocate) {
      map.flyTo({ center: lngLatToArray(latlng), zoom: targetZoom, duration: LOCATION_FLY_DURATION_MS });
    } else {
      map.once("moveend", () => {
        animateZoomToTarget(targetZoom, () => {});
      });
      map.easeTo({ center: lngLatToArray(latlng), duration: LOCATION_PAN_DURATION_SECONDS * 1000 });
    }
  } catch (error) {
    alert(describeGeolocationError(error));
  } finally {
    setLocateButtonState(false);
  }
}

function openStatsPopupAtLatLng(latlng) {
  if (!latlng) return;

  if (closePanelIfOpen()) {
    return;
  }

  if (!lastRestaurants || lastRestaurants.length === 0) {
    openPopupAtLngLat(latlng, "Load data first (click ‘Load / Refresh for current view’).", { closeButton: true });
    return;
  }

  const { hour, tauMeters } = lastParams;
  setSpotMarker(latlng);
  openPopupAtLngLat(
    latlng,
    renderSpotPopupHtml(latlngToObject(latlng), lastRestaurants, tauMeters, hour),
    { closeButton: true }
  );
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

function renderSummaryCards(rankedParking, restaurants, parking, residentialAnchors, censusAnchors = []) {
  if (!elSummaryCards) return;

  if (!rankedParking.length) {
    elSummaryCards.innerHTML = "";
    return;
  }

  const best = rankedParking[0];
  const bestRange = formatProbabilityRange(getProbabilityLow(best), getProbabilityHigh(best));
  const typicalRange = formatProbabilityRange(
    lastStats?.medianProbabilityLow ?? lastStats?.medianScore ?? 0,
    lastStats?.medianProbabilityHigh ?? lastStats?.medianScore ?? 0,
  );
  const hotRange = formatProbabilityRange(
    lastStats?.topDecileProbabilityLow ?? lastStats?.topDecileScore ?? 0,
    lastStats?.topDecileProbabilityHigh ?? lastStats?.topDecileScore ?? 0,
  );
  const bucketLabel = lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label;

  elSummaryCards.innerHTML = `
<article class="summary-card">
  <span class="summary-label">Best visible 10-minute field</span>
  <strong>${bestRange}</strong>
  <p>The strongest visible waiting point is modeled at <b>${bestRange}</b> for a good order in the next ${PROBABILITY_HORIZON_MINUTES} minutes. ${describeSignal(getProbabilityMid(best))}.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Field spread in this view</span>
  <strong>${typicalRange} typical · ${hotRange} hot zones</strong>
  <p>A typical point in this view sits around ${typicalRange}. The strongest visible zones sit around ${hotRange}, which tells you how separated the current probability field is.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Why the best spot rates well</span>
  <strong>${escapeHtml(best.explain?.merchantShare ?? `${bucketLabel} probability read`)}</strong>
  <p>${escapeHtml(best.explain?.residentialShare ?? "")}${best.explain?.relativeIntensity ? ` ${escapeHtml(best.explain.relativeIntensity)}` : ""}${best.explain?.rainLiftPercent ? ` ${escapeHtml(best.explain.rainLiftPercent)}` : ""}</p>
</article>

<article class="summary-card">
  <span class="summary-label">Data loaded</span>
  <strong>${restaurants.length} restaurants · ${residentialAnchors.length} residential anchors · ${censusAnchors.length} Census tracts · ${parking.length} parking lots</strong>
  <p>This probability field is built from ${restaurants.length} restaurants, ${residentialAnchors.length} residential anchors, ${censusAnchors.length} nearby Census tracts, and ${parking.length} parking lots visible on the map. ${escapeHtml(lastWeatherSignal ? formatWeatherSourceSummary(lastWeatherSignal) : "Manual rain lift is active.")} Zoom in for a tighter local read.</p>
</article>
`;
}

function addRestaurantMarkers(restaurants) {
  restaurantById.clear();

  const features = restaurants.map((restaurant) => {
    restaurantById.set(restaurant.id, restaurant);

    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [restaurant.lon, restaurant.lat],
      },
      properties: {
        id: restaurant.id,
      },
    };
  });

  setSourceData(SOURCE_RESTAURANTS, featureCollection(features));
}

function addParkingMarkers(rankedParking, restaurants, tauMeters, hour) {
  parkingById.clear();

  const features = rankedParking.map((parking) => {
    parkingById.set(parking.id, parking);

    return {
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [parking.lon, parking.lat],
      },
      properties: {
        id: parking.id,
      },
    };
  });

  setSourceData(SOURCE_PARKING, featureCollection(features));
}

function renderParkingPopupHtml(p, name, restaurants, tauMeters, hour) {
  const likely = topLikelyMerchantsForParking(p, restaurants, tauMeters, hour, 6);

  const rows = likely
    .map((x) => `<li>${escapeHtml(x.name)} <span class="mono">(${escapeHtml(x.amenity)}, ${x.distMeters}m)</span></li>`)
    .join("");

  return `
<div class="popup-friendly">
  <b>${escapeHtml(name)}</b>
  <div class="popup-score">${formatProbabilityRange(getProbabilityLow(p), getProbabilityHigh(p))}<span class="popup-score-label"> 10-minute probability of a good order</span></div>
  <div class="popup-explain">${escapeHtml(describeSignal(getProbabilityMid(p)))}</div>
  <div class="popup-rank">${escapeHtml(formatRelativeRank(p))}</div>
  <div class="popup-detail">Uncertainty band (λ ±30%): ${formatProbabilityRange(getProbabilityLow(p), getProbabilityHigh(p))} · ${escapeHtml(describeProbabilityBand(p))}</div>
  <div class="popup-detail">${escapeHtml(describePickup(p.expectedDistMeters))}</div>
  ${renderExplainabilityDetails(p)}

  ${renderNavigationAction(p.lat, p.lon, "Route here", name)}

  <hr/>

  <div><b>Closest restaurants</b></div>
  <ol style="margin:6px 0 0 18px; padding:0;">${rows}</ol>
</div>
`;
}

function renderSpotPopupHtml(latlng, restaurants, tauMeters, hour) {
  const params = {
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

  const r = probabilityOfGoodOrder(
    { lat: latlng.lat, lon: latlng.lng }, // Leaflet uses .lng; model uses .lon — mapping here
    restaurants,
    lastParkingCandidates,
    params
  );

  const likely = topLikelyMerchantsForParking(
    { lat: latlng.lat, lon: latlng.lng, tags: { name: "Selected spot" } },
    restaurants,
    tauMeters,
    hour,
    6
  );

  const rows = likely
    .map((x) => `<li>${escapeHtml(x.name)} <span class="mono">(${escapeHtml(x.amenity)}, ${x.distMeters}m)</span></li>`)
    .join("");

  return `
<div class="popup-friendly">
  <b>Spot you clicked</b>${lastStats === null ? ' <span style="color:#f5c542">(load data first for accurate scores)</span>' : ""}

  <div class="popup-score">${formatProbabilityRange(getProbabilityLow(r), getProbabilityHigh(r))}<span class="popup-score-label"> 10-minute probability of a good order</span></div>
  <div class="popup-explain">${escapeHtml(describeSignal(getProbabilityMid(r)))}</div>
  <div class="popup-rank">${escapeHtml(formatRelativeRank(r))}</div>
  <div class="popup-detail">Uncertainty band (λ ±30%): ${formatProbabilityRange(getProbabilityLow(r), getProbabilityHigh(r))} · ${escapeHtml(describeProbabilityBand(r))}</div>
  <div class="popup-detail">${escapeHtml(describePickup(r.expectedDistMeters))}</div>
  ${renderExplainabilityDetails(r)}

  ${renderNavigationAction(latlng.lat, latlng.lng, "Route here", "Selected spot")}

  <hr/>

  <div><b>Closest restaurants</b></div>
  <ol style="margin:6px 0 0 18px; padding:0;">${rows}</ol>
</div>
`;
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
    properties: {},
  }]));

  return point;
}

function renderParkingList(rankedParking) {
  elParkingList.innerHTML = "";

  for (const p of rankedParking) {
    const name = p.tags?.name || p.tags?.operator || "Parking";

    const li = document.createElement("li");
    const btn = document.createElement("button");

    btn.innerHTML = `
  <span class="list-title">${escapeHtml(name)} — ${escapeHtml(formatProbabilityRange(getProbabilityLow(p), getProbabilityHigh(p)))}</span>
  <span class="list-meta">10-minute good-order probability range</span>
  <span class="list-meta">${escapeHtml(describeSignal(getProbabilityMid(p)))}</span>
<span class="list-meta">${escapeHtml(formatRelativeRank(p))}</span>
<span class="list-meta">${escapeHtml(describePickup(p.expectedDistMeters))}</span>
  <span class="list-meta">${escapeHtml(p.explain?.relativeIntensity ?? "")}</span>
`;

    btn.addEventListener("click", () => {
      map.easeTo({
        center: [p.lon, p.lat],
        zoom: Math.max(map.getZoom(), 15),
        duration: 700,
      });
    });

    li.appendChild(btn);
    elParkingList.appendChild(li);
  }
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
  if (activeAbort) activeAbort.abort();

  activeAbort = new AbortController();

  elLoad.disabled = true;
  elLoad.textContent = "Loading OSM data…";

  try {
    clearLayers();

    const hour = Number(elHour.value);
    const tauMeters = Number(elTau.value);
    const gridStepMeters = Number(elGrid.value);
    const horizonMin = PROBABILITY_HORIZON_MINUTES;
    const competitionStrength = Number(elCompetition.value);
    const residentialDemandWeight = Number(elResidentialWeight.value);
    const useCensusData = elUseCensusData ? Boolean(elUseCensusData.checked) : false;
    const useLiveWeather = elUseLiveWeather ? Boolean(elUseLiveWeather.checked) : false;
    let rainBoost = Number(elRainBoost.value);
    const tipEmphasis = Number(elTipEmphasis.value);
    const useML = Boolean(elUseML.checked);
    const mlBeta = Number(elMlBeta.value);
    let useMIP = Boolean(elUseMIP.checked);
    const kSpots = Number(elKSpots.value);
    const minSepMeters = Number(elMinSep.value);

    if (useMIP && !isMipAvailable()) {
      useMIP = false;
      elUseMIP.checked = false;

      console.warn("MIP solver not available; falling back to the coverage-diversity selector.");

      alert(
        "MIP solver couldn’t load (CDN blocked/offline). Falling back to the coverage-diversity selector.\n\nIf you want MIP, allow loading: https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js"
      );
    }

    lastParams = {
      hour,
      tauMeters,
      horizonMin,
      competitionStrength,
      residentialDemandWeight,
      rainBoost,
      useCensusData,
      useLiveWeather,
      tipEmphasis,
      predictionModel: PREDICTION_MODEL,
      useML,
      mlBeta,
      useMIP,
      kSpots,
      minSepMeters,
    };

    const bbox = mapBoundsToAdapter(map.getBounds());
    const queryBounds = clampQueryBounds(bbox);
    const weatherPoint = lngLatToObject(lastCurrentLocation || map.getCenter());
    const censusPromise = useCensusData
      ? fetchCensusResidentialAnchors(queryBounds, activeAbort.signal)
        .then((result) => ({ ok: true, ...result }))
        .catch((error) => ({ ok: false, error }))
      : Promise.resolve({ ok: false, skipped: true, anchors: [] });
    const weatherPromise = useLiveWeather
      ? fetchCurrentWeatherSignal(weatherPoint, activeAbort.signal)
        .then((weatherSignal) => ({ ok: true, weatherSignal }))
        .catch((error) => ({ ok: false, error }))
      : Promise.resolve({ ok: false, skipped: true });

    const [allRestaurants, parking, residentialAnchors, censusResult, weatherResult] = await Promise.all([
      fetchFoodPlaces(queryBounds, activeAbort.signal),
      fetchParkingCandidates(queryBounds, activeAbort.signal),
      fetchResidentialAnchors(queryBounds, activeAbort.signal),
      censusPromise,
      weatherPromise,
    ]);

    const censusResidentialAnchors = censusResult?.ok && Array.isArray(censusResult.anchors)
      ? censusResult.anchors
      : [];
    if (censusResult?.ok) {
      lastCensusDataset = censusResult.dataset || null;
      lastCensusResidentialAnchors = censusResidentialAnchors;
      setCensusStatus(formatCensusSourceSummary(lastCensusDataset, censusResidentialAnchors));
    } else if (useCensusData && censusResult && !censusResult.skipped) {
      lastCensusDataset = null;
      lastCensusResidentialAnchors = [];
      console.warn("[DGM] Census data load failed:", censusResult.error);
      setCensusStatus("Census tract anchors unavailable. Using OSM residential anchors only.");
    }

    if (weatherResult?.ok && weatherResult.weatherSignal) {
      lastWeatherSignal = weatherResult.weatherSignal;
      rainBoost = weatherResult.weatherSignal.rainBoost;
      elRainBoost.value = rainBoost.toFixed(2);
      updateLabels();
    } else if (useLiveWeather && weatherResult && !weatherResult.skipped) {
      lastWeatherSignal = null;
      console.warn("[DGM] Live weather fetch failed:", weatherResult.error);
      setWeatherStatus("Live weather unavailable. Using the manual rain lift slider.");
    }

    // Freeze local time once so hours-based eligibility stays consistent for this refresh.
    const restaurants = filterOpenRestaurants(allRestaurants, new Date());
    const combinedResidentialAnchors = [...residentialAnchors, ...censusResidentialAnchors];

    lastRestaurants = restaurants;
    lastParkingCandidates = parking;
    lastResidentialAnchors = combinedResidentialAnchors;

    addRestaurantMarkers(restaurants);

    const heatResult = buildGridProbabilityHeat(
      queryBounds,
      restaurants,
      parking,
      {
        hour,
        tauMeters,
        horizonMin,
        competitionStrength,
        residentialAnchors: combinedResidentialAnchors,
        residentialDemandWeight,
        rainBoost,
        tipEmphasis,
        predictionModel: PREDICTION_MODEL,
        useML,
        mlBeta,
      },
      gridStepMeters
    );

    lastStats = heatResult.stats;
    lastLoadedBounds = queryBounds;

    checkDataFreshness();

    const heatFeatures = heatResult.heatPoints.map(([lat, lon, intensity]) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [lon, lat],
      },
      properties: {
        intensity,
      },
    }));

    lastHeatFeatures = heatFeatures;
    setSourceData(SOURCE_HEAT, featureCollection(heatFeatures));

    const rankedAll = rankParking(
      parking,
      restaurants,
      parking,
      {
        hour,
        tauMeters,
        horizonMin,
        competitionStrength,
        residentialAnchors: combinedResidentialAnchors,
        residentialDemandWeight,
        rainBoost,
        tipEmphasis,
        predictionModel: PREDICTION_MODEL,
        useML,
        mlBeta,
      },
      lastStats,
      Math.max(parking.length, 1)
    );

    const coverageTauMeters = Math.max(300, tauMeters);
    const demandNodes = buildDemandCoverageNodes(restaurants, {
      hour,
      dayOfWeek: lastStats?.dayOfWeek,
      residentialAnchors: combinedResidentialAnchors,
      residentialDemandWeight,
    });

    const ranked = useMIP
      ? optimizeParkingSet(rankedAll, { k: kSpots, minSepMeters, maxCandidates: 40 })
      : selectParkingSetSubmodular(rankedAll, {
        k: kSpots,
        demandNodes,
        coverageTauMeters,
      });

    if (SHADOW_LEARNED_MODEL && PREDICTION_MODEL !== "glm") {
      const shadowRankedAll = rankParking(
        parking,
        restaurants,
        parking,
        {
          hour,
          tauMeters,
          horizonMin,
          competitionStrength,
          residentialAnchors,
          residentialDemandWeight,
          rainBoost,
          tipEmphasis,
          predictionModel: "glm",
          useML,
          mlBeta,
        },
        lastStats,
        Math.max(parking.length, 1)
      );

      console.info("[DGM] learned-model shadow audit", {
        activeModel: PREDICTION_MODEL,
        topLegacyIds: rankedAll.slice(0, 5).map((candidate) => candidate.id),
        topShadowIds: shadowRankedAll.slice(0, 5).map((candidate) => candidate.id),
        meanAbsTopDelta: rankedAll.slice(0, 10).reduce((sum, candidate, index) => {
          const shadowCandidate = shadowRankedAll[index];
          return sum + Math.abs((candidate?.pGood ?? 0) - (shadowCandidate?.pGood ?? 0));
        }, 0) / Math.max(1, Math.min(10, rankedAll.length, shadowRankedAll.length)),
      });
    }

    if (useMIP) {
      const shadowRanked = selectParkingSetSubmodular(rankedAll, {
        k: kSpots,
        demandNodes,
        coverageTauMeters,
        maxCandidates: 60,
      });

      console.info("[DGM] selection shadow audit", {
        activeMode: "mip",
        activeCoverage: evaluateParkingCoverage(ranked, demandNodes, { coverageTauMeters }),
        shadowMode: "submodular",
        shadowCoverage: evaluateParkingCoverage(shadowRanked, demandNodes, { coverageTauMeters }),
        activeUtility: ranked.reduce((sum, candidate) => sum + (candidate.pGood ?? 0), 0),
        shadowUtility: shadowRanked.reduce((sum, candidate) => sum + (candidate.pGood ?? 0), 0),
      });
    }

    addParkingMarkers(ranked, restaurants, tauMeters, hour);
    renderParkingList(ranked);
    renderSummaryCards(ranked, restaurants, parking, residentialAnchors, censusResidentialAnchors);
    updateCensusUi();
    updateWeatherUi();

    setLayerVisibility(LAYER_RESTAURANTS, elShowRestaurants.checked);
    setLayerVisibility(LAYER_PARKING, elShowParking.checked);
  } finally {
    elLoad.disabled = false;
    elLoad.textContent = "Load / Refresh for current view";
  }
}

installRuntimeDebugSurface();
installCompassPermissionAutoRequest();

elLoad.addEventListener("click", () => {
  loadForView().catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err?.message ?? String(err)}`);
  });
});

if (elLocateMe) {
  elLocateMe.addEventListener("click", locateUser);
}

if (elStreetMode) {
  elStreetMode.addEventListener("click", () => applyBaseStyle("map"));
}

if (elSatelliteMode) {
  elSatelliteMode.addEventListener("click", () => applyBaseStyle("satellite"));
}

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

if (elNavigationRecenter) {
  elNavigationRecenter.addEventListener("click", () => {
    if (activeRoute) {
      fitRouteToView(activeRoute);
    }
  });
}

if (elNavigationClear) {
  elNavigationClear.addEventListener("click", clearInAppNavigation);
}

if (elNavigationVoice) {
  updateNavigationVoiceButton();
  elNavigationVoice.addEventListener("click", () => {
    setNavigationVoiceEnabled(!navigationVoiceEnabled);
  });
}

map.on("moveend", checkDataFreshness);
map.on("zoom", refreshHeadingConeFromState);
map.on("rotate", refreshHeadingConeFromState);
map.on("dragstart", () => {
  setCurrentLocationFollowEnabled(false);
});
map.on("rotatestart", () => {
  setCurrentLocationFollowEnabled(false);
});
map.on("pitchstart", () => {
  setCurrentLocationFollowEnabled(false);
});

map.on("click", (event) => {
  const featuresAtPoint = map.queryRenderedFeatures(event.point, {
    layers: [LAYER_RESTAURANTS, LAYER_PARKING, LAYER_CURRENT_LOCATION_HALO, LAYER_CURRENT_LOCATION_DOT],
  });

  if (featuresAtPoint.length) return;

  openStatsPopupAtLatLng(event.lngLat);
});

map.on("load", () => {
  ensureMapSourcesAndLayers();
  restoreMapDataSources();
  syncModeButtons();
  ensureCompassUi();
  startContinuousLocationWatch();
  startDeviceOrientationWatch();
  startBlueDotBreathingAnimation();
  startHeadingConeRenderLoop();

  if (menuButton && panel) {
    menuButton.addEventListener("click", () => {
      syncPanelState(!panel.classList.contains("open"));
    });
  }

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
  ensureMapSourcesAndLayers();
  restoreMapDataSources();
  syncModeButtons();
  syncHeadingConeRenderLoop();
});
