function createLocationRuntime({
  initialIsFollowingCurrentLocation = false,
  locateMeElement = null,
  getMap,
  getCurrentLocation,
  getCurrentLocationAccuracyMeters,
  setCurrentLocationData,
  lngLatToObject,
  lngLatToArray,
  featureCollection,
  setSourceData,
  createCirclePolygonFeature,
  currentLocationSourceId,
  currentLocationAccuracySourceId,
  maxVisibleAccuracyRadiusMeters,
  haversineMeters,
  hasActiveRoute,
  syncActiveNavigationCamera,
  openPopupAtLngLat,
  closePanelIfOpen,
  refreshHeadingConeFromState,
  syncHeadingFromLocation,
  clearLocationError,
  notifyLocationError,
  alertUser,
  currentLocationDotLayerId,
  currentLocationHaloLayerId,
  blueDotBaseRadiusPx,
  blueDotBreathingAmplitudePx,
  blueDotBreathingCycleMs,
  blueDotRadiusEpsilonPx,
  blueDotHaloRadiusScale,
  fullCycleRadians,
  continuousWatchTimeoutMs,
  liveLocationWatchMaximumAgeMs,
  initialLocationTimeoutMs,
  initialLocationZoom,
  locationTargetZoom,
  locationAnimationMinStartZoom,
  locationAnimationMaxDistanceMeters,
  locationFlyDurationMs,
  locationPanDurationSeconds,
  locationZoomStep,
  autoFollowLocationMinCenterOffsetMeters,
  autoFollowLocationPanDurationMs,
} = {}) {
  let isLocating = false;
  let hasRequestedInitialLocation = false;
  let hasCenteredInitialCurrentLocation = false;
  let activeContinuousWatchId = null;
  let hasStartedBlueDotBreathingAnimation = false;
  let blueDotBreathingAnimationFrame = null;
  let lastBlueDotBreathingRadius = null;
  let isFollowingCurrentLocation = Boolean(initialIsFollowingCurrentLocation);

  function getWindowLike() {
    return typeof window !== "undefined" ? window : null;
  }

  function getNavigatorLike() {
    return typeof navigator !== "undefined" ? navigator : null;
  }

  function setLocateButtonState(isLoading) {
    isLocating = Boolean(isLoading);
    if (!locateMeElement) {
      return;
    }

    locateMeElement.disabled = isLocating;
    locateMeElement.setAttribute("aria-busy", String(isLocating));
    locateMeElement.setAttribute(
      "aria-label",
      isLocating ? "Recentering on your current location" : "Recenter and follow my location"
    );
    locateMeElement.title = isLocating
      ? "Recentering on your current location"
      : "Recenter and follow my location";
  }

  function setCurrentLocationFollowEnabled(isEnabled) {
    isFollowingCurrentLocation = Boolean(isEnabled);
  }

  function getIsFollowingCurrentLocation() {
    return isFollowingCurrentLocation;
  }

  function syncMapToCurrentLocation(latlng, { force = false } = {}) {
    if (hasActiveRoute?.()) {
      syncActiveNavigationCamera?.({ latlng, force, allowBearing: false });
      return;
    }

    const map = getMap?.();
    if (!isFollowingCurrentLocation || !latlng || !map) {
      return;
    }

    const resolvedLatLng = lngLatToObject(latlng);
    const mapCenter = map.getCenter();
    const centerOffsetMeters = haversineMeters(
      mapCenter.lat,
      mapCenter.lng,
      resolvedLatLng.lat,
      resolvedLatLng.lng
    );

    if (!force && centerOffsetMeters < autoFollowLocationMinCenterOffsetMeters) {
      return;
    }

    map.easeTo({
      center: [resolvedLatLng.lng, resolvedLatLng.lat],
      duration: force ? locationFlyDurationMs : autoFollowLocationPanDurationMs,
    });
  }

  function setCurrentLocationState(latlng, accuracyMeters, { openPopup = true } = {}) {
    const currentLngLat = lngLatToObject(latlng);
    const accuracyRadius = Math.max(Number(accuracyMeters) || 0, 12);

    setCurrentLocationData?.(currentLngLat, accuracyRadius);
    clearLocationError?.();

    if (accuracyRadius <= maxVisibleAccuracyRadiusMeters) {
      const accuracyFeature = createCirclePolygonFeature(currentLngLat, accuracyRadius);
      accuracyFeature.properties = { accuracyMeters: accuracyRadius };
      setSourceData(currentLocationAccuracySourceId, featureCollection([accuracyFeature]));
    } else {
      setSourceData(currentLocationAccuracySourceId, featureCollection());
    }

    setSourceData(currentLocationSourceId, featureCollection([{
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [currentLngLat.lng, currentLngLat.lat],
      },
      properties: { accuracyMeters: accuracyRadius },
    }]));

    refreshHeadingConeFromState?.();
    syncMapToCurrentLocation(currentLngLat, { force: !hasCenteredInitialCurrentLocation });
    hasCenteredInitialCurrentLocation = true;

    if (openPopup) {
      openPopupAtLngLat?.(currentLngLat, `You are here<br/><span class="mono">Accuracy ±${Math.round(accuracyRadius)} m</span>`);
    }

    return currentLngLat;
  }

  function describeGeolocationError(error) {
    if (!error) return "Unable to determine your location.";
    if (error.code === error.PERMISSION_DENIED) return "Location access was denied. Enable location permission and try again.";
    if (error.code === error.POSITION_UNAVAILABLE) return "Your current position is unavailable right now. Try again in a moment.";
    if (error.code === error.TIMEOUT) return "Location lookup timed out. Try again with a stronger signal.";
    return error.message || "Unable to determine your location.";
  }

  function shouldAnimateLocate(latlng) {
    const map = getMap?.();
    return map.getZoom() >= locationAnimationMinStartZoom
      && haversineMeters(map.getCenter().lat, map.getCenter().lng, latlng.lat, latlng.lng) <= locationAnimationMaxDistanceMeters;
  }

  function animateZoomToTarget(targetZoom, onComplete) {
    const map = getMap?.();
    const currentZoom = map.getZoom();

    if (currentZoom >= targetZoom) {
      onComplete();
      return;
    }

    const nextZoom = Math.min(targetZoom, currentZoom + locationZoomStep);
    map.once("zoomend", () => {
      animateZoomToTarget(targetZoom, onComplete);
    });

    map.easeTo({ zoom: nextZoom, duration: 400 });
  }

  function getCurrentPosition(options = {}) {
    return new Promise((resolve, reject) => {
      const navigatorLike = getNavigatorLike();
      if (!navigatorLike?.geolocation) {
        reject(new Error("Geolocation is not supported in this browser."));
        return;
      }

      navigatorLike.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 0,
        ...options,
      });
    });
  }

  function clampMapZoom(zoom) {
    const map = getMap?.();
    const minZoom = Number.isFinite(map.getMinZoom()) ? map.getMinZoom() : 0;
    const maxZoom = Number.isFinite(map.getMaxZoom()) ? map.getMaxZoom() : zoom;
    return Math.max(minZoom, Math.min(maxZoom, zoom));
  }

  async function centerMapOnInitialLocationOnce() {
    if (hasRequestedInitialLocation) return;

    if (!getNavigatorLike()?.geolocation) return;

    hasRequestedInitialLocation = true;

    try {
      const position = await getCurrentPosition({
        enableHighAccuracy: true,
        timeout: Math.max(initialLocationTimeoutMs, continuousWatchTimeoutMs),
        maximumAge: 0,
      });

      const latlng = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
      setCurrentLocationFollowEnabled(true);
      setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
      syncHeadingFromLocation?.(latlng, position.coords.heading, position.coords.speed, {
        previousLocation: null,
      });

      getMap?.().jumpTo({
        center: [latlng.lng, latlng.lat],
        zoom: clampMapZoom(initialLocationZoom),
      });
    } catch (error) {
      notifyLocationError?.(error instanceof Error ? error.message : describeGeolocationError(error));
      hasRequestedInitialLocation = false;
      console.info("Initial geolocation unavailable.", error);
    }
  }

  async function locateUser() {
    if (isLocating) return;

    const currentLocation = getCurrentLocation?.();
    const map = getMap?.();

    if (currentLocation) {
      setCurrentLocationFollowEnabled(true);
      closePanelIfOpen?.();
      const latlng = { lat: currentLocation.lat, lng: currentLocation.lng };
      const targetZoom = clampMapZoom(locationTargetZoom);
      const animateLocate = shouldAnimateLocate(latlng);
      if (animateLocate) {
        map.flyTo({ center: [latlng.lng, latlng.lat], zoom: targetZoom, duration: locationFlyDurationMs });
      } else {
        map.once("moveend", () => {
          animateZoomToTarget(targetZoom, () => {});
        });
        map.easeTo({ center: [latlng.lng, latlng.lat], duration: locationPanDurationSeconds * 1000 });
      }
      return;
    }

    if (!getNavigatorLike()?.geolocation) {
      alertUser?.("Geolocation is not supported in this browser.");
      return;
    }

    setLocateButtonState(true);

    try {
      const position = await getCurrentPosition();
      const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
      const previousLocation = getCurrentLocation?.() ? { ...getCurrentLocation() } : null;
      setCurrentLocationFollowEnabled(true);

      const animateLocate = shouldAnimateLocate(latlng);
      const targetZoom = clampMapZoom(locationTargetZoom);

      closePanelIfOpen?.();
      setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
      syncHeadingFromLocation?.(latlng, position.coords.heading, position.coords.speed, { previousLocation });

      if (animateLocate) {
        map.flyTo({ center: lngLatToArray(latlng), zoom: targetZoom, duration: locationFlyDurationMs });
      } else {
        map.once("moveend", () => {
          animateZoomToTarget(targetZoom, () => {});
        });
        map.easeTo({ center: lngLatToArray(latlng), duration: locationPanDurationSeconds * 1000 });
      }
    } catch (error) {
      notifyLocationError?.(describeGeolocationError(error));
      alertUser?.(describeGeolocationError(error));
    } finally {
      setLocateButtonState(false);
    }
  }

  function getBlueDotBreathingRadius(timestampMs = 0) {
    const phase = (timestampMs % blueDotBreathingCycleMs) / blueDotBreathingCycleMs;
    const pulse = 0.5 - 0.5 * Math.cos(phase * fullCycleRadians);
    return blueDotBaseRadiusPx + blueDotBreathingAmplitudePx * pulse;
  }

  function getBlueDotHaloRadius(baseRadius) {
    return baseRadius * blueDotHaloRadiusScale;
  }

  function stopBlueDotBreathingAnimation() {
    const windowLike = getWindowLike();
    if (blueDotBreathingAnimationFrame !== null && windowLike) {
      windowLike.cancelAnimationFrame(blueDotBreathingAnimationFrame);
      blueDotBreathingAnimationFrame = null;
    }
  }

  function startBlueDotBreathingAnimation() {
    const windowLike = getWindowLike();
    if (hasStartedBlueDotBreathingAnimation || !windowLike) return;

    hasStartedBlueDotBreathingAnimation = true;
    const tick = (timestampMs) => {
      const map = getMap?.();
      const nextRadius = getBlueDotBreathingRadius(timestampMs);
      if (
        map.getLayer(currentLocationDotLayerId)
        && (
          lastBlueDotBreathingRadius === null
          || Math.abs(nextRadius - lastBlueDotBreathingRadius) >= blueDotRadiusEpsilonPx
        )
      ) {
        lastBlueDotBreathingRadius = nextRadius;
        if (map.getLayer(currentLocationHaloLayerId)) {
          map.setPaintProperty(
            currentLocationHaloLayerId,
            "circle-radius",
            getBlueDotHaloRadius(nextRadius)
          );
        }
        map.setPaintProperty(currentLocationDotLayerId, "circle-radius", nextRadius);
      }
      blueDotBreathingAnimationFrame = windowLike.requestAnimationFrame(tick);
    };

    blueDotBreathingAnimationFrame = windowLike.requestAnimationFrame(tick);
    windowLike.addEventListener("beforeunload", stopBlueDotBreathingAnimation, { once: true });
  }

  function startContinuousLocationWatch() {
    const navigatorLike = getNavigatorLike();
    if (activeContinuousWatchId !== null || !navigatorLike?.geolocation) return;

    activeContinuousWatchId = navigatorLike.geolocation.watchPosition(
      (position) => {
        const previousLocation = getCurrentLocation?.() ? { ...getCurrentLocation() } : null;
        const latlng = { lat: position.coords.latitude, lng: position.coords.longitude };
        setCurrentLocationState(latlng, position.coords.accuracy, { openPopup: false });
        syncHeadingFromLocation?.(latlng, position.coords.heading, position.coords.speed, { previousLocation });
      },
      (error) => {
        notifyLocationError?.(describeGeolocationError(error));
        console.warn("[DGM] Continuous location watch error:", error.code, error.message);
      },
      {
        enableHighAccuracy: true,
        timeout: continuousWatchTimeoutMs,
        maximumAge: liveLocationWatchMaximumAgeMs,
      }
    );
  }

  return {
    centerMapOnInitialLocationOnce,
    describeGeolocationError,
    getCurrentPosition,
    getIsFollowingCurrentLocation,
    locateUser,
    setCurrentLocationFollowEnabled,
    setCurrentLocationState,
    showCurrentLocation(latlng, accuracyMeters) {
      return setCurrentLocationState(latlng, accuracyMeters, { openPopup: true });
    },
    startBlueDotBreathingAnimation,
    startContinuousLocationWatch,
    syncMapToCurrentLocation,
  };
}

export {
  createLocationRuntime,
};