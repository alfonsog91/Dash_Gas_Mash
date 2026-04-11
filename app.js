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
} from "./heading_cone.js?v=20260410-heading-damping";
import {
  getLocationCourseHeading,
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
} from "./heading_runtime.js?v=20260410-course-heading";
import {
  fetchCurrentWeatherSignal,
  formatWeatherSourceSummary,
} from "./weather.js?v=20260410-live-weather";
import {
  fetchCensusResidentialAnchors,
  formatCensusSourceSummary,
} from "./census.js?v=20260410-census-data";

const APP_BUILD_ID = "20260410-nav-hotfix";
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
const HEADING_RENDER_LOOP_MAP_BEARING_SMOOTHING_TIME_MS = 240;
const HEADING_RENDER_LOOP_GPS_SMOOTHING_TIME_MS = 180;
const HEADING_RENDER_LOOP_MIN_DELTA_DEGREES = 1.5;
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

let activePopup = null;
let activeAbort = null;
let lastCurrentLocation = null;
let lastCurrentLocationAccuracyMeters = null;
let lastHeatFeatures = [];
let lastSpotPoint = null;
let lastRankedParkingAll = [];
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
let navigationCameraMode = "browse";
let navigationCameraModeAutoArrival = false;
let lastNavigationCameraSyncAt = 0;
let navigationVoiceEnabled = true;
let lastSpokenInstructionKey = "";
let lastNavigationStatusMessage = "";
let lastNavigationStatusTone = "info";
let isRoutePopupVisible = false;
let shouldOpenRoutePopupOnNextRender = false;

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
const elMain = document.getElementById("main");
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
const NAVIGATION_CAMERA_MIN_BEARING_DELTA_DEGREES = 4;
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
let compassPermissionButton = null;
let compassDebugToggleButton = null;
let compassDebugOverlay = null;
let compassDebugOverlayBody = null;
let isCompassDebugOverlayVisible = COMPASS_DEBUG_MODE_ENABLED;
let isFollowingCurrentLocation = isTouchInteractionDevice();
let pendingMapTapPopupTimer = null;
let lastMapTouchStartAt = 0;
let suppressMapTapPopupUntil = 0;
let placeSheetRoot = null;
let placeSheetBody = null;
let activePlaceSheetState = null;
let placeSheetCompareBaseline = null;
let activePlaceSheetRouteAbort = null;
let comparePlaceSheetRouteAbort = null;

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
  closePlaceSheet();
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
    const routeModeButton = event.target.closest("[data-route-camera-mode]");
    if (routeModeButton && popupElement.contains(routeModeButton)) {
      event.preventDefault();
      if (!activeRoute) return;

      const nextMode = String(routeModeButton.dataset.routeCameraMode || "driver");
      if (nextMode === "overview") {
        showActiveRouteOverview();
      } else if (nextMode === "arrival") {
        showActiveRouteArrivalView();
      } else {
        focusActiveNavigationCamera({ force: true, mode: "driver" });
      }
      return;
    }

    const routeVoiceToggle = event.target.closest("[data-route-voice-toggle]");
    if (routeVoiceToggle && popupElement.contains(routeVoiceToggle)) {
      event.preventDefault();
      setNavigationVoiceEnabled(!navigationVoiceEnabled);
      if (activeRoute) {
        syncRoutePopup(activeRoute, { forceOpen: isRoutePopupVisible });
      }
      return;
    }

    const routeClearButton = event.target.closest("[data-route-clear]");
    if (routeClearButton && popupElement.contains(routeClearButton)) {
      event.preventDefault();
      clearInAppNavigation();
      return;
    }

    const restaurantButton = event.target.closest("[data-place-sheet-restaurant-id]");
    if (restaurantButton && popupElement.contains(restaurantButton)) {
      event.preventDefault();
      const restaurant = restaurantById.get(restaurantButton.dataset.placeSheetRestaurantId);
      if (restaurant) {
        openPopupAtLngLat(
          { lat: restaurant.lat, lng: restaurant.lon },
          renderRestaurantPopupHtml(restaurant),
          { closeButton: true }
        );
      }
      return;
    }

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
      openPopupAtLngLat(
        {
          lat: Number(routeButton.dataset.routeLat),
          lng: Number(routeButton.dataset.routeLng),
        },
        `<div class="popup-sheet popup-friendly"><div class="popup-header"><div class="popup-kicker">Route</div><div class="popup-title">Could not start route</div><div class="popup-subtitle">${escapeHtml(error?.message ?? String(error))}</div></div></div>`,
        { closeButton: true }
      );
    });
  };

  popupElement.addEventListener("click", popupActionHandler);

  popup.on("close", () => {
    popupElement.removeEventListener("click", popupActionHandler);
    if (popup.__dgmPopupType === "route") {
      isRoutePopupVisible = false;
      shouldOpenRoutePopupOnNextRender = false;
    }
    if (activePopup === popup) {
      activePopup = null;
    }
  });

  activePopup = popup;

  return activePopup;
}

function abortActivePlaceSheetRouteSummary() {
  if (activePlaceSheetRouteAbort) {
    activePlaceSheetRouteAbort.abort();
    activePlaceSheetRouteAbort = null;
  }
}

function abortComparePlaceSheetRouteSummary() {
  if (comparePlaceSheetRouteAbort) {
    comparePlaceSheetRouteAbort.abort();
    comparePlaceSheetRouteAbort = null;
  }
}

function updatePlaceSheetRouteSummary(stateKey, patch) {
  let didUpdate = false;

  if (activePlaceSheetState?.key === stateKey) {
    activePlaceSheetState = { ...activePlaceSheetState, ...patch };
    didUpdate = true;
  }

  if (placeSheetCompareBaseline?.key === stateKey) {
    placeSheetCompareBaseline = { ...placeSheetCompareBaseline, ...patch };
    didUpdate = true;
  }

  if (didUpdate) {
    renderActivePlaceSheet();
  }
}

function queueActivePlaceSheetRouteSummary() {
  abortActivePlaceSheetRouteSummary();

  if (!activePlaceSheetState || !lastCurrentLocation) {
    return;
  }

  const controller = new AbortController();
  const stateKey = activePlaceSheetState.key;
  const destination = { lat: activePlaceSheetState.lat, lng: activePlaceSheetState.lng };
  activePlaceSheetRouteAbort = controller;

  fetchDrivingRoute(lastCurrentLocation, destination, { signal: controller.signal })
    .then((route) => {
      if (activePlaceSheetRouteAbort === controller) {
        activePlaceSheetRouteAbort = null;
      }

      updatePlaceSheetRouteSummary(stateKey, {
        routeStatus: "ready",
        routeError: "",
        routeSummary: {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
        },
      });
    })
    .catch((error) => {
      if (activePlaceSheetRouteAbort === controller) {
        activePlaceSheetRouteAbort = null;
      }

      if (error?.name === "AbortError") {
        return;
      }

      updatePlaceSheetRouteSummary(stateKey, {
        routeStatus: "error",
        routeError: error?.message ?? String(error),
        routeSummary: null,
      });
    });
}

