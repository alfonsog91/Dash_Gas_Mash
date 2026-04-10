const HEADING_CONE_LENGTH_PIXELS = 28;
const HEADING_CONE_HALF_ANGLE_MOVING = 18;
const HEADING_CONE_HALF_ANGLE_STATIONARY = 28;
const HEADING_CONE_SPEED_FOR_FULLY_MOVING = 3;
const HEADING_SENSOR_STALE_AFTER_MS = 2200;
const HEADING_SENSOR_SMOOTHING_TIME_MS = 220;
const HEADING_SENSOR_SMOOTHING_MIN_BLEND = 0.18;
const HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES = 30;
const HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS = 900;
const HEADING_CONE_BASE_OPACITY = 0.32;
const HEADING_CONE_TIP_OPACITY = 0.06;
const HEADING_CONE_ALPHA_BASE_BIAS_POWER = 1.2;
const HEADING_CONE_ALPHA_EASE_OUT_POWER = 1.75;
const HEADING_CONE_OPACITY_STEPS = 12;
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 40075016.68557849 / 512;

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
}

function resolveFiniteNumber(value, fallback, { min = -Infinity } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    return fallback;
  }
  return value;
}

function normalizeHeadingDegrees(heading) {
  if (typeof heading !== "number" || !Number.isFinite(heading)) return null;
  const normalized = heading % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function getHeadingDeltaDegrees(nextHeading, previousHeading) {
  const normalizedNext = normalizeHeadingDegrees(nextHeading);
  const normalizedPrevious = normalizeHeadingDegrees(previousHeading);
  if (normalizedNext === null || normalizedPrevious === null) return Infinity;
  return Math.abs(((normalizedNext - normalizedPrevious + 540) % 360) - 180);
}

function getHeadingBlendFactor(
  elapsedMs,
  timeConstantMs = HEADING_SENSOR_SMOOTHING_TIME_MS,
  minBlend = 0
) {
  const resolvedTimeConstant = resolveFiniteNumber(timeConstantMs, HEADING_SENSOR_SMOOTHING_TIME_MS, { min: Number.EPSILON });
  const resolvedElapsedMs = resolveFiniteNumber(elapsedMs, resolvedTimeConstant, { min: 0 });
  return clamp01(Math.max(clamp01(minBlend), 1 - Math.exp(-resolvedElapsedMs / resolvedTimeConstant)));
}

function interpolateHeadingDegrees(previousHeading, nextHeading, blend = 1) {
  const normalizedPrevious = normalizeHeadingDegrees(previousHeading);
  const normalizedNext = normalizeHeadingDegrees(nextHeading);
  if (normalizedNext === null) return normalizedPrevious;
  if (normalizedPrevious === null) return normalizedNext;
  const delta = ((normalizedNext - normalizedPrevious + 540) % 360) - 180;
  return normalizeHeadingDegrees(normalizedPrevious + delta * clamp01(blend));
}

function hasFreshHeadingSensorData(lastSensorHeadingAt, nowMs, maxAgeMs = HEADING_SENSOR_STALE_AFTER_MS) {
  const resolvedLastSensorHeadingAt = resolveFiniteNumber(lastSensorHeadingAt, null);
  const resolvedNowMs = resolveFiniteNumber(nowMs, null);
  const resolvedMaxAgeMs = resolveFiniteNumber(maxAgeMs, HEADING_SENSOR_STALE_AFTER_MS, { min: 0 });
  if (resolvedLastSensorHeadingAt === null || resolvedNowMs === null) {
    return false;
  }
  return resolvedNowMs - resolvedLastSensorHeadingAt <= resolvedMaxAgeMs;
}

function getHeadingConeHalfAngle(speed) {
  const normalizedSpeed = typeof speed === "number" && Number.isFinite(speed)
    ? Math.max(0, speed)
    : 0;
  const movingRatio = clamp01(normalizedSpeed / HEADING_CONE_SPEED_FOR_FULLY_MOVING);
  return HEADING_CONE_HALF_ANGLE_STATIONARY
    + (HEADING_CONE_HALF_ANGLE_MOVING - HEADING_CONE_HALF_ANGLE_STATIONARY) * movingRatio;
}

function getMetersPerPixelAtLatitude(latitude, zoom) {
  const resolvedLatitude = typeof latitude === "number" && Number.isFinite(latitude)
    ? Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude))
    : null;
  const resolvedZoom = typeof zoom === "number" && Number.isFinite(zoom)
    ? zoom
    : null;
  if (resolvedLatitude === null || resolvedZoom === null) {
    return null;
  }
  return WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0
    * Math.cos((resolvedLatitude * Math.PI) / 180)
    / (2 ** resolvedZoom);
}

function getHeadingConeLengthMeters(latitude, zoom, pixelLength = HEADING_CONE_LENGTH_PIXELS) {
  const metersPerPixel = getMetersPerPixelAtLatitude(latitude, zoom);
  const resolvedPixelLength = typeof pixelLength === "number" && Number.isFinite(pixelLength)
    ? Math.max(0, pixelLength)
    : 0;
  if (metersPerPixel === null) {
    return null;
  }
  return metersPerPixel * resolvedPixelLength;
}

