import {
  hasFreshHeadingSensorData,
  normalizeHeadingDegrees,
} from "./heading_cone.js";

function getLocationCourseHeading(previousLocation, nextLocation, { minDistanceMeters = 1.5 } = {}) {
  const previousLat = Number(previousLocation?.lat);
  const previousLng = Number(previousLocation?.lng ?? previousLocation?.lon);
  const nextLat = Number(nextLocation?.lat);
  const nextLng = Number(nextLocation?.lng ?? nextLocation?.lon);

  if (
    !Number.isFinite(previousLat)
    || !Number.isFinite(previousLng)
    || !Number.isFinite(nextLat)
    || !Number.isFinite(nextLng)
  ) {
    return null;
  }

  const earthRadiusMeters = 6371000;
  const previousLatRad = (previousLat * Math.PI) / 180;
  const nextLatRad = (nextLat * Math.PI) / 180;
  const deltaLatRad = ((nextLat - previousLat) * Math.PI) / 180;
  const deltaLngRad = ((nextLng - previousLng) * Math.PI) / 180;
  const haversineA = Math.sin(deltaLatRad / 2) ** 2
    + Math.cos(previousLatRad) * Math.cos(nextLatRad) * Math.sin(deltaLngRad / 2) ** 2;
  const haversineC = 2 * Math.atan2(Math.sqrt(haversineA), Math.sqrt(1 - haversineA));
  const distanceMeters = earthRadiusMeters * haversineC;

  if (!(distanceMeters >= minDistanceMeters)) {
    return null;
  }

  const y = Math.sin(deltaLngRad) * Math.cos(nextLatRad);
  const x = Math.cos(previousLatRad) * Math.sin(nextLatRad)
    - Math.sin(previousLatRad) * Math.cos(nextLatRad) * Math.cos(deltaLngRad);
  return normalizeHeadingDegrees((Math.atan2(y, x) * 180) / Math.PI);
}

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
  getLocationCourseHeading,
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
};