function queueComparePlaceSheetRouteSummary() {
  abortComparePlaceSheetRouteSummary();

  if (!placeSheetCompareBaseline || !lastCurrentLocation) {
    return;
  }

  const controller = new AbortController();
  const stateKey = placeSheetCompareBaseline.key;
  const destination = { lat: placeSheetCompareBaseline.lat, lng: placeSheetCompareBaseline.lng };
  comparePlaceSheetRouteAbort = controller;

  fetchDrivingRoute(lastCurrentLocation, destination, { signal: controller.signal })
    .then((route) => {
      if (comparePlaceSheetRouteAbort === controller) {
        comparePlaceSheetRouteAbort = null;
      }

      updatePlaceSheetRouteSummary(stateKey, {
        routeStatus: "ready",
        routeError: "",
        routeSummary: {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
        },
      });
    })
    .catch((error) => {
      if (comparePlaceSheetRouteAbort === controller) {
        comparePlaceSheetRouteAbort = null;
      }

      if (error?.name === "AbortError") {
        return;
      }

      updatePlaceSheetRouteSummary(stateKey, {
        routeStatus: "error",
        routeError: error?.message ?? String(error),
        routeSummary: null,
      });
    });
}

function ensurePlaceSheet() {
  if (typeof document === "undefined" || placeSheetRoot || !elMain) {
    return;
  }

  placeSheetRoot = document.createElement("section");
  placeSheetRoot.className = "place-sheet-host";
  placeSheetRoot.hidden = true;
  placeSheetRoot.innerHTML = `
    <div class="place-sheet-panel" role="dialog" aria-modal="false" aria-labelledby="placeSheetTitle">
      <div class="place-sheet-body"></div>
    </div>`;

  placeSheetBody = placeSheetRoot.querySelector(".place-sheet-body");
  placeSheetRoot.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-place-sheet-close]");
    if (closeButton) {
      event.preventDefault();
      closePlaceSheet();
      return;
    }

    const routeButton = event.target.closest("[data-route-lat][data-route-lng]");
    if (routeButton && placeSheetRoot.contains(routeButton)) {
      event.preventDefault();
      if (activePlaceSheetState) {
        const nextHistory = touchPlaceHistoryEntry(activePlaceSheetState, { incrementOpen: false, incrementRoute: true });
        if (nextHistory) {
          activePlaceSheetState = { ...activePlaceSheetState, history: nextHistory };
          if (placeSheetCompareBaseline?.key === activePlaceSheetState.key) {
            placeSheetCompareBaseline = { ...placeSheetCompareBaseline, history: nextHistory };
          }
          renderActivePlaceSheet();
        }
      }
      startInAppNavigation({
        lat: Number(routeButton.dataset.routeLat),
        lng: Number(routeButton.dataset.routeLng),
        title: routeButton.dataset.routeTitle || "Destination",
        placeState: activePlaceSheetState ? { ...activePlaceSheetState } : null,
      }).catch((error) => {
        console.error(error);
        setNavigationStatus(error?.message ?? String(error), "error");
      });
      return;
    }

    const sectionButton = event.target.closest("[data-place-sheet-scroll]");
    if (sectionButton && placeSheetRoot.contains(sectionButton)) {
      event.preventDefault();
      const sectionId = sectionButton.dataset.placeSheetScroll;
      const section = placeSheetRoot.querySelector(`#${sectionId}`);
      if (section && typeof section.scrollIntoView === "function") {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    const compareButton = event.target.closest("[data-place-sheet-compare]");
    if (compareButton && placeSheetRoot.contains(compareButton)) {
      event.preventDefault();
      const action = compareButton.dataset.placeSheetCompare;
      if (action === "clear") {
        abortComparePlaceSheetRouteSummary();
        placeSheetCompareBaseline = null;
      } else if (activePlaceSheetState) {
        placeSheetCompareBaseline = buildPlaceSheetComparable(activePlaceSheetState);
        if (lastCurrentLocation && placeSheetCompareBaseline.routeStatus !== "ready") {
          placeSheetCompareBaseline = { ...placeSheetCompareBaseline, routeStatus: "loading", routeError: "" };
          queueComparePlaceSheetRouteSummary();
        }
      }
      renderActivePlaceSheet();
      return;
    }

    const restaurantButton = event.target.closest("[data-place-sheet-restaurant-id]");
    if (restaurantButton && placeSheetRoot.contains(restaurantButton)) {
      event.preventDefault();
      const restaurant = restaurantById.get(restaurantButton.dataset.placeSheetRestaurantId);
      if (restaurant) {
        openRestaurantSheet(restaurant);
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activePlaceSheetState) {
      closePlaceSheet();
    }
  });

  elMain.append(placeSheetRoot);
}

function renderActivePlaceSheet() {
  if (!placeSheetBody || !activePlaceSheetState) {
    return;
  }

  placeSheetBody.innerHTML = renderPlaceSheetHtml(activePlaceSheetState);
}

function openPlaceSheet(state) {
  ensurePlaceSheet();
  if (!placeSheetRoot || !placeSheetBody) {
    return;
  }

  closeActivePopup();
  const history = touchPlaceHistoryEntry(state);
  activePlaceSheetState = {
    ...state,
    history,
    routeSummary: state.routeSummary ?? null,
    routeStatus: state.routeSummary
      ? "ready"
      : lastCurrentLocation
        ? "loading"
        : "unavailable",
    routeError: "",
  };
  placeSheetRoot.hidden = false;
  placeSheetRoot.classList.add("is-open");
  renderActivePlaceSheet();
  placeSheetBody.scrollTop = 0;
  if (activePlaceSheetState.routeStatus === "loading") {
    queueActivePlaceSheetRouteSummary();
  }
}

function closePlaceSheet() {
  abortActivePlaceSheetRouteSummary();
  activePlaceSheetState = null;
  if (!placeSheetRoot || !placeSheetBody) {
    return;
  }

  placeSheetRoot.classList.remove("is-open");
  placeSheetRoot.hidden = true;
  placeSheetBody.innerHTML = "";
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
  if (!route?.destination) {
    return;
  }

  const popupHtml = renderRoutePopupHtml(route);
  if (activePopup?.__dgmPopupType === "route") {
    activePopup
      .setLngLat(lngLatToArray(route.destination))
      .setHTML(popupHtml);
    isRoutePopupVisible = true;
    return;
  }

  if (!forceOpen) {
    return;
  }

  const popup = openPopupAtLngLat(route.destination, popupHtml, { closeButton: true });
  popup.__dgmPopupType = "route";
  isRoutePopupVisible = true;
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
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
}

