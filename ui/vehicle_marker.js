// Phase G vehicle marker + camera helpers (Mapbox GL JS v2.15.0 render path).
//
// Renders the driver's position as a heading-rotated symbol sprite (a symbol
// layer with icon-rotate) instead of the default blue dot, and provides
// deterministic camera helpers for smooth follow:
//   - shortestAngleDelta / interpolateHeading: bearing math for smooth rotation,
//   - speedAdaptiveZoom: faster speed -> wider (lower-zoom) view,
//   - buildFollowCamera: a CameraOptions object for heading-locked follow,
//   - animateCameraAlongPath(path, opts): deterministic camera keyframes along a
//     route path (the function the vehicle_camera test asserts on).
//
// Design notes (documented inline):
// - There is no native GLTF/model layer in Mapbox GL v2, so the vehicle is a
//   symbol sprite (icon-rotate, icon-rotation-alignment: map). This honors the
//   v2-only rendering rule (sprite billboards + fill-extrusion; no three.js).
// - All camera helpers are pure and deterministic so fixed inputs always yield
//   identical keyframes (unit-testable without a browser).
// - Heavy marker work is gated by an injected isGuardDisabled() reflecting the
//   phaseGVehicleModel perf-guard effect.

const SOURCE_VEHICLE = "dgm-vehicle";
const LAYER_VEHICLE = "dgm-vehicle-layer";
const IMAGE_VEHICLE = "dgm-vehicle-sprite";
const DEFAULT_SPRITE_URL = "./assets/sprites/dodge_dart_sprite.png?v=20260610-phaseg-vehicle";

const EARTH_RADIUS_METERS = 6371000;

const EASINGS = Object.freeze({
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
});

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

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
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

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians) {
  return (radians * 180) / Math.PI;
}

function normalizeBearing(degrees) {
  return ((Number(degrees) || 0) % 360 + 360) % 360;
}

// Signed shortest rotation (degrees) from one bearing to another, in [-180, 180].
function shortestAngleDelta(fromDeg, toDeg) {
  return ((normalizeBearing(toDeg) - normalizeBearing(fromDeg) + 540) % 360) - 180;
}

// Interpolate a bearing along the shortest arc. t is clamped to [0, 1].
function interpolateHeading(fromDeg, toDeg, t) {
  const clampedT = clamp(toFiniteNumber(t, 0), 0, 1);
  return normalizeBearing(normalizeBearing(fromDeg) + shortestAngleDelta(fromDeg, toDeg) * clampedT);
}

// Initial great-circle bearing (degrees, 0-360) from a -> b.
function bearingBetween(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLon = toRadians(b.lng - a.lng);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return normalizeBearing(toDegrees(Math.atan2(y, x)));
}

function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lerpPoint(a, b, t) {
  return { lng: a.lng + (b.lng - a.lng) * t, lat: a.lat + (b.lat - a.lat) * t };
}

// Speed-adaptive zoom: at/below minSpeed -> maxZoom (tight), at/above maxSpeed ->
// minZoom (wide). Linear in between. Deterministic and clamped.
function speedAdaptiveZoom(speedMps, { minZoom = 15, maxZoom = 18, minSpeed = 0, maxSpeed = 25 } = {}) {
  const speed = clamp(toFiniteNumber(speedMps, 0), 0, Number.MAX_SAFE_INTEGER);
  const span = Math.max(0.000001, maxSpeed - minSpeed);
  const ratio = clamp((speed - minSpeed) / span, 0, 1);
  return round4(maxZoom - (maxZoom - minZoom) * ratio);
}

// Build a CameraOptions object for heading-locked, speed-adaptive follow.
// mode: "heading-locked" rotates the map to the heading; "north-up" keeps bearing 0.
function buildFollowCamera({
  lng,
  lat,
  heading = 0,
  speed = 0,
  mode = "heading-locked",
  pitch = 45,
  zoomConfig = {},
} = {}) {
  const center = normalizePoint({ lng, lat });
  if (center.lng === null || center.lat === null) {
    return null;
  }
  return {
    center: [round6(center.lng), round6(center.lat)],
    bearing: mode === "heading-locked" ? round2(normalizeBearing(heading)) : 0,
    pitch: round2(clamp(toFiniteNumber(pitch, 45), 0, 85)),
    zoom: speedAdaptiveZoom(speed, zoomConfig),
  };
}

