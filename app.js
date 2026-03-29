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

import { fetchFoodPlaces, fetchParkingCandidates } from "./overpass.js";
import {
  buildGridProbabilityHeat,
  filterOpenRestaurants,
  probabilityOfGoodOrder,
  rankParking,
  topLikelyMerchantsForParking,
  timeBucket,
} from "./model.js";
import { renderModelDiagram } from "./diagram.js";
import { isMipAvailable, optimizeParkingSet } from "./optimizer.js";

if (window.location.protocol === "file:") {
  alert(
    "This app must be opened from a local web server (not file://).\n\nRun: python -m http.server 5173\nThen open: http://localhost:5173/"
  );
}

const DEFAULT_CENTER = [34.1064, -117.5931]; // Rancho Cucamonga
const DEFAULT_ZOOM = 12;

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
  tap: false,
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

let heatLayer = null;
const restaurantLayer = L.layerGroup().addTo(map);
const parkingLayer = L.layerGroup().addTo(map);
let spotLayer = L.layerGroup().addTo(map);
let spotMarker = null;

let lastRestaurants = [];
let lastParkingCandidates = [];
let lastStats = null;
let lastLoadedBounds = null; // tracks the bounds used for the last successful load

let lastParams = {
  hour: 0,
  tauMeters: 1200,
  horizonMin: 10,
  competitionStrength: 0.35,
  tipEmphasis: 0.55,
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

const DOUBLE_TAP_MAX_DELAY_MS = 400;
const DOUBLE_TAP_MAX_DISTANCE_PX = 28;
const DOUBLE_TAP_HOLD_DELAY_MS = 120;
const DOUBLE_TAP_HOLD_TOLERANCE_PX = 12;
const DOUBLE_TAP_ZOOM_PIXELS_PER_LEVEL = 125;
const DOUBLE_TAP_ZOOM_THROTTLE_MS = 16;
const DOUBLE_TAP_DBLCLICK_SUPPRESSION_MS = 250;
const TOUCH_CLICK_SUPPRESSION_MS = 700;

let suppressStatsPopupUntil = 0;
let pendingStatsPopupTimer = null;
let pendingStatsPopupLatLng = null;
let lastTouchInteractionAt = 0;
const SUPPRESS_AFTER_GESTURE_MS = L.Browser.mobile ? 450 : 0;

const diagramContainer = document.getElementById("diagram");
renderModelDiagram(diagramContainer);

let currentLocationLayer = L.layerGroup().addTo(map);
let isLocating = false;
let hasRequestedInitialLocation = false;

const touchGestureState = {
  active: false,
  pending: false,
  holdTimer: null,
  activeTouchId: null,
  controlTouchId: null,
  startPoint: null,
  startZoom: DEFAULT_ZOOM,
  controlStartPoint: null,
  controlStartZoom: DEFAULT_ZOOM,
  currentTouch: null,
  lastTap: null,
  dragWasEnabled: false,
  doubleClickZoomWasEnabled: false,
  previousZoomSnap: null,
};

let lastZoomUpdate = 0;

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
elTipEmphasis.addEventListener("input", updateLabels);
elUseML.addEventListener("change", updateLabels);
elMlBeta.addEventListener("input", updateLabels);
elUseMIP.addEventListener("change", updateLabels);
elKSpots.addEventListener("input", updateLabels);
elMinSep.addEventListener("input", updateLabels);

elShowRestaurants.addEventListener("change", () => {
  if (elShowRestaurants.checked) restaurantLayer.addTo(map);
  else restaurantLayer.removeFrom(map);
});

elShowParking.addEventListener("change", () => {
  if (elShowParking.checked) parkingLayer.addTo(map);
  else parkingLayer.removeFrom(map);
});

let activeAbort = null;

function clampQueryBounds(originalBounds) {
  // Overpass frequently 504s on large bounding boxes.
  // Clamp to a square around the center to keep queries light.
  const diagMeters = map.distance(originalBounds.getSouthWest(), originalBounds.getNorthEast());
  const maxDiagMeters = 12000; // ~12 km diagonal
  if (diagMeters <= maxDiagMeters) return originalBounds;

  // Show a persistent badge instead of a one-shot alert (m6).
  setDataStatus("Query area clamped to ~12 km diagonal — zoom in for full coverage", "warn");

  const center = map.getCenter();
  // Leaflet's toBounds uses meters; keep it conservative.
  return center.toBounds(maxDiagMeters / 2);
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

  const current = map.getBounds();

  if (!lastLoadedBounds.intersects(current)) {
    setDataStatus("Data stale — reload for this area", "warn");
  } else if (!lastLoadedBounds.contains(current)) {
    setDataStatus("View extends beyond loaded data — reload to refresh edges", "info");
  } else {
    setDataStatus("OSM data loaded for this view", "ok");
  }
}

function clearLayers() {
  restaurantLayer.clearLayers();
  parkingLayer.clearLayers();
  spotLayer.clearLayers();
  spotMarker = null;

  elParkingList.innerHTML = "";
  if (elSummaryCards) elSummaryCards.innerHTML = "";

  if (heatLayer) {
    map.removeLayer(heatLayer);
    heatLayer = null;
  }

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
    if (map) map.invalidateSize();
  }, 250);
}

