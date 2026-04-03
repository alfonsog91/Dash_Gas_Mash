const HEADING_CONE_METERS = 10;
const HEADING_CONE_HALF_ANGLE_MOVING = 18;
const HEADING_CONE_HALF_ANGLE_STATIONARY = 28;
const HEADING_CONE_SPEED_FOR_FULLY_MOVING = 3;
const HEADING_ORIENTATION_MIN_DELTA_DEGREES = 2;

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
  HEADING_CONE_METERS,
  HEADING_CONE_HALF_ANGLE_MOVING,
  HEADING_CONE_HALF_ANGLE_STATIONARY,
  HEADING_CONE_SPEED_FOR_FULLY_MOVING,
  HEADING_ORIENTATION_MIN_DELTA_DEGREES,
  normalizeHeadingDegrees,
  getHeadingDeltaDegrees,
  getHeadingConeHalfAngle,
  getDeviceOrientationHeading,
};