function updateNavigationVoiceButton() {
  if (activePopup?.__dgmPopupType === "route" && activeRoute) {
    syncRoutePopup(activeRoute);
  }
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

function formatCompactRouteDuration(durationSeconds) {
  const seconds = Math.abs(Math.round(Number(durationSeconds) || 0));
  if (seconds < 90) return `${seconds} sec`;
  return formatRouteDuration(seconds);
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

function setNavigationStatus(message, tone = "info") {
  lastNavigationStatusMessage = String(message || "").trim();
  lastNavigationStatusTone = lastNavigationStatusMessage ? tone : "info";

  if (activePopup?.__dgmPopupType === "route" && activeRoute) {
    syncRoutePopup(activeRoute);
  }
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
  const arrival = new Date(Date.now() + Math.max(0, Number(durationSeconds) || 0) * 1000);
  return arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getNavigationCameraModeLabel() {
  if (!activeRoute) return "Browse";
  if (navigationCameraMode === "driver") return "Driver camera";
  if (navigationCameraMode === "arrival") return "Arrival camera";
  if (navigationCameraMode === "overview") return "Overview";
  if (navigationCameraMode === "free") return "Free pan";
  return "Browse";
}

function setNavigationCameraMode(mode, { auto = false } = {}) {
  navigationCameraMode = mode;
  navigationCameraModeAutoArrival = Boolean(auto && mode === "arrival");
  if (mode !== "arrival") {
    navigationCameraModeAutoArrival = false;
  }
}

function isNavigationFollowCameraActive() {
  return Boolean(activeRoute && (navigationCameraMode === "driver" || navigationCameraMode === "arrival"));
}

function getNavigationCameraPitch(mode = navigationCameraMode, speedMetersPerSecond = 0, remainingDistanceMeters = 0) {
  if (mode === "arrival") {
    const imminence = 1 - clamp01((Number(remainingDistanceMeters) || 0) / ARRIVAL_CAMERA_EXIT_DISTANCE_METERS);
    return NAVIGATION_CAMERA_ARRIVAL_MIN_PITCH
      + imminence * (NAVIGATION_CAMERA_ARRIVAL_MAX_PITCH - NAVIGATION_CAMERA_ARRIVAL_MIN_PITCH);
  }

  const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 18);
  return NAVIGATION_CAMERA_DRIVER_MIN_PITCH
    + normalizedSpeed * (NAVIGATION_CAMERA_DRIVER_MAX_PITCH - NAVIGATION_CAMERA_DRIVER_MIN_PITCH);
}

function getNavigationCameraZoom(mode = navigationCameraMode, speedMetersPerSecond = 0, nextStepDistanceMeters = 0, remainingDistanceMeters = 0) {
  if (mode === "arrival") {
    const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 12);
    const imminence = 1 - clamp01((Number(remainingDistanceMeters) || 0) / ARRIVAL_CAMERA_EXIT_DISTANCE_METERS);
    const targetZoom = NAVIGATION_CAMERA_ARRIVAL_MIN_ZOOM
      + imminence * (NAVIGATION_CAMERA_ARRIVAL_MAX_ZOOM - NAVIGATION_CAMERA_ARRIVAL_MIN_ZOOM)
      + (1 - normalizedSpeed) * 0.18;
    return Math.max(NAVIGATION_CAMERA_ARRIVAL_MIN_ZOOM, Math.min(NAVIGATION_CAMERA_ARRIVAL_MAX_ZOOM, targetZoom));
  }

  const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 18);
  const turnImmediacy = 1 - clamp01((Number(nextStepDistanceMeters) || 0) / 900);
  const targetZoom = NAVIGATION_CAMERA_DRIVER_MAX_ZOOM - normalizedSpeed * 0.8 + turnImmediacy * 0.35;
  return Math.max(NAVIGATION_CAMERA_DRIVER_MIN_ZOOM, Math.min(NAVIGATION_CAMERA_DRIVER_MAX_ZOOM, targetZoom));
}

function syncNavigationCameraModeForRoute(route) {
  if (!route || navigationCameraMode === "overview" || navigationCameraMode === "free" || navigationCameraMode === "browse") {
    return;
  }

  const remainingDistanceMeters = Number(route.distanceMeters) || 0;
  if (navigationCameraMode === "driver" && remainingDistanceMeters <= ARRIVAL_CAMERA_AUTO_DISTANCE_METERS) {
    setNavigationCameraMode("arrival", { auto: true });
    return;
  }

  if (
    navigationCameraMode === "arrival"
    && navigationCameraModeAutoArrival
    && remainingDistanceMeters >= ARRIVAL_CAMERA_EXIT_DISTANCE_METERS
  ) {
    setNavigationCameraMode("driver", { auto: true });
  }
}

function syncActiveNavigationCamera({
  latlng = lastCurrentLocation,
  heading = lastKnownHeading,
  speed = lastKnownHeadingSpeed,
  force = false,
  allowBearing = true,
} = {}) {
  if (!isNavigationFollowCameraActive() || !map) {
    return;
  }

  const resolvedLatLng = lngLatToObject(latlng) || getRouteCameraAnchor(activeRoute);
  if (!resolvedLatLng) {
    return;
  }

  const normalizedHeading = normalizeHeadingDegrees(heading);
  const primaryStep = getPrimaryRouteStep(activeRoute);
  const remainingDistanceMeters = Number(activeRoute?.distanceMeters) || 0;
  const targetZoom = getNavigationCameraZoom(navigationCameraMode, speed, primaryStep?.distance, remainingDistanceMeters);
  const targetPitch = getNavigationCameraPitch(navigationCameraMode, speed, remainingDistanceMeters);
  const routeBearing = allowBearing ? getRouteCameraBearing(activeRoute, navigationCameraMode) : null;
  const targetBearing = allowBearing && normalizedHeading !== null
    ? normalizedHeading
    : routeBearing ?? getMapBearingHeading() ?? 0;

  const now = Date.now();
  if (!force && now - lastNavigationCameraSyncAt < NAVIGATION_CAMERA_UPDATE_MIN_INTERVAL_MS) {
    return;
  }

  const mapCenter = map.getCenter();
  const centerDelta = haversineMeters(mapCenter.lat, mapCenter.lng, resolvedLatLng.lat, resolvedLatLng.lng);
  const bearingDelta = getHeadingDeltaDegrees(targetBearing, getMapBearingHeading());
  const pitchDelta = Math.abs((Number(map.getPitch()) || 0) - targetPitch);
  const zoomDelta = Math.abs((Number(map.getZoom()) || 0) - targetZoom);

  if (
    !force
    && centerDelta < AUTO_FOLLOW_LOCATION_MIN_CENTER_OFFSET_METERS
    && (!Number.isFinite(bearingDelta) || bearingDelta < NAVIGATION_CAMERA_MIN_BEARING_DELTA_DEGREES)
    && pitchDelta < NAVIGATION_CAMERA_MIN_PITCH_DELTA
    && zoomDelta < NAVIGATION_CAMERA_MIN_ZOOM_DELTA
  ) {
    return;
  }

  lastNavigationCameraSyncAt = now;
  map.easeTo({
    center: [resolvedLatLng.lng, resolvedLatLng.lat],
    bearing: targetBearing,
    pitch: targetPitch,
    zoom: targetZoom,
    duration: force ? 700 : 320,
    essential: true,
  });
}

function focusActiveNavigationCamera({ force = false, mode = "driver" } = {}) {
  if (!activeRoute) {
    return;
  }

  setNavigationCameraMode(mode);
  renderNavigationCard(activeRoute);
  syncActiveNavigationCamera({ force: true, allowBearing: true });
  if (force) {
    setNavigationStatus(mode === "arrival" ? "Arrival camera active." : "Driver camera active.", "info");
  }
}

function showActiveRouteArrivalView() {
  if (!activeRoute) {
    return;
  }

  focusActiveNavigationCamera({ force: true, mode: "arrival" });
}

function showActiveRouteOverview() {
  if (!activeRoute) {
    return;
  }

  setNavigationCameraMode("overview");
  fitRouteToView(activeRoute);
  renderNavigationCard(activeRoute);
  setNavigationStatus("Overview active. Tap Drive to resume heading-follow.", "info");
}

function resetNavigationCamera() {
  setNavigationCameraMode("browse");
  navigationCameraModeAutoArrival = false;
  lastNavigationCameraSyncAt = 0;
  if (map) {
    map.easeTo({ bearing: 0, pitch: 0, duration: 650, essential: true });
  }
}


function getPrimaryRouteStep(route) {
  if (!route?.steps?.length) return null;
  return route.steps.find((step) => Number(step?.distance) > 15) || route.steps[0] || null;
}