function closePanelIfOpen() {
  if (!panel?.classList.contains("open")) return false;

  syncPanelState(false);
  map.closePopup();
  if (spotMarker) spotMarker.closePopup();
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
  currentLocationLayer.clearLayers();

  const accuracyRadius = Math.max(Number(accuracyMeters) || 0, 12);

  if (accuracyRadius <= MAX_VISIBLE_ACCURACY_RADIUS_METERS) {
    L.circle([latlng.lat, latlng.lng], {
      radius: accuracyRadius,
      weight: 1,
      color: "#a7e3ff",
      fillColor: "#2d6cdf",
      fillOpacity: 0.1,
    }).addTo(currentLocationLayer);
  }

  L.circleMarker([latlng.lat, latlng.lng], {
    radius: 8,
    weight: 3,
    color: "#f4fbff",
    fillColor: "#2d6cdf",
    fillOpacity: 0.95,
  })
    .bindPopup(`You are here<br/><span class="mono">Accuracy ±${Math.round(accuracyRadius)} m</span>`)
    .addTo(currentLocationLayer)
    .openPopup();
}

function shouldAnimateLocate(latlng) {
  return map.getZoom() >= LOCATION_ANIMATION_MIN_START_ZOOM
    && map.distance(map.getCenter(), latlng) <= LOCATION_ANIMATION_MAX_DISTANCE_METERS;
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

  map.setZoom(nextZoom, { animate: true });
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

    const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
    map.setView(latlng, clampMapZoom(INITIAL_LOCATION_ZOOM), { animate: false });
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
    const latlng = L.latLng(position.coords.latitude, position.coords.longitude);

    const animateLocate = shouldAnimateLocate(latlng);
    const targetZoom = clampMapZoom(LOCATION_TARGET_ZOOM);

    closePanelIfOpen();
    currentLocationLayer.clearLayers();

    if (animateLocate) {
      map.once("moveend", () => {
        showCurrentLocation(latlng, position.coords.accuracy);
      });

      map.flyTo(latlng, targetZoom, {
        duration: 0.85,
      });
    } else {
      map.once("moveend", () => {
        animateZoomToTarget(targetZoom, () => {
          showCurrentLocation(latlng, position.coords.accuracy);
        });
      });

      map.panTo(latlng, {
        animate: true,
        duration: LOCATION_PAN_DURATION_SECONDS,
        easeLinearity: 0.2,
      });
    }
  } catch (error) {
    alert(describeGeolocationError(error));
  } finally {
    setLocateButtonState(false);
  }
}

function clearDoubleTapHoldTimer() {
  if (touchGestureState.holdTimer !== null) {
    window.clearTimeout(touchGestureState.holdTimer);
    touchGestureState.holdTimer = null;
  }
}

function clearPendingStatsPopup() {
  if (pendingStatsPopupTimer !== null) {
    window.clearTimeout(pendingStatsPopupTimer);
    pendingStatsPopupTimer = null;
  }

  pendingStatsPopupLatLng = null;
}

