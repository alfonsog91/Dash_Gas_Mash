const HEADING_CONE_LENGTH_PIXELS = 28;
const HEADING_CONE_HALF_ANGLE_MOVING = 18;
const HEADING_CONE_HALF_ANGLE_STATIONARY = 28;
const HEADING_CONE_SPEED_FOR_FULLY_MOVING = 3;
const HEADING_ORIENTATION_MIN_DELTA_DEGREES = 2;
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878; // Web Mercator approaches infinity past this latitude.
const WEB_MERCATOR_METERS_PER_PIXEL_AT_ZOOM_0 = 40075016.68557849 / 512; // Earth's equatorial circumference / 512px world.

function clamp01(x) {
  return Math.max(0, Math.min(1, Number(x) || 0));
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

function getDeviceOrientationHeading(event) {
  const webkitHeading = normalizeHeadingDegrees(event?.webkitCompassHeading);
  if (webkitHeading !== null) {
    return webkitHeading;
  }
  const isAbsoluteHeading = event?.type === "deviceorientationabsolute" || event?.absolute === true;
  if (!isAbsoluteHeading) {
    return null;
  }
  const alphaHeading = normalizeHeadingDegrees(event?.alpha);
  if (alphaHeading === null) {
    return null;
  }
  return normalizeHeadingDegrees(360 - alphaHeading);
}

export {
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_CONE_HALF_ANGLE_MOVING,
  HEADING_CONE_HALF_ANGLE_STATIONARY,
  HEADING_CONE_SPEED_FOR_FULLY_MOVING,
  HEADING_ORIENTATION_MIN_DELTA_DEGREES,
  normalizeHeadingDegrees,
  getHeadingDeltaDegrees,
  getHeadingConeHalfAngle,
  getMetersPerPixelAtLatitude,
  getHeadingConeLengthMeters,
  getDeviceOrientationHeading,
};
