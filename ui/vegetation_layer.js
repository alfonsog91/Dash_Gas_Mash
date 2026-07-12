// Phase G vegetation layer UI (Mapbox GL JS v2.15.0 render path).
//
// Owns the v2-compatible render surfaces for vegetation produced by
// intelligence/vegetation_core.js:
//   - a symbol layer of sprite billboards (mid/high zoom), and
//   - a fill-extrusion polygon layer of aggregated tiles (low zoom).
// There is NO native GLTF/model layer in v2, so this is the supported path.
//
// Design notes (documented inline):
// - Dependency-injected (getMap, generateInstances, resolveLod) so the gating
//   and LOD logic can be exercised against a mock map.
// - Visibility is driven by syncVisibility({ zoom, guardDisabled, allowed }):
//   the caller (app_v2.js) computes `allowed` = (isPhaseDTuningEnabled() OR an
//   owner-local toggle) AND the user toggle, and `guardDisabled` from the
//   phaseGVegetationLayer perf-guard effect. When not allowed or guard-disabled,
//   both layers are hidden. Otherwise LOD selects sprite vs. extrusion by zoom.
// - The sprite image is loaded once; on any failure a deterministic programmatic
//   fallback image is registered so the symbol layer never triggers a
//   missing-image warning (keeps the browser smoke console clean).

const DEFAULT_SOURCE_SPRITES = "dgm-vegetation-sprites";
const DEFAULT_SOURCE_EXTRUSIONS = "dgm-vegetation-extrusions";
const DEFAULT_LAYER_SPRITES = "dgm-vegetation-sprite-layer";
const DEFAULT_LAYER_EXTRUSIONS = "dgm-vegetation-extrusion-layer";
const DEFAULT_IMAGE_ID = "dgm-vegetation-tree";
const DEFAULT_SPRITE_URL = "./assets/sprites/tree_sample.png?v=20260610-phaseg-vegetation";

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function instancesToFeatureCollection(instances) {
  return {
    type: "FeatureCollection",
    features: (Array.isArray(instances) ? instances : []).map((instance) => ({
      type: "Feature",
      properties: {
        id: instance.id,
        vegetationType: instance.type,
        height: instance.height,
        weight: instance.weight,
      },
      geometry: { type: "Point", coordinates: [instance.lng, instance.lat] },
    })),
  };
}

function aggregatesToFeatureCollection(aggregates) {
  return {
    type: "FeatureCollection",
    features: Array.isArray(aggregates) ? aggregates : [],
  };
}

// A 4x4 solid-green RGBA image used as a deterministic fallback when the sprite
// PNG cannot be decoded (e.g. some headless contexts). Guarantees the symbol
// layer's icon-image id always resolves.
function createFallbackImage() {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = 46;
    data[i * 4 + 1] = 125;
    data[i * 4 + 2] = 50;
    data[i * 4 + 3] = 255;
  }
  return { width: size, height: size, data };
}

