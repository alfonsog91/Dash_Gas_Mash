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
} from "./overpass.js?v=20260401-learnedglm";
import {
  buildDemandCoverageNodes,
  buildGridProbabilityHeat,
  filterOpenRestaurants,
  haversineMeters,
  probabilityOfGoodOrder,
  rankParking,
  topLikelyMerchantsForParking,
  timeBucket,
} from "./model.js?v=20260401-learnedglm";
import { renderModelDiagram } from "./diagram.js?v=20260401-learnedglm";
import {
  evaluateParkingCoverage,
  isMipAvailable,
  optimizeParkingSet,
  selectParkingSetSubmodular,
} from "./optimizer.js?v=20260401-learnedglm";

const APP_BUILD_ID = "20260401-learnedglm";
console.info("[DGM] app build", APP_BUILD_ID);

const PREDICTION_MODEL = String(window.DGM_PREDICTION_MODEL || "legacy").trim().toLowerCase();
const SHADOW_LEARNED_MODEL = Boolean(window.DGM_SHADOW_PREDICTION_MODEL);

if (window.location.protocol === "file:") {
  alert(
    "This app must be opened from a local web server (not file://).\n\nRun: python -m http.server 5173\nThen open: http://localhost:5173/"
  );
}

const DEFAULT_CENTER = [-117.5931, 34.1064]; // [lng, lat] Rancho Cucamonga
const DEFAULT_ZOOM = 12;

const MAPTILER_API_KEY = String(window.DASH_MAPTILER_KEY || "").trim();
const MAPTILER_STYLE_ID = String(window.DASH_MAPTILER_STYLE_ID || "basic-v2").trim();
const MAP_STYLE_URL = MAPTILER_API_KEY
  ? `https://api.maptiler.com/maps/${encodeURIComponent(MAPTILER_STYLE_ID)}/style.json?key=${encodeURIComponent(MAPTILER_API_KEY)}`
  : "https://demotiles.maplibre.org/style.json";

const SOURCE_RESTAURANTS = "restaurants";
const SOURCE_PARKING = "parking";
const SOURCE_HEAT = "heat";
const SOURCE_SPOT = "spot";
const SOURCE_CURRENT_LOCATION = "current-location";
const SOURCE_CURRENT_LOCATION_ACCURACY = "current-location-accuracy";

const LAYER_HEAT = "heat-layer";
const LAYER_RESTAURANTS = "restaurants-layer";
const LAYER_PARKING = "parking-layer";
const LAYER_SPOT = "spot-layer";
const LAYER_CURRENT_LOCATION_ACCURACY_FILL = "current-location-accuracy-fill";
const LAYER_CURRENT_LOCATION_ACCURACY_LINE = "current-location-accuracy-line";
const LAYER_CURRENT_LOCATION_DOT = "current-location-dot";

const map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE_URL,
  center: DEFAULT_CENTER,
  zoom: DEFAULT_ZOOM,
  maxZoom: 19,
  attributionControl: { compact: true },
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

let activePopup = null;
let activeAbort = null;
let lastCurrentLocation = null;
let lastCurrentLocationAccuracyMeters = null;

const restaurantById = new Map();
const parkingById = new Map();

let lastRestaurants = [];
let lastParkingCandidates = [];
let lastResidentialAnchors = [];
let lastStats = null;
let lastLoadedBounds = null; // tracks the bounds used for the last successful load

let lastParams = {
  hour: 0,
  tauMeters: 1200,
  horizonMin: 10,
  competitionStrength: 0.35,
  residentialDemandWeight: 0.35,
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

const LOCATION_TARGET_ZOOM = 16;
const LOCATION_ANIMATION_MIN_START_ZOOM = 14;
const LOCATION_ANIMATION_MAX_DISTANCE_METERS = 5000;
const LOCATION_PAN_DURATION_SECONDS = 0.9;
const LOCATION_ZOOM_STEP = 3;
const MAX_VISIBLE_ACCURACY_RADIUS_METERS = 45;

const INITIAL_LOCATION_ZOOM = 14;
const INITIAL_LOCATION_TIMEOUT_MS = 8000;

const diagramContainer = document.getElementById("diagram");
renderModelDiagram(diagramContainer);

let isLocating = false;
let hasRequestedInitialLocation = false;

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

  popup.on("close", () => {
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
    id: LAYER_CURRENT_LOCATION_DOT,
    type: "circle",
    source: SOURCE_CURRENT_LOCATION,
    paint: {
      "circle-radius": 8,
      "circle-color": "#2d6cdf",
      "circle-stroke-color": "#f4fbff",
      "circle-stroke-width": 3,
      "circle-opacity": 0.95,
    },
  });

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
    openPopupAtLngLat(event.lngLat, `<b>${escapeHtml(name)}</b><br/>${escapeHtml(amenity)}`);
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
  elHorizonVal.textContent = `${elHorizon.value} min`;
  elCompetitionVal.textContent = `${Number(elCompetition.value).toFixed(2)}`;
  elResidentialWeightVal.textContent = `${Number(elResidentialWeight.value).toFixed(2)}`;
  elTipEmphasisVal.textContent = `${Number(elTipEmphasis.value).toFixed(2)}`;
  elMlBetaVal.textContent = `${Number(elMlBeta.value).toFixed(1)}`;
  elKSpotsVal.textContent = `${Number(elKSpots.value)}`;
  elMinSepVal.textContent = `${Number(elMinSep.value)} m`;
}