function openStatsPopupAtLatLng(latlng) {
  if (!latlng) return;

  if (performance.now() < suppressStatsPopupUntil) {
    return;
  }

  if (closePanelIfOpen()) {
    return;
  }

  if (!lastRestaurants || lastRestaurants.length === 0) {
    L.popup()
      .setLatLng(latlng)
      .setContent("Load data first (click ‘Load / Refresh for current view’).")
      .openOn(map);
    return;
  }

  const { hour, tauMeters } = lastParams;

  const marker = setSpotMarker(latlng);
  marker.bindPopup(renderSpotPopupHtml(latlng, lastRestaurants, tauMeters, hour)).openPopup();
}

function schedulePendingStatsPopup(latlng) {
  clearPendingStatsPopup();

  pendingStatsPopupLatLng = latlng;
  pendingStatsPopupTimer = window.setTimeout(() => {
    const nextLatLng = pendingStatsPopupLatLng;
    clearPendingStatsPopup();
    openStatsPopupAtLatLng(nextLatLng);
  }, DOUBLE_TAP_MAX_DELAY_MS);
}

function resetDoubleTapHoldZoomState() {
  clearDoubleTapHoldTimer();

  if (touchGestureState.active) {
    const currentZoom = map.getZoom();
    const snappedZoom = Math.round(currentZoom);

    if (Math.abs(snappedZoom - currentZoom) > 0.02) {
      map.setZoom(snappedZoom, { animate: true, duration: 0.12 });
    } else {
      map.setZoom(snappedZoom, { animate: false });
    }

    if (touchGestureState.previousZoomSnap !== null) {
      map.options.zoomSnap = touchGestureState.previousZoomSnap;
    }

    if (touchGestureState.dragWasEnabled && map.dragging) {
      map.dragging.enable();
    }

    if (touchGestureState.doubleClickZoomWasEnabled && map.doubleClickZoom) {
      window.setTimeout(() => {
        map.doubleClickZoom.enable();
      }, DOUBLE_TAP_DBLCLICK_SUPPRESSION_MS);
    }
  }

  touchGestureState.active = false;
  touchGestureState.pending = false;
  touchGestureState.holdTimer = null;
  touchGestureState.activeTouchId = null;
  touchGestureState.controlTouchId = null;
  touchGestureState.startPoint = null;
  touchGestureState.startZoom = map.getZoom();
  touchGestureState.controlStartPoint = null;
  touchGestureState.controlStartZoom = map.getZoom();
  touchGestureState.dragWasEnabled = false;
  touchGestureState.doubleClickZoomWasEnabled = false;
  touchGestureState.previousZoomSnap = null;
}

function findTouchById(touchList, touchId) {
  if (!touchList) return null;

  for (const touch of touchList) {
    if (touch.identifier === touchId) return touch;
  }

  return null;
}

function findZoomControlTouch(touchList, anchorTouchId) {
  if (!touchList?.length) return null;

  for (const touch of touchList) {
    if (touch.identifier !== anchorTouchId) return touch;
  }

  return findTouchById(touchList, anchorTouchId);
}

