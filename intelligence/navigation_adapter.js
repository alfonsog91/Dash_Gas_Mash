// Phase G navigation adapter (STANDALONE).
//
// A self-contained Map Matching + Directions adapter for lane-aware routing,
// smoother turn transitions, and GPS-jitter smoothing. It is intentionally
// decoupled from intelligence/superposition_engine.js: navigation carries NO
// assignment-scoring signal, so the engine is never imported or called here.
//
// Provides:
//   - createGpsSmoother(): a deterministic position + heading filter (EMA with a
//     jump guard) for noisy GPS,
//   - createNavigationAdapter({ fetchImpl, mapMatchUrl, directionsUrl }): async
//     map-matching + directions with an injectable fetch (synthetic offline
//     fallback), plus lane-hint extraction from step/intersection data,
//   - pure helpers (laneHintFromStep, snapHeadingToLanes) used by both.
//
// Approximations / assumptions (documented inline):
// - GPS smoothing is an exponential moving average (EMA) on lon/lat with a
//   "teleport guard": jumps beyond maxJumpMeters are accepted verbatim (treated
//   as a real reposition, not jitter) and reset the filter. Heading is smoothed
//   along the shortest angular arc. This is a lightweight, deterministic
//   approximation of a Kalman filter; it has no velocity model.
// - Map matching: when no real provider is configured, a synthetic matcher snaps
//   each input point to the nearest vertex of a supplied reference path (or
//   passes the points through). This keeps tests deterministic and offline.
// - Lane hints are derived from Directions step "intersections[].lanes" when
//   present (Mapbox Directions shape), else from the maneuver modifier. Output
//   is a bounded, UI-ready { count, active[], recommendation } structure.

const EARTH_RADIUS_METERS = 6371000;
const DEFAULT_SMOOTHING_ALPHA = 0.35;
const DEFAULT_MAX_JUMP_METERS = 60;
const DEFAULT_HEADING_ALPHA = 0.4;

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function normalizeBearing(degrees) {
  return ((Number(degrees) || 0) % 360 + 360) % 360;
}

function shortestAngleDelta(fromDeg, toDeg) {
  return ((normalizeBearing(toDeg) - normalizeBearing(fromDeg) + 540) % 360) - 180;
}

function normalizePoint(point) {
  if (Array.isArray(point)) {
    return { lng: toFiniteNumber(point[0]), lat: toFiniteNumber(point[1]) };
  }
  if (point && typeof point === "object") {
    return {
      lng: toFiniteNumber(point.lng ?? point.lon ?? point.longitude),
      lat: toFiniteNumber(point.lat ?? point.latitude),
    };
  }
  return { lng: null, lat: null };
}

function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Deterministic GPS smoother. push({ lng, lat, heading }) -> smoothed sample.
// EMA on position with a teleport guard; shortest-arc EMA on heading.
function createGpsSmoother({
  alpha = DEFAULT_SMOOTHING_ALPHA,
  headingAlpha = DEFAULT_HEADING_ALPHA,
  maxJumpMeters = DEFAULT_MAX_JUMP_METERS,
} = {}) {
  const positionAlpha = clamp(toFiniteNumber(alpha, DEFAULT_SMOOTHING_ALPHA), 0.01, 1);
  const angleAlpha = clamp(toFiniteNumber(headingAlpha, DEFAULT_HEADING_ALPHA), 0.01, 1);
  const jumpGuard = Math.max(1, toFiniteNumber(maxJumpMeters, DEFAULT_MAX_JUMP_METERS));

  let smoothed = null;
  let smoothedHeading = null;
  const diagnostics = { samples: 0, jumps: 0 };

  function push(sample) {
    const point = normalizePoint(sample);
    if (point.lng === null || point.lat === null) {
      return smoothed ? { ...smoothed } : null;
    }

    const heading = sample && sample.heading !== undefined && sample.heading !== null
      ? normalizeBearing(sample.heading)
      : null;

    diagnostics.samples += 1;

    if (!smoothed) {
      smoothed = { lng: point.lng, lat: point.lat };
      smoothedHeading = heading;
      return { lng: round6(smoothed.lng), lat: round6(smoothed.lat), heading: smoothedHeading === null ? null : round2(smoothedHeading), jumped: false };
    }

    const movement = haversineMeters(smoothed, point);
    if (movement > jumpGuard) {
      // Teleport guard: a large jump is treated as a real reposition.
      diagnostics.jumps += 1;
      smoothed = { lng: point.lng, lat: point.lat };
      smoothedHeading = heading ?? smoothedHeading;
      return { lng: round6(smoothed.lng), lat: round6(smoothed.lat), heading: smoothedHeading === null ? null : round2(smoothedHeading), jumped: true };
    }

    smoothed = {
      lng: smoothed.lng + (point.lng - smoothed.lng) * positionAlpha,
      lat: smoothed.lat + (point.lat - smoothed.lat) * positionAlpha,
    };
    if (heading !== null) {
      smoothedHeading = smoothedHeading === null
        ? heading
        : normalizeBearing(smoothedHeading + shortestAngleDelta(smoothedHeading, heading) * angleAlpha);
    }

    return {
      lng: round6(smoothed.lng),
      lat: round6(smoothed.lat),
      heading: smoothedHeading === null ? null : round2(smoothedHeading),
      jumped: false,
    };
  }

  function reset() {
    smoothed = null;
    smoothedHeading = null;
  }

  function getDiagnostics() {
    return { ...diagnostics };
  }

  return { push, reset, getDiagnostics };
}