function getArrivalRouteStep(route) {
  if (!route?.steps?.length) return null;

  for (let index = route.steps.length - 1; index >= 0; index -= 1) {
    const step = route.steps[index];
    if (String(step?.maneuver?.type || "").toLowerCase() === "arrive") {
      return step;
    }
  }

  return route.steps[route.steps.length - 1] || null;
}

function getFinalTurnRouteStep(route) {
  if (!route?.steps?.length) return null;

  for (let index = route.steps.length - 1; index >= 0; index -= 1) {
    const step = route.steps[index];
    if (String(step?.maneuver?.type || "").toLowerCase() !== "arrive") {
      return step;
    }
  }

  return route.steps[0] || null;
}

function getRouteApproachSegment(route) {
  const coordinates = route?.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const end = coordinates[coordinates.length - 1];
  for (let index = coordinates.length - 2; index >= 0; index -= 1) {
    const candidate = coordinates[index];
    if (candidate[0] !== end[0] || candidate[1] !== end[1]) {
      return {
        start: { lng: candidate[0], lat: candidate[1] },
        end: { lng: end[0], lat: end[1] },
      };
    }
  }

  return null;
}

function getRouteSegmentBearingDegrees(start, end) {
  const startLat = Number(start?.lat);
  const startLng = Number(start?.lng);
  const endLat = Number(end?.lat);
  const endLng = Number(end?.lng);
  if (![startLat, startLng, endLat, endLng].every(Number.isFinite)) {
    return null;
  }

  const startLatRad = startLat * (Math.PI / 180);
  const endLatRad = endLat * (Math.PI / 180);
  const deltaLngRad = (endLng - startLng) * (Math.PI / 180);
  const y = Math.sin(deltaLngRad) * Math.cos(endLatRad);
  const x = Math.cos(startLatRad) * Math.sin(endLatRad)
    - Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLngRad);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) {
    return null;
  }

  return normalizeHeadingDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

function getRouteCoordinateBearing(coordinates, { fromEnd = false } = {}) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  if (fromEnd) {
    let previous = coordinates[coordinates.length - 1];
    for (let index = coordinates.length - 2; index >= 0; index -= 1) {
      const current = coordinates[index];
      const bearing = getRouteSegmentBearingDegrees(
        { lng: current?.[0], lat: current?.[1] },
        { lng: previous?.[0], lat: previous?.[1] }
      );
      if (bearing !== null) {
        return bearing;
      }
      previous = current;
    }
    return null;
  }

  let previous = coordinates[0];
  for (let index = 1; index < coordinates.length; index += 1) {
    const current = coordinates[index];
    const bearing = getRouteSegmentBearingDegrees(
      { lng: previous?.[0], lat: previous?.[1] },
      { lng: current?.[0], lat: current?.[1] }
    );
    if (bearing !== null) {
      return bearing;
    }
    previous = current;
  }

  return null;
}

function getRouteStepBearingDegrees(step) {
  const bearingAfter = normalizeHeadingDegrees(step?.maneuver?.bearing_after);
  if (bearingAfter !== null) {
    return bearingAfter;
  }

  const bearingBefore = normalizeHeadingDegrees(step?.maneuver?.bearing_before);
  if (bearingBefore !== null) {
    return bearingBefore;
  }

  return getRouteCoordinateBearing(step?.geometry?.coordinates);
}

function getRouteCameraBearing(route, mode = navigationCameraMode) {
  const preferredStep = mode === "arrival"
    ? getFinalTurnRouteStep(route) || getArrivalRouteStep(route)
    : getPrimaryRouteStep(route);
  const preferredBearing = getRouteStepBearingDegrees(preferredStep);
  if (preferredBearing !== null) {
    return preferredBearing;
  }

  if (mode === "arrival") {
    const approachSegment = getRouteApproachSegment(route);
    const approachBearing = getRouteSegmentBearingDegrees(approachSegment?.start, approachSegment?.end);
    if (approachBearing !== null) {
      return approachBearing;
    }
  }

  return getRouteCoordinateBearing(route?.geometry?.coordinates, { fromEnd: mode === "arrival" });
}

function getRouteCameraAnchor(route, mode = navigationCameraMode) {
  if (mode === "arrival") {
    return lngLatToObject(route?.destination) || lngLatToObject(route?.origin);
  }

  return lngLatToObject(route?.origin) || lngLatToObject(route?.destination);
}

function getPlanarVectorMeters(fromLatLng, toLatLng) {
  const fromLat = Number(fromLatLng?.lat ?? 0);
  const fromLng = Number(fromLatLng?.lng ?? 0);
  const toLat = Number(toLatLng?.lat ?? 0);
  const toLng = Number(toLatLng?.lng ?? 0);
  const avgLatRad = (((fromLat + toLat) / 2) * Math.PI) / 180;
  return {
    x: (toLng - fromLng) * 111320 * Math.cos(avgLatRad),
    y: (toLat - fromLat) * 111320,
  };
}

function getApproachRelativeSide(approachStart, approachEnd, point) {
  const travel = getPlanarVectorMeters(approachStart, approachEnd);
  const target = getPlanarVectorMeters(approachEnd, point);
  const targetDistance = Math.hypot(target.x, target.y);
  if (targetDistance < 12) {
    return "center";
  }

  const cross = travel.x * target.y - travel.y * target.x;
  const along = travel.x * target.x + travel.y * target.y;
  if (Math.abs(cross) < Math.max(14, targetDistance * 0.18)) {
    return along >= 0 ? "ahead" : "behind";
  }

  return cross > 0 ? "left" : "right";
}

function formatRelativeSideLabel(side) {
  if (side === "left") return "to the left";
  if (side === "right") return "to the right";
  if (side === "ahead") return "straight ahead";
  if (side === "behind") return "behind the finish";
  return "near the curb";
}

function getArrivalSideFromModifier(modifier) {
  const normalizedModifier = String(modifier || "").toLowerCase().replace(/_/g, " ");
  if (normalizedModifier.includes("left")) return "left";
  if (normalizedModifier.includes("right")) return "right";
  if (normalizedModifier === "straight") return "center";
  return "center";
}

function getTurnDeltaDegrees(bearingBefore, bearingAfter) {
  if (!Number.isFinite(bearingBefore) || !Number.isFinite(bearingAfter)) {
    return 0;
  }
  return ((bearingAfter - bearingBefore + 540) % 360) - 180;
}


function buildRouteStepInstruction(step) {
  const maneuver = step?.maneuver || {};
  const type = String(maneuver.type || "continue").toLowerCase().replace(/_/g, " ");
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
    case "on ramp":
      return `Take the ${modifier ? `${modifier} ` : ""}on-ramp${road}`.trim();
    case "off ramp":
      return `Take the ${modifier ? `${modifier} ` : ""}exit${road}`.trim();
    case "fork":
      return `Keep ${modifier || "ahead"}${road}`.trim();
    case "roundabout":
    case "rotary":
      return maneuver.exit
        ? `Take exit ${maneuver.exit} at the roundabout${road}`.trim()
        : `Enter the roundabout${road}`.trim();
    case "exit roundabout":
    case "exit rotary":
      return `Exit the roundabout${road}`.trim();
    case "end of road":
      return `At the end of the road, turn ${modifier}${road}`.trim();
    case "new name":
      return step?.name ? `Continue as ${step.name}` : "Continue ahead";
    default:
      return `Continue ${modifier || "ahead"}${road}`.trim();
  }
}

