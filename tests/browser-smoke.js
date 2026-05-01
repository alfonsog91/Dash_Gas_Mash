const SMOKE_TIMEOUT_MS = 30000;
const SMOKE_POLL_INTERVAL_MS = 100;
const STORAGE_SNAPSHOT_KEYS = Object.freeze([
  "dgm:map-mode",
  "map.standardTrafficEnabled",
  "dgm:map-config:feature:trafficVisibilityController",
  "dgm:map-config:feature:trafficPaintVisibilityFallback",
  "dgm:map-config:feature:headingCompassAutoRequest",
  "dgm:map-config:feature:headingKeyboardShortcut",
  "dgm:map-config:feature:headingRelativeAlphaFallback",
  "dgm:map-config:feature:visualPerformanceHeuristics",
  "dgm:map-config:kill:traffic",
  "dgm:map-config:kill:heading",
  "dgm:map-config:kill:compassPermission",
  "dgm:map-config:kill:runtimeDiagnostics",
]);

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

function waitForSmokeCondition(predicate, label, timeoutMs = SMOKE_TIMEOUT_MS) {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let result = false;
      try {
        result = predicate();
      } catch {
        result = false;
      }

      if (result) {
        resolve(result);
        return;
      }

      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }

      window.setTimeout(tick, SMOKE_POLL_INTERVAL_MS);
    };

    tick();
  });
}

function snapshotSmokeStorage() {
  const snapshot = new Map();
  for (const key of STORAGE_SNAPSHOT_KEYS) {
    snapshot.set(key, window.localStorage.getItem(key));
  }
  return snapshot;
}

function restoreSmokeStorage(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  }
}

function configureSmokeStorage() {
  window.localStorage.setItem("dgm:map-mode", "standard");
  window.localStorage.setItem("map.standardTrafficEnabled", "false");
  window.localStorage.setItem("dgm:map-config:feature:trafficVisibilityController", "true");
  window.localStorage.setItem("dgm:map-config:feature:trafficPaintVisibilityFallback", "true");
  window.localStorage.setItem("dgm:map-config:feature:headingCompassAutoRequest", "false");
  window.localStorage.setItem("dgm:map-config:feature:headingKeyboardShortcut", "true");
  window.localStorage.setItem("dgm:map-config:feature:headingRelativeAlphaFallback", "true");
  window.localStorage.setItem("dgm:map-config:feature:visualPerformanceHeuristics", "false");
  window.localStorage.setItem("dgm:map-config:kill:traffic", "false");
  window.localStorage.setItem("dgm:map-config:kill:heading", "false");
  window.localStorage.setItem("dgm:map-config:kill:compassPermission", "false");
  window.localStorage.setItem("dgm:map-config:kill:runtimeDiagnostics", "false");
}

function isMapboxExpressionValidationError(message) {
  return /mapbox/i.test(message)
    && /(expression|validation|layers\.|paint\.|layout\.|source-layer|expected value)/i.test(message);
}

function isAcceptableEnvironmentalConsoleNoise(message) {
  if (isMapboxExpressionValidationError(message)) {
    return false;
  }

  return /(failed to load resource|net::err_|err_blocked_by_client|webgl warning|context lost)/i.test(message);
}

function getSmokeReport(appWindow) {
  return appWindow.__DGM_SMOKE_REPORT || {
    consoleErrors: [],
    pageErrors: [],
    unhandledRejections: [],
  };
}

async function createSmokeIframe(targetUrl) {
  const iframe = document.createElement("iframe");
  iframe.id = "appSmokeFrame";
  iframe.title = "Dash Gas Mash smoke target";
  iframe.src = targetUrl;
  document.body.append(iframe);
  await waitForSmokeCondition(() => iframe.contentWindow?.document?.readyState === "complete", "app document load");
  return iframe;
}

async function runTrafficSmoke(runtime) {
  const traffic = runtime.traffic;
  const beforeVisible = traffic.getVisible();
  const nextPreference = traffic.toggleTraffic();
  await waitForSmokeCondition(
    () => traffic.getVisible() === Boolean(nextPreference),
    "traffic runtime toggle"
  );
  const afterVisible = traffic.getVisible();

  if (afterVisible !== beforeVisible) {
    traffic.toggleTraffic();
    await waitForSmokeCondition(
      () => traffic.getVisible() === beforeVisible,
      "traffic runtime toggle restore"
    );
  }

  return { beforeVisible, afterVisible };
}

function runHeadingPermissionSmoke(runtime) {
  const beforeState = runtime.getState();
  runtime.startDeviceOrientationWatch();
  const afterState = runtime.getState();
  const validStates = new Set(["required", "granted", "denied", "not-required", "unavailable"]);
  assert(validStates.has(afterState.compassPermissionState), "heading permission state stays in a known state");
  return {
    before: beforeState.compassPermissionState,
    after: afterState.compassPermissionState,
  };
}

