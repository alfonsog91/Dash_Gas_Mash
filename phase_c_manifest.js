// ──────────────────────────────────────────────────────────────────
//
// PHASE C MANIFEST — INERT PREDECLARATION ONLY
//
// This file declares the canonical IDs, source URLs, and parameter
// defaults for Phase C (terrain, globe, 3D buildings, fog, sky).
// Nothing here activates any Phase C visual behavior on the map.
// Caller code to apply terrain, set globe projection, add 3D
// building layers, configure fog, or enable sky does not exist
// until Phase C is explicitly activated.
//
// Activation requires:
//   1. The corresponding `phaseC*` feature flags in map_config.js
//      to be explicitly enabled (all default to false).
//   2. Separate Phase C activation code (not yet implemented).
//
// GOVERNANCE: This module contains no side effects. Importing it
// does not modify the map, DOM, or any shared state.
//
// ──────────────────────────────────────────────────────────────────

export const PHASE_C_MANIFEST_VERSION = "phase-c-v0-inert";

// ── Terrain / DEM ─────────────────────────────────────────────────

export const PHASE_C_TERRAIN_SOURCE_ID = "dgm-phase-c-terrain-dem";
export const PHASE_C_TERRAIN_SOURCE_URL = "mapbox://mapbox.mapbox-terrain-dem-v1";
export const PHASE_C_TERRAIN_EXAGGERATION = 1.0;
export const PHASE_C_TERRAIN_TILE_SIZE = 512;

// ── Projection ────────────────────────────────────────────────────

export const PHASE_C_GLOBE_PROJECTION = "globe";
export const PHASE_C_FALLBACK_PROJECTION = "mercator";

// ── 3D Buildings ──────────────────────────────────────────────────

export const PHASE_C_3D_BUILDINGS_LAYER_ID = "dgm-phase-c-3d-buildings";
export const PHASE_C_3D_BUILDINGS_SOURCE_LAYER = "building";
export const PHASE_C_3D_BUILDINGS_MIN_ZOOM = 15;
export const PHASE_C_3D_BUILDINGS_FILL_COLOR = "hsl(235, 15%, 60%)";
export const PHASE_C_3D_BUILDINGS_FILL_OPACITY = 0.6;

// ── Fog / Atmosphere ──────────────────────────────────────────────

export const PHASE_C_FOG_RANGE_NEAR = 0.5;
export const PHASE_C_FOG_RANGE_FAR = 10;
export const PHASE_C_FOG_COLOR = "rgb(186, 210, 235)";
export const PHASE_C_FOG_HIGH_COLOR = "#245bde";
export const PHASE_C_FOG_SPACE_COLOR = "#000000";
export const PHASE_C_FOG_STAR_INTENSITY = 0.15;
export const PHASE_C_FOG_HORIZON_BLEND = 0.4;

// ── Sky Layer ─────────────────────────────────────────────────────

export const PHASE_C_SKY_LAYER_ID = "dgm-phase-c-sky";
export const PHASE_C_SKY_TYPE = "atmosphere";
export const PHASE_C_SKY_ATMOSPHERE_SUN_INTENSITY = 15;

// ── Camera Presets ────────────────────────────────────────────────

export const PHASE_C_CAMERA_3D_PITCH_DEGREES = 45;
export const PHASE_C_CAMERA_3D_ZOOM_OFFSET = -0.5;
export const PHASE_C_CAMERA_GLOBE_ZOOM_MIN = 1.5;
export const PHASE_C_CAMERA_GLOBE_ZOOM_MAX = 22;
export const PHASE_C_CAMERA_TRANSITION_DURATION_MS = 1200;

// ── Manifest Accessor ─────────────────────────────────────────────

/**
 * Returns a frozen snapshot of all Phase C config IDs and parameters.
 *
 * Does not activate any map behavior. Safe to call at any time.
 * Returns the same structural shape on every call.
 */
export function getPhaseCManifest() {
  return Object.freeze({
    version: PHASE_C_MANIFEST_VERSION,
    terrain: Object.freeze({
      sourceId: PHASE_C_TERRAIN_SOURCE_ID,
      sourceUrl: PHASE_C_TERRAIN_SOURCE_URL,
      exaggeration: PHASE_C_TERRAIN_EXAGGERATION,
      tileSize: PHASE_C_TERRAIN_TILE_SIZE,
    }),
    projection: Object.freeze({
      globe: PHASE_C_GLOBE_PROJECTION,
      fallback: PHASE_C_FALLBACK_PROJECTION,
    }),
    buildings3d: Object.freeze({
      layerId: PHASE_C_3D_BUILDINGS_LAYER_ID,
      sourceLayer: PHASE_C_3D_BUILDINGS_SOURCE_LAYER,
      minZoom: PHASE_C_3D_BUILDINGS_MIN_ZOOM,
      fillColor: PHASE_C_3D_BUILDINGS_FILL_COLOR,
      fillOpacity: PHASE_C_3D_BUILDINGS_FILL_OPACITY,
    }),
    fog: Object.freeze({
      range: Object.freeze([PHASE_C_FOG_RANGE_NEAR, PHASE_C_FOG_RANGE_FAR]),
      color: PHASE_C_FOG_COLOR,
      highColor: PHASE_C_FOG_HIGH_COLOR,
      spaceColor: PHASE_C_FOG_SPACE_COLOR,
      starIntensity: PHASE_C_FOG_STAR_INTENSITY,
      horizonBlend: PHASE_C_FOG_HORIZON_BLEND,
    }),
    sky: Object.freeze({
      layerId: PHASE_C_SKY_LAYER_ID,
      type: PHASE_C_SKY_TYPE,
      sunIntensity: PHASE_C_SKY_ATMOSPHERE_SUN_INTENSITY,
    }),
    camera: Object.freeze({
      pitchDegrees: PHASE_C_CAMERA_3D_PITCH_DEGREES,
      zoomOffset: PHASE_C_CAMERA_3D_ZOOM_OFFSET,
      globeZoomMin: PHASE_C_CAMERA_GLOBE_ZOOM_MIN,
      globeZoomMax: PHASE_C_CAMERA_GLOBE_ZOOM_MAX,
      transitionDurationMs: PHASE_C_CAMERA_TRANSITION_DURATION_MS,
    }),
  });
}
