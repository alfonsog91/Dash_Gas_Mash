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

function getTrafficSourceCandidates(layers) {
  const candidates = [];
  const seen = new Set();

  for (const layer of layers) {
    const source = String(layer?.source || "").trim();
    const sourceLayer = String(layer?.["source-layer"] || "").trim();
    if (!source || !sourceLayer) {
      continue;
    }

    const key = `${source}:${sourceLayer}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push({ source, sourceLayer });
  }

  return candidates;
}

function buildTrafficDiscoveryFailure(reason, layerIds, layers, sourceCandidates) {
  return {
    ok: false,
    reason,
    layerIds,
    source: null,
    sourceLayer: null,
    sourceCandidates,
    layers: layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      source: layer.source || null,
      sourceLayer: layer["source-layer"] || null,
    })),
  };
}

function findStyleLayerById(styleLayers, layerId) {
  return styleLayers.find((layer) => layer?.id === layerId) || null;
}

function discoverTrafficLayerSource(map, { explicitLayerIds = [] } = {}) {
  const layerIds = findTrafficLayerIds(map, { explicitLayerIds });
  const styleLayers = getMapStyleLayers(map);
  const layers = layerIds
    .map((layerId) => findStyleLayerById(styleLayers, layerId)
      || (typeof map?.getLayer === "function" ? map.getLayer(layerId) : null))
    .filter(Boolean);

  if (layers.length === 0) {
    return buildTrafficDiscoveryFailure("traffic_layers_missing", layerIds, layers, []);
  }

  const explicitIdSet = new Set(normalizeLayerIdList(explicitLayerIds));
  const explicitLayers = layers.filter((layer) => explicitIdSet.has(layer.id));
  const explicitSourceCandidates = getTrafficSourceCandidates(explicitLayers);
  const sourceCandidates = explicitSourceCandidates.length > 0
    ? explicitSourceCandidates
    : getTrafficSourceCandidates(layers);

  if (sourceCandidates.length === 0) {
    return buildTrafficDiscoveryFailure("traffic_source_missing", layerIds, layers, sourceCandidates);
  }

  if (sourceCandidates.length > 1) {
    return buildTrafficDiscoveryFailure("traffic_source_mismatch", layerIds, layers, sourceCandidates);
  }

  return {
    ok: true,
    reason: null,
    layerIds,
    source: sourceCandidates[0].source,
    sourceLayer: sourceCandidates[0].sourceLayer,
    sourceCandidates,
    layers: layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      source: layer.source || null,
      sourceLayer: layer["source-layer"] || null,
    })),
  };
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
  discoverTrafficLayerSource,
  findTrafficLayerIds,
  isTrafficLayer,
  setTrafficVisibility,
  toggleTraffic,
};