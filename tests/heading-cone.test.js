import {
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_CONE_HALF_ANGLE_MOVING,
  HEADING_CONE_HALF_ANGLE_STATIONARY,
  HEADING_CONE_SPEED_FOR_FULLY_MOVING,
  getDeviceOrientationHeading,
  getHeadingConeHalfAngle,
  getHeadingConeLengthMeters,
  getHeadingDeltaDegrees,
  getMetersPerPixelAtLatitude,
  normalizeHeadingDegrees,
} from "../heading_cone.js?v=20260403-presence-layer";

function createLogger() {
  const logEl = document.getElementById("log");
  const entries = [];
  return {
    write(message) {
      entries.push(message);
      if (logEl) {
        logEl.textContent = `${entries.join("\n")}\n`;
      }
      console.log(message);
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertApprox(actual, expected, epsilon, message) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message}: expected ${expected} ± ${epsilon}, got ${actual}`);
  }
}

export function runHeadingConeTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  function runTest(name, fn) {
    try {
      fn();
      passed += 1;
      log.write(`✅ ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`❌ ${name}: ${error.message}`);
    }
  }

  log.write("Directional cone helper tests");

  runTest("normalizeHeadingDegrees wraps negatives", () => {
    assertEqual(normalizeHeadingDegrees(-15), 345, "negative headings wrap into [0,360)");
  });

  runTest("normalizeHeadingDegrees wraps values above 360", () => {
    assertEqual(normalizeHeadingDegrees(725), 5, "headings above 360 wrap");
  });

  runTest("normalizeHeadingDegrees rejects non-finite values", () => {
    assert(normalizeHeadingDegrees(Number.NaN) === null, "NaN should return null");
    assert(normalizeHeadingDegrees(Infinity) === null, "Infinity should return null");
  });

  runTest("getHeadingDeltaDegrees crosses the 0/360 seam", () => {
    assertEqual(getHeadingDeltaDegrees(350, 10), 20, "wraparound delta should stay small");
    assertEqual(getHeadingDeltaDegrees(5, 355), 10, "reverse wraparound delta should stay small");
  });

  runTest("getHeadingConeHalfAngle returns stationary width at zero speed", () => {
    assertEqual(getHeadingConeHalfAngle(0), HEADING_CONE_HALF_ANGLE_STATIONARY, "stationary speed uses stationary angle");
  });

  runTest("getHeadingConeHalfAngle interpolates smoothly", () => {
    assertApprox(
      getHeadingConeHalfAngle(HEADING_CONE_SPEED_FOR_FULLY_MOVING / 2),
      (HEADING_CONE_HALF_ANGLE_STATIONARY + HEADING_CONE_HALF_ANGLE_MOVING) / 2,
      0.0001,
      "half speed should land midway between stationary and moving angles"
    );
  });

  runTest("getHeadingConeHalfAngle clamps to moving width", () => {
    assertEqual(
      getHeadingConeHalfAngle(HEADING_CONE_SPEED_FOR_FULLY_MOVING * 5),
      HEADING_CONE_HALF_ANGLE_MOVING,
      "high speeds should clamp to moving angle"
    );
  });

  runTest("getMetersPerPixelAtLatitude shrinks as zoom increases", () => {
    const zoom12 = getMetersPerPixelAtLatitude(34.1064, 12);
    const zoom13 = getMetersPerPixelAtLatitude(34.1064, 13);
    assertApprox(zoom13, zoom12 / 2, 0.0001, "one zoom step should halve meters per pixel");
  });

  runTest("getMetersPerPixelAtLatitude reflects latitude", () => {
    const equator = getMetersPerPixelAtLatitude(0, 12);
    const highLatitude = getMetersPerPixelAtLatitude(60, 12);
    assertApprox(highLatitude, equator * 0.5, 0.0001, "60° latitude should use cosine scaling");
  });

  runTest("getHeadingConeLengthMeters converts fixed pixels into map meters", () => {
    const metersPerPixel = getMetersPerPixelAtLatitude(34.1064, 15);
    assertApprox(
      getHeadingConeLengthMeters(34.1064, 15),
      HEADING_CONE_LENGTH_PIXELS * metersPerPixel,
      0.0001,
      "default cone pixels should map into zoom-scaled meters"
    );
  });

  runTest("getDeviceOrientationHeading prefers iOS webkit compass heading", () => {
    assertEqual(
      getDeviceOrientationHeading({ webkitCompassHeading: 271 }),
      271,
      "webkit compass heading should be used directly"
    );
  });

  runTest("getDeviceOrientationHeading converts absolute alpha to compass heading", () => {
    assertEqual(
      getDeviceOrientationHeading({ type: "deviceorientationabsolute", alpha: 90 }),
      270,
      "absolute alpha should convert to compass heading"
    );
    assertEqual(
      getDeviceOrientationHeading({ absolute: true, alpha: 15 }),
      345,
      "absolute orientation events should convert alpha"
    );
  });

  runTest("getDeviceOrientationHeading ignores relative or invalid events", () => {
    assert(getDeviceOrientationHeading({ type: "deviceorientation", absolute: false, alpha: 15 }) === null, "relative alpha should be ignored");
    assert(getDeviceOrientationHeading({ type: "deviceorientationabsolute", alpha: Number.NaN }) === null, "invalid alpha should be ignored");
    assert(getDeviceOrientationHeading(null) === null, "null events should be ignored");
  });

  const title = failed === 0
    ? `✅ All ${passed} heading cone tests passed`
    : `❌ ${failed}/${passed + failed} heading cone tests failed`;
  document.title = title;
  log.write(`Results: ${passed} passed, ${failed} failed`);
}

window.addEventListener("load", runHeadingConeTests);