function handleMapTouchStart(event) {
  const originalEvent = event.originalEvent;
  if (!originalEvent) return;

  lastTouchInteractionAt = performance.now();
  clearPendingStatsPopup();

  if (touchGestureState.pending || touchGestureState.active) {
    return;
  }

  if (originalEvent.touches.length !== 1) {
    touchGestureState.currentTouch = null;
    return;
  }

  const touch = originalEvent.touches[0];
  const point = L.point(touch.clientX, touch.clientY);
  const now = performance.now();

  touchGestureState.currentTouch = {
    id: touch.identifier,
    startPoint: point,
    startTime: now,
    moved: false,
  };

  const lastTap = touchGestureState.lastTap;

  const isDoubleTap = lastTap
    && now - lastTap.time <= DOUBLE_TAP_MAX_DELAY_MS
    && point.distanceTo(lastTap.point) <= DOUBLE_TAP_MAX_DISTANCE_PX;

  if (!isDoubleTap) return;

  suppressStatsPopupUntil = now + SUPPRESS_AFTER_GESTURE_MS;

  // Wait briefly on the second tap so normal taps and pans still pass through untouched.
  touchGestureState.pending = true;
  touchGestureState.activeTouchId = touch.identifier;
  touchGestureState.startPoint = point;
  touchGestureState.startZoom = map.getZoom();
  touchGestureState.controlTouchId = null;
  touchGestureState.controlStartPoint = null;
  touchGestureState.controlStartZoom = touchGestureState.startZoom;

  clearDoubleTapHoldTimer();

  touchGestureState.holdTimer = window.setTimeout(() => {
    if (!touchGestureState.pending || !touchGestureState.startPoint) return;

    // Once the hold is confirmed, convert vertical drag distance into fractional zoom.
    touchGestureState.pending = false;
    touchGestureState.active = true;

    suppressStatsPopupUntil = performance.now() + SUPPRESS_AFTER_GESTURE_MS;

    touchGestureState.lastTap = null;
    touchGestureState.dragWasEnabled = Boolean(map.dragging?.enabled());
    touchGestureState.doubleClickZoomWasEnabled = Boolean(map.doubleClickZoom?.enabled());
    touchGestureState.previousZoomSnap = map.options.zoomSnap;

    if (touchGestureState.dragWasEnabled) {
      map.dragging.disable();
    }

    if (touchGestureState.doubleClickZoomWasEnabled) {
      map.doubleClickZoom.disable();
    }

    map.options.zoomSnap = 0;
  }, DOUBLE_TAP_HOLD_DELAY_MS);
}

function handleMapTouchMove(event) {
  const originalEvent = event.originalEvent;
  if (!originalEvent) return;

  lastTouchInteractionAt = performance.now();

  const currentTouchId = touchGestureState.currentTouch?.id;
  const touch = findTouchById(originalEvent.touches, currentTouchId);
  if (!touch) return;

  const point = L.point(touch.clientX, touch.clientY);

  if (touchGestureState.currentTouch?.startPoint) {
    const movedDistance = point.distanceTo(touchGestureState.currentTouch.startPoint);
    if (movedDistance > DOUBLE_TAP_HOLD_TOLERANCE_PX) {
      touchGestureState.currentTouch.moved = true;
    }
  }

  if (touchGestureState.pending && touch.identifier === touchGestureState.activeTouchId) {
    if (touchGestureState.startPoint && point.distanceTo(touchGestureState.startPoint) > DOUBLE_TAP_HOLD_TOLERANCE_PX) {
      // Dragging before the hold timer fires — activate zoom immediately instead of cancelling.
      clearDoubleTapHoldTimer();
      touchGestureState.pending = false;
      touchGestureState.active = true;
      suppressStatsPopupUntil = performance.now() + SUPPRESS_AFTER_GESTURE_MS;
      touchGestureState.lastTap = null;
      touchGestureState.dragWasEnabled = Boolean(map.dragging?.enabled());
      touchGestureState.doubleClickZoomWasEnabled = Boolean(map.doubleClickZoom?.enabled());
      touchGestureState.previousZoomSnap = map.options.zoomSnap;
      if (touchGestureState.dragWasEnabled) map.dragging.disable();
      if (touchGestureState.doubleClickZoomWasEnabled) map.doubleClickZoom.disable();
      map.options.zoomSnap = 0;
      // Fall through to the zoom handling below.
    } else {
      return;
    }
  }

  if (!touchGestureState.active || touch.identifier !== touchGestureState.activeTouchId || !touchGestureState.startPoint) {
    if (!touchGestureState.active || !touchGestureState.startPoint) {
      return;
    }
  }

  const anchorTouch = findTouchById(originalEvent.touches, touchGestureState.activeTouchId);
  if (!anchorTouch) {
    resetDoubleTapHoldZoomState();
    return;
  }

  const zoomTouch = findZoomControlTouch(originalEvent.touches, touchGestureState.activeTouchId);
  if (!zoomTouch) return;

  let zoomStartPoint = touchGestureState.startPoint;
  let zoomStartLevel = touchGestureState.startZoom;

  if (zoomTouch.identifier !== touchGestureState.activeTouchId) {
    if (touchGestureState.controlTouchId !== zoomTouch.identifier || !touchGestureState.controlStartPoint) {
      touchGestureState.controlTouchId = zoomTouch.identifier;
      touchGestureState.controlStartPoint = L.point(zoomTouch.clientX, zoomTouch.clientY);
      touchGestureState.controlStartZoom = map.getZoom();
    }

    zoomStartPoint = touchGestureState.controlStartPoint;
    zoomStartLevel = touchGestureState.controlStartZoom;
  } else {
    touchGestureState.controlTouchId = null;
    touchGestureState.controlStartPoint = null;
    touchGestureState.controlStartZoom = map.getZoom();
  }

  originalEvent.preventDefault();
  suppressStatsPopupUntil = performance.now() + SUPPRESS_AFTER_GESTURE_MS;

  const deltaY = zoomTouch.clientY - zoomStartPoint.y;
  const rawZoom = clampMapZoom(
    zoomStartLevel + deltaY / DOUBLE_TAP_ZOOM_PIXELS_PER_LEVEL
  );

  const nextZoom = rawZoom;

  const now = performance.now();
  if (now - lastZoomUpdate < DOUBLE_TAP_ZOOM_THROTTLE_MS) return;
  lastZoomUpdate = now;

  if (Math.abs(nextZoom - map.getZoom()) < 0.02) return;

  map.setZoomAround(
    map.containerPointToLatLng(touchGestureState.startPoint),
    nextZoom,
    { animate: false }
  );
}

