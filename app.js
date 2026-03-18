// ──────────────────────────────────────────────────────────────────
// GOVERNANCE: This UI module renders descriptive, annotation-only
// outputs (§6 A-1..A-4). All advisory text is non-prescriptive
// and many-to-one (§6.6). Threshold-based descriptions (§5) carry
// no triggers, alerts, or implied actions. No element of this
// module constitutes decision authority (§1 I-4).
// See docs/GOVERNANCE.md and docs/CLASSIFICATION_REGISTRY.md.
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

const diagramContainer = document.getElementById("diagram");
renderModelDiagram(diagramContainer);

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
    setDataStatus("Data stale \u2014 reload for this area", "warn");
  } else if (!lastLoadedBounds.contains(current)) {
    setDataStatus("View extends beyond loaded data \u2014 reload to refresh edges", "info");
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
  return advisory === 'hold'
    ? '\u2705 Hold — worth waiting here'
    : '\u21bb Rotate — try a different spot';
}

function renderSignalBarsHtml(signals, bucketLabel) {
  const bars = [
    { key: 'I', label: 'Avg ticket size', tip: 'How expensive nearby restaurants tend to be (correlates with tips)', value: signals.I, color: '#7fe8b0' },
    { key: 'M', label: 'Restaurant density', tip: 'How many restaurants are within range', value: signals.M, color: '#9ad3ff' },
    { key: 'R', label: 'Proximity', tip: 'How close the nearest merchants are', value: signals.R, color: '#c4b5fd' },
    { key: 'D', label: 'Crowding (bad)', tip: 'How many other parking spots are nearby (more = more competition)', value: signals.D, color: '#f87171' },
  ];
  const rows = bars.map(b =>
    `<div class="sig-row" title="${escapeHtml(b.tip)}"><span class="sig-label">${b.label}</span><span class="sig-track"><span class="sig-fill" style="width:${Math.round(b.value * 100)}%;background:${b.color}"></span></span><span class="sig-val">${Math.round(b.value * 100)}%</span></div>`
  ).join('');
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
  const holdCount = rankedParking.filter(p => p.advisory === 'hold').length;

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
      <p>The model shifts what matters by time of day. Right now (${escapeHtml(bucketLabel)}), ${holdCount > 0 ? holdCount + ' spot(s) are strong enough to wait at' : 'no spots are strong enough to just wait — consider moving between areas'}.</p>
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
    .map(
      (x) =>
        `<li>${escapeHtml(x.name)} <span class="mono">(${escapeHtml(x.amenity)}, ${x.distMeters}m)</span></li>`
    )
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
    .map(
      (x) =>
        `<li>${escapeHtml(x.name)} <span class="mono">(${escapeHtml(x.amenity)}, ${x.distMeters}m)</span></li>`
    )
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

map.on("click", (e) => {
  if (!lastRestaurants || lastRestaurants.length === 0) {
    L.popup()
      .setLatLng(e.latlng)
      .setContent("Load data first (click ‘Load / Refresh for current view’).")
      .openOn(map);
    return;
  }

  const { hour, tauMeters } = lastParams;
  const marker = setSpotMarker(e.latlng);
  marker.bindPopup(renderSpotPopupHtml(e.latlng, lastRestaurants, tauMeters, hour)).openPopup();
});

elLoad.addEventListener("click", () => {
  loadForView().catch((err) => {
    console.error(err);
    alert(`Failed to load: ${err?.message ?? String(err)}`);
  });
});

// Helpful default: pre-load once the first tiles render.
map.whenReady(() => {
  const menuButton = document.getElementById("menuToggle");
  const panel = document.getElementById("panel");

  if (menuButton && panel) {
    menuButton.addEventListener("click", () => {
      const isOpen = panel.classList.toggle("open");
      menuButton.setAttribute("aria-expanded", String(isOpen));
      setTimeout(() => { if (map) map.invalidateSize(); }, 250);
    });
  }

  // Force size recalculation before first data load so the canvas
  // never encounters a zero-height container (Leaflet #3575).
  if (map) map.invalidateSize();
  setTimeout(() => {
    if (map) map.invalidateSize();
    loadForView().catch((err) => {
      console.error(err);
      alert(`Failed to load map data: ${err?.message ?? String(err)}`);
    });
  }, 250);
});