function getNavigationTurnComplexity(step) {
  if (!step) {
    return null;
  }

  const maneuver = step.maneuver || {};
  const maneuverType = String(maneuver.type || "continue").toLowerCase().replace(/_/g, " ");
  const angleFactor = clamp01(Math.abs(getTurnDeltaDegrees(maneuver.bearing_before, maneuver.bearing_after)) / 135);
  const intersection = Array.isArray(step.intersections) ? step.intersections[0] || null : null;
  const laneCount = Array.isArray(intersection?.lanes) ? intersection.lanes.length : 0;
  const validEntryCount = Array.isArray(intersection?.entry)
    ? intersection.entry.filter(Boolean).length
    : 0;
  const laneFactor = clamp01(Math.max(0, laneCount - 1) / 4);
  const entryFactor = clamp01(Math.max(0, validEntryCount - 1) / 4);

  let typeFactor = 0.34;
  if (maneuverType === "roundabout" || maneuverType === "rotary" || maneuverType === "exit roundabout" || maneuverType === "exit rotary") {
    typeFactor = 0.84;
  } else if (maneuverType === "fork" || maneuverType === "merge" || maneuverType === "on ramp" || maneuverType === "off ramp") {
    typeFactor = 0.72;
  } else if (maneuverType === "end of road") {
    typeFactor = 0.63;
  } else if (maneuverType === "turn") {
    typeFactor = 0.48;
  }

  const score = clamp01(0.42 * typeFactor + 0.28 * angleFactor + 0.16 * laneFactor + 0.14 * entryFactor);
  let label = "Clean";
  if (score >= 0.76) {
    label = "Complex";
  } else if (score >= 0.56) {
    label = "Busy";
  } else if (score >= 0.34) {
    label = "Moderate";
  }

  const detailParts = [];
  if (laneCount > 0) detailParts.push(`${laneCount} lane${laneCount === 1 ? "" : "s"}`);
  if (validEntryCount > 1) detailParts.push(`${validEntryCount} legal branches`);
  if (!detailParts.length) detailParts.push(buildRouteStepInstruction(step));

  return {
    score,
    label,
    detail: detailParts.join(" · "),
  };
}

function buildRouteApproachProfile(route, destinationState, { pickupFriction, stagingCandidate, microCandidate } = {}) {
  const approachSegment = getRouteApproachSegment(route);
  const arrivalStep = getArrivalRouteStep(route);
  const finalTurnStep = getFinalTurnRouteStep(route);
  const finalTurn = getNavigationTurnComplexity(finalTurnStep || arrivalStep);
  const approachDirection = approachSegment
    ? getDirectionLabel(approachSegment.start, approachSegment.end)
    : "unknown";
  const arrivalSide = getArrivalSideFromModifier(arrivalStep?.maneuver?.modifier);
  const drivingSide = String(arrivalStep?.driving_side || finalTurnStep?.driving_side || "right").toLowerCase() === "left"
    ? "left"
    : "right";
  const legalCurbSide = drivingSide;
  const curbParkingCandidate = pickupFriction?.nearestParking?.candidate || null;
  const curbParkingSide = curbParkingCandidate && approachSegment
    ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: curbParkingCandidate.lat, lng: curbParkingCandidate.lon })
    : null;
  const stagingSide = stagingCandidate && approachSegment
    ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: stagingCandidate.candidate.lat, lng: stagingCandidate.candidate.lon })
    : null;
  const microSide = microCandidate && approachSegment
    ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: microCandidate.candidate.lat, lng: microCandidate.candidate.lon })
    : null;

  let curbsideConfidence = arrivalSide === "center" ? 0.46 : 0.64;
  if (arrivalSide === legalCurbSide) {
    curbsideConfidence += 0.14;
  } else if (arrivalSide !== "center") {
    curbsideConfidence -= 0.14;
  }
  if (curbParkingSide && arrivalSide !== "center") {
    curbsideConfidence += curbParkingSide === arrivalSide ? 0.12 : -0.08;
  }
  if (stagingSide && arrivalSide !== "center") {
    curbsideConfidence += stagingSide === arrivalSide ? 0.06 : -0.04;
  }
  if (microSide && arrivalSide !== "center") {
    curbsideConfidence += microSide === arrivalSide ? 0.04 : -0.03;
  }
  if (finalTurn) {
    curbsideConfidence -= clamp01((finalTurn.score - 0.3) / 0.7) * 0.12;
  }
  curbsideConfidence -= (pickupFriction?.score ?? 0) * 0.08;
  curbsideConfidence = clamp01(curbsideConfidence);

  let curbsideLabel = "Curbside uncertain";
  if (arrivalSide === "center") {
    curbsideLabel = curbsideConfidence >= 0.62 ? "Straight-in arrival" : "Curbside uncertain";
  } else if (arrivalSide === legalCurbSide && curbsideConfidence >= 0.72) {
    curbsideLabel = `Likely ${arrivalSide}-side curb`;
  } else if (arrivalSide !== legalCurbSide) {
    curbsideLabel = `${arrivalSide[0].toUpperCase()}${arrivalSide.slice(1)}-side finish`;
  } else {
    curbsideLabel = `${arrivalSide[0].toUpperCase()}${arrivalSide.slice(1)}-side possible`;
  }

  const contextParts = [];
  if (curbParkingCandidate && Number.isFinite(pickupFriction?.nearestParking?.distanceMeters)) {
    contextParts.push(`${pickupFriction.nearestParking.distanceMeters} m visible parking sits ${formatRelativeSideLabel(curbParkingSide)}`);
  }
  if (stagingCandidate) {
    contextParts.push(`best staging sits ${formatRelativeSideLabel(stagingSide)} and ${formatProbabilityDelta(stagingCandidate.probabilityDelta)}`);
  } else if (microCandidate) {
    contextParts.push(`short move support sits ${formatRelativeSideLabel(microSide)}`);
  }

  const curbsideDetail = arrivalSide === "center"
    ? `OSRM does not expose a firm last-segment curbside here, so DGM is leaning on the visible parking field.${contextParts.length ? ` ${contextParts.join(". ")}.` : ""}`
    : `OSRM places the finish on the ${arrivalSide} while legal curb flow is ${legalCurbSide}.${contextParts.length ? ` ${contextParts.join(". ")}.` : ""}`;

  return {
    approachDirection,
    arrivalSide,
    legalCurbSide,
    curbsideConfidence,
    curbsideLabel,
    curbsideDetail,
    finalTurn,
    destinationState,
  };
}