function handleMapTouchEnd(event) {
  const originalEvent = event.originalEvent;
  const currentTouch = touchGestureState.currentTouch;
  lastTouchInteractionAt = performance.now();

  const finishedTouch = currentTouch
    ? findTouchById(originalEvent?.changedTouches, currentTouch.id)
    : null;

  const endPoint = finishedTouch
    ? L.point(finishedTouch.clientX, finishedTouch.clientY)
    : currentTouch?.startPoint;
  const endLatLng = finishedTouch
    ? map.mouseEventToLatLng(finishedTouch)
    : null;

  const now = performance.now();

  if (touchGestureState.active || touchGestureState.pending) {
    if (originalEvent) L.DomEvent.preventDefault(originalEvent);
    suppressStatsPopupUntil = now + SUPPRESS_AFTER_GESTURE_MS;
  }

  const activeTouchEnded = Boolean(
    touchGestureState.activeTouchId !== null
      && findTouchById(originalEvent?.changedTouches, touchGestureState.activeTouchId)
  );
  const controlTouchEnded = Boolean(
    touchGestureState.controlTouchId !== null
      && findTouchById(originalEvent?.changedTouches, touchGestureState.controlTouchId)
  );

  if (touchGestureState.active && activeTouchEnded) {
    resetDoubleTapHoldZoomState();
    touchGestureState.currentTouch = null;
    return;
  }

  if (touchGestureState.active && controlTouchEnded) {
    touchGestureState.controlTouchId = null;
    touchGestureState.controlStartPoint = null;
    touchGestureState.controlStartZoom = map.getZoom();
  }

  if (touchGestureState.pending && activeTouchEnded) {
    clearDoubleTapHoldTimer();
    touchGestureState.pending = false;
    touchGestureState.activeTouchId = null;
    touchGestureState.startPoint = null;
    touchGestureState.controlTouchId = null;
    touchGestureState.controlStartPoint = null;
    touchGestureState.controlStartZoom = map.getZoom();
  }

  if (currentTouch && endPoint && !currentTouch.moved && now - currentTouch.startTime <= DOUBLE_TAP_MAX_DELAY_MS) {
    touchGestureState.lastTap = {
      point: endPoint,
      time: now,
    };

    if (!touchGestureState.active && endLatLng) {
      suppressStatsPopupUntil = now + DOUBLE_TAP_MAX_DELAY_MS;
      schedulePendingStatsPopup(endLatLng);
    }
  } else if (!touchGestureState.active) {
    touchGestureState.lastTap = null;
    clearPendingStatsPopup();
  }

  touchGestureState.currentTouch = null;
}

