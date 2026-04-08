import {
  hasFreshHeadingSensorData,
  normalizeHeadingDegrees,
} from "./heading_cone.js";

function resolveCompassPermissionState({
  hasDeviceOrientationEvent,
  canRequestPermission,
  permissionState,
  requiredState = "required",
  grantedState = "granted",
  deniedState = "denied",
  notRequiredState = "not-required",
  unavailableState = "unavailable",
} = {}) {
  if (!hasDeviceOrientationEvent) {
    return unavailableState;
  }

  if (!canRequestPermission) {
    return notRequiredState;
  }

  if (permissionState === grantedState || permissionState === deniedState) {
    return permissionState;
  }

  return requiredState;
}

function resolveEffectiveHeadingState({
  storedHeading = null,
  storedHeadingSource = null,
  storedSpeed = null,
  sensorHeading = null,
  sensorHeadingAt = null,
  nowMs = null,
  mapBearing = null,
  maxSensorAgeMs,
} = {}) {
  const normalizedStoredHeading = normalizeHeadingDegrees(storedHeading);
  const normalizedSensorHeading = normalizeHeadingDegrees(sensorHeading);
  const normalizedMapBearing = normalizeHeadingDegrees(mapBearing);
  const sensorFresh = hasFreshHeadingSensorData(sensorHeadingAt, nowMs, maxSensorAgeMs);

  let effectiveHeading = null;
  let source = null;

  if (sensorFresh && normalizedSensorHeading !== null) {
    effectiveHeading = normalizedSensorHeading;
    source = "sensor";
  } else if (normalizedStoredHeading !== null && storedHeadingSource !== "sensor") {
    effectiveHeading = normalizedStoredHeading;
    source = storedHeadingSource || "stored";
  } else if (normalizedMapBearing !== null) {
    effectiveHeading = normalizedMapBearing;
    source = "bearing";
  }

  return {
    effectiveHeading,
    source,
    mapBearing: normalizedMapBearing,
    storedHeading: normalizedStoredHeading,
    storedHeadingSource,
    storedSpeed,
    sensorHeading: normalizedSensorHeading,
    sensorFresh,
    sensorAgeMs: typeof sensorHeadingAt === "number"
      && Number.isFinite(sensorHeadingAt)
      && typeof nowMs === "number"
      && Number.isFinite(nowMs)
      ? Math.max(0, nowMs - sensorHeadingAt)
      : null,
  };
}

function isHeadingRenderLoopDocumentActive(documentLike) {
  if (!documentLike) {
    return true;
  }

  return documentLike.hidden !== true;
}

export {
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
};