function buildNavigationArrivalReadiness({
  route,
  destinationScore,
  pickupFriction,
  stagingCandidate,
  microCandidate,
  approachProfile,
}) {
  const fieldScore = destinationScore ? clamp01(getProbabilityMid(destinationScore)) : 0.34;
  const pickupEase = pickupFriction ? 1 - clamp01(pickupFriction.score) : 0.4;
  const curbScore = approachProfile ? clamp01(approachProfile.curbsideConfidence) : 0.4;
  const stageScore = stagingCandidate
    ? clamp01(0.52 + stagingCandidate.probabilityDelta * 2.6)
    : microCandidate
      ? clamp01(0.36 + microCandidate.suitability * 0.48)
      : 0.26;
  const overall = clamp01(0.34 * fieldScore + 0.24 * pickupEase + 0.24 * curbScore + 0.18 * stageScore);
  const finalApproach = (Number(route?.distanceMeters) || 0) <= ARRIVAL_CAMERA_EXIT_DISTANCE_METERS;

  let headline = "Arrival watch";
  if (overall >= 0.74) {
    headline = "Arrival locked";
  } else if (overall >= 0.56) {
    headline = "Arrival building";
  }

  return {
    overall,
    headline,
    isFinalApproach: finalApproach,
    detail: finalApproach
      ? "Final approach is live. DGM is biasing the HUD toward curbside and staging clarity."
      : `Arrival camera will tighten automatically inside ${formatRouteDistance(ARRIVAL_CAMERA_AUTO_DISTANCE_METERS)}.`,
    items: [
      {
        label: "Field",
        value: destinationScore ? describeSignal(getProbabilityMid(destinationScore)) : "Route only",
        detail: destinationScore
          ? formatProbabilityRange(getProbabilityLow(destinationScore), getProbabilityHigh(destinationScore))
          : "Refresh the field to unlock arrival scoring.",
        score: fieldScore,
      },
      {
        label: "Friction",
        value: pickupFriction?.label || "Route only",
        detail: pickupFriction?.value || "Needs field refresh",
        score: pickupEase,
      },
      {
        label: "Curb",
        value: approachProfile?.curbsideLabel || "Unmapped",
        detail: approachProfile ? `${Math.round(approachProfile.curbsideConfidence * 100)}/100 confidence` : "Needs route finish context",
        score: curbScore,
      },
      {
        label: "Stage",
        value: stagingCandidate
          ? formatProbabilityDelta(stagingCandidate.probabilityDelta)
          : microCandidate
            ? `${Math.round(microCandidate.suitability * 100)}/100`
            : "No edge",
        detail: stagingCandidate
          ? `${stagingCandidate.distanceMeters} m ${stagingCandidate.direction}`
          : microCandidate
            ? `${microCandidate.distanceMeters} m ${microCandidate.direction}`
            : "No visible nearby lift",
        score: stageScore,
      },
    ],
  };
}


function getParkingCandidateIdentity(candidate) {
  if (!candidate) {
    return "";
  }

  const lat = Number(candidate.lat);
  const lon = Number(candidate.lon);
  return String(
    candidate.id
      || `${Number.isFinite(lat) ? lat.toFixed(5) : "x"}:${Number.isFinite(lon) ? lon.toFixed(5) : "y"}:${getParkingCandidateLabel(candidate)}`
  );
}

function formatRouteDurationDelta(durationSeconds) {
  const delta = Math.round(Number(durationSeconds) || 0);
  if (delta === 0) return "ETA unchanged";
  return `${formatCompactRouteDuration(delta)} ${delta < 0 ? "faster" : "slower"}`;
}

function formatRouteDistanceDelta(distanceMeters) {
  const delta = Math.round(Number(distanceMeters) || 0);
  if (delta === 0) return "distance unchanged";
  return `${formatRouteDistance(Math.abs(delta))} ${delta < 0 ? "shorter" : "longer"}`;
}

function buildNavigationSnapshot(route) {
  const primaryStep = getPrimaryRouteStep(route);
  const destinationState = getNavigationDestinationState(route);
  const destinationScore = destinationState?.score ?? null;
  const pickupFriction = destinationState ? getPickupFrictionDetails(destinationState) : null;
  const competition = destinationScore ? getCompetitionPressureDetails(destinationScore) : null;
  const stagingCandidate = destinationState
    ? buildParkingCandidateInsights(destinationState, {
      minDistanceMeters: STAGING_SPOT_MIN_DISTANCE_METERS,
      maxDistanceMeters: STAGING_SPOT_MAX_DISTANCE_METERS,
      limit: 1,
    })[0] || null
    : null;
  const microCandidate = destinationState
    ? buildParkingCandidateInsights(destinationState, {
      minDistanceMeters: MICRO_CORRIDOR_MIN_DISTANCE_METERS,
      maxDistanceMeters: MICRO_CORRIDOR_MAX_DISTANCE_METERS,
      limit: 1,
    })[0] || null
    : null;
  const approachProfile = buildRouteApproachProfile(route, destinationState, {
    pickupFriction,
    stagingCandidate,
    microCandidate,
  });
  const arrivalReadiness = buildNavigationArrivalReadiness({
    route,
    destinationScore,
    pickupFriction,
    stagingCandidate,
    microCandidate,
    approachProfile,
  });
  const arrivalSummary = destinationScore
    ? `${arrivalReadiness.headline}. ${approachProfile?.curbsideLabel || "Approach stabilizing"}. ${competition?.detail || ""}`.trim()
    : "Route is active. Load or refresh the current field to unlock DGM arrival intelligence for this destination.";

  return {
    primaryStep,
    destinationState,
    destinationScore,
    pickupFriction,
    competition,
    stagingCandidate,
    microCandidate,
    approachProfile,
    arrivalReadiness,
    arrivalSummary,
  };
}

function buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot) {
  if (!previousRoute || !nextRoute || !previousSnapshot || !nextSnapshot) {
    return null;
  }

  const durationDelta = (Number(nextRoute.durationSeconds) || 0) - (Number(previousRoute.durationSeconds) || 0);
  const distanceDelta = (Number(nextRoute.distanceMeters) || 0) - (Number(previousRoute.distanceMeters) || 0);
  const detailParts = [];

  if (Math.abs(durationDelta) >= NAVIGATION_REROUTE_DELTA_MIN_DURATION_SECONDS) {
    detailParts.push(formatRouteDurationDelta(durationDelta));
  }
  if (Math.abs(distanceDelta) >= NAVIGATION_REROUTE_DELTA_MIN_DISTANCE_METERS) {
    detailParts.push(formatRouteDistanceDelta(distanceDelta));
  }

  const previousCurb = previousSnapshot.approachProfile?.curbsideLabel || "";
  const nextCurb = nextSnapshot.approachProfile?.curbsideLabel || "";
  if (previousCurb && nextCurb && previousCurb !== nextCurb) {
    detailParts.push(`curbside shifts to ${nextCurb.toLowerCase()}`);
  }

  const previousTurn = previousSnapshot.approachProfile?.finalTurn?.label || "";
  const nextTurn = nextSnapshot.approachProfile?.finalTurn?.label || "";
  if (previousTurn && nextTurn && previousTurn !== nextTurn) {
    detailParts.push(`final turn is now ${nextTurn.toLowerCase()}`);
  }

  const previousStagingKey = getParkingCandidateIdentity(previousSnapshot.stagingCandidate?.candidate);
  const nextStagingKey = getParkingCandidateIdentity(nextSnapshot.stagingCandidate?.candidate);
  if (nextStagingKey && previousStagingKey !== nextStagingKey) {
    detailParts.push(`best staging shifts to ${getParkingCandidateLabel(nextSnapshot.stagingCandidate.candidate)}`);
  }

  const previousFrictionLabel = previousSnapshot.pickupFriction?.label || "";
  const nextFrictionLabel = nextSnapshot.pickupFriction?.label || "";
  if (previousFrictionLabel && nextFrictionLabel && previousFrictionLabel !== nextFrictionLabel) {
    detailParts.push(`pickup friction moves to ${nextFrictionLabel.toLowerCase()}`);
  }

  if (!detailParts.length) {
    return null;
  }

  let headline = "Reroute changes arrival setup";
  if (durationDelta <= -NAVIGATION_REROUTE_DELTA_MIN_DURATION_SECONDS) {
    headline = "Reroute improves arrival";
  } else if (durationDelta >= NAVIGATION_REROUTE_DELTA_MIN_DURATION_SECONDS) {
    headline = "Reroute slows arrival";
  } else if (previousCurb !== nextCurb) {
    headline = "Reroute changes curbside";
  }

  return {
    headline,
    detail: detailParts.join(" · "),
    tone: durationDelta > 0 ? "watch" : "good",
  };
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
  } else if (activeRoute) {
    speakNavigationInstruction(activeRoute, { force: true });
  }

  if (activePopup?.__dgmPopupType === "route" && activeRoute) {
    syncRoutePopup(activeRoute);
  }
}