function getHeadingConeOpacityAtRatio(ratio) {
  const resolvedRatio = clamp01(ratio);
  const baseBiasedRatio = resolvedRatio ** HEADING_CONE_ALPHA_BASE_BIAS_POWER;
  const easedTail = (1 - baseBiasedRatio) ** HEADING_CONE_ALPHA_EASE_OUT_POWER;
  return HEADING_CONE_TIP_OPACITY
    + (HEADING_CONE_BASE_OPACITY - HEADING_CONE_TIP_OPACITY) * easedTail;
}

const HEADING_CONE_BAND_OPACITIES = Object.freeze(
  Array.from({ length: HEADING_CONE_OPACITY_STEPS }, (_, index) => {
    const midpointRatio = (index + 0.5) / HEADING_CONE_OPACITY_STEPS;
    return getHeadingConeOpacityAtRatio(midpointRatio);
  })
);

function getHeadingConeBandStops(opacities = HEADING_CONE_BAND_OPACITIES) {
  const resolvedOpacities = Array.isArray(opacities) && opacities.length
    ? opacities
    : HEADING_CONE_BAND_OPACITIES;
  return resolvedOpacities.map((opacity, index) => ({
    startRatio: index / resolvedOpacities.length,
    endRatio: (index + 1) / resolvedOpacities.length,
    startOpacity: getHeadingConeOpacityAtRatio(index / resolvedOpacities.length),
    endOpacity: getHeadingConeOpacityAtRatio((index + 1) / resolvedOpacities.length),
    opacity: clamp01(opacity),
  }));
}

function getDeviceOrientationReading(
  event,
  {
    maxWebkitCompassAccuracyDegrees = HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
    allowRelativeAlphaFallback = false,
  } = {}
) {
  const webkitHeading = normalizeHeadingDegrees(event?.webkitCompassHeading);
  const webkitAccuracy = resolveFiniteNumber(event?.webkitCompassAccuracy, null, { min: 0 });
  if (webkitHeading !== null) {
    const accuracyLimit = resolveFiniteNumber(
      maxWebkitCompassAccuracyDegrees,
      HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
      { min: 0 }
    );
    const reliable = webkitAccuracy === null || webkitAccuracy <= accuracyLimit;
    return {
      heading: reliable ? webkitHeading : null,
      rawHeading: webkitHeading,
      accuracy: webkitAccuracy,
      source: "webkit-compass",
      reliable,
    };
  }

  const isAbsoluteHeading = event?.type === "deviceorientationabsolute" || event?.absolute === true;
  if (!isAbsoluteHeading) {
    if (allowRelativeAlphaFallback) {
      const fallbackAlphaHeading = normalizeHeadingDegrees(event?.alpha);
      if (fallbackAlphaHeading !== null) {
        const fallbackHeading = normalizeHeadingDegrees(360 - fallbackAlphaHeading);
        return {
          heading: fallbackHeading,
          rawHeading: fallbackHeading,
          accuracy: null,
          source: "alpha-fallback",
          reliable: false,
        };
      }
    }

    return {
      heading: null,
      rawHeading: null,
      accuracy: webkitAccuracy,
      source: null,
      reliable: false,
    };
  }

  const alphaHeading = normalizeHeadingDegrees(event?.alpha);
  if (alphaHeading === null) {
    return {
      heading: null,
      rawHeading: null,
      accuracy: null,
      source: null,
      reliable: false,
    };
  }

  const absoluteHeading = normalizeHeadingDegrees(360 - alphaHeading);
  return {
    heading: absoluteHeading,
    rawHeading: absoluteHeading,
    accuracy: null,
    source: "absolute-alpha",
    reliable: absoluteHeading !== null,
  };
}

function getDeviceOrientationHeading(event, options) {
  return getDeviceOrientationReading(event, options).heading;
}

export {
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_CONE_HALF_ANGLE_MOVING,
  HEADING_CONE_HALF_ANGLE_STATIONARY,
  HEADING_CONE_SPEED_FOR_FULLY_MOVING,
  HEADING_SENSOR_STALE_AFTER_MS,
  HEADING_SENSOR_SMOOTHING_TIME_MS,
  HEADING_SENSOR_SMOOTHING_MIN_BLEND,
  HEADING_SENSOR_MAX_WEBKIT_COMPASS_ACCURACY_DEGREES,
  HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
  HEADING_CONE_BAND_OPACITIES,
  normalizeHeadingDegrees,
  getHeadingDeltaDegrees,
  getHeadingBlendFactor,
  interpolateHeadingDegrees,
  hasFreshHeadingSensorData,
  getHeadingConeHalfAngle,
  getMetersPerPixelAtLatitude,
  getHeadingConeLengthMeters,
  getHeadingConeBandStops,
  getDeviceOrientationReading,
  getDeviceOrientationHeading,
};
