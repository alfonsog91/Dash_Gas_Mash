import {
  HEADING_CONE_LENGTH_PIXELS,
  HEADING_CONE_BAND_OPACITIES,
  HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS,
  HEADING_CONE_HALF_ANGLE_MOVING,
  HEADING_CONE_HALF_ANGLE_STATIONARY,
  HEADING_CONE_SPEED_FOR_FULLY_MOVING,
  HEADING_SENSOR_SMOOTHING_MIN_BLEND,
  HEADING_SENSOR_SMOOTHING_TIME_MS,
  HEADING_SENSOR_STALE_AFTER_MS,
  getDeviceOrientationHeading,
  getHeadingBlendFactor,
  getHeadingConeBandStops,
  getHeadingConeHalfAngle,
  getHeadingConeLengthMeters,
  getHeadingDeltaDegrees,
  hasFreshHeadingSensorData,
  interpolateHeadingDegrees,
  getMetersPerPixelAtLatitude,
  normalizeHeadingDegrees,
} from "../heading_cone.js?v=20260403-sensor-presence";
import {
  getLocationCourseHeading,
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
} from "../heading_runtime.js";

function createLogger() {
  const logEl = typeof document !== "undefined" ? document.getElementById("log") : null;
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
      log.write(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`FAIL ${name}: ${error.message}`);
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

  runTest("interpolateHeadingDegrees follows the shortest turn", () => {
    assertEqual(interpolateHeadingDegrees(350, 10, 0.5), 0, "half blend should cross the seam cleanly");
    assertEqual(interpolateHeadingDegrees(null, 95, 0.2), 95, "missing previous heading should use next heading");
  });

  runTest("getHeadingBlendFactor stays time-based and lightly responsive", () => {
    const immediateSensorBlend = getHeadingBlendFactor(16, HEADING_SENSOR_SMOOTHING_TIME_MS, HEADING_SENSOR_SMOOTHING_MIN_BLEND);
    const slowerGpsBlend = getHeadingBlendFactor(16, HEADING_GPS_FALLBACK_SMOOTHING_TIME_MS, 0);
    assert(immediateSensorBlend >= HEADING_SENSOR_SMOOTHING_MIN_BLEND, "sensor smoothing should keep a minimum response");
    assert(immediateSensorBlend > slowerGpsBlend, "sensor updates should respond faster than GPS fallback");
  });

  runTest("hasFreshHeadingSensorData expires stale sensor authority", () => {
    assert(hasFreshHeadingSensorData(1000, 1000 + HEADING_SENSOR_STALE_AFTER_MS - 1), "recent sensor data should stay authoritative");
    assert(!hasFreshHeadingSensorData(1000, 1000 + HEADING_SENSOR_STALE_AFTER_MS + 1), "stale sensor data should expire");
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
    assertApprox(highLatitude, equator * 0.5, 0.0001, "60 degrees latitude should use cosine scaling");
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

  runTest("getHeadingConeBandStops fade toward the cone tip", () => {
    const stops = getHeadingConeBandStops();
    assertEqual(stops.length, HEADING_CONE_BAND_OPACITIES.length, "one stop per opacity band");
    assertEqual(stops[0].startRatio, 0, "first band begins at the blue dot");
    assertEqual(stops.at(-1).endRatio, 1, "last band reaches the cone tip");
    assert(stops[0].opacity > stops.at(-1).opacity, "near band should be more opaque than the tip band");
  });

  runTest("getDeviceOrientationHeading prefers iOS webkit compass heading", () => {
    assertEqual(getDeviceOrientationHeading({ webkitCompassHeading: 271 }), 271, "webkit compass heading should be used directly");
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

  runTest("getDeviceOrientationHeading keeps relative alpha opt-in", () => {
    assert(getDeviceOrientationHeading({ type: "deviceorientation", absolute: false, alpha: 15 }) === null, "relative alpha should stay disabled by default");
    assertEqual(
      getDeviceOrientationHeading(
        { type: "deviceorientation", absolute: false, alpha: 15 },
        { allowRelativeAlphaFallback: true }
      ),
      345,
      "relative alpha fallback should produce a compass heading when explicitly enabled"
    );
  });

  runTest("getDeviceOrientationHeading ignores invalid events", () => {
    assert(getDeviceOrientationHeading({ type: "deviceorientationabsolute", alpha: Number.NaN }) === null, "invalid alpha should be ignored");
    assert(getDeviceOrientationHeading(null) === null, "null events should be ignored");
  });

  runTest("getLocationCourseHeading derives course from successive fixes", () => {
    assertApprox(
      getLocationCourseHeading(
        { lat: 34.1064, lng: -117.5931 },
        { lat: 34.1064, lng: -117.5920 }
      ),
      90,
      2,
      "eastbound movement should yield an easterly course"
    );
  });

  runTest("getLocationCourseHeading ignores tiny GPS jitter", () => {
    assert(
      getLocationCourseHeading(
        { lat: 34.1064, lng: -117.5931 },
        { lat: 34.1064005, lng: -117.5931005 }
      ) === null,
      "tiny movement should not produce a fake heading"
    );
  });

  runTest("resolveEffectiveHeadingState prefers fresh sensor heading", () => {
    const state = resolveEffectiveHeadingState({
      storedHeading: 120,
      storedHeadingSource: "gps",
      storedSpeed: 0.4,
      sensorHeading: 270,
      sensorHeadingAt: 1000,
      nowMs: 1000 + HEADING_SENSOR_STALE_AFTER_MS - 1,
      mapBearing: 35,
      maxSensorAgeMs: HEADING_SENSOR_STALE_AFTER_MS,
    });

    assertEqual(state.effectiveHeading, 270, "fresh sensor heading should win precedence");
    assertEqual(state.source, "sensor", "fresh sensor heading should report sensor source");
  });

  runTest("resolveEffectiveHeadingState falls back from stale or invalid sensor data", () => {
    const gpsFallback = resolveEffectiveHeadingState({
      storedHeading: 120,
      storedHeadingSource: "gps",
      storedSpeed: 0.4,
      sensorHeading: 270,
      sensorHeadingAt: 1000,
      nowMs: 1000 + HEADING_SENSOR_STALE_AFTER_MS + 1,
      mapBearing: 35,
      maxSensorAgeMs: HEADING_SENSOR_STALE_AFTER_MS,
    });
    assertEqual(gpsFallback.effectiveHeading, 120, "stale sensor data should fall back to stored GPS heading");
    assertEqual(gpsFallback.source, "gps", "stale sensor fallback should preserve GPS source");

    const bearingFallback = resolveEffectiveHeadingState({
      storedHeading: Number.NaN,
      storedHeadingSource: "gps",
      storedSpeed: 0.4,
      sensorHeading: Number.NaN,
      sensorHeadingAt: 1000,
      nowMs: 1000 + HEADING_SENSOR_STALE_AFTER_MS + 1,
      mapBearing: 35,
      maxSensorAgeMs: HEADING_SENSOR_STALE_AFTER_MS,
    });
    assertEqual(bearingFallback.effectiveHeading, 35, "invalid stored heading should fall back to map bearing");
    assertEqual(bearingFallback.source, "bearing", "map bearing should remain the final fallback source");
  });

  runTest("isHeadingRenderLoopDocumentActive keeps visible pages eligible without focus", () => {
    assert(
      isHeadingRenderLoopDocumentActive({ hidden: false, hasFocus: () => false }),
      "visible documents should not lose heading updates just because focus is false"
    );
    assert(
      !isHeadingRenderLoopDocumentActive({ hidden: true, hasFocus: () => true }),
      "hidden documents should still pause heading updates"
    );
  });

  runTest("resolveCompassPermissionState preserves permission gating semantics", () => {
    assertEqual(
      resolveCompassPermissionState({
        hasDeviceOrientationEvent: false,
        canRequestPermission: false,
        permissionState: null,
      }),
      "unavailable",
      "missing DeviceOrientationEvent should stay unavailable"
    );
    assertEqual(
      resolveCompassPermissionState({
        hasDeviceOrientationEvent: true,
        canRequestPermission: false,
        permissionState: null,
      }),
      "not-required",
      "platforms without requestPermission should stay not-required"
    );
    assertEqual(
      resolveCompassPermissionState({
        hasDeviceOrientationEvent: true,
        canRequestPermission: true,
        permissionState: null,
      }),
      "required",
      "requestPermission platforms should remain gesture-gated until decided"
    );
    assertEqual(
      resolveCompassPermissionState({
        hasDeviceOrientationEvent: true,
        canRequestPermission: true,
        permissionState: "granted",
      }),
      "granted",
      "granted state should persist"
    );
    assertEqual(
      resolveCompassPermissionState({
        hasDeviceOrientationEvent: true,
        canRequestPermission: true,
        permissionState: "denied",
      }),
      "denied",
      "denied state should persist"
    );
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} heading cone tests passed`
      : `${failed}/${passed + failed} heading cone tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runHeadingConeTests);
}
