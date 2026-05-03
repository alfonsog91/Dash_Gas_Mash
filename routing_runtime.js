function createRoutingRuntime({
  mapboxgl,
  getMap,
  getRoutingState,
  setRoutingState,
  getCurrentLocation,
  getHeadingRuntime,
  lngLatToObject,
  normalizeHeadingDegrees,
  getHeadingDeltaDegrees,
  featureCollection,
  setSourceData,
  routeSourceId,
  haversineMeters,
  clamp01,
  closePlaceSheet,
  closeActivePopup,
  hasActiveRoutePopup,
  syncRoutePopup,
  consumeShouldOpenRoutePopupOnNextRender,
  clearRoutePopupState,
  setShouldOpenRoutePopupOnNextRender,
  setCurrentLocationState,
  syncHeadingFromLocation,
  describeGeolocationError,
  getCurrentPosition,
  getNavigationDestinationState,
  resolveNavigationDestinationState,
  getPickupFrictionDetails,
  getCompetitionPressureDetails,
  buildParkingCandidateInsights,
  getParkingCandidateLabel,
  getDirectionLabel,
  formatProbabilityDelta,
  formatProbabilityRange,
  getProbabilityLow,
  getProbabilityHigh,
  getProbabilityMid,
  describeSignal,
  osrmRouteApiUrl,
  navRerouteMinDistanceMeters,
  navRerouteMinIntervalMs,
  arrivalCameraAutoDistanceMeters,
  arrivalCameraExitDistanceMeters,
  navigationCameraArrivalMinZoom,
  navigationCameraArrivalMaxZoom,
  navigationCameraArrivalMinPitch,
  navigationCameraArrivalMaxPitch,
  navigationCameraDriverMinZoom,
  navigationCameraDriverMaxZoom,
  navigationCameraDriverMinPitch,
  navigationCameraDriverMaxPitch,
  navigationCameraUpdateMinIntervalMs,
  navigationCameraMinBearingDeltaDegrees,
  navigationCameraMinPitchDelta,
  navigationCameraMinZoomDelta,
  autoFollowLocationMinCenterOffsetMeters,
  navigationRerouteDeltaMinDurationSeconds,
  navigationRerouteDeltaMinDistanceMeters,
  liveLocationWatchMaximumAgeMs,
  stagingSpotMinDistanceMeters,
  stagingSpotMaxDistanceMeters,
  microCorridorMinDistanceMeters,
  microCorridorMaxDistanceMeters,
  getProgrammaticCameraOptions,
} = {}) {
  function getState() {
    return typeof getRoutingState === "function" ? getRoutingState() : {};
  }

  function patchState(patch) {
    if (!patch || typeof patch !== "object") {
      return;
    }

    setRoutingState?.(patch);
  }

  function getMapBearingHeading() {
    const map = getMap?.();
    if (!map || typeof map.getBearing !== "function") {
      return null;
    }

    return normalizeHeadingDegrees(map.getBearing());
  }

  function stopNavigationSpeech() {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
  }

  function updateNavigationVoiceButton() {
    const { activeRoute } = getState();
    if (hasActiveRoutePopup?.() && activeRoute) {
      syncRoutePopup?.(activeRoute);
    }
  }

  function formatRouteDistance(distanceMeters) {
    const meters = Math.max(0, Number(distanceMeters) || 0);
    if (meters >= 1609.344) {
      return `${(meters / 1609.344).toFixed(meters >= 16093 ? 0 : 1)} mi`;
    }
    return `${Math.round(meters)} m`;
  }

  function formatRouteDuration(durationSeconds) {
    const totalMinutes = Math.max(1, Math.round((Number(durationSeconds) || 0) / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${totalMinutes} min`;
    if (minutes === 0) return `${hours} hr`;
    return `${hours} hr ${minutes} min`;
  }

  function formatCompactRouteDuration(durationSeconds) {
    const seconds = Math.abs(Math.round(Number(durationSeconds) || 0));
    if (seconds < 90) return `${seconds} sec`;
    return formatRouteDuration(seconds);
  }

  function buildRouteBounds(coordinates) {
    if (!coordinates?.length) return null;
    const bounds = new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]);
    for (const coordinate of coordinates) {
      bounds.extend(coordinate);
    }
    return bounds;
  }

  function getCameraOptions(cameraOptions = {}) {
    return typeof getProgrammaticCameraOptions === "function"
      ? getProgrammaticCameraOptions(cameraOptions)
      : cameraOptions;
  }

  function fitRouteToView(route) {
    const map = getMap?.();
    const bounds = buildRouteBounds(route?.geometry?.coordinates);
    if (!map || !bounds) return;

    map.fitBounds(bounds, getCameraOptions({
      padding: { top: 180, right: 32, bottom: 220, left: 32 },
      duration: 850,
      maxZoom: 16,
    }));
  }

  function clearRouteOverlay() {
    setSourceData(routeSourceId, featureCollection());
  }

  function setNavigationStatus(message, tone = "info") {
    const nextMessage = String(message || "").trim();
    patchState({
      lastNavigationStatusMessage: nextMessage,
      lastNavigationStatusTone: nextMessage ? tone : "info",
    });

    const { activeRoute } = getState();
    if (hasActiveRoutePopup?.() && activeRoute) {
      syncRoutePopup?.(activeRoute);
    }
  }

  function formatArrivalClock(durationSeconds) {
    const arrival = new Date(Date.now() + Math.max(0, Number(durationSeconds) || 0) * 1000);
    return arrival.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function getNavigationCameraModeLabel() {
    const { activeRoute, navigationCameraMode } = getState();
    if (!activeRoute) return "Browse";
    if (navigationCameraMode === "driver") return "Driver camera";
    if (navigationCameraMode === "arrival") return "Arrival camera";
    if (navigationCameraMode === "overview") return "Overview";
    if (navigationCameraMode === "free") return "Free pan";
    return "Browse";
  }

  function setNavigationCameraMode(mode, { auto = false } = {}) {
    patchState({
      navigationCameraMode: mode,
      navigationCameraModeAutoArrival: Boolean(auto && mode === "arrival"),
    });

    if (mode !== "arrival") {
      patchState({ navigationCameraModeAutoArrival: false });
    }
  }

  function isNavigationFollowCameraActive() {
    const { activeRoute, navigationCameraMode } = getState();
    return Boolean(activeRoute && (navigationCameraMode === "driver" || navigationCameraMode === "arrival"));
  }

  function getNavigationCameraPitch(mode = getState().navigationCameraMode, speedMetersPerSecond = 0, remainingDistanceMeters = 0) {
    if (mode === "arrival") {
      const imminence = 1 - clamp01((Number(remainingDistanceMeters) || 0) / arrivalCameraExitDistanceMeters);
      return navigationCameraArrivalMinPitch
        + imminence * (navigationCameraArrivalMaxPitch - navigationCameraArrivalMinPitch);
    }

    const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 18);
    return navigationCameraDriverMinPitch
      + normalizedSpeed * (navigationCameraDriverMaxPitch - navigationCameraDriverMinPitch);
  }

  function getNavigationCameraZoom(mode = getState().navigationCameraMode, speedMetersPerSecond = 0, nextStepDistanceMeters = 0, remainingDistanceMeters = 0) {
    if (mode === "arrival") {
      const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 12);
      const imminence = 1 - clamp01((Number(remainingDistanceMeters) || 0) / arrivalCameraExitDistanceMeters);
      const targetZoom = navigationCameraArrivalMinZoom
        + imminence * (navigationCameraArrivalMaxZoom - navigationCameraArrivalMinZoom)
        + (1 - normalizedSpeed) * 0.18;
      return Math.max(navigationCameraArrivalMinZoom, Math.min(navigationCameraArrivalMaxZoom, targetZoom));
    }

    const normalizedSpeed = clamp01((Number(speedMetersPerSecond) || 0) / 18);
    const turnImmediacy = 1 - clamp01((Number(nextStepDistanceMeters) || 0) / 900);
    const targetZoom = navigationCameraDriverMaxZoom - normalizedSpeed * 0.8 + turnImmediacy * 0.35;
    return Math.max(navigationCameraDriverMinZoom, Math.min(navigationCameraDriverMaxZoom, targetZoom));
  }

  function syncNavigationCameraModeForRoute(route) {
    const { navigationCameraMode, navigationCameraModeAutoArrival } = getState();

    if (!route || navigationCameraMode === "overview" || navigationCameraMode === "free" || navigationCameraMode === "browse") {
      return;
    }

    const remainingDistanceMeters = Number(route.distanceMeters) || 0;
    if (navigationCameraMode === "driver" && remainingDistanceMeters <= arrivalCameraAutoDistanceMeters) {
      setNavigationCameraMode("arrival", { auto: true });
      return;
    }

    if (
      navigationCameraMode === "arrival"
      && navigationCameraModeAutoArrival
      && remainingDistanceMeters >= arrivalCameraExitDistanceMeters
    ) {
      setNavigationCameraMode("driver", { auto: true });
    }
  }

  function syncActiveNavigationCamera({
    latlng = getCurrentLocation?.(),
    heading = getHeadingRuntime?.()?.getStoredHeading() ?? null,
    speed = getHeadingRuntime?.()?.getStoredSpeed() ?? null,
    force = false,
    allowBearing = true,
  } = {}) {
    const { activeRoute, navigationCameraMode, lastNavigationCameraSyncAt } = getState();
    const map = getMap?.();

    if (!isNavigationFollowCameraActive() || !map) {
      return;
    }

    const resolvedLatLng = lngLatToObject(latlng) || getRouteCameraAnchor(activeRoute);
    if (!resolvedLatLng) {
      return;
    }

    const normalizedHeading = normalizeHeadingDegrees(heading);
    const primaryStep = getPrimaryRouteStep(activeRoute);
    const remainingDistanceMeters = Number(activeRoute?.distanceMeters) || 0;
    const targetZoom = getNavigationCameraZoom(navigationCameraMode, speed, primaryStep?.distance, remainingDistanceMeters);
    const targetPitch = getNavigationCameraPitch(navigationCameraMode, speed, remainingDistanceMeters);
    const routeBearing = allowBearing ? getRouteCameraBearing(activeRoute, navigationCameraMode) : null;
    const targetBearing = allowBearing && normalizedHeading !== null
      ? normalizedHeading
      : routeBearing ?? getMapBearingHeading() ?? 0;

    const now = Date.now();
    if (!force && now - lastNavigationCameraSyncAt < navigationCameraUpdateMinIntervalMs) {
      return;
    }

    const mapCenter = map.getCenter();
    const centerDelta = haversineMeters(mapCenter.lat, mapCenter.lng, resolvedLatLng.lat, resolvedLatLng.lng);
    const bearingDelta = getHeadingDeltaDegrees(targetBearing, getMapBearingHeading());
    const pitchDelta = Math.abs((Number(map.getPitch()) || 0) - targetPitch);
    const zoomDelta = Math.abs((Number(map.getZoom()) || 0) - targetZoom);

    if (
      !force
      && centerDelta < autoFollowLocationMinCenterOffsetMeters
      && (!Number.isFinite(bearingDelta) || bearingDelta < navigationCameraMinBearingDeltaDegrees)
      && pitchDelta < navigationCameraMinPitchDelta
      && zoomDelta < navigationCameraMinZoomDelta
    ) {
      return;
    }

    patchState({ lastNavigationCameraSyncAt: now });
    map.easeTo(getCameraOptions({
      center: [resolvedLatLng.lng, resolvedLatLng.lat],
      bearing: targetBearing,
      pitch: targetPitch,
      zoom: targetZoom,
      duration: force ? 700 : 320,
      essential: true,
    }));
  }

  function focusActiveNavigationCamera({ force = false, mode = "driver" } = {}) {
    const { activeRoute } = getState();
    if (!activeRoute) {
      return;
    }

    setNavigationCameraMode(mode);
    renderNavigationCard(activeRoute);
    syncActiveNavigationCamera({ force: true, allowBearing: false });
    if (force) {
      setNavigationStatus(mode === "arrival" ? "Arrival camera active." : "Driver camera active.", "info");
    }
  }

  function showActiveRouteArrivalView() {
    const { activeRoute } = getState();
    if (!activeRoute) {
      return;
    }

    focusActiveNavigationCamera({ force: true, mode: "arrival" });
  }

  function showActiveRouteOverview() {
    const { activeRoute } = getState();
    if (!activeRoute) {
      return;
    }

    setNavigationCameraMode("overview");
    fitRouteToView(activeRoute);
    renderNavigationCard(activeRoute);
    setNavigationStatus("Overview active. Tap Drive to resume heading-follow.", "info");
  }

  function resetNavigationCamera() {
    patchState({
      navigationCameraMode: "browse",
      navigationCameraModeAutoArrival: false,
      lastNavigationCameraSyncAt: 0,
    });

    const map = getMap?.();
    if (map) {
      map.easeTo(getCameraOptions({ bearing: 0, pitch: 0, duration: 650, essential: true }));
    }
  }

  function getPrimaryRouteStep(route) {
    if (!route?.steps?.length) return null;
    return route.steps.find((step) => Number(step?.distance) > 15) || route.steps[0] || null;
  }

  function getArrivalRouteStep(route) {
    if (!route?.steps?.length) return null;

    for (let index = route.steps.length - 1; index >= 0; index -= 1) {
      const step = route.steps[index];
      if (String(step?.maneuver?.type || "").toLowerCase() === "arrive") {
        return step;
      }
    }

    return route.steps[route.steps.length - 1] || null;
  }

  function getFinalTurnRouteStep(route) {
    if (!route?.steps?.length) return null;

    for (let index = route.steps.length - 1; index >= 0; index -= 1) {
      const step = route.steps[index];
      if (String(step?.maneuver?.type || "").toLowerCase() !== "arrive") {
        return step;
      }
    }

    return route.steps[0] || null;
  }

  function getRouteApproachSegment(route) {
    const coordinates = route?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    const end = coordinates[coordinates.length - 1];
    for (let index = coordinates.length - 2; index >= 0; index -= 1) {
      const candidate = coordinates[index];
      if (candidate[0] !== end[0] || candidate[1] !== end[1]) {
        return {
          start: { lng: candidate[0], lat: candidate[1] },
          end: { lng: end[0], lat: end[1] },
        };
      }
    }

    return null;
  }

  function getRouteSegmentBearingDegrees(start, end) {
    const startLat = Number(start?.lat);
    const startLng = Number(start?.lng);
    const endLat = Number(end?.lat);
    const endLng = Number(end?.lng);
    if (![startLat, startLng, endLat, endLng].every(Number.isFinite)) {
      return null;
    }

    const startLatRad = startLat * (Math.PI / 180);
    const endLatRad = endLat * (Math.PI / 180);
    const deltaLngRad = (endLng - startLng) * (Math.PI / 180);
    const y = Math.sin(deltaLngRad) * Math.cos(endLatRad);
    const x = Math.cos(startLatRad) * Math.sin(endLatRad)
      - Math.sin(startLatRad) * Math.cos(endLatRad) * Math.cos(deltaLngRad);
    if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) {
      return null;
    }

    return normalizeHeadingDegrees((Math.atan2(y, x) * 180) / Math.PI);
  }

  function getRouteCoordinateBearing(coordinates, { fromEnd = false } = {}) {
    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    if (fromEnd) {
      let previous = coordinates[coordinates.length - 1];
      for (let index = coordinates.length - 2; index >= 0; index -= 1) {
        const current = coordinates[index];
        const bearing = getRouteSegmentBearingDegrees(
          { lng: current?.[0], lat: current?.[1] },
          { lng: previous?.[0], lat: previous?.[1] }
        );
        if (bearing !== null) {
          return bearing;
        }
        previous = current;
      }
      return null;
    }

    let previous = coordinates[0];
    for (let index = 1; index < coordinates.length; index += 1) {
      const current = coordinates[index];
      const bearing = getRouteSegmentBearingDegrees(
        { lng: previous?.[0], lat: previous?.[1] },
        { lng: current?.[0], lat: current?.[1] }
      );
      if (bearing !== null) {
        return bearing;
      }
      previous = current;
    }

    return null;
  }

  function getRouteStepBearingDegrees(step) {
    const bearingAfter = normalizeHeadingDegrees(step?.maneuver?.bearing_after);
    if (bearingAfter !== null) {
      return bearingAfter;
    }

    const bearingBefore = normalizeHeadingDegrees(step?.maneuver?.bearing_before);
    if (bearingBefore !== null) {
      return bearingBefore;
    }

    return getRouteCoordinateBearing(step?.geometry?.coordinates);
  }

  function getRouteCameraBearing(route, mode = getState().navigationCameraMode) {
    const preferredStep = mode === "arrival"
      ? getFinalTurnRouteStep(route) || getArrivalRouteStep(route)
      : getPrimaryRouteStep(route);
    const preferredBearing = getRouteStepBearingDegrees(preferredStep);
    if (preferredBearing !== null) {
      return preferredBearing;
    }

    if (mode === "arrival") {
      const approachSegment = getRouteApproachSegment(route);
      const approachBearing = getRouteSegmentBearingDegrees(approachSegment?.start, approachSegment?.end);
      if (approachBearing !== null) {
        return approachBearing;
      }
    }

    return getRouteCoordinateBearing(route?.geometry?.coordinates, { fromEnd: mode === "arrival" });
  }

  function getRouteCameraAnchor(route, mode = getState().navigationCameraMode) {
    if (mode === "arrival") {
      return lngLatToObject(route?.destination) || lngLatToObject(route?.origin);
    }

    return lngLatToObject(route?.origin) || lngLatToObject(route?.destination);
  }

  function getPlanarVectorMeters(fromLatLng, toLatLng) {
    const fromLat = Number(fromLatLng?.lat ?? 0);
    const fromLng = Number(fromLatLng?.lng ?? 0);
    const toLat = Number(toLatLng?.lat ?? 0);
    const toLng = Number(toLatLng?.lng ?? 0);
    const avgLatRad = (((fromLat + toLat) / 2) * Math.PI) / 180;
    return {
      x: (toLng - fromLng) * 111320 * Math.cos(avgLatRad),
      y: (toLat - fromLat) * 111320,
    };
  }

  function getApproachRelativeSide(approachStart, approachEnd, point) {
    const travel = getPlanarVectorMeters(approachStart, approachEnd);
    const target = getPlanarVectorMeters(approachEnd, point);
    const targetDistance = Math.hypot(target.x, target.y);
    if (targetDistance < 12) {
      return "center";
    }

    const cross = travel.x * target.y - travel.y * target.x;
    const along = travel.x * target.x + travel.y * target.y;
    if (Math.abs(cross) < Math.max(14, targetDistance * 0.18)) {
      return along >= 0 ? "ahead" : "behind";
    }

    return cross > 0 ? "left" : "right";
  }

  function formatRelativeSideLabel(side) {
    if (side === "left") return "to the left";
    if (side === "right") return "to the right";
    if (side === "ahead") return "straight ahead";
    if (side === "behind") return "behind the finish";
    return "near the curb";
  }

  function getArrivalSideFromModifier(modifier) {
    const normalizedModifier = String(modifier || "").toLowerCase().replace(/_/g, " ");
    if (normalizedModifier.includes("left")) return "left";
    if (normalizedModifier.includes("right")) return "right";
    if (normalizedModifier === "straight") return "center";
    return "center";
  }

  function getTurnDeltaDegrees(bearingBefore, bearingAfter) {
    if (!Number.isFinite(bearingBefore) || !Number.isFinite(bearingAfter)) {
      return 0;
    }
    return ((bearingAfter - bearingBefore + 540) % 360) - 180;
  }

  function buildRouteStepInstruction(step) {
    const maneuver = step?.maneuver || {};
    const type = String(maneuver.type || "continue").toLowerCase().replace(/_/g, " ");
    const modifier = String(maneuver.modifier || "").replace(/_/g, " ");
    const road = step?.name ? ` on ${step.name}` : "";

    if (maneuver.instruction) return maneuver.instruction;

    switch (type) {
      case "depart":
        return `Head ${modifier || "out"}${road}`.trim();
      case "arrive":
        return "Arrive at your destination";
      case "turn":
        return `Turn ${modifier}${road}`.trim();
      case "merge":
        return `Merge${road}`.trim();
      case "on ramp":
        return `Take the ${modifier ? `${modifier} ` : ""}on-ramp${road}`.trim();
      case "off ramp":
        return `Take the ${modifier ? `${modifier} ` : ""}exit${road}`.trim();
      case "fork":
        return `Keep ${modifier || "ahead"}${road}`.trim();
      case "roundabout":
      case "rotary":
        return maneuver.exit
          ? `Take exit ${maneuver.exit} at the roundabout${road}`.trim()
          : `Enter the roundabout${road}`.trim();
      case "exit roundabout":
      case "exit rotary":
        return `Exit the roundabout${road}`.trim();
      case "end of road":
        return `At the end of the road, turn ${modifier}${road}`.trim();
      case "new name":
        return step?.name ? `Continue as ${step.name}` : "Continue ahead";
      default:
        return `Continue ${modifier || "ahead"}${road}`.trim();
    }
  }

  function getNavigationTurnComplexity(step) {
    if (!step) {
      return null;
    }

    const maneuver = step.maneuver || {};
    const maneuverType = String(maneuver.type || "continue").toLowerCase().replace(/_/g, " ");
    const angleFactor = clamp01(Math.abs(getTurnDeltaDegrees(maneuver.bearing_before, maneuver.bearing_after)) / 135);
    const intersection = Array.isArray(step.intersections) ? step.intersections[0] || null : null;
    const laneCount = Array.isArray(intersection?.lanes) ? intersection.lanes.length : 0;
    const validEntryCount = Array.isArray(intersection?.entry)
      ? intersection.entry.filter(Boolean).length
      : 0;
    const laneFactor = clamp01(Math.max(0, laneCount - 1) / 4);
    const entryFactor = clamp01(Math.max(0, validEntryCount - 1) / 4);

    let typeFactor = 0.34;
    if (maneuverType === "roundabout" || maneuverType === "rotary" || maneuverType === "exit roundabout" || maneuverType === "exit rotary") {
      typeFactor = 0.84;
    } else if (maneuverType === "fork" || maneuverType === "merge" || maneuverType === "on ramp" || maneuverType === "off ramp") {
      typeFactor = 0.72;
    } else if (maneuverType === "end of road") {
      typeFactor = 0.63;
    } else if (maneuverType === "turn") {
      typeFactor = 0.48;
    }

    const score = clamp01(0.42 * typeFactor + 0.28 * angleFactor + 0.16 * laneFactor + 0.14 * entryFactor);
    let label = "Clean";
    if (score >= 0.76) {
      label = "Complex";
    } else if (score >= 0.56) {
      label = "Busy";
    } else if (score >= 0.34) {
      label = "Moderate";
    }

    const detailParts = [];
    if (laneCount > 0) detailParts.push(`${laneCount} lane${laneCount === 1 ? "" : "s"}`);
    if (validEntryCount > 1) detailParts.push(`${validEntryCount} legal branches`);
    if (!detailParts.length) detailParts.push(buildRouteStepInstruction(step));

    return {
      score,
      label,
      detail: detailParts.join(" · "),
    };
  }

  function buildRouteApproachProfile(route, destinationState, { pickupFriction, stagingCandidate, microCandidate } = {}) {
    const approachSegment = getRouteApproachSegment(route);
    const arrivalStep = getArrivalRouteStep(route);
    const finalTurnStep = getFinalTurnRouteStep(route);
    const finalTurn = getNavigationTurnComplexity(finalTurnStep || arrivalStep);
    const approachDirection = approachSegment
      ? getDirectionLabel(approachSegment.start, approachSegment.end)
      : "unknown";
    const arrivalSide = getArrivalSideFromModifier(arrivalStep?.maneuver?.modifier);
    const drivingSide = String(arrivalStep?.driving_side || finalTurnStep?.driving_side || "right").toLowerCase() === "left"
      ? "left"
      : "right";
    const legalCurbSide = drivingSide;
    const curbParkingCandidate = pickupFriction?.nearestParking?.candidate || null;
    const curbParkingSide = curbParkingCandidate && approachSegment
      ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: curbParkingCandidate.lat, lng: curbParkingCandidate.lon })
      : null;
    const stagingSide = stagingCandidate && approachSegment
      ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: stagingCandidate.candidate.lat, lng: stagingCandidate.candidate.lon })
      : null;
    const microSide = microCandidate && approachSegment
      ? getApproachRelativeSide(approachSegment.start, approachSegment.end, { lat: microCandidate.candidate.lat, lng: microCandidate.candidate.lon })
      : null;

    let curbsideConfidence = arrivalSide === "center" ? 0.46 : 0.64;
    if (arrivalSide === legalCurbSide) {
      curbsideConfidence += 0.14;
    } else if (arrivalSide !== "center") {
      curbsideConfidence -= 0.14;
    }
    if (curbParkingSide && arrivalSide !== "center") {
      curbsideConfidence += curbParkingSide === arrivalSide ? 0.12 : -0.08;
    }
    if (stagingSide && arrivalSide !== "center") {
      curbsideConfidence += stagingSide === arrivalSide ? 0.06 : -0.04;
    }
    if (microSide && arrivalSide !== "center") {
      curbsideConfidence += microSide === arrivalSide ? 0.04 : -0.03;
    }
    if (finalTurn) {
      curbsideConfidence -= clamp01((finalTurn.score - 0.3) / 0.7) * 0.12;
    }
    curbsideConfidence -= (pickupFriction?.score ?? 0) * 0.08;
    curbsideConfidence = clamp01(curbsideConfidence);

    let curbsideLabel = "Curbside uncertain";
    if (arrivalSide === "center") {
      curbsideLabel = curbsideConfidence >= 0.62 ? "Straight-in arrival" : "Curbside uncertain";
    } else if (arrivalSide === legalCurbSide && curbsideConfidence >= 0.72) {
      curbsideLabel = `Likely ${arrivalSide}-side curb`;
    } else if (arrivalSide !== legalCurbSide) {
      curbsideLabel = `${arrivalSide[0].toUpperCase()}${arrivalSide.slice(1)}-side finish`;
    } else {
      curbsideLabel = `${arrivalSide[0].toUpperCase()}${arrivalSide.slice(1)}-side possible`;
    }

    const contextParts = [];
    if (curbParkingCandidate && Number.isFinite(pickupFriction?.nearestParking?.distanceMeters)) {
      contextParts.push(`${pickupFriction.nearestParking.distanceMeters} m visible parking sits ${formatRelativeSideLabel(curbParkingSide)}`);
    }
    if (stagingCandidate) {
      contextParts.push(`best staging sits ${formatRelativeSideLabel(stagingSide)} and ${formatProbabilityDelta(stagingCandidate.probabilityDelta)}`);
    } else if (microCandidate) {
      contextParts.push(`short move support sits ${formatRelativeSideLabel(microSide)}`);
    }

    const curbsideDetail = arrivalSide === "center"
      ? `OSRM does not expose a firm last-segment curbside here, so DGM is leaning on the visible parking field.${contextParts.length ? ` ${contextParts.join(". ")}.` : ""}`
      : `OSRM places the finish on the ${arrivalSide} while legal curb flow is ${legalCurbSide}.${contextParts.length ? ` ${contextParts.join(". ")}.` : ""}`;

    return {
      approachDirection,
      arrivalSide,
      legalCurbSide,
      curbsideConfidence,
      curbsideLabel,
      curbsideDetail,
      finalTurn,
      destinationState,
    };
  }

  function buildNavigationArrivalReadiness({
    route,
    destinationScore,
    pickupFriction,
    stagingCandidate,
    microCandidate,
    approachProfile,
  }) {
    const fieldScore = destinationScore ? clamp01(getProbabilityMid(destinationScore)) : 0.34;
    const pickupEase = pickupFriction ? 1 - clamp01(pickupFriction.score) : 0.4;
    const curbScore = approachProfile ? clamp01(approachProfile.curbsideConfidence) : 0.4;
    const stageScore = stagingCandidate
      ? clamp01(0.52 + stagingCandidate.probabilityDelta * 2.6)
      : microCandidate
        ? clamp01(0.36 + microCandidate.suitability * 0.48)
        : 0.26;
    const overall = clamp01(0.34 * fieldScore + 0.24 * pickupEase + 0.24 * curbScore + 0.18 * stageScore);
    const finalApproach = (Number(route?.distanceMeters) || 0) <= arrivalCameraExitDistanceMeters;

    let headline = "Arrival watch";
    if (overall >= 0.74) {
      headline = "Arrival locked";
    } else if (overall >= 0.56) {
      headline = "Arrival building";
    }

    return {
      overall,
      headline,
      isFinalApproach: finalApproach,
      detail: finalApproach
        ? "Final approach is live. DGM is biasing the HUD toward curbside and staging clarity."
        : `Arrival camera will tighten automatically inside ${formatRouteDistance(arrivalCameraAutoDistanceMeters)}.`,
      items: [
        {
          label: "Field",
          value: destinationScore ? describeSignal(getProbabilityMid(destinationScore)) : "Route only",
          detail: destinationScore
            ? formatProbabilityRange(getProbabilityLow(destinationScore), getProbabilityHigh(destinationScore))
            : "Refresh the field to unlock arrival scoring.",
          score: fieldScore,
        },
        {
          label: "Friction",
          value: pickupFriction?.label || "Route only",
          detail: pickupFriction?.value || "Needs field refresh",
          score: pickupEase,
        },
        {
          label: "Curb",
          value: approachProfile?.curbsideLabel || "Unmapped",
          detail: approachProfile ? `${Math.round(approachProfile.curbsideConfidence * 100)}/100 confidence` : "Needs route finish context",
          score: curbScore,
        },
        {
          label: "Stage",
          value: stagingCandidate
            ? formatProbabilityDelta(stagingCandidate.probabilityDelta)
            : microCandidate
              ? `${Math.round(microCandidate.suitability * 100)}/100`
              : "No edge",
          detail: stagingCandidate
            ? `${stagingCandidate.distanceMeters} m ${stagingCandidate.direction}`
            : microCandidate
              ? `${microCandidate.distanceMeters} m ${microCandidate.direction}`
              : "No visible nearby lift",
          score: stageScore,
        },
      ],
    };
  }

  function getParkingCandidateIdentity(candidate) {
    if (!candidate) {
      return "";
    }

    const lat = Number(candidate.lat);
    const lon = Number(candidate.lon);
    return String(
      candidate.id
        || `${Number.isFinite(lat) ? lat.toFixed(5) : "x"}:${Number.isFinite(lon) ? lon.toFixed(5) : "y"}:${getParkingCandidateLabel(candidate)}`
    );
  }

  function formatRouteDurationDelta(durationSeconds) {
    const delta = Math.round(Number(durationSeconds) || 0);
    if (delta === 0) return "ETA unchanged";
    return `${formatCompactRouteDuration(delta)} ${delta < 0 ? "faster" : "slower"}`;
  }

  function formatRouteDistanceDelta(distanceMeters) {
    const delta = Math.round(Number(distanceMeters) || 0);
    if (delta === 0) return "distance unchanged";
    return `${formatRouteDistance(Math.abs(delta))} ${delta < 0 ? "shorter" : "longer"}`;
  }

  function buildNavigationSnapshot(route) {
    const primaryStep = getPrimaryRouteStep(route);
    const destinationState = getNavigationDestinationState(route);
    const destinationScore = destinationState?.score ?? null;
    const pickupFriction = destinationState ? getPickupFrictionDetails(destinationState) : null;
    const competition = destinationScore ? getCompetitionPressureDetails(destinationScore) : null;
    const stagingCandidate = destinationState
      ? buildParkingCandidateInsights(destinationState, {
        minDistanceMeters: stagingSpotMinDistanceMeters,
        maxDistanceMeters: stagingSpotMaxDistanceMeters,
        limit: 1,
      })[0] || null
      : null;
    const microCandidate = destinationState
      ? buildParkingCandidateInsights(destinationState, {
        minDistanceMeters: microCorridorMinDistanceMeters,
        maxDistanceMeters: microCorridorMaxDistanceMeters,
        limit: 1,
      })[0] || null
      : null;
    const approachProfile = buildRouteApproachProfile(route, destinationState, {
      pickupFriction,
      stagingCandidate,
      microCandidate,
    });
    const arrivalReadiness = buildNavigationArrivalReadiness({
      route,
      destinationScore,
      pickupFriction,
      stagingCandidate,
      microCandidate,
      approachProfile,
    });
    const arrivalSummary = destinationScore
      ? `${arrivalReadiness.headline}. ${approachProfile?.curbsideLabel || "Approach stabilizing"}. ${competition?.detail || ""}`.trim()
      : "Route is active. Load or refresh the current field to unlock DGM arrival intelligence for this destination.";

    return {
      primaryStep,
      destinationState,
      destinationScore,
      pickupFriction,
      competition,
      stagingCandidate,
      microCandidate,
      approachProfile,
      arrivalReadiness,
      arrivalSummary,
    };
  }

  function buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot) {
    if (!previousRoute || !nextRoute || !previousSnapshot || !nextSnapshot) {
      return null;
    }

    const durationDelta = (Number(nextRoute.durationSeconds) || 0) - (Number(previousRoute.durationSeconds) || 0);
    const distanceDelta = (Number(nextRoute.distanceMeters) || 0) - (Number(previousRoute.distanceMeters) || 0);
    const detailParts = [];

    if (Math.abs(durationDelta) >= navigationRerouteDeltaMinDurationSeconds) {
      detailParts.push(formatRouteDurationDelta(durationDelta));
    }
    if (Math.abs(distanceDelta) >= navigationRerouteDeltaMinDistanceMeters) {
      detailParts.push(formatRouteDistanceDelta(distanceDelta));
    }

    const previousCurb = previousSnapshot.approachProfile?.curbsideLabel || "";
    const nextCurb = nextSnapshot.approachProfile?.curbsideLabel || "";
    if (previousCurb && nextCurb && previousCurb !== nextCurb) {
      detailParts.push(`curbside shifts to ${nextCurb.toLowerCase()}`);
    }

    const previousTurn = previousSnapshot.approachProfile?.finalTurn?.label || "";
    const nextTurn = nextSnapshot.approachProfile?.finalTurn?.label || "";
    if (previousTurn && nextTurn && previousTurn !== nextTurn) {
      detailParts.push(`final turn is now ${nextTurn.toLowerCase()}`);
    }

    const previousStagingKey = getParkingCandidateIdentity(previousSnapshot.stagingCandidate?.candidate);
    const nextStagingKey = getParkingCandidateIdentity(nextSnapshot.stagingCandidate?.candidate);
    if (nextStagingKey && previousStagingKey !== nextStagingKey) {
      detailParts.push(`best staging shifts to ${getParkingCandidateLabel(nextSnapshot.stagingCandidate.candidate)}`);
    }

    const previousFrictionLabel = previousSnapshot.pickupFriction?.label || "";
    const nextFrictionLabel = nextSnapshot.pickupFriction?.label || "";
    if (previousFrictionLabel && nextFrictionLabel && previousFrictionLabel !== nextFrictionLabel) {
      detailParts.push(`pickup friction moves to ${nextFrictionLabel.toLowerCase()}`);
    }

    if (!detailParts.length) {
      return null;
    }

    let headline = "Reroute changes arrival setup";
    if (durationDelta <= -navigationRerouteDeltaMinDurationSeconds) {
      headline = "Reroute improves arrival";
    } else if (durationDelta >= navigationRerouteDeltaMinDurationSeconds) {
      headline = "Reroute slows arrival";
    } else if (previousCurb !== nextCurb) {
      headline = "Reroute changes curbside";
    }

    return {
      headline,
      detail: detailParts.join(" · "),
      tone: durationDelta > 0 ? "watch" : "good",
    };
  }

  function speakNavigationInstruction(route, { force = false } = {}) {
    const { navigationVoiceEnabled, lastSpokenInstructionKey } = getState();

    if (!navigationVoiceEnabled || !("speechSynthesis" in window)) return;
    const primaryStep = getPrimaryRouteStep(route);
    if (!primaryStep) return;

    const instruction = buildRouteStepInstruction(primaryStep);
    const distanceText = formatRouteDistance(primaryStep.distance);
    const speechKey = instruction;
    if (!force && speechKey === lastSpokenInstructionKey) {
      return;
    }

    patchState({ lastSpokenInstructionKey: speechKey });
    stopNavigationSpeech();

    const utterance = new SpeechSynthesisUtterance(`${instruction}. In ${distanceText}.`);
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  }

  function setNavigationVoiceEnabled(isEnabled) {
    patchState({ navigationVoiceEnabled: Boolean(isEnabled) });
    updateNavigationVoiceButton();

    const { activeRoute, navigationVoiceEnabled } = getState();
    if (!navigationVoiceEnabled) {
      stopNavigationSpeech();
    } else if (activeRoute) {
      speakNavigationInstruction(activeRoute, { force: true });
    }

    if (hasActiveRoutePopup?.() && activeRoute) {
      syncRoutePopup?.(activeRoute);
    }
  }

  function renderNavigationCard(route) {
    if (!route) return;

    syncNavigationCameraModeForRoute(route);

    const snapshot = route.navigationSnapshot || buildNavigationSnapshot(route);
    route.navigationSnapshot = snapshot;
    route.destinationState = snapshot.destinationState;
    syncRoutePopup?.(route, { forceOpen: consumeShouldOpenRoutePopupOnNextRender?.() });

    const { navigationCameraMode, activeRoute, lastNavigationStatusTone } = getState();
    if (navigationCameraMode === "free" && activeRoute) {
      setNavigationStatus("Driver camera paused. Tap Drive to resume heading-follow.", "info");
    } else if (lastNavigationStatusTone !== "error") {
      setNavigationStatus("", "info");
    }

    updateNavigationVoiceButton();
    speakNavigationInstruction(route);
  }

  async function fetchDrivingRoute(origin, destination, { signal } = {}) {
    const routeUrl = new URL(`${osrmRouteApiUrl}/${origin.lng.toFixed(6)},${origin.lat.toFixed(6)};${destination.lng.toFixed(6)},${destination.lat.toFixed(6)}`);
    routeUrl.searchParams.set("alternatives", "false");
    routeUrl.searchParams.set("overview", "full");
    routeUrl.searchParams.set("steps", "true");
    routeUrl.searchParams.set("geometries", "geojson");

    const response = await fetch(routeUrl, {
      headers: { Accept: "application/json" },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Route request failed (${response.status})`);
    }

    const payload = await response.json();
    const route = payload?.routes?.[0];
    if (!route?.geometry?.coordinates?.length) {
      throw new Error("No drivable route was returned for that destination.");
    }

    return {
      geometry: route.geometry,
      distanceMeters: Number(route.distance) || 0,
      durationSeconds: Number(route.duration) || 0,
      steps: Array.isArray(route.legs)
        ? route.legs.flatMap((leg) => Array.isArray(leg.steps) ? leg.steps : [])
        : [],
    };
  }

  function stopNavigationWatch() {
    const { activeNavigationWatchId } = getState();
    if (activeNavigationWatchId === null) return;
    if (navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(activeNavigationWatchId);
    }
    patchState({ activeNavigationWatchId: null });
  }

  async function refreshActiveRouteFromOrigin(origin, options = {}) {
    const {
      activeRoute,
      lastRouteOriginForRefresh,
      lastRouteRefreshAt,
      activeRouteAbort,
      navigationCameraMode,
    } = getState();

    if (!activeRoute?.destination) return null;

    const now = Date.now();
    const previousRoute = activeRoute;
    const previousSnapshot = previousRoute
      ? (previousRoute.navigationSnapshot || buildNavigationSnapshot(previousRoute))
      : null;
    const shouldThrottle = !options.force;
    const movedEnough = !lastRouteOriginForRefresh
      || haversineMeters(
        lastRouteOriginForRefresh.lat,
        lastRouteOriginForRefresh.lng,
        origin.lat,
        origin.lng
      ) >= navRerouteMinDistanceMeters;

    if (shouldThrottle) {
      if (!movedEnough) return activeRoute;
      if (now - lastRouteRefreshAt < navRerouteMinIntervalMs) return activeRoute;
    }

    patchState({
      lastRouteOriginForRefresh: origin,
      lastRouteRefreshAt: now,
    });
    setNavigationStatus("Updating route…", "info");

    if (activeRouteAbort) {
      activeRouteAbort.abort();
    }

    const nextActiveRouteAbort = new AbortController();
    patchState({ activeRouteAbort: nextActiveRouteAbort });
    const routeResult = await fetchDrivingRoute(origin, activeRoute.destination, { signal: nextActiveRouteAbort.signal });

    const nextRoute = {
      ...routeResult,
      origin,
      destination: activeRoute.destination,
      destinationState: activeRoute.destinationState,
    };
    const nextSnapshot = buildNavigationSnapshot(nextRoute);
    nextRoute.navigationSnapshot = nextSnapshot;
    nextRoute.destinationState = nextSnapshot.destinationState;
    nextRoute.rerouteDelta = buildNavigationRerouteDelta(previousRoute, nextRoute, previousSnapshot, nextSnapshot);

    patchState({ activeRoute: nextRoute });

    setSourceData(routeSourceId, featureCollection([{
      type: "Feature",
      geometry: routeResult.geometry,
      properties: {},
    }]));

    renderNavigationCard(nextRoute);

    if (options.fitToRoute || navigationCameraMode === "overview") {
      fitRouteToView(nextRoute);
    } else if (isNavigationFollowCameraActive()) {
      const headingRuntime = getHeadingRuntime?.();
      syncActiveNavigationCamera({
        latlng: origin,
        heading: headingRuntime?.getStoredHeading(),
        speed: headingRuntime?.getStoredSpeed(),
        force: true,
        allowBearing: false,
      });
    }

    return getState().activeRoute;
  }

  function ensureNavigationWatch() {
    const { activeNavigationWatchId, activeRoute } = getState();
    if (!navigator.geolocation || activeNavigationWatchId !== null || !activeRoute?.destination) return;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const currentLocation = getCurrentLocation?.();
        const previousLocation = currentLocation ? { ...currentLocation } : null;
        const origin = setCurrentLocationState(
          { lat: position.coords.latitude, lng: position.coords.longitude },
          position.coords.accuracy,
          { openPopup: false }
        );
        syncHeadingFromLocation(origin, position.coords.heading, position.coords.speed, { previousLocation });

        refreshActiveRouteFromOrigin(origin, { fitToRoute: false }).catch((error) => {
          if (error?.name === "AbortError") return;
          console.error(error);
          setNavigationStatus(error?.message ?? String(error), "error");
        });
      },
      (error) => {
        setNavigationStatus(describeGeolocationError(error), "error");
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: liveLocationWatchMaximumAgeMs,
      }
    );

    patchState({ activeNavigationWatchId: watchId });
  }

  async function ensureNavigationOrigin() {
    const currentLocation = getCurrentLocation?.();
    if (currentLocation) return currentLocation;
    if (!navigator.geolocation) {
      throw new Error("Enable location to start an in-app route.");
    }

    const position = await getCurrentPosition();
    return setCurrentLocationState(
      { lat: position.coords.latitude, lng: position.coords.longitude },
      position.coords.accuracy,
      { openPopup: false }
    );
  }

  async function startInAppNavigation(destination, options = {}) {
    const resolvedDestination = {
      lat: Number(destination?.lat),
      lng: Number(destination?.lng),
      title: String(destination?.title || "Destination"),
      placeState: destination?.placeState ? { ...destination.placeState } : null,
    };

    if (!Number.isFinite(resolvedDestination.lat) || !Number.isFinite(resolvedDestination.lng)) {
      throw new Error("Destination coordinates are invalid.");
    }

    closePlaceSheet?.();
    closeActivePopup?.();
    setNavigationCameraMode("driver");
    setShouldOpenRoutePopupOnNextRender?.(true);
    setNavigationStatus(getCurrentLocation?.() ? "Calculating route…" : "Locating you…", "info");

    const origin = await ensureNavigationOrigin();
    const { activeRouteAbort } = getState();

    if (activeRouteAbort) {
      activeRouteAbort.abort();
    }

    const nextActiveRouteAbort = new AbortController();
    patchState({ activeRouteAbort: nextActiveRouteAbort });
    const routeResult = await fetchDrivingRoute(origin, resolvedDestination, { signal: nextActiveRouteAbort.signal });

    const nextRoute = {
      ...routeResult,
      origin,
      destination: resolvedDestination,
      destinationState: resolveNavigationDestinationState(resolvedDestination),
      rerouteDelta: null,
    };
    nextRoute.navigationSnapshot = buildNavigationSnapshot(nextRoute);
    nextRoute.destinationState = nextRoute.navigationSnapshot.destinationState;

    patchState({
      activeRoute: nextRoute,
      lastRouteOriginForRefresh: origin,
      lastRouteRefreshAt: Date.now(),
      lastNavigationCameraSyncAt: 0,
    });

    setSourceData(routeSourceId, featureCollection([{
      type: "Feature",
      geometry: routeResult.geometry,
      properties: {},
    }]));

    renderNavigationCard(nextRoute);
    ensureNavigationWatch();

    if (options.fitToRoute === true) {
      fitRouteToView(nextRoute);
      setNavigationCameraMode("overview");
    } else {
      focusActiveNavigationCamera({ force: true });
    }

    return getState().activeRoute;
  }

  function clearInAppNavigation() {
    const { activeRouteAbort } = getState();

    if (activeRouteAbort) {
      activeRouteAbort.abort();
      patchState({ activeRouteAbort: null });
    }

    stopNavigationWatch();
    stopNavigationSpeech();

    patchState({
      activeRoute: null,
      lastRouteOriginForRefresh: null,
      lastRouteRefreshAt: 0,
      lastNavigationCameraSyncAt: 0,
      lastSpokenInstructionKey: "",
    });

    clearRoutePopupState?.();
    clearRouteOverlay();
    setNavigationStatus("", "info");
    resetNavigationCamera();
  }

  return {
    buildNavigationArrivalReadiness,
    buildNavigationRerouteDelta,
    buildNavigationSnapshot,
    buildRouteApproachProfile,
    buildRouteBounds,
    buildRouteStepInstruction,
    clearInAppNavigation,
    clearRouteOverlay,
    ensureNavigationOrigin,
    ensureNavigationWatch,
    fetchDrivingRoute,
    fitRouteToView,
    focusActiveNavigationCamera,
    formatArrivalClock,
    formatCompactRouteDuration,
    formatRelativeSideLabel,
    formatRouteDistance,
    formatRouteDistanceDelta,
    formatRouteDuration,
    formatRouteDurationDelta,
    getApproachRelativeSide,
    getArrivalRouteStep,
    getArrivalSideFromModifier,
    getFinalTurnRouteStep,
    getMapBearingHeading,
    getNavigationCameraModeLabel,
    getNavigationCameraPitch,
    getNavigationCameraZoom,
    getNavigationTurnComplexity,
    getParkingCandidateIdentity,
    getPlanarVectorMeters,
    getPrimaryRouteStep,
    getRouteApproachSegment,
    getRouteCameraAnchor,
    getRouteCameraBearing,
    getRouteCoordinateBearing,
    getRouteSegmentBearingDegrees,
    getRouteStepBearingDegrees,
    getTurnDeltaDegrees,
    isNavigationFollowCameraActive,
    refreshActiveRouteFromOrigin,
    renderNavigationCard,
    resetNavigationCamera,
    setNavigationCameraMode,
    setNavigationStatus,
    setNavigationVoiceEnabled,
    showActiveRouteArrivalView,
    showActiveRouteOverview,
    speakNavigationInstruction,
    startInAppNavigation,
    stopNavigationSpeech,
    stopNavigationWatch,
    syncActiveNavigationCamera,
    syncNavigationCameraModeForRoute,
    updateNavigationVoiceButton,
  };
}

export {
  createRoutingRuntime,
};