function createMapInteractionRuntime({
  maplibregl,
  getMap,
  getElMain,
  getPanel,
  getMenuButton,
  lngLatToArray,
  getActiveRoute,
  getLastCurrentLocation,
  getLastCurrentLocationAccuracyMeters,
  getNavigationVoiceEnabled,
  restaurantById,
  parkingById,
  renderRestaurantPopupHtml,
  renderParkingPopupHtml,
  renderRoutePopupHtml,
  renderPlaceSheetHtml,
  buildRestaurantSheetState,
  buildSpotSheetState,
  buildPlaceSheetComparable,
  touchPlaceHistoryEntry,
  fetchDrivingRoute,
  startInAppNavigation,
  setNavigationStatus,
  setNavigationVoiceEnabled,
  clearInAppNavigation,
  showActiveRouteOverview,
  showActiveRouteArrivalView,
  focusActiveNavigationCamera,
  openStatsPopupAtLatLng,
  setNavigationCameraMode,
  setCurrentLocationFollowEnabled,
  setSpotMarker,
  escapeHtml,
  isTouchInteractionDevice,
  mapTouchTapPopupDelayMs,
  mapTouchGestureSuppressionMs,
  resizeDelayMs = 250,
  layerRestaurantId,
  layerParkingId,
  layerCurrentLocationHaloId,
  layerCurrentLocationDotId,
} = {}) {
  let activePopup = null;
  let hasBoundLayerEvents = false;
  let isRoutePopupVisible = false;
  let shouldOpenRoutePopupOnNextRender = false;
  let pendingMapTapPopupTimer = null;
  let lastMapTouchStartAt = 0;
  let suppressMapTapPopupUntil = 0;
  let placeSheetRoot = null;
  let placeSheetBody = null;
  let activePlaceSheetState = null;
  let placeSheetCompareBaseline = null;
  let activePlaceSheetRouteAbort = null;
  let comparePlaceSheetRouteAbort = null;

  function getWindowLike() {
    return typeof window !== "undefined" ? window : null;
  }

  function getDocumentLike() {
    return typeof document !== "undefined" ? document : null;
  }

  function closeActivePopup() {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
  }

  function hasActiveRoutePopup() {
    return Boolean(activePopup?.__dgmPopupType === "route");
  }

  function openPopupAtLngLat(lngLat, html, popupOptions = {}) {
    const map = getMap?.();
    if (!map) {
      return null;
    }

    closePlaceSheet();
    closeActivePopup();

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: "dgm-popup",
      maxWidth: "360px",
      offset: 12,
      ...popupOptions,
    })
      .setLngLat(lngLatToArray(lngLat))
      .setHTML(html)
      .addTo(map);

    const popupElement = popup.getElement();
    const popupActionHandler = (event) => {
      const routeModeButton = event.target.closest("[data-route-camera-mode]");
      if (routeModeButton && popupElement.contains(routeModeButton)) {
        event.preventDefault();
        if (!getActiveRoute?.()) {
          return;
        }

        const nextMode = String(routeModeButton.dataset.routeCameraMode || "driver");
        if (nextMode === "overview") {
          showActiveRouteOverview?.();
        } else if (nextMode === "arrival") {
          showActiveRouteArrivalView?.();
        } else {
          focusActiveNavigationCamera?.({ force: true, mode: "driver" });
        }
        return;
      }

      const routeVoiceToggle = event.target.closest("[data-route-voice-toggle]");
      if (routeVoiceToggle && popupElement.contains(routeVoiceToggle)) {
        event.preventDefault();
        setNavigationVoiceEnabled?.(!getNavigationVoiceEnabled?.());
        if (getActiveRoute?.()) {
          syncRoutePopup(getActiveRoute(), { forceOpen: isRoutePopupVisible });
        }
        return;
      }

      const routeClearButton = event.target.closest("[data-route-clear]");
      if (routeClearButton && popupElement.contains(routeClearButton)) {
        event.preventDefault();
        clearInAppNavigation?.();
        return;
      }

      const restaurantButton = event.target.closest("[data-place-sheet-restaurant-id]");
      if (restaurantButton && popupElement.contains(restaurantButton)) {
        event.preventDefault();
        const restaurant = restaurantById?.get(restaurantButton.dataset.placeSheetRestaurantId);
        if (restaurant) {
          openPopupAtLngLat(
            { lat: restaurant.lat, lng: restaurant.lon },
            renderRestaurantPopupHtml?.(restaurant),
            { closeButton: true }
          );
        }
        return;
      }

      const routeButton = event.target.closest("[data-route-lat][data-route-lng]");
      if (!routeButton || !popupElement.contains(routeButton)) {
        return;
      }

      event.preventDefault();

      startInAppNavigation?.({
        lat: Number(routeButton.dataset.routeLat),
        lng: Number(routeButton.dataset.routeLng),
        title: routeButton.dataset.routeTitle || "Destination",
      }).catch((error) => {
        console.error(error);
        setNavigationStatus?.(error?.message ?? String(error), "error");
        openPopupAtLngLat(
          {
            lat: Number(routeButton.dataset.routeLat),
            lng: Number(routeButton.dataset.routeLng),
          },
          `<div class="popup-sheet popup-friendly"><div class="popup-header"><div class="popup-kicker">Route</div><div class="popup-title">Could not start route</div><div class="popup-subtitle">${escapeHtml(error?.message ?? String(error))}</div></div></div>`,
          { closeButton: true }
        );
      });
    };

    popupElement.addEventListener("click", popupActionHandler);

    popup.on("close", () => {
      popupElement.removeEventListener("click", popupActionHandler);
      if (popup.__dgmPopupType === "route") {
        isRoutePopupVisible = false;
        shouldOpenRoutePopupOnNextRender = false;
      }
      if (activePopup === popup) {
        activePopup = null;
      }
    });

    activePopup = popup;
    return activePopup;
  }

  function abortActivePlaceSheetRouteSummary() {
    if (activePlaceSheetRouteAbort) {
      activePlaceSheetRouteAbort.abort();
      activePlaceSheetRouteAbort = null;
    }
  }

  function abortComparePlaceSheetRouteSummary() {
    if (comparePlaceSheetRouteAbort) {
      comparePlaceSheetRouteAbort.abort();
      comparePlaceSheetRouteAbort = null;
    }
  }

  function renderActivePlaceSheet() {
    if (!placeSheetBody || !activePlaceSheetState) {
      return;
    }

    placeSheetBody.innerHTML = renderPlaceSheetHtml?.(activePlaceSheetState, placeSheetCompareBaseline) || "";
  }

  function updatePlaceSheetRouteSummary(stateKey, patch) {
    let didUpdate = false;

    if (activePlaceSheetState?.key === stateKey) {
      activePlaceSheetState = { ...activePlaceSheetState, ...patch };
      didUpdate = true;
    }

    if (placeSheetCompareBaseline?.key === stateKey) {
      placeSheetCompareBaseline = { ...placeSheetCompareBaseline, ...patch };
      didUpdate = true;
    }

    if (didUpdate) {
      renderActivePlaceSheet();
    }
  }

  function queueActivePlaceSheetRouteSummary() {
    abortActivePlaceSheetRouteSummary();

    if (!activePlaceSheetState || !getLastCurrentLocation?.()) {
      return;
    }

    const controller = new AbortController();
    const stateKey = activePlaceSheetState.key;
    const destination = { lat: activePlaceSheetState.lat, lng: activePlaceSheetState.lng };
    activePlaceSheetRouteAbort = controller;

    fetchDrivingRoute?.(getLastCurrentLocation(), destination, { signal: controller.signal })
      .then((route) => {
        if (activePlaceSheetRouteAbort === controller) {
          activePlaceSheetRouteAbort = null;
        }

        updatePlaceSheetRouteSummary(stateKey, {
          routeStatus: "ready",
          routeError: "",
          routeSummary: {
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
          },
        });
      })
      .catch((error) => {
        if (activePlaceSheetRouteAbort === controller) {
          activePlaceSheetRouteAbort = null;
        }

        if (error?.name === "AbortError") {
          return;
        }

        updatePlaceSheetRouteSummary(stateKey, {
          routeStatus: "error",
          routeError: error?.message ?? String(error),
          routeSummary: null,
        });
      });
  }

  function queueComparePlaceSheetRouteSummary() {
    abortComparePlaceSheetRouteSummary();

    if (!placeSheetCompareBaseline || !getLastCurrentLocation?.()) {
      return;
    }

    const controller = new AbortController();
    const stateKey = placeSheetCompareBaseline.key;
    const destination = { lat: placeSheetCompareBaseline.lat, lng: placeSheetCompareBaseline.lng };
    comparePlaceSheetRouteAbort = controller;

    fetchDrivingRoute?.(getLastCurrentLocation(), destination, { signal: controller.signal })
      .then((route) => {
        if (comparePlaceSheetRouteAbort === controller) {
          comparePlaceSheetRouteAbort = null;
        }

        updatePlaceSheetRouteSummary(stateKey, {
          routeStatus: "ready",
          routeError: "",
          routeSummary: {
            distanceMeters: route.distanceMeters,
            durationSeconds: route.durationSeconds,
          },
        });
      })
      .catch((error) => {
        if (comparePlaceSheetRouteAbort === controller) {
          comparePlaceSheetRouteAbort = null;
        }

        if (error?.name === "AbortError") {
          return;
        }

        updatePlaceSheetRouteSummary(stateKey, {
          routeStatus: "error",
          routeError: error?.message ?? String(error),
          routeSummary: null,
        });
      });
  }

  function ensurePlaceSheet() {
    const documentLike = getDocumentLike();
    const elMain = getElMain?.();
    if (!documentLike || placeSheetRoot || !elMain) {
      return;
    }

    placeSheetRoot = documentLike.createElement("section");
    placeSheetRoot.className = "place-sheet-host";
    placeSheetRoot.hidden = true;
    placeSheetRoot.innerHTML = `
    <div class="place-sheet-panel" role="dialog" aria-modal="false" aria-labelledby="placeSheetTitle">
      <div class="place-sheet-body"></div>
    </div>`;

    placeSheetBody = placeSheetRoot.querySelector(".place-sheet-body");
    placeSheetRoot.addEventListener("click", (event) => {
      const closeButton = event.target.closest("[data-place-sheet-close]");
      if (closeButton) {
        event.preventDefault();
        closePlaceSheet();
        return;
      }

      const routeButton = event.target.closest("[data-route-lat][data-route-lng]");
      if (routeButton && placeSheetRoot.contains(routeButton)) {
        event.preventDefault();
        if (activePlaceSheetState) {
          const nextHistory = touchPlaceHistoryEntry?.(activePlaceSheetState, { incrementOpen: false, incrementRoute: true });
          if (nextHistory) {
            activePlaceSheetState = { ...activePlaceSheetState, history: nextHistory };
            if (placeSheetCompareBaseline?.key === activePlaceSheetState.key) {
              placeSheetCompareBaseline = { ...placeSheetCompareBaseline, history: nextHistory };
            }
            renderActivePlaceSheet();
          }
        }
        startInAppNavigation?.({
          lat: Number(routeButton.dataset.routeLat),
          lng: Number(routeButton.dataset.routeLng),
          title: routeButton.dataset.routeTitle || "Destination",
          placeState: activePlaceSheetState ? { ...activePlaceSheetState } : null,
        }).catch((error) => {
          console.error(error);
          setNavigationStatus?.(error?.message ?? String(error), "error");
        });
        return;
      }

      const sectionButton = event.target.closest("[data-place-sheet-scroll]");
      if (sectionButton && placeSheetRoot.contains(sectionButton)) {
        event.preventDefault();
        const sectionId = sectionButton.dataset.placeSheetScroll;
        const section = placeSheetRoot.querySelector(`#${sectionId}`);
        if (section && typeof section.scrollIntoView === "function") {
          section.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }

      const compareButton = event.target.closest("[data-place-sheet-compare]");
      if (compareButton && placeSheetRoot.contains(compareButton)) {
        event.preventDefault();
        const action = compareButton.dataset.placeSheetCompare;
        if (action === "clear") {
          abortComparePlaceSheetRouteSummary();
          placeSheetCompareBaseline = null;
        } else if (activePlaceSheetState) {
          placeSheetCompareBaseline = buildPlaceSheetComparable?.(activePlaceSheetState);
          if (getLastCurrentLocation?.() && placeSheetCompareBaseline.routeStatus !== "ready") {
            placeSheetCompareBaseline = { ...placeSheetCompareBaseline, routeStatus: "loading", routeError: "" };
            queueComparePlaceSheetRouteSummary();
          }
        }
        renderActivePlaceSheet();
        return;
      }

      const restaurantButton = event.target.closest("[data-place-sheet-restaurant-id]");
      if (restaurantButton && placeSheetRoot.contains(restaurantButton)) {
        event.preventDefault();
        const restaurant = restaurantById?.get(restaurantButton.dataset.placeSheetRestaurantId);
        if (restaurant) {
          openRestaurantSheet(restaurant);
        }
      }
    });

    documentLike.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && activePlaceSheetState) {
        closePlaceSheet();
      }
    });

    elMain.append(placeSheetRoot);
  }

  function openPlaceSheet(state) {
    ensurePlaceSheet();
    if (!placeSheetRoot || !placeSheetBody) {
      return;
    }

    closeActivePopup();
    const history = touchPlaceHistoryEntry?.(state);
    activePlaceSheetState = {
      ...state,
      history,
      routeSummary: state.routeSummary ?? null,
      routeStatus: state.routeSummary
        ? "ready"
        : getLastCurrentLocation?.()
          ? "loading"
          : "unavailable",
      routeError: "",
    };
    placeSheetRoot.hidden = false;
    placeSheetRoot.classList.add("is-open");
    renderActivePlaceSheet();
    placeSheetBody.scrollTop = 0;
    if (activePlaceSheetState.routeStatus === "loading") {
      queueActivePlaceSheetRouteSummary();
    }
  }

  function closePlaceSheet() {
    abortActivePlaceSheetRouteSummary();
    activePlaceSheetState = null;
    if (!placeSheetRoot || !placeSheetBody) {
      return;
    }

    placeSheetRoot.classList.remove("is-open");
    placeSheetRoot.hidden = true;
    placeSheetBody.innerHTML = "";
  }

  function openRestaurantSheet(restaurant) {
    if (!restaurant) {
      return;
    }

    openPlaceSheet(buildRestaurantSheetState?.(restaurant));
  }

  function openSpotSheet(latlng) {
    if (!latlng) {
      return;
    }

    setSpotMarker?.(latlng);
    openPlaceSheet(buildSpotSheetState?.(latlng));
  }

  function syncRoutePopup(route, { forceOpen = false } = {}) {
    if (!route?.destination) {
      return;
    }

    const popupHtml = renderRoutePopupHtml?.(route);
    if (hasActiveRoutePopup()) {
      activePopup
        .setLngLat(lngLatToArray(route.destination))
        .setHTML(popupHtml);
      isRoutePopupVisible = true;
      return;
    }

    if (!forceOpen) {
      return;
    }

    const popup = openPopupAtLngLat(route.destination, popupHtml, { closeButton: true });
    popup.__dgmPopupType = "route";
    isRoutePopupVisible = true;
  }

  function consumeShouldOpenRoutePopupOnNextRender() {
    const shouldOpen = shouldOpenRoutePopupOnNextRender;
    shouldOpenRoutePopupOnNextRender = false;
    return shouldOpen;
  }

  function setShouldOpenRoutePopupOnNextRender(isEnabled) {
    shouldOpenRoutePopupOnNextRender = Boolean(isEnabled);
  }

  function resetRoutePopupState() {
    shouldOpenRoutePopupOnNextRender = false;
    isRoutePopupVisible = false;
    if (hasActiveRoutePopup()) {
      closeActivePopup();
    }
  }

  function syncPanelState(isOpen) {
    const panel = getPanel?.();
    if (!panel) {
      return;
    }

    panel.classList.toggle("open", isOpen);

    const menuButton = getMenuButton?.();
    if (menuButton) {
      menuButton.setAttribute("aria-expanded", String(isOpen));
    }

    const windowLike = getWindowLike();
    if (windowLike) {
      windowLike.setTimeout(() => {
        const map = getMap?.();
        if (map) {
          map.resize();
        }
      }, resizeDelayMs);
    }
  }

  function closePanelIfOpen() {
    const panel = getPanel?.();
    if (!panel?.classList.contains("open")) {
      return false;
    }

    syncPanelState(false);
    closeActivePopup();
    return true;
  }

  function togglePanel() {
    const panel = getPanel?.();
    if (!panel) {
      return;
    }

    syncPanelState(!panel.classList.contains("open"));
  }

  function clearPendingMapTapPopup() {
    const windowLike = getWindowLike();
    if (pendingMapTapPopupTimer !== null && windowLike) {
      windowLike.clearTimeout(pendingMapTapPopupTimer);
      pendingMapTapPopupTimer = null;
    }
  }

  function suppressMapTapPopupTemporarily(durationMs = mapTouchGestureSuppressionMs) {
    suppressMapTapPopupUntil = Date.now() + durationMs;
    clearPendingMapTapPopup();
  }

  function handleMapTouchStart() {
    const now = Date.now();
    if (now - lastMapTouchStartAt <= mapTouchTapPopupDelayMs) {
      suppressMapTapPopupTemporarily();
    }
    lastMapTouchStartAt = now;
  }

  function scheduleMapTapPopup(lngLat) {
    const windowLike = getWindowLike();
    if (!windowLike) {
      return;
    }

    clearPendingMapTapPopup();
    pendingMapTapPopupTimer = windowLike.setTimeout(() => {
      pendingMapTapPopupTimer = null;
      if (Date.now() < suppressMapTapPopupUntil) {
        return;
      }
      openStatsPopupAtLatLng?.(lngLat);
    }, mapTouchTapPopupDelayMs);
  }

  function handleManualMapCameraStart(event) {
    if (!event?.originalEvent) {
      return;
    }

    if (getActiveRoute?.()) {
      setNavigationCameraMode?.("free");
      setNavigationStatus?.("Driver camera paused. Tap Drive to resume heading-follow.", "info");
      suppressMapTapPopupTemporarily();
      return;
    }

    setCurrentLocationFollowEnabled?.(false);
    suppressMapTapPopupTemporarily();
  }

  function handleMapBackgroundClick(event) {
    const map = getMap?.();
    if (!map) {
      return;
    }

    const featuresAtPoint = map.queryRenderedFeatures(event.point, {
      layers: [layerRestaurantId, layerParkingId, layerCurrentLocationHaloId, layerCurrentLocationDotId],
    });

    if (featuresAtPoint.length) {
      return;
    }

    if (isTouchInteractionDevice?.() && Date.now() - lastMapTouchStartAt <= mapTouchTapPopupDelayMs) {
      scheduleMapTapPopup(event.lngLat);
      return;
    }

    openStatsPopupAtLatLng?.(event.lngLat);
  }

  function bindLayerInteractionEvents() {
    const map = getMap?.();
    if (!map || hasBoundLayerEvents) {
      return;
    }

    hasBoundLayerEvents = true;

    for (const layerId of [layerRestaurantId, layerParkingId, layerCurrentLocationDotId]) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });
    }

    map.on("click", layerRestaurantId, (event) => {
      const feature = event.features?.[0];
      if (!feature) {
        return;
      }

      const restaurant = restaurantById?.get(feature.properties?.id);
      if (restaurant) {
        openRestaurantSheet(restaurant);
      }
    });

    map.on("click", layerParkingId, (event) => {
      const feature = event.features?.[0];
      if (!feature) {
        return;
      }

      const parking = parkingById?.get(feature.properties?.id);
      if (!parking) {
        return;
      }

      const name = parking.tags?.name || parking.tags?.operator || "Parking";
      openPopupAtLngLat(event.lngLat, renderParkingPopupHtml?.(parking, name));
    });

    map.on("click", layerCurrentLocationDotId, () => {
      const currentLocation = getLastCurrentLocation?.();
      if (!currentLocation) {
        return;
      }

      openPopupAtLngLat(
        currentLocation,
        `You are here<br/><span class="mono">Accuracy ±${Math.round(Number(getLastCurrentLocationAccuracyMeters?.()) || 0)} m</span>`
      );
    });
  }

  return {
    bindLayerInteractionEvents,
    closeActivePopup,
    closePanelIfOpen,
    closePlaceSheet,
    consumeShouldOpenRoutePopupOnNextRender,
    handleManualMapCameraStart,
    handleMapBackgroundClick,
    handleMapTouchStart,
    hasActiveRoutePopup,
    openPlaceSheet,
    openPopupAtLngLat,
    openRestaurantSheet,
    openSpotSheet,
    resetRoutePopupState,
    scheduleMapTapPopup,
    setShouldOpenRoutePopupOnNextRender,
    suppressMapTapPopupTemporarily,
    syncPanelState,
    syncRoutePopup,
    togglePanel,
  };
}

export {
  createMapInteractionRuntime,
};