function renderNavigationCard(route) {
  if (!route) return;

  syncNavigationCameraModeForRoute(route);

  const snapshot = route.navigationSnapshot || buildNavigationSnapshot(route);
  route.navigationSnapshot = snapshot;
  route.destinationState = snapshot.destinationState;
  syncRoutePopup(route, { forceOpen: shouldOpenRoutePopupOnNextRender });
  shouldOpenRoutePopupOnNextRender = false;
  if (navigationCameraMode === "free" && activeRoute) {
    setNavigationStatus("Driver camera paused. Tap Drive to resume heading-follow.", "info");
  } else if (lastNavigationStatusTone !== "error") {
    setNavigationStatus("", "info");
  }
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

  if (source === "course") {
    return "course";
  }

  if (source === "bearing" || source === "map-bearing") {
    const shouldShowPermissionButton = compassPermissionState === COMPASS_PERMISSION_REQUIRED_STATE
      || compassPermissionState === COMPASS_PERMISSION_DENIED_STATE
      || isCompassPermissionRequestPending;
    compassPermissionButton.hidden = !shouldShowPermissionButton;
    compassPermissionButton.disabled = isCompassPermissionRequestPending;
    compassPermissionButton.textContent = isCompassPermissionRequestPending
      ? "Enabling..."
      : compassPermissionState === COMPASS_PERMISSION_DENIED_STATE
        ? "Retry Compass"
        : "Enable Compass";
  }

  if (compassDebugToggleButton && compassDebugOverlay) {
    compassDebugOverlay.hidden = !isCompassDebugOverlayVisible;
    compassDebugToggleButton.textContent = isCompassDebugOverlayVisible ? "Hide Debug" : "Show Debug";
    compassDebugToggleButton.setAttribute("aria-pressed", String(isCompassDebugOverlayVisible));
  }

  updateCompassDebugOverlay(nowMs);
}

function setCompassPermissionState(nextState, nowMs = getHeadingNowMs()) {
  compassPermissionState = nextState;
  writeStoredCompassPermissionState(nextState);
  syncCompassUi(nowMs);
}