const MANEUVER_TO_LANE_RECOMMENDATION = Object.freeze({
  left: "left",
  "slight left": "left",
  "sharp left": "left",
  right: "right",
  "slight right": "right",
  "sharp right": "right",
  straight: "straight",
  uturn: "left",
});

// Derive a bounded, UI-ready lane hint from a Directions step. Prefers explicit
// intersection lane data; falls back to the maneuver modifier. Returns null when
// there is no usable guidance.
function laneHintFromStep(step) {
  if (!step || typeof step !== "object") {
    return null;
  }

  const modifier = String(step.maneuver?.modifier || step.maneuver?.type || "").toLowerCase();
  const recommendation = MANEUVER_TO_LANE_RECOMMENDATION[modifier] || "straight";

  // Mapbox-style intersections[].lanes: [{ valid, indications: [...] }].
  const intersections = Array.isArray(step.intersections) ? step.intersections : [];
  const laneIntersection = intersections.find((entry) => Array.isArray(entry?.lanes) && entry.lanes.length > 0);
  const lanes = laneIntersection ? laneIntersection.lanes : null;

  if (lanes) {
    const active = lanes.map((lane) => Boolean(lane?.valid));
    const indications = lanes.map((lane) => (Array.isArray(lane?.indications) ? lane.indications.slice() : []));
    return {
      count: lanes.length,
      active,
      indications,
      recommendation,
      source: "intersections",
    };
  }

  return {
    count: null,
    active: [],
    indications: [],
    recommendation,
    source: "maneuver",
  };
}

// Snap a raw heading to the closest of a set of allowed lane bearings (degrees).
// Useful for stabilizing the displayed heading near multi-lane intersections.
function snapHeadingToLanes(headingDeg, laneBearings, { toleranceDeg = 25 } = {}) {
  const bearings = (Array.isArray(laneBearings) ? laneBearings : [])
    .map((value) => toFiniteNumber(value))
    .filter((value) => value !== null);
  if (bearings.length === 0) {
    return normalizeBearing(headingDeg);
  }
  let best = null;
  for (const bearing of bearings) {
    const delta = Math.abs(shortestAngleDelta(headingDeg, bearing));
    if (best === null || delta < best.delta) {
      best = { bearing: normalizeBearing(bearing), delta };
    }
  }
  return best && best.delta <= toleranceDeg ? round2(best.bearing) : normalizeBearing(headingDeg);
}

// Synthetic, deterministic map matcher: snaps each point to the nearest vertex
// of a reference path when supplied; otherwise passes points through.
function syntheticMapMatch(points, referencePath) {
  const reference = (Array.isArray(referencePath) ? referencePath : []).map(normalizePoint).filter((p) => p.lng !== null);
  return points.map((rawPoint) => {
    const point = normalizePoint(rawPoint);
    if (point.lng === null) {
      return null;
    }
    if (reference.length === 0) {
      return { lng: round6(point.lng), lat: round6(point.lat), snapped: false };
    }
    let best = null;
    for (const vertex of reference) {
      const distance = haversineMeters(point, vertex);
      if (best === null || distance < best.distance) {
        best = { vertex, distance };
      }
    }
    return { lng: round6(best.vertex.lng), lat: round6(best.vertex.lat), snapped: true, snapDistanceMeters: round2(best.distance) };
  }).filter((p) => p !== null);
}