// Produce deterministic camera keyframes that sweep along a route path. Each
// keyframe carries center, heading-locked bearing, pitch, offset, and timing.
// Fixed inputs always yield identical output (pure).
function animateCameraAlongPath(path, {
  duration = 4000,
  easing = "easeInOut",
  pitch = 45,
  offset = [0, 0],
  frames = null,
  fps = 60,
} = {}) {
  const points = (Array.isArray(path) ? path : [])
    .map(normalizePoint)
    .filter((p) => p.lng !== null && p.lat !== null);

  const ease = typeof easing === "function" ? easing : EASINGS[easing] || EASINGS.easeInOut;
  const durationMs = Math.max(0, toFiniteNumber(duration, 4000));
  const safeOffset = Array.isArray(offset) ? [toFiniteNumber(offset[0], 0), toFiniteNumber(offset[1], 0)] : [0, 0];
  const safePitch = round2(clamp(toFiniteNumber(pitch, 45), 0, 85));

  if (points.length === 0) {
    return [];
  }
  if (points.length === 1) {
    return [{
      index: 0,
      t: 0,
      progress: 0,
      atMs: 0,
      center: [round6(points[0].lng), round6(points[0].lat)],
      bearing: 0,
      pitch: safePitch,
      offset: safeOffset,
    }];
  }

  // Segment lengths + cumulative distance for distance-parameterized sampling.
  const segments = [];
  let totalDistance = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const length = haversineMeters(points[i], points[i + 1]);
    segments.push({ start: points[i], end: points[i + 1], length, bearing: bearingBetween(points[i], points[i + 1]) });
    totalDistance += length;
  }

  const frameCount = frames !== null
    ? Math.max(2, Math.trunc(frames))
    : clamp(Math.round((durationMs / 1000) * fps), 2, 600);

  const keyframes = [];
  for (let i = 0; i < frameCount; i += 1) {
    const t = i / (frameCount - 1);
    const eased = clamp(ease(t), 0, 1);
    const targetDistance = eased * totalDistance;

    // Walk segments to find the point at targetDistance.
    let distanceSoFar = 0;
    let segment = segments[segments.length - 1];
    let localFraction = 1;
    for (const candidate of segments) {
      if (targetDistance <= distanceSoFar + candidate.length || candidate.length === 0) {
        segment = candidate;
        localFraction = candidate.length === 0 ? 0 : (targetDistance - distanceSoFar) / candidate.length;
        break;
      }
      distanceSoFar += candidate.length;
    }
    localFraction = clamp(localFraction, 0, 1);
    const center = lerpPoint(segment.start, segment.end, localFraction);

    keyframes.push({
      index: i,
      t: round4(t),
      progress: round4(eased),
      atMs: Math.round(eased * durationMs),
      center: [round6(center.lng), round6(center.lat)],
      bearing: round2(segment.bearing),
      pitch: safePitch,
      offset: safeOffset,
    });
  }

  return keyframes;
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

