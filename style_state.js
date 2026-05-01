function normalizeVisibility(value) {
  return value ? "visible" : "none";
}

function restoreStyleState(map, state = {}, { logTelemetry = null, telemetryPayload = {} } = {}) {
  const result = {
    changedLayoutProperties: [],
    changedPaintProperties: [],
    missingLayerIds: [],
    failedUpdates: [],
  };

  const noteMissingLayer = (layerId) => {
    if (!result.missingLayerIds.includes(layerId)) {
      result.missingLayerIds.push(layerId);
    }
  };

  const hasLayer = (layerId) => Boolean(layerId && (typeof map?.getLayer !== "function" || map.getLayer(layerId)));

  const setLayout = (layerId, propertyName, value) => {
    if (!hasLayer(layerId)) {
      noteMissingLayer(layerId);
      return;
    }

    try {
      map.setLayoutProperty(layerId, propertyName, value);
      result.changedLayoutProperties.push({ layerId, propertyName, value });
    } catch (error) {
      result.failedUpdates.push({ layerId, propertyName, kind: "layout", message: error?.message ?? String(error) });
    }
  };

  const setPaint = (layerId, propertyName, value) => {
    if (!hasLayer(layerId)) {
      noteMissingLayer(layerId);
      return;
    }

    try {
      map.setPaintProperty(layerId, propertyName, value);
      result.changedPaintProperties.push({ layerId, propertyName, value });
    } catch (error) {
      result.failedUpdates.push({ layerId, propertyName, kind: "paint", message: error?.message ?? String(error) });
    }
  };

  for (const [layerId, visible] of Object.entries(state.visibility || {})) {
    setLayout(layerId, "visibility", normalizeVisibility(visible));
  }

  for (const [layerId, properties] of Object.entries(state.layout || {})) {
    for (const [propertyName, value] of Object.entries(properties || {})) {
      setLayout(layerId, propertyName, value);
    }
  }

  for (const [layerId, properties] of Object.entries(state.paint || {})) {
    for (const [propertyName, value] of Object.entries(properties || {})) {
      setPaint(layerId, propertyName, value);
    }
  }

  if (typeof logTelemetry === "function") {
    logTelemetry("map.style_reload_restored", {
      ...telemetryPayload,
      changedLayoutCount: result.changedLayoutProperties.length,
      changedPaintCount: result.changedPaintProperties.length,
      missingLayerIds: result.missingLayerIds,
      failedUpdates: result.failedUpdates,
    });
  }

  return result;
}

export { restoreStyleState };