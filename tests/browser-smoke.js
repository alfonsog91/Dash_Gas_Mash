import { resolveWebsitePreviewPlan, buildTelHref } from "../ui/place_card.js?v=20260610-phaseg-place-card";
import { animateCameraAlongPath } from "../ui/vehicle_marker.js?v=20260610-phaseg-vehicle-marker";

const SMOKE_TIMEOUT_MS = 30000;
const SMOKE_POLL_INTERVAL_MS = 100;
const STORAGE_SNAPSHOT_KEYS = Object.freeze([
  "dgm:map-mode",
  "map.standardTrafficEnabled",
  "dgm:standard-traffic-enabled:v2",
  "dgm:standard-map-theme",
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
  window.localStorage.setItem("map.standardTrafficEnabled", "true");
  window.localStorage.removeItem("dgm:standard-traffic-enabled:v2");
  window.localStorage.removeItem("dgm:standard-map-theme");
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
  assert(
    appWindow.document.body.dataset.standardResolvedTheme === "light",
    "standard map defaults to the light gold-road palette"
  );
  assert(
    runtime.traffic.getPreference() === false && runtime.traffic.getVisible() === false,
    "a legacy traffic preference does not enable traffic after the styling upgrade"
  );
  const appBuildId = runtime.getState()?.appBuildId || "";
  assert(appBuildId && appBuildId !== "20260410-nav-hotfix", "runtime reports the current release identifier");
  assert(runtime.config.buildId === appBuildId, "runtime configuration and app state report the same build identifier");

  return {
    runtime,
    canvasCount,
    fatalOverlayCount,
    standardResolvedTheme: appWindow.document.body.dataset.standardResolvedTheme,
    trafficVisible: runtime.traffic.getVisible(),
    appBuildId,
  };
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

async function runVegetationSmoke(runtime) {
  const vegetation = runtime.vegetation;
  assert(vegetation && typeof vegetation.syncVisibility === "function", "vegetation runtime surface is exposed");

  // Seed deterministic samples and enable the owner-local toggle path.
  vegetation.setSamples([
    { type: "wood", density: 2, polygon: [[-117.651, 34.05], [-117.649, 34.05], [-117.649, 34.0512], [-117.651, 34.0512], [-117.651, 34.05]] },
    { type: "tree", lat: 34.06, lng: -117.6 },
    { type: "tree", lat: 34.0601, lng: -117.6001 },
  ]);
  vegetation.setEnabled(true);

  const baseInstances = vegetation.getInstanceCount();
  assert(baseInstances > 0, "vegetation generates sprite instances from samples");

  // High zoom + allowed + no guard => sprite billboards.
  const spriteMode = vegetation.syncVisibility({ zoom: 16, guardDisabled: false, allowed: true });
  assert(spriteMode === "sprite", "high zoom renders sprite billboards when allowed");

  // Mid zoom => aggregated extrusions.
  const extrusionMode = vegetation.syncVisibility({ zoom: 10, guardDisabled: false, allowed: true });
  assert(extrusionMode === "extrusion", "mid zoom renders aggregated extrusions");

  // Simulated low-FPS perf guard disables the layer entirely.
  const guardedMode = vegetation.syncVisibility({ zoom: 16, guardDisabled: true, allowed: true });
  assert(guardedMode === "hidden", "a tripped perf guard hides vegetation");

  // Not allowed (no tuning and no owner toggle) also hides it.
  const disallowedMode = vegetation.syncVisibility({ zoom: 16, guardDisabled: false, allowed: false });
  assert(disallowedMode === "hidden", "vegetation stays hidden when not allowed");

  // Density slider updates instance count (raising the threshold reduces it).
  vegetation.setDensityThreshold(99);
  assert(vegetation.getInstanceCount() < baseInstances, "raising density threshold reduces the instance count");
  vegetation.setDensityThreshold(1);

  // Debug metadata is exposed on the debug host (localhost).
  const debugMetadata = vegetation.getDebugMetadata();
  assert(debugMetadata && typeof debugMetadata.instanceCount === "number", "vegetation debug metadata is exposed on the debug host");

  // Leave the layer hidden so it does not affect later checks.
  vegetation.setEnabled(false);
  vegetation.syncVisibility({ zoom: 16, guardDisabled: false, allowed: false });

  return { baseInstances, spriteMode, extrusionMode };
}

async function runVehicleCameraSmoke(runtime, appWindow) {
  const vehicle = runtime.vehicle;
  assert(vehicle && typeof vehicle.setEnabled === "function", "vehicle runtime surface is exposed");

  // Deterministic camera keyframes (the asserted-on function) work in the live app.
  const keyframes = vehicle.animateCameraAlongPath([[-117.6, 34.06], [-117.59, 34.07]], { frames: 3, easing: "linear", pitch: 45 });
  assert(keyframes.length === 3, "animateCameraAlongPath yields the requested keyframes");
  assert(JSON.stringify(keyframes[0].center) === JSON.stringify([-117.6, 34.06]), "first keyframe is the path start");
  assert(JSON.stringify(keyframes[2].center) === JSON.stringify([-117.59, 34.07]), "last keyframe is the path end");

  // Enabling the vehicle hides the blue dot and shows the sprite marker. The
  // vehicle is owner-gated, so opt in via the owner toggle before enabling.
  appWindow.DGM_VEHICLE = true;
  const enabled = vehicle.setEnabled(true);
  assert(enabled === true, "vehicle is enabled once the owner toggle is set");
  vehicle.update({ lng: -117.6, lat: 34.06, heading: 90, speed: 10 });

  const doc = appWindow.document;
  const dotLayerHidden = appWindow.DGM_RUNTIME?.map?.getLayer?.("current-location-dot");
  if (dotLayerHidden) {
    const visibility = appWindow.DGM_RUNTIME.map.getLayoutProperty("current-location-dot", "visibility");
    assert(visibility === "none", "the blue dot is hidden while the vehicle marker owns the location visual");
  }
  assert(appWindow.DGM_RUNTIME.map.getLayer("dgm-vehicle-layer"), "vehicle symbol layer is added");
  assert(vehicle.isVisible() === true, "vehicle marker is visible when enabled");

  const state = vehicle.getState();
  assert(Math.round(state.lng * 100) / 100 === -117.6, "vehicle state tracks the update position");
  assert(state.renderedHeading === 90, "first update snaps the rendered heading");

  const debugMetadata = vehicle.getDebugMetadata();
  assert(debugMetadata && typeof debugMetadata.updates === "number", "vehicle debug metadata is exposed on the debug host");

  // Restore the blue dot so later checks and normal UX are unaffected.
  vehicle.setEnabled(false);
  appWindow.DGM_VEHICLE = false;
  assert(vehicle.isEnabled() === false, "vehicle disables cleanly and restores the blue dot");

  return { keyframeCount: keyframes.length, renderedHeading: state.renderedHeading };
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

    const vegetation = await runVegetationSmoke(readiness.runtime);
    log.write("PASS Phase G vegetation toggle, LOD, perf-guard gating, and density slider");

    const vehicle = await runVehicleCameraSmoke(readiness.runtime, iframe.contentWindow);
    log.write("PASS Phase G vehicle marker, blue-dot replacement, and deterministic camera keyframes");

    const errors = assertNoCapturedErrors(getSmokeReport(iframe.contentWindow));
    log.write("PASS captured page, console, and Mapbox validation checks");

    const result = {
      passed: 11,
      failed: 0,
      readiness: {
        canvasCount: readiness.canvasCount,
        fatalOverlayCount: readiness.fatalOverlayCount,
      },
      traffic,
      headingPermission,
      featureFlag,
      placeCard,
      vegetation,
      vehicle,
      errors,
    };
    window.__DGM_BROWSER_SMOKE_RESULT = result;
    document.title = "All 11 browser smoke checks passed";
    log.write("Results: 11 passed, 0 failed");
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