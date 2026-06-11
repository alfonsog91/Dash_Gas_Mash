import { resolveWebsitePreviewPlan, buildTelHref } from "../ui/place_card.js?v=20260610-phaseg-place-card";

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

async function runPlaceCardSmoke(runtime, appWindow) {
  const placeCard = runtime.placeCard;
  assert(placeCard && typeof placeCard.open === "function", "place card runtime surface is exposed");

  // Security invariant (pure helper): a sandboxed preview never combines
  // allow-scripts with allow-same-origin, and non-http schemes are not framed.
  const stripPlan = resolveWebsitePreviewPlan("https://example.com", { sandbox: ["allow-scripts", "allow-same-origin"] });
  assert(stripPlan.mode === "iframe", "http(s) websites resolve to an iframe preview");
  assert(!stripPlan.sandbox.includes("allow-same-origin"), "allow-same-origin is stripped when combined with allow-scripts");
  assert(resolveWebsitePreviewPlan("javascript:alert(1)").mode === "none", "non-http websites are not previewable");
  assert(String(buildTelHref("(909) 555-0148")).startsWith("tel:"), "tel: href is built from a phone number");

  // Same-origin website avoids cross-origin framing console noise in the smoke.
  const sameOriginWebsite = new URL("style.json", appWindow.location.href).href;
  const place = {
    id: "smoke-poi-1",
    name: "Smoke Test POI",
    lat: 34.06,
    lon: -117.59,
    category: "gas_station",
    rating: 4.4,
    phone: "(909) 555-0148",
    website: sameOriginWebsite,
    hours: { periods: [{ day: 1, open: "0600", close: "2200" }] },
    photoRefs: [{ ref: "smoke-a" }, { ref: "smoke-b" }],
  };

  const model = placeCard.open(place);
  assert(model && model.id === "smoke-poi-1", "tapping a POI opens the place card");

  const doc = appWindow.document;
  const cardEl = doc.querySelector(".dgm-place-card");
  assert(cardEl, "place card dialog is rendered");
  assert(cardEl.getAttribute("role") === "dialog", "place card uses role=dialog");
  assert(cardEl.getAttribute("aria-modal") === "true", "place card is aria-modal");

  const phoneLink = cardEl.querySelector(".dgm-place-card__phone");
  assert(phoneLink && (phoneLink.getAttribute("href") || "").startsWith("tel:"), "tel: link is present on the card");

  const iframe = cardEl.querySelector(".dgm-place-card__iframe");
  assert(iframe, "website preview iframe is rendered when a website is present");
  const sandboxTokens = (iframe.getAttribute("sandbox") || "").split(/\s+/);
  assert(!sandboxTokens.includes("allow-same-origin"), "rendered iframe sandbox excludes allow-same-origin");
  assert(cardEl.querySelector(".dgm-place-card__website-newtab"), "new-tab fallback control is present");

  const photos = cardEl.querySelector(".dgm-place-card__photos");
  assert(photos && photos.getAttribute("data-photo-count") === "2", "photos carousel lazily renders the photo set");

  const navigate = cardEl.querySelector(".dgm-place-card__navigate");
  assert(navigate && /Navigate to/.test(navigate.getAttribute("aria-label") || ""), "Navigate button is present and labelled");

  // Debug metadata is gated by shouldExposePhaseDDebug(); the smoke runs on a
  // localhost debug host, so it is exposed and structured.
  const debugMetadata = placeCard.getDebugMetadata();
  assert(debugMetadata && debugMetadata.activePlaceId === "smoke-poi-1", "debug metadata is exposed on the debug host");

  placeCard.close();
  assert(placeCard.isOpen() === false, "place card closes cleanly");
  assert(!doc.querySelector(".dgm-place-card"), "place card is removed from the DOM after close");

  return { websiteMode: model.websitePlan.mode, photoCount: model.photoRefs.length };
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

    const placeCard = await runPlaceCardSmoke(readiness.runtime, iframe.contentWindow);
    log.write("PASS Phase G place card open, accessibility, security, and debug gating");

    const errors = assertNoCapturedErrors(getSmokeReport(iframe.contentWindow));
    log.write("PASS captured page, console, and Mapbox validation checks");

    const result = {
      passed: 9,
      failed: 0,
      readiness: {
        canvasCount: readiness.canvasCount,
        fatalOverlayCount: readiness.fatalOverlayCount,
      },
      traffic,
      headingPermission,
      featureFlag,
      placeCard,
      errors,
    };
    window.__DGM_BROWSER_SMOKE_RESULT = result;
    document.title = "All 9 browser smoke checks passed";
    log.write("Results: 9 passed, 0 failed");
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