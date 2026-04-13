import {
  filterHeadingDegrees,
  getDeviceOrientationReading,
  getHeadingBlendFactor,
  getHeadingDeltaDegrees,
  hasFreshHeadingSensorData,
  interpolateHeadingDegrees,
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

function getHeadingNowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }

  return Date.now();
}

function createHeadingRuntime({
  appBuildId,
  compassDebugModeEnabled = false,
  runtimeDiagnosticsEnabled = false,
  allowRelativeCompassAlphaFallback = false,
  compassPermissionRequestTimeoutMs = 5000,
  compassPermissionStorageKey = "dgm:compass-permission-state",
  headingSensorMaxWebkitCompassAccuracyDegrees,
  headingSensorStaleAfterMs,
  headingSensorSmoothingTimeMs,
  headingSensorSmoothingMinBlend,
  headingGpsFallbackSmoothingTimeMs,
  headingFilterSmoothingFactor,
  headingFilterDeadZoneDegrees,
  headingFilterMinRotationDegrees,
  headingRenderLoopFrameIntervalMs,
  headingRenderLoopMapBearingSmoothingTimeMs,
  headingRenderLoopGpsSmoothingTimeMs,
  headingRenderLoopMinDeltaDegrees,
  headingRenderLoopMinLocationDeltaMeters,
  headingRenderLoopMinSpeedDeltaMps,
  isTouchInteractionDevice,
  getMap,
  getMapBearing,
  getMapZoom,
  isHeadingConeRenderTargetActive,
  getCurrentLocation,
  getCurrentLocationAccuracyMeters,
  getIsFollowingCurrentLocation,
  getBaseStyle,
  getRouteActive,
  getDataLoaded,
  lngLatToObject,
  haversineMeters,
  renderHeadingCone,
  clearHeadingCone,
  syncMapBearingToHeading,
  searchToggleElement = null,
  locateMeElement = null,
  compassPermissionStates = {},
} = {}) {
  const requiredState = compassPermissionStates.required ?? "required";
  const grantedState = compassPermissionStates.granted ?? "granted";
  const deniedState = compassPermissionStates.denied ?? "denied";
  const notRequiredState = compassPermissionStates.notRequired ?? "not-required";
  const unavailableState = compassPermissionStates.unavailable ?? "unavailable";

  let storedHeading = null;
  let storedHeadingSource = null;
  let storedSpeed = null;
  let sensorHeading = null;
  let sensorHeadingAt = null;
  let sensorEventWallClockMs = null;
  let rawSensorHeading = null;
  let sensorHeadingAccuracy = null;
  let sensorHeadingKind = null;
  let lastHeadingRenderAt = null;
  let hasStartedDeviceOrientationWatch = false;
  let hasStartedHeadingConeRenderLoop = false;
  let headingConeRenderLoopFrame = null;
  let lastHeadingConeLoopFrameAt = null;
  let lastHeadingConeLoopTickAt = null;
  let lastHeadingConeLoopHeading = null;
  let lastRenderedHeadingConeHeading = null;
  let lastRenderedHeadingConeLocation = null;
  let lastRenderedHeadingConeSpeed = null;
  let lastRenderedHeadingConeZoom = null;
  let compassPermissionState = readStoredCompassPermissionState() || unavailableState;
  let isCompassPermissionRequestPending = false;
  let hasInstalledCompassPermissionAutoRequest = false;
  let hasTriggeredCompassPermissionAutoRequest = false;
  let compassUiRoot = null;
  let compassPermissionButton = null;
  let compassDebugToggleButton = null;
  let compassDebugOverlay = null;
  let compassDebugOverlayBody = null;
  let isCompassDebugOverlayVisible = compassDebugModeEnabled;
  let lastCompassPermissionErrorMessage = null;
  let lastLocationErrorMessage = null;

  function getWindowLike() {
    return typeof window !== "undefined" ? window : null;
  }

  function getDocumentLike() {
    return typeof document !== "undefined" ? document : null;
  }

  function canUseLocalStorage() {
    const windowLike = getWindowLike();
    return Boolean(windowLike?.localStorage);
  }

  function canPersistCompassPermissionState(state) {
    return (
      state === grantedState
      || state === deniedState
      || state === notRequiredState
      || state === unavailableState
    );
  }

  function readStoredCompassPermissionState() {
    const windowLike = getWindowLike();
    if (!windowLike?.localStorage) {
      return null;
    }

    try {
      const nextState = windowLike.localStorage.getItem(compassPermissionStorageKey);
      return canPersistCompassPermissionState(nextState) ? nextState : null;
    } catch {
      return null;
    }
  }

  function writeStoredCompassPermissionState(nextState) {
    const windowLike = getWindowLike();
    if (!windowLike?.localStorage) {
      return;
    }

    try {
      if (canPersistCompassPermissionState(nextState)) {
        windowLike.localStorage.setItem(compassPermissionStorageKey, nextState);
      } else {
        windowLike.localStorage.removeItem(compassPermissionStorageKey);
      }
    } catch {
      // Ignore storage failures and keep runtime behavior intact.
    }
  }

  function getCompassPermissionRequestTarget() {
    const windowLike = getWindowLike();
    if (!windowLike) {
      return null;
    }

    const permissionSources = [windowLike.DeviceOrientationEvent, windowLike.DeviceMotionEvent]
      .filter((eventType, index, list) => eventType && list.indexOf(eventType) === index)
      .filter((eventType) => typeof eventType.requestPermission === "function");

    if (!permissionSources.length) {
      return null;
    }

    return {
      async requestPermission() {
        const settled = await Promise.allSettled(
          permissionSources.map((eventType) => eventType.requestPermission())
        );

        if (settled.some((result) => result.status === "fulfilled" && result.value === grantedState)) {
          return grantedState;
        }

        if (settled.some((result) => result.status === "fulfilled" && result.value === deniedState)) {
          return deniedState;
        }

        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected) {
          throw rejected.reason;
        }

        return requiredState;
      },
    };
  }

  function getResolvedCompassPermissionState() {
    const windowLike = getWindowLike();
    return resolveCompassPermissionState({
      hasDeviceOrientationEvent: Boolean(windowLike?.DeviceOrientationEvent),
      canRequestPermission: Boolean(getCompassPermissionRequestTarget()),
      permissionState: compassPermissionState,
      requiredState,
      grantedState,
      deniedState,
      notRequiredState,
      unavailableState,
    });
  }

  function formatCompassTimestamp(timestampMs) {
    if (!(typeof timestampMs === "number" && Number.isFinite(timestampMs))) {
      return "none";
    }

    return new Date(timestampMs).toISOString().slice(11, 23);
  }

  function formatCompassHeadingValue(heading) {
    if (!(typeof heading === "number" && Number.isFinite(heading))) {
      return "none";
    }

    return `${heading.toFixed(1)}°`;
  }

  function formatDiagnosticsCoordinate(value) {
    if (!(typeof value === "number" && Number.isFinite(value))) {
      return "none";
    }

    return value.toFixed(6);
  }

  function formatDiagnosticsMeters(value) {
    if (!(typeof value === "number" && Number.isFinite(value))) {
      return "none";
    }

    return `${Math.round(value)} m`;
  }

  function getHeadingSourceLabel(source) {
    if (source === "sensor") {
      return "sensor";
    }

    if (source === "gps") {
      return "GPS";
    }

    if (source === "course") {
      return "course";
    }

    if (source === "bearing" || source === "map-bearing") {
      return "map";
    }

    return source || "none";
  }

  function getHeadingState(nowMs = getHeadingNowMs()) {
    return resolveEffectiveHeadingState({
      storedHeading,
      storedHeadingSource,
      storedSpeed,
      sensorHeading,
      sensorHeadingAt,
      nowMs,
      mapBearing: typeof getMapBearing === "function" ? getMapBearing() : null,
      maxSensorAgeMs: headingSensorStaleAfterMs,
    });
  }

  function updateCompassDebugOverlay(nowMs = getHeadingNowMs(), currentHeadingState = null) {
    if (!compassDebugOverlayBody) {
      return;
    }

    const headingState = currentHeadingState || getHeadingState(nowMs);
    const currentLocation = typeof getCurrentLocation === "function" ? getCurrentLocation() : null;
    const currentLocationLabel = currentLocation
      ? `${formatDiagnosticsCoordinate(currentLocation.lat)}, ${formatDiagnosticsCoordinate(currentLocation.lng)}`
      : "none";
    const sensorAgeMs = typeof sensorHeadingAt === "number" && Number.isFinite(sensorHeadingAt)
      ? Math.max(0, Math.round(nowMs - sensorHeadingAt))
      : null;
    const diagnosticsLines = [
      `Build: ${appBuildId}`,
      `URL: ${getWindowLike() ? getWindowLike().location.href : "none"}`,
      `Secure context: ${getWindowLike() ? String(Boolean(getWindowLike().isSecureContext)) : "false"}`,
      `Touch device: ${String(Boolean(isTouchInteractionDevice?.()))}`,
      `Geolocation API: ${typeof navigator !== "undefined" && navigator.geolocation ? "available" : "missing"}`,
      `Following me: ${String(Boolean(getIsFollowingCurrentLocation?.()))}`,
      `Current location: ${currentLocationLabel}`,
      `Accuracy: ${formatDiagnosticsMeters(getCurrentLocationAccuracyMeters?.())}`,
      `Last location error: ${lastLocationErrorMessage || "none"}`,
      `Compass permission: ${getResolvedCompassPermissionState()}`,
      `Compass pending: ${String(isCompassPermissionRequestPending)}`,
      `Last compass error: ${lastCompassPermissionErrorMessage || "none"}`,
      `Heading source: ${getHeadingSourceLabel(headingState.source)}`,
      `Effective heading: ${formatCompassHeadingValue(headingState.effectiveHeading)}`,
      `Stored heading: ${formatCompassHeadingValue(headingState.storedHeading)}`,
      `Sensor heading: ${formatCompassHeadingValue(sensorHeading)}`,
      `Raw sensor heading: ${formatCompassHeadingValue(rawSensorHeading)}`,
      `Sensor kind: ${sensorHeadingKind || "none"}`,
      `Sensor accuracy: ${typeof sensorHeadingAccuracy === "number" && Number.isFinite(sensorHeadingAccuracy) ? `${sensorHeadingAccuracy.toFixed(1)}°` : "none"}`,
      `Sensor age: ${sensorAgeMs === null ? "none" : `${sensorAgeMs} ms`}`,
      `Last sensor event: ${formatCompassTimestamp(sensorEventWallClockMs)}`,
      `Route active: ${String(Boolean(getRouteActive?.()))}`,
      `Field loaded: ${String(Boolean(getDataLoaded?.()))}`,
      `Storage: ${canUseLocalStorage() ? "available" : "unavailable"}`,
    ];

    compassDebugOverlayBody.textContent = diagnosticsLines.join("\n");
  }

  function syncCompassUi(nowMs = getHeadingNowMs()) {
    if (compassPermissionButton) {
      const shouldShowPermissionButton = compassPermissionState === requiredState
        || compassPermissionState === deniedState
        || isCompassPermissionRequestPending;
      compassPermissionButton.hidden = !shouldShowPermissionButton;
      compassPermissionButton.disabled = isCompassPermissionRequestPending;
      compassPermissionButton.textContent = isCompassPermissionRequestPending
        ? "Waiting for Permission"
        : compassPermissionState === deniedState
          ? "Retry Compass"
          : "Enable Compass";
    }

    if (compassDebugToggleButton && compassDebugOverlay) {
      compassDebugOverlay.hidden = !isCompassDebugOverlayVisible;
      compassDebugToggleButton.textContent = isCompassDebugOverlayVisible ? "Hide Diagnostics" : "Show Diagnostics";
      compassDebugToggleButton.setAttribute("aria-pressed", String(isCompassDebugOverlayVisible));
    }

    updateCompassDebugOverlay(nowMs);
  }

  function setCompassPermissionState(nextState, nowMs = getHeadingNowMs()) {
    compassPermissionState = nextState;
    writeStoredCompassPermissionState(nextState);
    syncCompassUi(nowMs);
  }

  function ensureCompassUi() {
    const canRequestCompassPermission = Boolean(getCompassPermissionRequestTarget());
    if (
      !getDocumentLike()
      || compassUiRoot
      || (!runtimeDiagnosticsEnabled && !canRequestCompassPermission)
    ) {
      return;
    }

    const documentLike = getDocumentLike();
    compassUiRoot = documentLike.createElement("div");
    Object.assign(compassUiRoot.style, {
      position: "fixed",
      top: "12px",
      left: "12px",
      zIndex: "12",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-start",
      gap: "8px",
      maxWidth: "min(82vw, 280px)",
      pointerEvents: "none",
    });

    if (canRequestCompassPermission) {
      compassPermissionButton = documentLike.createElement("button");
      compassPermissionButton.type = "button";
      compassPermissionButton.hidden = true;
      Object.assign(compassPermissionButton.style, {
        pointerEvents: "auto",
        border: "0",
        borderRadius: "999px",
        padding: "10px 14px",
        fontSize: "12px",
        fontWeight: "700",
        color: "#08111d",
        background: "rgba(238, 246, 255, 0.92)",
        boxShadow: "0 8px 20px rgba(8, 17, 29, 0.22)",
      });
      compassPermissionButton.addEventListener("click", () => {
        requestCompassPermissionFromUserGesture().catch((error) => {
          console.warn("[DGM] Compass permission request failed:", error);
        });
      });
      compassUiRoot.append(compassPermissionButton);
    }

    if (!runtimeDiagnosticsEnabled) {
      documentLike.body.append(compassUiRoot);
      syncCompassUi();
      return;
    }

    compassDebugToggleButton = documentLike.createElement("button");
    compassDebugToggleButton.type = "button";
    Object.assign(compassDebugToggleButton.style, {
      pointerEvents: "auto",
      border: "0",
      borderRadius: "999px",
      padding: "8px 12px",
      fontSize: "12px",
      fontWeight: "600",
      color: "#eef6ff",
      background: "rgba(8, 17, 29, 0.82)",
      boxShadow: "0 8px 20px rgba(8, 17, 29, 0.22)",
    });
    compassDebugToggleButton.addEventListener("click", () => {
      isCompassDebugOverlayVisible = !isCompassDebugOverlayVisible;
      syncCompassUi();
    });

    compassDebugOverlay = documentLike.createElement("div");
    Object.assign(compassDebugOverlay.style, {
      pointerEvents: "auto",
      minWidth: "220px",
      padding: "10px 12px",
      borderRadius: "14px",
      background: "rgba(8, 17, 29, 0.82)",
      color: "#eef6ff",
      boxShadow: "0 12px 28px rgba(8, 17, 29, 0.28)",
      backdropFilter: "blur(10px)",
    });

    const compassDebugTitle = documentLike.createElement("div");
    compassDebugTitle.textContent = "Runtime Diagnostics";
    Object.assign(compassDebugTitle.style, {
      marginBottom: "6px",
      fontSize: "12px",
      fontWeight: "700",
      letterSpacing: "0.04em",
      textTransform: "uppercase",
    });

    compassDebugOverlayBody = documentLike.createElement("pre");
    Object.assign(compassDebugOverlayBody.style, {
      margin: "0",
      fontSize: "11px",
      lineHeight: "1.5",
      whiteSpace: "pre-wrap",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    });

    compassDebugOverlay.append(compassDebugTitle, compassDebugOverlayBody);
    compassUiRoot.append(compassDebugToggleButton, compassDebugOverlay);
    documentLike.body.append(compassUiRoot);
    syncCompassUi();
  }

  async function requestCompassPermissionFromUserGesture() {
    ensureCompassUi();

    const requestTarget = getCompassPermissionRequestTarget();
    if (!requestTarget) {
      const nextState = getWindowLike()?.DeviceOrientationEvent ? notRequiredState : unavailableState;
      setCompassPermissionState(nextState);
      startDeviceOrientationWatch();
      return nextState;
    }

    if (isCompassPermissionRequestPending) {
      return compassPermissionState;
    }

    isCompassPermissionRequestPending = true;
    lastCompassPermissionErrorMessage = null;
    syncCompassUi();

    try {
      const permissionResult = await Promise.race([
        requestTarget.requestPermission(),
        new Promise((_, reject) => {
          getWindowLike().setTimeout(() => reject(new Error("Compass permission request timed out.")), compassPermissionRequestTimeoutMs);
        }),
      ]);
      if (permissionResult === grantedState) {
        setCompassPermissionState(grantedState);
        startDeviceOrientationWatch();
        syncHeadingConeRenderLoop();
        return grantedState;
      }

      setCompassPermissionState(deniedState);
      return deniedState;
    } catch (error) {
      lastCompassPermissionErrorMessage = error instanceof Error ? error.message : String(error);
      setCompassPermissionState(
        error instanceof Error && error.message === "Compass permission request timed out."
          ? requiredState
          : deniedState
      );
      throw error;
    } finally {
      isCompassPermissionRequestPending = false;
      syncCompassUi();
    }
  }

  function requestCompassPermissionOnFirstGesture() {
    if (hasTriggeredCompassPermissionAutoRequest || isCompassPermissionRequestPending) {
      return;
    }

    if (getResolvedCompassPermissionState() !== requiredState) {
      return;
    }

    hasTriggeredCompassPermissionAutoRequest = true;
    requestCompassPermissionFromUserGesture().catch((error) => {
      console.warn("[DGM] Compass permission request failed:", error);
    });
  }

  function installCompassPermissionAutoRequest() {
    if (!getDocumentLike() || hasInstalledCompassPermissionAutoRequest) {
      return;
    }

    hasInstalledCompassPermissionAutoRequest = true;
    const handleFirstGesture = () => {
      requestCompassPermissionOnFirstGesture();
    };

    getDocumentLike().addEventListener("touchstart", handleFirstGesture, {
      capture: true,
      once: true,
      passive: true,
    });

    if (searchToggleElement) {
      searchToggleElement.addEventListener("pointerdown", handleFirstGesture, {
        capture: true,
        once: true,
      });
    }

    if (locateMeElement) {
      locateMeElement.addEventListener("click", handleFirstGesture, {
        capture: true,
        once: true,
      });
    }

    const map = getMap?.();
    if (map && typeof map.once === "function") {
      map.once("click", handleFirstGesture);
    }
  }

  function getHeadingRenderLoopSmoothingTimeMs(source) {
    if (source === "sensor") {
      return headingSensorSmoothingTimeMs;
    }

    if (source === "gps" || source === "course") {
      return headingRenderLoopGpsSmoothingTimeMs;
    }

    return headingRenderLoopMapBearingSmoothingTimeMs;
  }

  function clearRenderedHeadingConeState() {
    lastHeadingConeLoopHeading = null;
    lastRenderedHeadingConeHeading = null;
    lastRenderedHeadingConeLocation = null;
    lastRenderedHeadingConeSpeed = null;
    lastRenderedHeadingConeZoom = null;
  }

  function clearHeadingConeOutput() {
    clearRenderedHeadingConeState();
    clearHeadingCone();
  }

  function renderHeadingConeOutput(latlng, heading, speed) {
    const resolvedLatLng = lngLatToObject(latlng);
    const resolvedHeading = normalizeHeadingDegrees(heading);
    if (!resolvedLatLng || resolvedHeading === null) {
      clearHeadingConeOutput();
      return false;
    }

    const didRender = renderHeadingCone(resolvedLatLng, resolvedHeading, speed);
    if (!didRender) {
      clearRenderedHeadingConeState();
      return false;
    }

    lastHeadingConeLoopHeading = resolvedHeading;
    lastRenderedHeadingConeHeading = resolvedHeading;
    lastRenderedHeadingConeLocation = { ...resolvedLatLng };
    lastRenderedHeadingConeSpeed = typeof speed === "number" && Number.isFinite(speed)
      ? Math.max(0, speed)
      : 0;
    lastRenderedHeadingConeZoom = typeof getMapZoom === "function" ? getMapZoom() : null;
    return true;
  }

  function shouldRenderHeadingConeFrame(latlng, heading, speed) {
    if (!lastRenderedHeadingConeLocation || lastRenderedHeadingConeHeading === null) {
      return true;
    }

    if (typeof getMapZoom === "function" && getMapZoom() !== lastRenderedHeadingConeZoom) {
      return true;
    }

    const headingDelta = getHeadingDeltaDegrees(heading, lastRenderedHeadingConeHeading);
    if (!Number.isFinite(headingDelta) || headingDelta >= headingRenderLoopMinDeltaDegrees) {
      return true;
    }

    const movedMeters = haversineMeters(
      latlng.lat,
      latlng.lng,
      lastRenderedHeadingConeLocation.lat,
      lastRenderedHeadingConeLocation.lng
    );
    if (movedMeters >= headingRenderLoopMinLocationDeltaMeters) {
      return true;
    }

    const resolvedSpeed = typeof speed === "number" && Number.isFinite(speed)
      ? Math.max(0, speed)
      : 0;
    return Math.abs(resolvedSpeed - (lastRenderedHeadingConeSpeed ?? 0)) >= headingRenderLoopMinSpeedDeltaMps;
  }

  function renderHeadingConeFrame(nowMs = getHeadingNowMs()) {
    const currentLocation = getCurrentLocation?.();
    const headingState = getHeadingState(nowMs);
    updateCompassDebugOverlay(nowMs, headingState);
    const targetHeading = normalizeHeadingDegrees(headingState.effectiveHeading);

    if (!currentLocation || targetHeading === null) {
      clearHeadingConeOutput();
      return null;
    }

    const elapsedMs = lastHeadingConeLoopTickAt === null
      ? getHeadingRenderLoopSmoothingTimeMs(headingState.source)
      : Math.max(0, nowMs - lastHeadingConeLoopTickAt);
    lastHeadingConeLoopTickAt = nowMs;

    const previousHeading = lastHeadingConeLoopHeading ?? lastRenderedHeadingConeHeading ?? targetHeading;
    const nextHeading = headingState.source === "sensor"
      ? filterHeadingDegrees(previousHeading, targetHeading, {
        smoothingFactor: headingFilterSmoothingFactor,
        deadZoneDegrees: headingFilterDeadZoneDegrees,
        minRotationDegrees: headingFilterMinRotationDegrees,
      })
      : interpolateHeadingDegrees(
        previousHeading,
        targetHeading,
        getHeadingBlendFactor(
          elapsedMs,
          getHeadingRenderLoopSmoothingTimeMs(headingState.source),
          headingState.source === "sensor" ? headingSensorSmoothingMinBlend : 0
        )
      );
    const resolvedHeading = normalizeHeadingDegrees(nextHeading);
    if (resolvedHeading === null) {
      clearHeadingConeOutput();
      return null;
    }

    lastHeadingConeLoopHeading = resolvedHeading;
    syncMapBearingToHeading(resolvedHeading);
    if (
      headingState.source === "sensor"
      || shouldRenderHeadingConeFrame(currentLocation, resolvedHeading, headingState.storedSpeed)
    ) {
      renderHeadingConeOutput(currentLocation, resolvedHeading, headingState.storedSpeed);
    }

    return resolvedHeading;
  }

  function updateStoredHeadingSpeed(nextSpeed) {
    if (typeof nextSpeed === "number" && Number.isFinite(nextSpeed)) {
      storedSpeed = Math.max(0, nextSpeed);
    }
    return storedSpeed;
  }

  function applyHeadingUpdate(
    nextHeading,
    {
      latlng = getCurrentLocation?.(),
      speed = storedSpeed,
      nowMs = getHeadingNowMs(),
      timeConstantMs = headingSensorSmoothingTimeMs,
      minBlend = 0,
      source = storedHeadingSource || "stored",
    } = {}
  ) {
    const normalizedHeading = normalizeHeadingDegrees(nextHeading);
    if (normalizedHeading === null) {
      return null;
    }

    const elapsedMs = lastHeadingRenderAt === null
      ? timeConstantMs
      : Math.max(0, nowMs - lastHeadingRenderAt);
    const resolvedHeading = interpolateHeadingDegrees(
      storedHeading,
      normalizedHeading,
      getHeadingBlendFactor(elapsedMs, timeConstantMs, minBlend)
    );

    storedHeading = resolvedHeading;
    storedHeadingSource = source;
    lastHeadingRenderAt = nowMs;
    updateStoredHeadingSpeed(speed);
    if (latlng) {
      renderHeadingConeOutput(latlng, resolvedHeading, storedSpeed);
    }

    return resolvedHeading;
  }

  function getEffectiveHeading(nowMs = getHeadingNowMs()) {
    return getHeadingState(nowMs).effectiveHeading;
  }

  function refreshHeadingConeWithEffectiveHeading(latlng, speed, nowMs = getHeadingNowMs()) {
    const resolvedLatLng = latlng ? lngLatToObject(latlng) : null;
    const effectiveHeading = getEffectiveHeading(nowMs);
    const resolvedSpeed = updateStoredHeadingSpeed(speed);
    if (resolvedLatLng && effectiveHeading !== null) {
      renderHeadingConeOutput(resolvedLatLng, effectiveHeading, resolvedSpeed);
      return effectiveHeading;
    }

    clearHeadingConeOutput();
    return effectiveHeading;
  }

  function refreshHeadingConeFromState(nowMs = getHeadingNowMs()) {
    refreshHeadingConeWithEffectiveHeading(getCurrentLocation?.(), storedSpeed, nowMs);
  }

  function getRuntimeDebugState(nowMs = getHeadingNowMs()) {
    const currentLocation = getCurrentLocation?.();
    return {
      appBuildId,
      currentLocation: currentLocation ? { ...currentLocation } : null,
      currentLocationAccuracyMeters: getCurrentLocationAccuracyMeters?.(),
      compassPermissionState: getResolvedCompassPermissionState(),
      lastSensorEventWallClockMs: sensorEventWallClockMs,
      lastRawSensorHeading: rawSensorHeading,
      lastSensorHeadingAccuracy: sensorHeadingAccuracy,
      lastSensorHeadingKind: sensorHeadingKind,
      heading: getHeadingState(nowMs),
      baseStyle: getBaseStyle?.(),
      routeActive: Boolean(getRouteActive?.()),
      dataLoaded: Boolean(getDataLoaded?.()),
    };
  }

  function installRuntimeDebugSurface({ loadForView, locateUser } = {}) {
    if (!getWindowLike()) {
      return;
    }

    getWindowLike().DGM_RUNTIME = {
      map: getMap?.(),
      getState: () => getRuntimeDebugState(),
      getHeadingState: () => getHeadingState(getHeadingNowMs()),
      refreshHeadingCone: () => {
        refreshHeadingConeFromState();
        return getHeadingState(getHeadingNowMs());
      },
      renderHeadingConeFrame: () => renderHeadingConeFrame(getHeadingNowMs()),
      loadForView,
      locateUser,
      startHeadingConeRenderLoop,
      startDeviceOrientationWatch,
    };
  }

  function syncHeadingFromLocation(
    latlng,
    gpsHeading,
    speed,
    {
      nowMs = getHeadingNowMs(),
      previousLocation = null,
    } = {}
  ) {
    updateStoredHeadingSpeed(speed);

    if (sensorHeading !== null && hasFreshHeadingSensorData(sensorHeadingAt, nowMs, headingSensorStaleAfterMs)) {
      return refreshHeadingConeWithEffectiveHeading(latlng, storedSpeed, nowMs);
    }

    const normalizedGpsHeading = normalizeHeadingDegrees(gpsHeading);
    const derivedCourseHeading = normalizedGpsHeading === null
      ? getLocationCourseHeading(previousLocation, latlng)
      : null;
    const fallbackHeading = normalizedGpsHeading ?? derivedCourseHeading;
    if (fallbackHeading === null) {
      storedHeading = null;
      storedHeadingSource = null;
      return refreshHeadingConeWithEffectiveHeading(latlng, storedSpeed, nowMs);
    }

    return applyHeadingUpdate(fallbackHeading, {
      latlng,
      speed,
      nowMs,
      timeConstantMs: headingGpsFallbackSmoothingTimeMs,
      source: normalizedGpsHeading !== null ? "gps" : "course",
    });
  }

  function stopHeadingConeRenderLoop() {
    const windowLike = getWindowLike();
    if (headingConeRenderLoopFrame !== null && windowLike) {
      windowLike.cancelAnimationFrame(headingConeRenderLoopFrame);
      headingConeRenderLoopFrame = null;
    }

    lastHeadingConeLoopFrameAt = null;
    lastHeadingConeLoopTickAt = null;
  }

  function isHeadingConeRenderLoopActive() {
    const windowLike = getWindowLike();
    if (!windowLike || typeof windowLike.requestAnimationFrame !== "function") {
      return false;
    }

    if (!isHeadingRenderLoopDocumentActive(getDocumentLike())) {
      return false;
    }

    return Boolean(isHeadingConeRenderTargetActive?.());
  }

  function queueHeadingConeRenderLoop() {
    const windowLike = getWindowLike();
    if (headingConeRenderLoopFrame !== null || !isHeadingConeRenderLoopActive() || !windowLike) {
      return;
    }

    headingConeRenderLoopFrame = windowLike.requestAnimationFrame((timestampMs) => {
      headingConeRenderLoopFrame = null;

      if (!isHeadingConeRenderLoopActive()) {
        stopHeadingConeRenderLoop();
        return;
      }

      if (
        lastHeadingConeLoopFrameAt !== null
        && timestampMs - lastHeadingConeLoopFrameAt < headingRenderLoopFrameIntervalMs
      ) {
        queueHeadingConeRenderLoop();
        return;
      }

      lastHeadingConeLoopFrameAt = timestampMs;
      renderHeadingConeFrame(getHeadingNowMs());
      queueHeadingConeRenderLoop();
    });
  }

  function syncHeadingConeRenderLoop() {
    if (!isHeadingConeRenderLoopActive()) {
      stopHeadingConeRenderLoop();
      return;
    }

    if (lastHeadingConeLoopHeading === null) {
      lastHeadingConeLoopHeading = lastRenderedHeadingConeHeading;
    }

    queueHeadingConeRenderLoop();
  }

  function startHeadingConeRenderLoop() {
    const windowLike = getWindowLike();
    if (hasStartedHeadingConeRenderLoop || !windowLike) {
      return;
    }

    hasStartedHeadingConeRenderLoop = true;
    const handleLoopActivityChange = () => {
      if (isHeadingConeRenderLoopActive()) {
        lastHeadingConeLoopFrameAt = null;
        lastHeadingConeLoopTickAt = null;
        syncHeadingConeRenderLoop();
        return;
      }

      stopHeadingConeRenderLoop();
    };

    if (getDocumentLike()) {
      getDocumentLike().addEventListener("visibilitychange", handleLoopActivityChange);
    }

    windowLike.addEventListener("focus", handleLoopActivityChange);
    windowLike.addEventListener("blur", handleLoopActivityChange);
    windowLike.addEventListener("beforeunload", stopHeadingConeRenderLoop, { once: true });
    handleLoopActivityChange();
  }

  function startDeviceOrientationWatch() {
    const windowLike = getWindowLike();
    if (!windowLike) {
      return;
    }

    ensureCompassUi();

    if (!windowLike.DeviceOrientationEvent) {
      setCompassPermissionState(unavailableState);
      return;
    }

    const resolvedPermissionState = getResolvedCompassPermissionState();
    if (
      resolvedPermissionState === requiredState
      || resolvedPermissionState === deniedState
    ) {
      setCompassPermissionState(resolvedPermissionState);
      return;
    }

    if (hasStartedDeviceOrientationWatch) {
      setCompassPermissionState(resolvedPermissionState);
      return;
    }

    hasStartedDeviceOrientationWatch = true;
    const onOrientationChange = (event) => {
      const sensorReading = getDeviceOrientationReading(event, {
        maxWebkitCompassAccuracyDegrees: headingSensorMaxWebkitCompassAccuracyDegrees,
        allowRelativeAlphaFallback: allowRelativeCompassAlphaFallback,
      });

      const nowMs = getHeadingNowMs();
      sensorEventWallClockMs = Date.now();
      rawSensorHeading = normalizeHeadingDegrees(sensorReading.rawHeading);
      sensorHeadingAccuracy = typeof sensorReading.accuracy === "number" && Number.isFinite(sensorReading.accuracy)
        ? sensorReading.accuracy
        : null;
      sensorHeadingKind = sensorReading.source;

      if (sensorReading.heading !== null) {
        sensorHeading = sensorReading.heading;
        sensorHeadingAt = nowMs;
      }

      updateCompassDebugOverlay(nowMs);
    };

    windowLike.addEventListener("deviceorientationabsolute", onOrientationChange, { passive: true });
    windowLike.addEventListener("deviceorientation", onOrientationChange, { passive: true });
    setCompassPermissionState(resolvedPermissionState);
  }

  function notifyLocationError(message) {
    lastLocationErrorMessage = message || null;
    updateCompassDebugOverlay(getHeadingNowMs());
  }

  function clearLocationError() {
    lastLocationErrorMessage = null;
    updateCompassDebugOverlay(getHeadingNowMs());
  }

  return {
    clearLocationError,
    ensureCompassUi,
    getHeadingState,
    getResolvedCompassPermissionState,
    getRuntimeDebugState,
    getStoredHeading: () => storedHeading,
    getStoredSpeed: () => storedSpeed,
    installCompassPermissionAutoRequest,
    installRuntimeDebugSurface,
    notifyLocationError,
    refreshHeadingConeFromState,
    requestCompassPermissionFromUserGesture,
    startDeviceOrientationWatch,
    startHeadingConeRenderLoop,
    syncHeadingConeRenderLoop,
    syncHeadingFromLocation,
  };
}

export {
  createHeadingRuntime,
  getLocationCourseHeading,
  isHeadingRenderLoopDocumentActive,
  resolveCompassPermissionState,
  resolveEffectiveHeadingState,
};