function handleMapTouchCancel() {
  lastTouchInteractionAt = performance.now();
  touchGestureState.currentTouch = null;
  touchGestureState.lastTap = null;
  clearPendingStatsPopup();
  resetDoubleTapHoldZoomState();
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
  if (score >= 0.75) return "Excellent area — dense, high-quality merchants nearby";
  if (score >= 0.58) return "Good area — solid merchant coverage";
  if (score >= 0.42) return "Decent area — moderate merchant presence";
  if (score >= 0.25) return "Sparse area — few merchants in range";
  return "Weak area — very little merchant coverage";
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

function renderSummaryCards(rankedParking, restaurants, parking) {
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
  <strong>${restaurants.length} restaurants · ${parking.length} parking lots</strong>
  <p>Scores are based on ${restaurants.length} restaurants and ${parking.length} parking lots visible on the map. Zoom in for more accurate results.</p>
</article>
`;
}

function addRestaurantMarkers(restaurants) {
  for (const r of restaurants) {
    const name = r.tags?.name || r.tags?.brand || "Food place";
    const amenity = r.tags?.amenity || "";

    L.circleMarker([r.lat, r.lon], {
      radius: 4,
      weight: 1,
      color: "#ffe59a",
      fillColor: "#ffbf45",
      fillOpacity: 0.8,
    })
      .bindPopup(`<b>${escapeHtml(name)}</b><br/>${escapeHtml(amenity)}`)
      .addTo(restaurantLayer);
  }
}

function addParkingMarkers(rankedParking, restaurants, tauMeters, hour) {
  for (const p of rankedParking) {
    const name = p.tags?.name || p.tags?.operator || "Parking";

    const marker = L.circleMarker([p.lat, p.lon], {
      radius: 7,
      weight: 2,
      color: "#9ad3ff",
      fillColor: "#2d6cdf",
      fillOpacity: 0.6,
    })
      .bindPopup(renderParkingPopupHtml(p, name, restaurants, tauMeters, hour))
      .addTo(parkingLayer);

    marker.on("click", () => {
      map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
    });
  }
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
    tipEmphasis: lastParams.tipEmphasis,
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
  <div class="popup-advisory">Overall strength: ${formatPercent(r.composite)} · ${describeAdvisory(r.advisory)}</div>

  ${renderSignalBarsHtml(r.signals, r.timeBucketLabel)}

  <hr/>

  <div><b>Closest restaurants</b></div>
  <ol style="margin:6px 0 0 18px; padding:0;">${rows}</ol>
</div>
`;
}

function setSpotMarker(latlng) {
  spotLayer.clearLayers();

  spotMarker = L.circleMarker([latlng.lat, latlng.lng], {
    radius: 9,
    weight: 2,
    color: "#f4f1ff",
    fillColor: "#b18bff",
    fillOpacity: 0.75,
  }).addTo(spotLayer);

  return spotMarker;
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
      map.setView([p.lat, p.lon], Math.max(map.getZoom(), 15));
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
    const tipEmphasis = Number(elTipEmphasis.value);
    const useML = Boolean(elUseML.checked);
    const mlBeta = Number(elMlBeta.value);
    let useMIP = Boolean(elUseMIP.checked);
    const kSpots = Number(elKSpots.value);
    const minSepMeters = Number(elMinSep.value);

    if (useMIP && !isMipAvailable()) {
      useMIP = false;
      elUseMIP.checked = false;

      console.warn("MIP solver not available; falling back to non-MIP ranking.");

      alert(
        "MIP solver couldn’t load (CDN blocked/offline). Falling back to non-MIP ranking.\n\nIf you want MIP, allow loading: https://unpkg.com/javascript-lp-solver@0.4.24/prod/solver.js"
      );
    }

    lastParams = {
      hour,
      tauMeters,
      horizonMin,
      competitionStrength,
      tipEmphasis,
      useML,
      mlBeta,
      useMIP,
      kSpots,
      minSepMeters,
    };

    const bbox = map.getBounds();
    const queryBounds = clampQueryBounds(bbox);

    const [allRestaurants, parking] = await Promise.all([
      fetchFoodPlaces(queryBounds, activeAbort.signal),
      fetchParkingCandidates(queryBounds, activeAbort.signal),
    ]);

    // Freeze local time once so hours-based eligibility stays consistent for this refresh.
    const restaurants = filterOpenRestaurants(allRestaurants, new Date());

    lastRestaurants = restaurants;
    lastParkingCandidates = parking;

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
        tipEmphasis,
        useML,
        mlBeta,
      },
      gridStepMeters
    );

    lastStats = heatResult.stats;
    lastLoadedBounds = queryBounds;

    checkDataFreshness();

    heatLayer = L.heatLayer(heatResult.heatPoints, {
      radius: 22,
      blur: 18,
      maxZoom: 17,
      minOpacity: 0.25,
      gradient: {
        0.1: "#2d6cdf",
        0.35: "#00d4ff",
        0.55: "#fff1a8",
        0.75: "#ff9b3d",
        1.0: "#ff3b3b",
      },
    }).addTo(map);

    const rankedAll = rankParking(
      parking,
      restaurants,
      parking,
      { hour, tauMeters, horizonMin, competitionStrength, tipEmphasis, useML, mlBeta },
      lastStats,
      40
    );

    const ranked = useMIP
      ? optimizeParkingSet(rankedAll, { k: kSpots, minSepMeters, maxCandidates: 40 })
      : rankedAll.slice(0, 12);

    addParkingMarkers(ranked, restaurants, tauMeters, hour);
    renderParkingList(ranked);
    renderSummaryCards(ranked, restaurants, parking);

    if (!elShowRestaurants.checked) restaurantLayer.removeFrom(map);
    if (!elShowParking.checked) parkingLayer.removeFrom(map);
  } finally {
    elLoad.disabled = false;
    elLoad.textContent = "Load / Refresh for current view";
  }
}