function ensureCompassUi() {
  const canRequestCompassPermission = Boolean(getCompassPermissionRequestTarget());
  if (
    typeof document === "undefined"
    || compassUiRoot
    || (!COMPASS_DEBUG_MODE_ENABLED && !canRequestCompassPermission)
  ) {
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

  if (canRequestCompassPermission) {
    compassPermissionButton = document.createElement("button");
    compassPermissionButton.type = "button";
    compassPermissionButton.hidden = true;
    Object.assign(compassPermissionButton.style, {
      pointerEvents: "auto",
      border: "0",
      borderRadius: "999px",
      padding: "10px 14px",
      fontSize: "12px",
      fontWeight: "700",
      color: "#08111d",
      background: "rgba(238, 246, 255, 0.92)",
      boxShadow: "0 8px 20px rgba(8, 17, 29, 0.22)",
    });
    compassPermissionButton.addEventListener("click", () => {
      requestCompassPermissionFromUserGesture().catch((error) => {
        console.warn("[DGM] Compass permission request failed:", error);
      });
    });
    compassUiRoot.append(compassPermissionButton);
  }

  if (!COMPASS_DEBUG_MODE_ENABLED) {
    document.body.append(compassUiRoot);
    syncCompassUi();
    return;
  }

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

  if (source === "gps" || source === "course") {
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
  syncMapBearingToHeading(resolvedHeading);
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

function syncHeadingFromLocation(
  latlng,
  gpsHeading,
  speed,
  {
    nowMs = getHeadingNowMs(),
    previousLocation = null,
  } = {}
) {
  updateStoredHeadingSpeed(speed);

  if (lastSensorHeading !== null && hasFreshHeadingSensorData(lastSensorHeadingAt, nowMs, HEADING_SENSOR_STALE_AFTER_MS)) {
    return refreshHeadingConeWithEffectiveHeading(latlng, lastKnownHeadingSpeed, nowMs);
  }

  const normalizedGpsHeading = normalizeHeadingDegrees(gpsHeading);
  const derivedCourseHeading = normalizedGpsHeading === null
    ? getLocationCourseHeading(previousLocation, latlng)
    : null;
  const fallbackHeading = normalizedGpsHeading ?? derivedCourseHeading;
  if (fallbackHeading === null) {
    lastKnownHeading = null;
    lastKnownHeadingSource = null;
    return refreshHeadingConeWithEffectiveHeading(latlng, lastKnownHeadingSpeed, nowMs);
  }

  return applyHeadingUpdate(fallbackHeading, {
    latlng,
    speed,
    nowMs,
    timeConstantMs: HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
    source: normalizedGpsHeading !== null ? "gps" : "course",
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
      const previousLocation = lastCurrentLocation ? { ...lastCurrentLocation } : null;
      const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
      setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
      syncHeadingFromLocation(latlng, position.coords.heading, position.coords.speed, { previousLocation });
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
  const previousRoute = activeRoute;
  const previousSnapshot = previousRoute
    ? (previousRoute.navigationSnapshot || buildNavigationSnapshot(previousRoute))
    : null;
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

  const nextRoute = {
    ...routeResult,
    origin,
    destination: activeRoute.destination,
    destinationState: activeRoute.destinationState,
  };
  const nextSnapshot = buildNavigationSnapshot(nextRoute);
  nextRoute.navigationSnapshot = nextSnapshot;
  nextRoute.destinationState = nextSnapshot.destinationState;
  nextRoute.rerouteDelta = buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot);

  activeRoute = nextRoute;

  setSourceData(SOURCE_ROUTE, featureCollection([{
    type: "Feature",
    geometry: routeResult.geometry,
    properties: {},
  }]));

  renderNavigationCard(activeRoute);

  if (options.fitToRoute || navigationCameraMode === "overview") {
    fitRouteToView(activeRoute);
  } else if (isNavigationFollowCameraActive()) {
    syncActiveNavigationCamera({ latlng: origin, heading: lastKnownHeading, speed: lastKnownHeadingSpeed, force: true });
  }

  return activeRoute;
}

function ensureNavigationWatch() {
  if (!navigator.geolocation || activeNavigationWatchId !== null || !activeRoute?.destination) return;

  activeNavigationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const previousLocation = lastCurrentLocation ? { ...lastCurrentLocation } : null;
      const origin = setCurrentLocationState(
        { lat: position.coords.latitude, lng: position.coords.longitude },
        position.coords.accuracy,
        { openPopup: false }
      );
      syncHeadingFromLocation(origin, position.coords.heading, position.coords.speed, { previousLocation });

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
    placeState: destination?.placeState ? { ...destination.placeState } : null,
  };

  if (!Number.isFinite(resolvedDestination.lat) || !Number.isFinite(resolvedDestination.lng)) {
    throw new Error("Destination coordinates are invalid.");
  }

  closePlaceSheet();
  closeActivePopup();
  setNavigationCameraMode("driver");
  shouldOpenRoutePopupOnNextRender = true;
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
    destinationState: resolveNavigationDestinationState(resolvedDestination),
    rerouteDelta: null,
  };
  activeRoute.navigationSnapshot = buildNavigationSnapshot(activeRoute);
  activeRoute.destinationState = activeRoute.navigationSnapshot.destinationState;
  lastRouteOriginForRefresh = origin;
  lastRouteRefreshAt = Date.now();
  lastNavigationCameraSyncAt = 0;

  setSourceData(SOURCE_ROUTE, featureCollection([{
    type: "Feature",
    geometry: routeResult.geometry,
    properties: {},
  }]));

  renderNavigationCard(activeRoute);
  ensureNavigationWatch();

  if (options.fitToRoute === true) {
    fitRouteToView(activeRoute);
    setNavigationCameraMode("overview");
  } else {
    focusActiveNavigationCamera({ force: true });
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
  lastNavigationCameraSyncAt = 0;
  lastSpokenInstructionKey = "";
  shouldOpenRoutePopupOnNextRender = false;
  isRoutePopupVisible = false;
  clearRouteOverlay();
  if (activePopup?.__dgmPopupType === "route") {
    closeActivePopup();
  }
  setNavigationStatus("", "info");
  resetNavigationCamera();
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

      openRestaurantSheet(restaurant);
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
  if (activeRoute) {
    syncActiveNavigationCamera({ latlng, force, allowBearing: false });
    return;
  }

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

function syncMapBearingToHeading(heading, { force = false } = {}) {
  if (!activeRoute) {
    return;
  }

  syncActiveNavigationCamera({ heading, force, allowBearing: true });
}

function clearPendingMapTapPopup() {
  if (pendingMapTapPopupTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(pendingMapTapPopupTimer);
    pendingMapTapPopupTimer = null;
  }
}

function suppressMapTapPopupTemporarily(durationMs = MAP_TOUCH_GESTURE_SUPPRESSION_MS) {
  suppressMapTapPopupUntil = Date.now() + durationMs;
  clearPendingMapTapPopup();
}

function handleMapTouchStart() {
  const now = Date.now();
  if (now - lastMapTouchStartAt <= MAP_TOUCH_TAP_POPUP_DELAY_MS) {
    suppressMapTapPopupTemporarily();
  }
  lastMapTouchStartAt = now;
}

function scheduleMapTapPopup(lngLat) {
  clearPendingMapTapPopup();
  pendingMapTapPopupTimer = window.setTimeout(() => {
    pendingMapTapPopupTimer = null;
    if (Date.now() < suppressMapTapPopupUntil) {
      return;
    }
    openStatsPopupAtLatLng(lngLat);
  }, MAP_TOUCH_TAP_POPUP_DELAY_MS);
}

function handleManualMapCameraStart(event) {
  if (!event?.originalEvent) {
    return;
  }

  if (activeRoute) {
    setNavigationCameraMode("free");
    setNavigationStatus("Driver camera paused. Tap Drive to resume heading-follow.", "info");
    suppressMapTapPopupTemporarily();
    return;
  }

  setCurrentLocationFollowEnabled(false);
  suppressMapTapPopupTemporarily();
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
    const previousLocation = lastCurrentLocation ? { ...lastCurrentLocation } : null;
    setCurrentLocationFollowEnabled(true);

    const animateLocate = shouldAnimateLocate(latlng);
    const targetZoom = clampMapZoom(LOCATION_TARGET_ZOOM);

    closePanelIfOpen();
    setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
    syncHeadingFromLocation(latlng, position.coords.heading, position.coords.speed, { previousLocation });

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

  closePanelIfOpen();

  if (!lastRestaurants || lastRestaurants.length === 0) {
    openPopupAtLngLat(latlng, "Load data first (click ‘Load / Refresh for current view’).", { closeButton: true });
    return;
  }

  const point = setSpotMarker(latlng);
  openPopupAtLngLat(
    point,
    renderSpotPopupHtml(point, lastRestaurants, lastParams.tauMeters, lastParams.hour),
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

function renderPlaceSheetCompareButton(state) {
  const buttonLabel = placeSheetCompareBaseline?.key === state.key
    ? "Pick second place"
    : placeSheetCompareBaseline
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

function renderPlaceSheetOverviewSection(state) {
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
        renderPlaceSheetCompareButton(state),
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
      renderPlaceSheetCompareButton(state),
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

function renderPlaceSheetCompareSection(state) {
  if (!placeSheetCompareBaseline) {
    return `
      <div class="popup-empty">Save this place as your baseline, then tap any other restaurant dot or stat ping to compare them side by side.</div>
      ${renderPopupActions([renderPlaceSheetCompareButton(state)])}`;
  }

  const current = buildPlaceSheetComparable(state);
  if (placeSheetCompareBaseline.key === current.key) {
    return `
      <div class="popup-banner">Baseline locked on ${escapeHtml(current.title)}. Tap another restaurant dot or stat ping on the map to complete the comparison.</div>
      <div class="place-sheet-compare-grid">
        ${renderPlaceSheetComparisonCard(placeSheetCompareBaseline, "Baseline")}
      </div>
      ${renderPopupActions([
        '<button type="button" class="popup-action popup-action--secondary" data-place-sheet-compare="clear">Clear baseline</button>',
      ])}`;
  }

  const baselineMid = getProbabilityMid(placeSheetCompareBaseline.score);
  const currentMid = getProbabilityMid(current.score);

  return `
    <div class="popup-banner popup-banner--accent">${escapeHtml(getPlaceSheetComparisonSummary(current, placeSheetCompareBaseline))}</div>
    <div class="place-sheet-compare-grid">
      ${renderPlaceSheetComparisonCard(current, "Current", currentMid >= baselineMid)}
      ${renderPlaceSheetComparisonCard(placeSheetCompareBaseline, "Baseline", baselineMid > currentMid)}
    </div>
    ${renderPopupActions([
      renderPlaceSheetCompareButton(state),
      '<button type="button" class="popup-action popup-action--secondary" data-place-sheet-compare="clear">Clear baseline</button>',
    ])}`;
}

function renderPlaceSheetHtml(state) {
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
      ${renderPlaceSheetOverviewSection(state)}
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
      ${renderPlaceSheetCompareSection(state)}
    </section>`;
}

function openRestaurantSheet(restaurant) {
  if (!restaurant) {
    return;
  }

  openPlaceSheet(buildRestaurantSheetState(restaurant));
}

function openSpotSheet(latlng) {
  if (!latlng) {
    return;
  }

  setSpotMarker(latlng);
  openPlaceSheet(buildSpotSheetState(latlng));
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
    lastRankedParkingAll = rankedAll;

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

map.on("moveend", checkDataFreshness);
map.on("zoom", refreshHeadingConeFromState);
map.on("rotate", refreshHeadingConeFromState);
map.on("dragstart", handleManualMapCameraStart);
map.on("rotatestart", handleManualMapCameraStart);
map.on("pitchstart", handleManualMapCameraStart);
map.on("zoomstart", handleManualMapCameraStart);

map.on("click", (event) => {
  const featuresAtPoint = map.queryRenderedFeatures(event.point, {
    layers: [LAYER_RESTAURANTS, LAYER_PARKING, LAYER_CURRENT_LOCATION_HALO, LAYER_CURRENT_LOCATION_DOT],
  });

  if (featuresAtPoint.length) return;

  if (isTouchInteractionDevice() && Date.now() - lastMapTouchStartAt <= MAP_TOUCH_TAP_POPUP_DELAY_MS) {
    scheduleMapTapPopup(event.lngLat);
    return;
  }

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
    addPreferredPressHandler(menuButton, () => {
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