function createVegetationLayer({
  getMap,
  generateInstances,
  resolveLod,
  spriteImageUrl = DEFAULT_SPRITE_URL,
  spriteImageId = DEFAULT_IMAGE_ID,
  sourceSpriteId = DEFAULT_SOURCE_SPRITES,
  sourceExtrusionId = DEFAULT_SOURCE_EXTRUSIONS,
  layerSpriteId = DEFAULT_LAYER_SPRITES,
  layerExtrusionId = DEFAULT_LAYER_EXTRUSIONS,
  gridResolution = 30,
  densityThreshold = 1,
  lodRules = undefined,
  shouldExposeDebug = () => false,
} = {}) {
  if (typeof getMap !== "function") {
    throw new TypeError("createVegetationLayer requires a getMap function");
  }
  if (typeof generateInstances !== "function" || typeof resolveLod !== "function") {
    throw new TypeError("createVegetationLayer requires generateInstances and resolveLod");
  }

  let layersReady = false;
  let imageRequested = false;
  let enabled = false;
  let samples = [];
  let lastGeneration = { instances: [], aggregates: [], metadata: null };
  let currentMode = "hidden";
  const config = { gridResolution, densityThreshold, lodRules };
  const diagnostics = { generations: 0, lastMode: "hidden", imageSource: "none" };

  function regenerate() {
    lastGeneration = generateInstances(samples, {
      gridResolution: config.gridResolution,
      densityThreshold: config.densityThreshold,
      lodRules: config.lodRules,
    });
    diagnostics.generations += 1;
    return lastGeneration;
  }

  function pushSourceData() {
    const map = getMap();
    if (!map || !layersReady) {
      return;
    }
    map.getSource(sourceSpriteId)?.setData(instancesToFeatureCollection(lastGeneration.instances));
    map.getSource(sourceExtrusionId)?.setData(aggregatesToFeatureCollection(lastGeneration.aggregates));
  }

  function ensureSpriteImage(map) {
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
          // Ignore: a concurrent add already registered the id.
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

  // Idempotently add the vegetation sources, image, and layers. Safe to call
  // after the style is loaded; a no-op once layers exist.
  function ensureLayers() {
    const map = getMap();
    if (!map || typeof map.addLayer !== "function") {
      return false;
    }
    if (layersReady || map.getLayer(layerSpriteId)) {
      layersReady = true;
      return true;
    }

    if (!map.getSource(sourceExtrusionId)) {
      map.addSource(sourceExtrusionId, { type: "geojson", data: emptyFeatureCollection() });
    }
    if (!map.getSource(sourceSpriteId)) {
      map.addSource(sourceSpriteId, { type: "geojson", data: emptyFeatureCollection() });
    }

    // Register the sprite image before the symbol layer so icon-image resolves.
    ensureSpriteImage(map);

    map.addLayer({
      id: layerExtrusionId,
      type: "fill-extrusion",
      source: sourceExtrusionId,
      layout: { visibility: "none" },
      paint: {
        "fill-extrusion-color": "#2e7d32",
        "fill-extrusion-height": ["coalesce", ["get", "height"], 8],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.55,
      },
    });

    map.addLayer({
      id: layerSpriteId,
      type: "symbol",
      source: sourceSpriteId,
      layout: {
        visibility: "none",
        "icon-image": spriteImageId,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-anchor": "bottom",
        "icon-size": [
          "interpolate", ["linear"], ["zoom"],
          12, 0.4,
          16, 0.9,
          19, 1.4,
        ],
      },
    });

    layersReady = true;
    pushSourceData();
    return true;
  }

  function setVisibility(map, mode) {
    const spriteVisible = mode === "sprite" ? "visible" : "none";
    const extrusionVisible = mode === "extrusion" ? "visible" : "none";
    if (map.getLayer(layerSpriteId)) {
      map.setLayoutProperty(layerSpriteId, "visibility", spriteVisible);
    }
    if (map.getLayer(layerExtrusionId)) {
      map.setLayoutProperty(layerExtrusionId, "visibility", extrusionVisible);
    }
  }

  // Apply gating + LOD. Returns the active render mode:
  // "hidden" | "sprite" | "extrusion". `allowed` and `guardDisabled` are
  // computed by the host from tuning/owner-toggle state and the perf guard.
  function syncVisibility({ zoom = 0, guardDisabled = false, allowed = true } = {}) {
    const map = getMap();
    if (!map) {
      return "hidden";
    }
    ensureLayers();

    if (!enabled || !allowed || guardDisabled) {
      currentMode = "hidden";
      diagnostics.lastMode = "hidden";
      setVisibility(map, "hidden");
      return "hidden";
    }

    const lod = resolveLod(zoom, config.lodRules);
    currentMode = lod.mode;
    diagnostics.lastMode = lod.mode;
    setVisibility(map, lod.mode);
    return lod.mode;
  }

  function setSamples(nextSamples) {
    samples = Array.isArray(nextSamples) ? nextSamples : [];
    regenerate();
    pushSourceData();
    return lastGeneration.metadata;
  }

  function setDensityThreshold(value) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) {
      config.densityThreshold = next;
      regenerate();
      pushSourceData();
    }
    return config.densityThreshold;
  }

  function setGridResolution(value) {
    const next = Number(value);
    if (Number.isFinite(next) && next > 0) {
      config.gridResolution = next;
      regenerate();
      pushSourceData();
    }
    return config.gridResolution;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    return enabled;
  }

  function getInstanceCount() {
    return lastGeneration.instances.length;
  }

  function getActiveMode() {
    return currentMode;
  }

  function getDebugMetadata() {
    if (typeof shouldExposeDebug !== "function" || !shouldExposeDebug()) {
      return null;
    }
    return {
      enabled,
      currentMode,
      instanceCount: lastGeneration.instances.length,
      aggregateCount: lastGeneration.aggregates.length,
      gridResolution: config.gridResolution,
      densityThreshold: config.densityThreshold,
      metadata: lastGeneration.metadata,
      ...diagnostics,
    };
  }

  function destroy() {
    const map = getMap();
    if (!map) {
      return;
    }
    for (const layerId of [layerSpriteId, layerExtrusionId]) {
      if (map.getLayer(layerId)) {
        map.removeLayer(layerId);
      }
    }
    for (const sourceId of [sourceSpriteId, sourceExtrusionId]) {
      if (map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    }
    layersReady = false;
  }

  return {
    ensureLayers,
    syncVisibility,
    setSamples,
    setDensityThreshold,
    setGridResolution,
    setEnabled,
    isEnabled: () => enabled,
    getInstanceCount,
    getActiveMode,
    getDebugMetadata,
    destroy,
  };
}

export {
  createVegetationLayer,
  instancesToFeatureCollection,
  aggregatesToFeatureCollection,
  DEFAULT_LAYER_SPRITES,
  DEFAULT_LAYER_EXTRUSIONS,
};