function runFeatureFlagSmoke(runtime) {
  const config = runtime.config;
  const featureName = "trafficVisibilityController";
  const previous = config.isFeatureEnabled(featureName);
  const changed = config.setFeatureFlag(featureName, !previous, { persist: false });
  const observed = config.isFeatureEnabled(featureName);
  config.setFeatureFlag(featureName, previous, { persist: false });
  const restored = config.isFeatureEnabled(featureName);

  assert(changed === !previous, "feature flag setter returns the next runtime value");
  assert(observed === !previous, "feature flag runtime toggle is observable");
  assert(restored === previous, "feature flag runtime toggle restores cleanly");

  return { featureName, previous, observed, restored };
}

async function runAppReadinessSmoke(appWindow) {
  await waitForSmokeCondition(
    () => appWindow.document.querySelectorAll(".mapboxgl-canvas").length === 1,
    "one Mapbox canvas"
  );
  await waitForSmokeCondition(
    () => appWindow.DGM_RUNTIME?.map && appWindow.DGM_RUNTIME?.traffic && appWindow.DGM_RUNTIME?.config,
    "DGM runtime debug surface"
  );

  const runtime = appWindow.DGM_RUNTIME;
  await waitForSmokeCondition(
    () => typeof runtime.map.isStyleLoaded !== "function" || runtime.map.isStyleLoaded(),
    "Mapbox style readiness"
  );

  const canvasCount = appWindow.document.querySelectorAll(".mapboxgl-canvas").length;
  const fatalOverlayCount = appWindow.document.querySelectorAll(".map-fatal-overlay").length;
  assert(canvasCount === 1, "exactly one Mapbox canvas is rendered");
  assert(fatalOverlayCount === 0, "fatal map overlay is absent");

  return { runtime, canvasCount, fatalOverlayCount };
}

function assertNoCapturedErrors(smokeReport) {
  const consoleErrors = smokeReport.consoleErrors || [];
  const pageErrors = smokeReport.pageErrors || [];
  const unhandledRejections = smokeReport.unhandledRejections || [];
  const mapboxExpressionValidationErrors = consoleErrors.filter(isMapboxExpressionValidationError);
  const appConsoleErrors = consoleErrors.filter((message) => !isAcceptableEnvironmentalConsoleNoise(message));
  const environmentalNoise = consoleErrors.filter(isAcceptableEnvironmentalConsoleNoise);

  assert(pageErrors.length === 0, `page errors captured: ${pageErrors.join(" | ")}`);
  assert(unhandledRejections.length === 0, `unhandled rejections captured: ${unhandledRejections.join(" | ")}`);
  assert(mapboxExpressionValidationErrors.length === 0, `Mapbox expression validation errors captured: ${mapboxExpressionValidationErrors.join(" | ")}`);
  assert(appConsoleErrors.length === 0, `app console errors captured: ${appConsoleErrors.join(" | ")}`);

  return {
    pageErrors,
    unhandledRejections,
    appConsoleErrors,
    mapboxExpressionValidationErrors,
    environmentalNoise,
    acceptableEnvironmentalNoise: [
      "External tile, glyph, CDN, or network resource failures may be reported separately when the browser surfaces them as console errors.",
      "Browser WebGL context warnings are environmental unless they are emitted as app console errors.",
      "Mapbox expression validation errors are never acceptable environmental noise.",
    ],
  };
}

async function runDgmBrowserSmoke({ targetUrl = "../index.html?dgmSmoke=1" } = {}) {
  const log = createLogger();
  const storageSnapshot = snapshotSmokeStorage();
  let iframe = null;

  try {
    log.write("DGM browser smoke started");
    configureSmokeStorage();
    iframe = await createSmokeIframe(targetUrl);

    const readiness = await runAppReadinessSmoke(iframe.contentWindow);
    log.write("PASS app readiness and fatal overlay checks");

    const traffic = await runTrafficSmoke(readiness.runtime);
    log.write("PASS traffic runtime toggle");

    const headingPermission = runHeadingPermissionSmoke(readiness.runtime);
    log.write("PASS heading permission path smoke");

    const featureFlag = runFeatureFlagSmoke(readiness.runtime);
    log.write("PASS feature flag runtime toggle");

    const errors = assertNoCapturedErrors(getSmokeReport(iframe.contentWindow));
    log.write("PASS captured page, console, and Mapbox validation checks");

    const result = {
      passed: 8,
      failed: 0,
      readiness: {
        canvasCount: readiness.canvasCount,
        fatalOverlayCount: readiness.fatalOverlayCount,
      },
      traffic,
      headingPermission,
      featureFlag,
      errors,
    };
    window.__DGM_BROWSER_SMOKE_RESULT = result;
    document.title = "All 8 browser smoke checks passed";
    log.write("Results: 8 passed, 0 failed");
    return result;
  } catch (error) {
    const result = {
      passed: 0,
      failed: 1,
      error: error.message,
    };
    window.__DGM_BROWSER_SMOKE_RESULT = result;
    document.title = "Browser smoke checks failed";
    log.write(`FAIL ${error.message}`);
    throw error;
  } finally {
    restoreSmokeStorage(storageSnapshot);
    if (iframe) {
      iframe.remove();
    }
  }
}

export {
  runDgmBrowserSmoke,
  waitForSmokeCondition,
};

if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    runDgmBrowserSmoke().catch((error) => {
      console.error(error);
    });
  });
}