// 4x4 solid amber RGBA fallback so the symbol layer's icon always resolves even
// when the sprite PNG cannot be decoded.
function createFallbackImage() {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = 209;
    data[i * 4 + 1] = 64;
    data[i * 4 + 2] = 48;
    data[i * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}

// Dependency-injected vehicle marker. Renders a heading-rotated symbol sprite on
// a dedicated source/layer and exposes update/show/hide/destroy. Heavy work is
// skipped while the phaseGVehicleModel guard (isGuardDisabled) is tripped.
function createVehicleMarker({
  getMap,
  spriteImageUrl = DEFAULT_SPRITE_URL,
  spriteImageId = IMAGE_VEHICLE,
  sourceId = SOURCE_VEHICLE,
  layerId = LAYER_VEHICLE,
  isGuardDisabled = () => false,
  shouldExposeDebug = () => false,
  headingLerp = 0.25,
} = {}) {
  if (typeof getMap !== "function") {
    throw new TypeError("createVehicleMarker requires a getMap function");
  }

  let layersReady = false;
  let imageRequested = false;
  let visible = false;
  const state = { lng: null, lat: null, targetHeading: 0, renderedHeading: 0, speed: 0 };
  const diagnostics = { updates: 0, guardSkips: 0, imageSource: "none" };

  function ensureImage(map) {
    if (imageRequested) {
      return;
    }
    imageRequested = true;
    const registerFallback = () => {
      if (!map.hasImage || !map.hasImage(spriteImageId)) {
        try {
          map.addImage(spriteImageId, createFallbackImage());
          diagnostics.imageSource = "fallback";
        } catch {
          // already registered
        }
      }
    };
    if (typeof map.loadImage !== "function") {
      registerFallback();
      return;
    }
    try {
      map.loadImage(spriteImageUrl, (error, image) => {
        if (error || !image) {
          registerFallback();
          return;
        }
        if (!map.hasImage || !map.hasImage(spriteImageId)) {
          try {
            map.addImage(spriteImageId, image);
            diagnostics.imageSource = "sprite";
          } catch {
            registerFallback();
          }
        }
      });
    } catch {
      registerFallback();
    }
  }

  function ensureLayer() {
    const map = getMap();
    if (!map || typeof map.addLayer !== "function") {
      return false;
    }
    if (layersReady || map.getLayer(layerId)) {
      layersReady = true;
      return true;
    }
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, { type: "geojson", data: emptyFeatureCollection() });
    }
    ensureImage(map);
    map.addLayer({
      id: layerId,
      type: "symbol",
      source: sourceId,
      layout: {
        visibility: "none",
        "icon-image": spriteImageId,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-rotate": ["coalesce", ["get", "heading"], 0],
        "icon-rotation-alignment": "map",
        "icon-size": [
          "interpolate", ["linear"], ["zoom"],
          12, 0.5,
          16, 0.9,
          19, 1.3,
        ],
      },
    });
    layersReady = true;
    return true;
  }

  function render() {
    const map = getMap();
    if (!map || !layersReady || state.lng === null || state.lat === null) {
      return;
    }
    map.getSource(sourceId)?.setData({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { heading: round2(state.renderedHeading), speed: round2(state.speed) },
        geometry: { type: "Point", coordinates: [state.lng, state.lat] },
      }],
    });
  }

  // Merge a partial motion update ({ lng, lat, heading, speed }) and re-render.
  // Heading is smoothed toward the target along the shortest arc.
  function update({ lng, lat, heading, speed } = {}) {
    if (isGuardDisabled()) {
      diagnostics.guardSkips += 1;
      hide();
      return null;
    }
    ensureLayer();

    const nextLng = toFiniteNumber(lng, state.lng);
    const nextLat = toFiniteNumber(lat, state.lat);
    if (nextLng !== null) {
      state.lng = nextLng;
    }
    if (nextLat !== null) {
      state.lat = nextLat;
    }
    if (heading !== undefined && heading !== null && Number.isFinite(Number(heading))) {
      state.targetHeading = normalizeBearing(heading);
      // First update snaps; subsequent updates ease toward the target.
      state.renderedHeading = diagnostics.updates === 0
        ? state.targetHeading
        : interpolateHeading(state.renderedHeading, state.targetHeading, headingLerp);
    }
    if (speed !== undefined && speed !== null && Number.isFinite(Number(speed))) {
      state.speed = Math.max(0, Number(speed));
    }

    diagnostics.updates += 1;
    render();
    return { ...state };
  }

  function show() {
    if (isGuardDisabled()) {
      return false;
    }
    ensureLayer();
    const map = getMap();
    if (map?.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "visible");
      visible = true;
    }
    return visible;
  }

  function hide() {
    const map = getMap();
    if (map?.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "none");
    }
    visible = false;
    return true;
  }

  function destroy() {
    const map = getMap();
    if (map?.getLayer(layerId)) {
      map.removeLayer(layerId);
    }
    if (map?.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
    layersReady = false;
    visible = false;
  }

  function getState() {
    return { ...state, visible };
  }

  function getDebugMetadata() {
    if (typeof shouldExposeDebug !== "function" || !shouldExposeDebug()) {
      return null;
    }
    return { ...state, visible, ...diagnostics };
  }

  return {
    ensureLayer,
    update,
    show,
    hide,
    destroy,
    isVisible: () => visible,
    getState,
    getDebugMetadata,
  };
}

export {
  createVehicleMarker,
  animateCameraAlongPath,
  buildFollowCamera,
  speedAdaptiveZoom,
  interpolateHeading,
  shortestAngleDelta,
  bearingBetween,
  EASINGS,
};