setHourDefaults();
updateLabels();

elHour.addEventListener("input", updateLabels);
elTau.addEventListener("input", updateLabels);
elGrid.addEventListener("input", updateLabels);
elHorizon.addEventListener("input", updateLabels);
elCompetition.addEventListener("input", updateLabels);
elResidentialWeight.addEventListener("input", updateLabels);
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

function describeGeolocationError(error) {
  if (!error) return "Unable to determine your location.";
  if (error.code === error.PERMISSION_DENIED) return "Location access was denied. Enable location permission and try again.";
  if (error.code === error.POSITION_UNAVAILABLE) return "Your current position is unavailable right now. Try again in a moment.";
  if (error.code === error.TIMEOUT) return "Location lookup timed out. Try again with a stronger signal.";
  return error.message || "Unable to determine your location.";
}

function showCurrentLocation(latlng, accuracyMeters) {
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

  openPopupAtLngLat(currentLngLat, `You are here<br/><span class="mono">Accuracy ±${Math.round(accuracyRadius)} m</span>`);
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

  if (!navigator.geolocation) {
    alert("Geolocation is not supported in this browser.");
    return;
  }

  setLocateButtonState(true);

  try {
    const position = await getCurrentPosition();
    const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };

    const animateLocate = shouldAnimateLocate(latlng);
    const targetZoom = clampMapZoom(LOCATION_TARGET_ZOOM);

    closePanelIfOpen();
    lastCurrentLocation = null;
    lastCurrentLocationAccuracyMeters = null;
    setSourceData(SOURCE_CURRENT_LOCATION, featureCollection());
    setSourceData(SOURCE_CURRENT_LOCATION_ACCURACY, featureCollection());

    if (animateLocate) {
      map.once("moveend", () => {
        showCurrentLocation(latlng, position.coords.accuracy);
      });

      map.flyTo({ center: lngLatToArray(latlng), zoom: targetZoom, duration: 850 });
    } else {
      map.once("moveend", () => {
        animateZoomToTarget(targetZoom, () => {
          showCurrentLocation(latlng, position.coords.accuracy);
        });
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
  const percentile = percentileFromSorted(score.pGood, lastStats?.scoreSamplesSorted);
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

function renderDemandMixDetail(score) {
  const residentialShare = clamp01(score?.residentialShare ?? 0);
  const merchantShare = clamp01(1 - residentialShare);

  if (residentialShare <= 0.02) {
    return `Demand mix: ${formatPercent(merchantShare)} merchant-driven · negligible residential pull`;
  }

  return `Demand mix: ${formatPercent(merchantShare)} merchant-driven · ${formatPercent(residentialShare)} residential pull`;
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

function renderSummaryCards(rankedParking, restaurants, parking, residentialAnchors) {
  if (!elSummaryCards) return;

  if (!rankedParking.length) {
    elSummaryCards.innerHTML = "";
    return;
  }

  const best = rankedParking[0];
  const medianScore = lastStats?.medianScore ?? 0;
  const topDecileScore = lastStats?.topDecileScore ?? 0;
  const bucketLabel = lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label;
  const holdCount = rankedParking.filter(p => p.advisory === "hold").length;

  elSummaryCards.innerHTML = `
<article class="summary-card">
  <span class="summary-label">Best spot found</span>
  <strong>${formatPercent(best.pGood)} chance</strong>
  <p>The top-ranked parking spot has a <b>${formatPercent(best.pGood)}</b> estimated chance of getting a good order within ${lastParams.horizonMin} minutes. ${describeSignal(best.pGood)}.</p>
</article>

<article class="summary-card">
  <span class="summary-label">How this area compares</span>
  <strong>${formatPercent(medianScore)} typical · ${formatPercent(topDecileScore)} best zones</strong>
  <p>A typical spot on this map scores ${formatPercent(medianScore)}. The hottest 10% of the map scores ${formatPercent(topDecileScore)} or higher. Bigger gap = more variation to exploit.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Time of day: ${escapeHtml(bucketLabel)}</span>
  <strong>${holdCount} of ${rankedParking.length} spots worth holding</strong>
  <p>The model shifts what matters by time of day. Right now (${escapeHtml(bucketLabel)}), ${holdCount > 0 ? holdCount + " spot(s) are strong enough to wait at" : "no spots are strong enough to just wait — consider moving between areas"}.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Data loaded</span>
  <strong>${restaurants.length} restaurants · ${residentialAnchors.length} residential anchors · ${parking.length} parking lots</strong>
  <p>Scores are based on ${restaurants.length} restaurants, ${residentialAnchors.length} residential demand anchors, and ${parking.length} parking lots visible on the map. Zoom in for more accurate results.</p>
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
  <div class="popup-score">${formatPercent(p.pGood)}<span class="popup-score-label"> chance of a good order in ${lastParams.horizonMin} min</span></div>
  <div class="popup-explain">${escapeHtml(describeSignal(p.pGood))}</div>
  <div class="popup-rank">${escapeHtml(formatRelativeRank(p))}</div>
  <div class="popup-detail" title="We're ${formatPercent(p.stabilityLow)}–${formatPercent(p.stabilityHigh)} confident in this score">Confidence range: ${formatPercent(p.stabilityLow)} – ${formatPercent(p.stabilityHigh)} · ${escapeHtml(describeStability(p))}</div>
  <div class="popup-detail">${escapeHtml(describePickup(p.expectedDistMeters))}</div>
  <div class="popup-detail">Chance of <i>any</i> order: ${formatPercent(p.pAny)} · Avg ticket quality: ${formatPercent(p.tipProxy)}</div>
  <div class="popup-detail">${escapeHtml(renderDemandMixDetail(p))}</div>
  <div class="popup-advisory">Overall strength: ${formatPercent(p.composite)} · ${describeAdvisory(p.advisory)}</div>

  ${renderSignalBarsHtml(p.signals, p.timeBucketLabel)}

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

  <div class="popup-score">${formatPercent(r.pGood)}<span class="popup-score-label"> chance of a good order in ${lastParams.horizonMin} min</span></div>
  <div class="popup-explain">${escapeHtml(describeSignal(r.pGood))}</div>
  <div class="popup-rank">${escapeHtml(formatRelativeRank(r))}</div>
  <div class="popup-detail" title="We're ${formatPercent(r.stabilityLow)}–${formatPercent(r.stabilityHigh)} confident in this score">Confidence range: ${formatPercent(r.stabilityLow)} – ${formatPercent(r.stabilityHigh)} · ${escapeHtml(describeStability(r))}</div>
  <div class="popup-detail">${escapeHtml(describePickup(r.expectedDistMeters))}</div>
  <div class="popup-detail">Chance of <i>any</i> order: ${formatPercent(r.pAny)} · Avg ticket quality: ${formatPercent(r.tipProxy)}</div>
  <div class="popup-detail">${escapeHtml(renderDemandMixDetail(r))}</div>
  <div class="popup-advisory">Overall strength: ${formatPercent(r.composite)} · ${describeAdvisory(r.advisory)}</div>

  ${renderSignalBarsHtml(r.signals, r.timeBucketLabel)}

  <hr/>

  <div><b>Closest restaurants</b></div>
  <ol style="margin:6px 0 0 18px; padding:0;">${rows}</ol>
</div>
`;
}

function setSpotMarker(latlng) {
  const point = latlngToObject(latlng);

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
<span class="list-title">${escapeHtml(name)} — ${formatPercent(p.pGood)} chance</span>
<span class="list-meta">${escapeHtml(describeSignal(p.pGood))}</span>
<span class="list-meta">${escapeHtml(formatRelativeRank(p))}</span>
<span class="list-meta">${escapeHtml(describePickup(p.expectedDistMeters))}</span>
<span class="list-meta">Strength: ${formatPercent(p.composite)} · ${describeAdvisory(p.advisory)}</span>
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
    const horizonMin = Number(elHorizon.value);
    const competitionStrength = Number(elCompetition.value);
    const residentialDemandWeight = Number(elResidentialWeight.value);
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

    const [allRestaurants, parking, residentialAnchors] = await Promise.all([
      fetchFoodPlaces(queryBounds, activeAbort.signal),
      fetchParkingCandidates(queryBounds, activeAbort.signal),
      fetchResidentialAnchors(queryBounds, activeAbort.signal),
    ]);

    // Freeze local time once so hours-based eligibility stays consistent for this refresh.
    const restaurants = filterOpenRestaurants(allRestaurants, new Date());

    lastRestaurants = restaurants;
    lastParkingCandidates = parking;
    lastResidentialAnchors = residentialAnchors;

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
        residentialAnchors,
        residentialDemandWeight,
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
        residentialAnchors,
        residentialDemandWeight,
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
      residentialAnchors,
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
    renderSummaryCards(ranked, restaurants, parking, residentialAnchors);

    setLayerVisibility(LAYER_RESTAURANTS, elShowRestaurants.checked);
    setLayerVisibility(LAYER_PARKING, elShowParking.checked);
  } finally {
    elLoad.disabled = false;
    elLoad.textContent = "Load / Refresh for current view";
  }
}

elLoad.addEventListener("click", () => {
  loadForView().catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err?.message ?? String(err)}`);
  });
});

if (elLocateMe) {
  elLocateMe.addEventListener("click", locateUser);
}

map.on("moveend", checkDataFreshness);

map.on("click", (event) => {
  const featuresAtPoint = map.queryRenderedFeatures(event.point, {
    layers: [LAYER_RESTAURANTS, LAYER_PARKING, LAYER_CURRENT_LOCATION_DOT],
  });

  if (featuresAtPoint.length) return;

  openStatsPopupAtLatLng(event.lngLat);
});

map.on("load", () => {
  ensureMapSourcesAndLayers();

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
