const paintFallbackCacheByMap = new WeakMap();

function getMapStyleLayers(map) {
  const layers = map?.getStyle?.().layers;
  return Array.isArray(layers) ? layers : [];
}

function normalizeLayerIdList(layerIds) {
  return Array.from(new Set((Array.isArray(layerIds) ? layerIds : [])
    .map((layerId) => String(layerId || "").trim())
    .filter(Boolean)));
}

function getLayerSignature(layer) {
  return [
    layer?.id,
    layer?.source,
    layer?.["source-layer"],
    layer?.metadata?.["mapbox:group"],
  ]
    .map((value) => String(value || "").toLowerCase())
    .join(" ");
}

function isTrafficLayer(layer) {
  if (!layer?.id || layer.type !== "line") {
    return false;
  }

  return /\btraffic\b|\bcongestion\b/.test(getLayerSignature(layer));
}

function findTrafficLayerIds(map, { explicitLayerIds = [] } = {}) {
  const explicitIds = normalizeLayerIdList(explicitLayerIds)
    .filter((layerId) => typeof map?.getLayer === "function" ? Boolean(map.getLayer(layerId)) : true);
  const inferredIds = getMapStyleLayers(map)
    .filter(isTrafficLayer)
    .map((layer) => layer.id);

  return normalizeLayerIdList([...explicitIds, ...inferredIds]);
}

function getPaintFallbacks(layer) {
  if (!layer || layer.type !== "line") {
    return [];
  }

  return ["line-opacity"];
}

function getPaintFallbackCache(map) {
  if (!map || (typeof map !== "object" && typeof map !== "function")) {
    return null;
  }

  let cache = paintFallbackCacheByMap.get(map);
  if (!cache) {
    cache = new Map();
    paintFallbackCacheByMap.set(map, cache);
  }
  return cache;
}

function getPaintFallbackValue(map, layerId, propertyName, visible) {
  const cache = getPaintFallbackCache(map);
  const cacheKey = `${layerId}:${propertyName}`;

  if (!visible) {
    if (cache && !cache.has(cacheKey) && typeof map?.getPaintProperty === "function") {
      cache.set(cacheKey, map.getPaintProperty(layerId, propertyName));
    }
    return 0;
  }

  if (cache?.has(cacheKey)) {
    const value = cache.get(cacheKey);
    cache.delete(cacheKey);
    return value;
  }

  return null;
}

function setTrafficVisibility(
  map,
  visible,
  {
    layerIds = null,
    explicitLayerIds = [],
    paintFallback = true,
    logTelemetry = null,
  } = {}
) {
  const nextVisibility = visible ? "visible" : "none";
  const trafficLayerIds = normalizeLayerIdList(layerIds || findTrafficLayerIds(map, { explicitLayerIds }));
  const changedLayerIds = [];
  const fallbackLayerIds = [];
  const failedLayerIds = [];

  for (const layerId of trafficLayerIds) {
    const layer = typeof map?.getLayer === "function" ? map.getLayer(layerId) : null;
    if (!layer) {
      continue;
    }

    try {
      map.setLayoutProperty(layerId, "visibility", nextVisibility);
      changedLayerIds.push(layerId);
      continue;
    } catch {
      // Some Mapbox styles can reject layout updates on imported layers; fall through to paint fallback.
    }

    if (!paintFallback || typeof map?.setPaintProperty !== "function") {
      failedLayerIds.push(layerId);
      continue;
    }

    const fallbackProperties = getPaintFallbacks(layer);
    let appliedFallback = false;
    for (const propertyName of fallbackProperties) {
      try {
        map.setPaintProperty(layerId, propertyName, getPaintFallbackValue(map, layerId, propertyName, visible));
        appliedFallback = true;
      } catch {
        // Try the next fallback property if one exists.
      }
    }

    if (appliedFallback) {
      fallbackLayerIds.push(layerId);
      changedLayerIds.push(layerId);
    } else {
      failedLayerIds.push(layerId);
    }
  }

  const result = {
    visible: Boolean(visible),
    layerIds: trafficLayerIds,
    changedLayerIds,
    fallbackLayerIds,
    failedLayerIds,
  };

  if (typeof logTelemetry === "function") {
    logTelemetry("map.traffic_visibility_changed", result);
    if (fallbackLayerIds.length > 0) {
      logTelemetry("map.fallback_triggered", {
        source: "traffic_visibility",
        reason: "layout_property_failed",
        visible: result.visible,
        fallbackLayerIds,
        failedLayerIds,
      });
    }
  }

  return result;
}

function toggleTraffic(map, currentVisible, options = {}) {
  return setTrafficVisibility(map, !currentVisible, options);
}

export {
  findTrafficLayerIds,
  isTrafficLayer,
  setTrafficVisibility,
  toggleTraffic,
};