map.on("moveend", checkDataFreshness);

// Leaflet does not re-emit touchstart/move/end/cancel as map-level events,
// so we attach directly to the DOM container.
const _mapEl = map.getContainer();
_mapEl.addEventListener("touchstart",  (e) => handleMapTouchStart({ originalEvent: e }),  { passive: true });
_mapEl.addEventListener("touchmove",   (e) => handleMapTouchMove({ originalEvent: e }),   { passive: false });
_mapEl.addEventListener("touchend",    (e) => handleMapTouchEnd({ originalEvent: e }),    { passive: false });
_mapEl.addEventListener("touchcancel", ()  => handleMapTouchCancel(),                     { passive: true });

map.on("click", (e) => {
  // Ignore browser-synthesized clicks that originated from a touch/pen.
  const pointerType = e.originalEvent?.pointerType;
  if (pointerType === "touch" || pointerType === "pen") return;

  // Fallback: ignore anything arriving shortly after a real touch interaction.
  if (performance.now() - lastTouchInteractionAt <= TOUCH_CLICK_SUPPRESSION_MS) return;

  if (performance.now() < suppressStatsPopupUntil) {
    suppressStatsPopupUntil = 0;
    return;
  }

  clearPendingStatsPopup();
  openStatsPopupAtLatLng(e.latlng);
});

elLoad.addEventListener("click", () => {
  loadForView().catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err?.message ?? String(err)}`);
  });
});

if (elLocateMe) {
  elLocateMe.addEventListener("click", locateUser);
}

// Helpful default: pre-load once the first tiles render.
map.whenReady(() => {
  if (menuButton && panel) {
    menuButton.addEventListener("click", () => {
      syncPanelState(!panel.classList.contains("open"));
    });
  }

  // Prevent clicks inside the panel from closing it
  if (panel) {
    panel.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  }

  // Force size recalculation before first data load so the canvas
  // never encounters a zero-height container (Leaflet #3575).
  if (map) map.invalidateSize();

  setTimeout(async () => {
    if (map) map.invalidateSize();

    await centerMapOnInitialLocationOnce();

    loadForView().catch((err) => {
      console.error(err);
      alert(`Failed to load map data: ${err?.message ?? String(err)}`);
    });
  }, 250);
});