// Standalone navigation adapter. fetchImpl is injectable; without it (or on any
// error) the adapter uses deterministic synthetic fallbacks so it works offline
// and in tests. NEVER touches superposition_engine.js.
function createNavigationAdapter({
  fetchImpl = typeof fetch !== "undefined" ? fetch : null,
  mapMatchUrl = null,
  directionsUrl = null,
  referencePath = null,
} = {}) {
  const diagnostics = { mapMatchCalls: 0, directionsCalls: 0, fallbacks: 0 };

  // Map matching: snap a noisy GPS trace to the road network.
  async function matchTrace(points, { signal } = {}) {
    const inputPoints = Array.isArray(points) ? points : [];
    diagnostics.mapMatchCalls += 1;

    if (fetchImpl && mapMatchUrl) {
      try {
        const coordinates = inputPoints.map(normalizePoint).filter((p) => p.lng !== null)
          .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
        const url = `${mapMatchUrl}/${coordinates}`;
        const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
        if (response.ok) {
          const body = await response.json();
          const matched = (body.matchings?.[0]?.geometry?.coordinates || []).map((coord) => ({
            lng: round6(coord[0]),
            lat: round6(coord[1]),
            snapped: true,
          }));
          if (matched.length > 0) {
            return { points: matched, source: "provider", confidence: toFiniteNumber(body.matchings?.[0]?.confidence, null) };
          }
        }
      } catch {
        // fall through to synthetic
      }
    }

    diagnostics.fallbacks += 1;
    return { points: syntheticMapMatch(inputPoints, referencePath), source: "synthetic", confidence: null };
  }

  // Directions: fetch a route between waypoints with lane-aware steps. Returns a
  // normalized { distanceMeters, durationSeconds, steps[], laneHints[] }.
  async function getDirections(waypoints, { signal } = {}) {
    const points = (Array.isArray(waypoints) ? waypoints : []).map(normalizePoint).filter((p) => p.lng !== null);
    diagnostics.directionsCalls += 1;
    if (points.length < 2) {
      return { distanceMeters: 0, durationSeconds: 0, steps: [], laneHints: [], source: "empty" };
    }

    if (fetchImpl && directionsUrl) {
      try {
        const coordinates = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
        const url = `${directionsUrl}/${coordinates}`;
        const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
        if (response.ok) {
          const body = await response.json();
          const route = body.routes?.[0];
          if (route) {
            const steps = (route.legs || []).flatMap((leg) => leg.steps || []);
            return {
              distanceMeters: round2(toFiniteNumber(route.distance, 0)),
              durationSeconds: round2(toFiniteNumber(route.duration, 0)),
              steps,
              laneHints: steps.map(laneHintFromStep).filter(Boolean),
              source: "provider",
            };
          }
        }
      } catch {
        // fall through to synthetic
      }
    }

    // Synthetic straight-line directions: one step per leg, distance via haversine.
    diagnostics.fallbacks += 1;
    let distanceMeters = 0;
    const steps = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const legDistance = haversineMeters(points[i], points[i + 1]);
      distanceMeters += legDistance;
      steps.push({
        distance: round2(legDistance),
        maneuver: { type: i === 0 ? "depart" : "continue", modifier: "straight" },
        intersections: [],
      });
    }
    return {
      distanceMeters: round2(distanceMeters),
      durationSeconds: round2(distanceMeters / 13.4), // ~30 mph nominal
      steps,
      laneHints: steps.map(laneHintFromStep).filter(Boolean),
      source: "synthetic",
    };
  }

  function getDiagnostics() {
    return { ...diagnostics };
  }

  return { matchTrace, getDirections, getDiagnostics };
}

export {
  createNavigationAdapter,
  createGpsSmoother,
  laneHintFromStep,
  snapHeadingToLanes,
  syntheticMapMatch,
  shortestAngleDelta,
};
