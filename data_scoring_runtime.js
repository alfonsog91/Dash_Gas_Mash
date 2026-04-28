function createDataScoringRuntime({
  getMap,
  getLastCurrentLocation,
  getLastCurrentLocationAccuracyMeters,
  getActiveRoute,
  getDataState,
  setDataState,
  getDataStatusElement,
  restaurantById,
  parkingById,
  featureCollection,
  setSourceData,
  createCirclePolygonFeature,
  maxVisibleAccuracyRadiusMeters,
  refreshHeadingConeFromState,
  setLayerVisibility,
  getShowRestaurantsChecked,
  getShowParkingChecked,
  lngLatToObject,
  mapBoundsToAdapter,
  boundsAroundCenter,
  haversineMeters,
  closeActivePopup,
  getProbabilityLow,
  getProbabilityHigh,
  getProbabilityMid,
  formatProbabilityRange,
  formatRelativeRank,
  describeSignal,
  describePickup,
  escapeHtml,
  timeBucket,
  probabilityHorizonMinutes,
  predictionModel,
  shadowLearnedModelEnabled,
  fetchFoodPlaces,
  fetchParkingCandidates,
  fetchResidentialAnchors,
  fetchCensusResidentialAnchors,
  fetchCurrentWeatherSignal,
  formatCensusSourceSummary,
  formatWeatherSourceSummary,
  filterOpenRestaurants,
  buildGridProbabilityHeat,
  rankParking,
  buildDemandCoverageNodes,
  selectParkingSetSubmodular,
  evaluateParkingCoverage,
  updateLabels,
  loadButton,
  hourElement,
  tauElement,
  gridElement,
  competitionElement,
  residentialWeightElement,
  useCensusDataElement,
  censusStatusElement,
  rainBoostElement,
  useLiveWeatherElement,
  weatherStatusElement,
  tipEmphasisElement,
  useMlElement,
  mlBetaElement,
  kSpotsElement,
  parkingListElement,
  summaryCardsElement,
  restaurantSourceId,
  parkingSourceId,
  heatSourceId,
  spotSourceId,
  currentLocationSourceId,
  currentLocationAccuracySourceId,
  routeSourceId,
  restaurantLayerId,
  parkingLayerId,
} = {}) {
  let activeAbort = null;

  function getState() {
    return typeof getDataState === "function" ? getDataState() : {};
  }

  function patchState(patch) {
    setDataState?.(patch || {});
  }

  function setWeatherStatus(message) {
    if (!weatherStatusElement) {
      return;
    }

    weatherStatusElement.textContent = String(message || "").trim();
  }

  function setCensusStatus(message) {
    if (!censusStatusElement) {
      return;
    }

    censusStatusElement.textContent = String(message || "").trim();
  }

  function setDataStatus(message, level) {
    const dataStatusElement = getDataStatusElement?.();
    if (!dataStatusElement) {
      return;
    }

    dataStatusElement.textContent = message;
    dataStatusElement.className = message ? `data-status data-status--${level}` : "";
  }

  function isFiniteLngLat(point) {
    return Number.isFinite(point?.lat)
      && Number.isFinite(point?.lng)
      && point.lat >= -90
      && point.lat <= 90
      && point.lng >= -180
      && point.lng <= 180;
  }

  function clampQueryBounds(originalBounds) {
    const sw = originalBounds.getSouthWest();
    const ne = originalBounds.getNorthEast();
    const diagMeters = haversineMeters(sw.lat, sw.lng, ne.lat, ne.lng);
    const maxDiagMeters = 12000;
    if (diagMeters <= maxDiagMeters) {
      return originalBounds;
    }

    setDataStatus("Query area clamped to ~12 km diagonal — zoom in for full coverage", "warn");

    const center = lngLatToObject(getMap?.().getCenter());
    return boundsAroundCenter(center, maxDiagMeters / 2);
  }

  function updateCensusUi() {
    const useCensusData = useCensusDataElement ? Boolean(useCensusDataElement.checked) : false;
    if (!useCensusData) {
      patchState({
        lastCensusResidentialAnchors: [],
        lastCensusDataset: null,
      });
      setCensusStatus("Census tract anchors off. Using OSM residential anchors only.");
      return;
    }

    const { lastCensusResidentialAnchors = [], lastCensusDataset = null } = getState();
    setCensusStatus(
      lastCensusResidentialAnchors.length
        ? formatCensusSourceSummary(lastCensusDataset, lastCensusResidentialAnchors)
        : "Static Census tract anchors for the default Rancho/Ontario region will be blended into residential demand when they overlap the current view."
    );
  }

  function updateWeatherUi() {
    const useLiveWeather = useLiveWeatherElement ? Boolean(useLiveWeatherElement.checked) : false;

    if (rainBoostElement) {
      rainBoostElement.disabled = useLiveWeather;
      rainBoostElement.setAttribute("aria-disabled", String(useLiveWeather));
    }

    if (useLiveWeather) {
      const { lastWeatherSignal = null } = getState();
      setWeatherStatus(
        lastWeatherSignal
          ? formatWeatherSourceSummary(lastWeatherSignal)
          : "Live weather will be fetched from Open-Meteo on refresh. If it fails, the manual rain lift slider remains the fallback."
      );
      return;
    }

    patchState({ lastWeatherSignal: null });
    setWeatherStatus("Live weather off. Using the manual rain lift slider.");
  }

  function checkDataFreshness() {
    const { lastLoadedBounds = null, lastStats = null } = getState();
    if (!lastLoadedBounds || !lastStats) {
      setDataStatus("", "");
      return;
    }

    const current = mapBoundsToAdapter(getMap?.().getBounds());

    if (!lastLoadedBounds.intersects(current)) {
      setDataStatus("Data stale — reload for this area", "warn");
    } else if (!lastLoadedBounds.contains(current)) {
      setDataStatus("View extends beyond loaded data — reload to refresh edges", "info");
    } else {
      setDataStatus("OSM data loaded for this view", "ok");
    }
  }

  function clearLayers() {
    restaurantById.clear();
    parkingById.clear();
    patchState({
      lastResidentialAnchors: [],
      lastCensusResidentialAnchors: [],
      lastCensusDataset: null,
      lastHeatFeatures: [],
      lastSpotPoint: null,
      lastLoadedBounds: null,
    });

    setSourceData(restaurantSourceId, featureCollection());
    setSourceData(parkingSourceId, featureCollection());
    setSourceData(heatSourceId, featureCollection());
    setSourceData(spotSourceId, featureCollection());

    closeActivePopup?.();

    if (parkingListElement) {
      parkingListElement.innerHTML = "";
    }
    if (summaryCardsElement) {
      summaryCardsElement.innerHTML = "";
    }

    setDataStatus("", "");
  }

  function renderSummaryCards(rankedParking, restaurants, parking, residentialAnchors, censusAnchors = []) {
    if (!summaryCardsElement) {
      return;
    }

    if (!rankedParking.length) {
      summaryCardsElement.innerHTML = "";
      return;
    }

    const { lastStats = null, lastParams = {}, lastWeatherSignal = null } = getState();
    const best = rankedParking[0];
    const bestRange = formatProbabilityRange(getProbabilityLow(best), getProbabilityHigh(best));
    const typicalRange = formatProbabilityRange(
      lastStats?.medianProbabilityLow ?? lastStats?.medianScore ?? 0,
      lastStats?.medianProbabilityHigh ?? lastStats?.medianScore ?? 0
    );
    const hotRange = formatProbabilityRange(
      lastStats?.topDecileProbabilityLow ?? lastStats?.topDecileScore ?? 0,
      lastStats?.topDecileProbabilityHigh ?? lastStats?.topDecileScore ?? 0
    );
    const bucketLabel = lastStats?.timeBucketLabel ?? timeBucket(lastParams.hour).label;

    summaryCardsElement.innerHTML = `
<article class="summary-card">
  <span class="summary-label">Best visible 10-minute field</span>
  <strong>${bestRange}</strong>
  <p>The strongest visible waiting point is modeled at <b>${bestRange}</b> for a good order in the next ${probabilityHorizonMinutes} minutes. ${describeSignal(getProbabilityMid(best))}.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Field spread in this view</span>
  <strong>${typicalRange} typical · ${hotRange} hot zones</strong>
  <p>A typical point in this view sits around ${typicalRange}. The strongest visible zones sit around ${hotRange}, which tells you how separated the current probability field is.</p>
</article>

<article class="summary-card">
  <span class="summary-label">Why the best spot rates well</span>
  <strong>${escapeHtml(best.explain?.merchantShare ?? `${bucketLabel} probability read`)}</strong>
  <p>${escapeHtml(best.explain?.residentialShare ?? "")}${best.explain?.relativeIntensity ? ` ${escapeHtml(best.explain.relativeIntensity)}` : ""}${best.explain?.rainLiftPercent ? ` ${escapeHtml(best.explain.rainLiftPercent)}` : ""}</p>
</article>

<article class="summary-card">
  <span class="summary-label">Data loaded</span>
  <strong>${restaurants.length} restaurants · ${residentialAnchors.length} residential anchors · ${censusAnchors.length} Census tracts · ${parking.length} parking lots</strong>
  <p>This probability field is built from ${restaurants.length} restaurants, ${residentialAnchors.length} residential anchors, ${censusAnchors.length} nearby Census tracts, and ${parking.length} parking lots visible on the map. ${escapeHtml(lastWeatherSignal ? formatWeatherSourceSummary(lastWeatherSignal) : "Manual rain lift is active.")} Zoom in for a tighter local read.</p>
</article>
`;
  }

  function addRestaurantMarkers(restaurants) {
    restaurantById.clear();

    const features = restaurants.map((restaurant) => {
      restaurantById.set(restaurant.id, restaurant);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [restaurant.lon, restaurant.lat],
        },
        properties: {
          id: restaurant.id,
        },
      };
    });

    setSourceData(restaurantSourceId, featureCollection(features));
  }

  function addParkingMarkers(rankedParking) {
    parkingById.clear();

    const features = rankedParking.map((parking) => {
      parkingById.set(parking.id, parking);

      return {
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [parking.lon, parking.lat],
        },
        properties: {
          id: parking.id,
        },
      };
    });

    setSourceData(parkingSourceId, featureCollection(features));
  }

  function renderParkingList(rankedParking) {
    if (!parkingListElement) {
      return;
    }

    parkingListElement.innerHTML = "";

    for (const parking of rankedParking) {
      const name = parking.tags?.name || parking.tags?.operator || "Parking";

      const li = document.createElement("li");
      const btn = document.createElement("button");

      btn.innerHTML = `
  <span class="list-title">${escapeHtml(name)} — ${escapeHtml(formatProbabilityRange(getProbabilityLow(parking), getProbabilityHigh(parking)))}</span>
  <span class="list-meta">10-minute good-order probability range</span>
  <span class="list-meta">${escapeHtml(describeSignal(getProbabilityMid(parking)))}</span>
<span class="list-meta">${escapeHtml(formatRelativeRank(parking))}</span>
<span class="list-meta">${escapeHtml(describePickup(parking.expectedDistMeters))}</span>
  <span class="list-meta">${escapeHtml(parking.explain?.relativeIntensity ?? "")}</span>
`;

      btn.addEventListener("click", () => {
        getMap?.().easeTo({
          center: [parking.lon, parking.lat],
          zoom: Math.max(getMap?.().getZoom(), 15),
          duration: 700,
        });
      });

      li.appendChild(btn);
      parkingListElement.appendChild(li);
    }
  }

  function restoreMapDataSources() {
    const {
      lastHeatFeatures = [],
      lastSpotPoint = null,
    } = getState();

    setSourceData(restaurantSourceId, featureCollection(Array.from(restaurantById.values()).map((restaurant) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [restaurant.lon, restaurant.lat],
      },
      properties: { id: restaurant.id },
    }))));

    setSourceData(parkingSourceId, featureCollection(Array.from(parkingById.values()).map((parking) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [parking.lon, parking.lat],
      },
      properties: { id: parking.id },
    }))));

    setSourceData(heatSourceId, featureCollection(lastHeatFeatures));

    if (lastSpotPoint) {
      setSourceData(spotSourceId, featureCollection([{
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lastSpotPoint.lng, lastSpotPoint.lat],
        },
        properties: {},
      }]));
    } else {
      setSourceData(spotSourceId, featureCollection());
    }

    const lastCurrentLocation = getLastCurrentLocation?.();
    if (lastCurrentLocation) {
      const accuracyRadius = Math.max(Number(getLastCurrentLocationAccuracyMeters?.()) || 0, 12);
      if (accuracyRadius <= maxVisibleAccuracyRadiusMeters) {
        const accuracyFeature = createCirclePolygonFeature(lastCurrentLocation, accuracyRadius);
        accuracyFeature.properties = { accuracyMeters: accuracyRadius };
        setSourceData(currentLocationAccuracySourceId, featureCollection([accuracyFeature]));
      } else {
        setSourceData(currentLocationAccuracySourceId, featureCollection());
      }

      setSourceData(currentLocationSourceId, featureCollection([{
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lastCurrentLocation.lng, lastCurrentLocation.lat],
        },
        properties: { accuracyMeters: accuracyRadius },
      }]));
    } else {
      setSourceData(currentLocationSourceId, featureCollection());
      setSourceData(currentLocationAccuracySourceId, featureCollection());
    }

    refreshHeadingConeFromState?.();

    const activeRoute = getActiveRoute?.();
    if (activeRoute?.geometry?.coordinates?.length) {
      setSourceData(routeSourceId, featureCollection([{
        type: "Feature",
        geometry: activeRoute.geometry,
        properties: {},
      }]));
    } else {
      setSourceData(routeSourceId, featureCollection());
    }

    setLayerVisibility(restaurantLayerId, getShowRestaurantsChecked?.());
    setLayerVisibility(parkingLayerId, getShowParkingChecked?.());
  }

  async function loadForView() {
    if (activeAbort) {
      activeAbort.abort();
    }

    activeAbort = new AbortController();

    loadButton.disabled = true;
    loadButton.textContent = "Loading OSM data…";

    try {
      clearLayers();

      const hour = Number(hourElement.value);
      const tauMeters = Number(tauElement.value);
      const gridStepMeters = Number(gridElement.value);
      const horizonMin = probabilityHorizonMinutes;
      const competitionStrength = Number(competitionElement.value);
      const residentialDemandWeight = Number(residentialWeightElement.value);
      const useCensusData = useCensusDataElement ? Boolean(useCensusDataElement.checked) : false;
      const useLiveWeather = useLiveWeatherElement ? Boolean(useLiveWeatherElement.checked) : false;
      let rainBoost = Number(rainBoostElement.value);
      const tipEmphasis = Number(tipEmphasisElement.value);
      const useML = Boolean(useMlElement.checked);
      const mlBeta = Number(mlBetaElement.value);
      const kSpots = Number(kSpotsElement.value);

      patchState({
        lastParams: {
          hour,
          tauMeters,
          horizonMin,
          competitionStrength,
          residentialDemandWeight,
          rainBoost,
          useCensusData,
          useLiveWeather,
          tipEmphasis,
          predictionModel,
          useML,
          mlBeta,
          kSpots,
        },
      });

      const bbox = mapBoundsToAdapter(getMap?.().getBounds());
      const queryBounds = clampQueryBounds(bbox);
      const weatherPoint = lngLatToObject(getLastCurrentLocation?.() || getMap?.().getCenter());
      const canFetchLiveWeather = useLiveWeather && isFiniteLngLat(weatherPoint);
      const censusPromise = useCensusData
        ? fetchCensusResidentialAnchors(queryBounds, activeAbort.signal)
          .then((result) => ({ ok: true, ...result }))
          .catch((error) => ({ ok: false, error }))
        : Promise.resolve({ ok: false, skipped: true, anchors: [] });
      const weatherPromise = canFetchLiveWeather
        ? fetchCurrentWeatherSignal(weatherPoint, activeAbort.signal)
          .then((weatherSignal) => ({ ok: true, weatherSignal }))
          .catch((error) => ({ ok: false, error }))
        : Promise.resolve({ ok: false, skipped: true, reason: useLiveWeather ? "invalid-weather-point" : "disabled" });

      const [allRestaurants, parking, residentialAnchors, censusResult, weatherResult] = await Promise.all([
        fetchFoodPlaces(queryBounds, activeAbort.signal),
        fetchParkingCandidates(queryBounds, activeAbort.signal),
        fetchResidentialAnchors(queryBounds, activeAbort.signal),
        censusPromise,
        weatherPromise,
      ]);

      const censusResidentialAnchors = censusResult?.ok && Array.isArray(censusResult.anchors)
        ? censusResult.anchors
        : [];
      if (censusResult?.ok) {
        patchState({
          lastCensusDataset: censusResult.dataset || null,
          lastCensusResidentialAnchors: censusResidentialAnchors,
        });
        setCensusStatus(formatCensusSourceSummary(censusResult.dataset || null, censusResidentialAnchors));
      } else if (useCensusData && censusResult && !censusResult.skipped) {
        patchState({
          lastCensusDataset: null,
          lastCensusResidentialAnchors: [],
        });
        console.warn("[DGM] Census data load failed:", censusResult.error);
        setCensusStatus("Census tract anchors unavailable. Using OSM residential anchors only.");
      }

      if (weatherResult?.ok && weatherResult.weatherSignal) {
        patchState({ lastWeatherSignal: weatherResult.weatherSignal });
        rainBoost = weatherResult.weatherSignal.rainBoost;
        rainBoostElement.value = rainBoost.toFixed(2);
        updateLabels?.();
      } else if (useLiveWeather && weatherResult && !weatherResult.skipped) {
        patchState({ lastWeatherSignal: null });
        console.warn("[DGM] Live weather fetch failed:", weatherResult.error);
        setWeatherStatus("Live weather unavailable. Using the manual rain lift slider.");
      }

      const restaurants = filterOpenRestaurants(allRestaurants, new Date());
      const combinedResidentialAnchors = [...residentialAnchors, ...censusResidentialAnchors];

      addRestaurantMarkers(restaurants);

      const heatResult = buildGridProbabilityHeat(
        queryBounds,
        restaurants,
        parking,
        {
          hour,
          tauMeters,
          horizonMin,
          competitionStrength,
          residentialAnchors: combinedResidentialAnchors,
          residentialDemandWeight,
          rainBoost,
          tipEmphasis,
          predictionModel,
          useML,
          mlBeta,
        },
        gridStepMeters
      );

      const heatFeatures = heatResult.heatPoints.map(([lat, lon, intensity]) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [lon, lat],
        },
        properties: {
          intensity,
        },
      }));

      patchState({
        lastRestaurants: restaurants,
        lastParkingCandidates: parking,
        lastResidentialAnchors: combinedResidentialAnchors,
        lastStats: heatResult.stats,
        lastLoadedBounds: queryBounds,
        lastHeatFeatures: heatFeatures,
      });
      checkDataFreshness();

      setSourceData(heatSourceId, featureCollection(heatFeatures));

      const rankedAll = rankParking(
        parking,
        restaurants,
        parking,
        {
          hour,
          tauMeters,
          horizonMin,
          competitionStrength,
          residentialAnchors: combinedResidentialAnchors,
          residentialDemandWeight,
          rainBoost,
          tipEmphasis,
          predictionModel,
          useML,
          mlBeta,
        },
        heatResult.stats,
        Math.max(parking.length, 1)
      );
      patchState({ lastRankedParkingAll: rankedAll });

      const coverageTauMeters = Math.max(300, tauMeters);
      const demandNodes = buildDemandCoverageNodes(restaurants, {
        hour,
        dayOfWeek: heatResult.stats?.dayOfWeek,
        residentialAnchors: combinedResidentialAnchors,
        residentialDemandWeight,
      });

      const ranked = selectParkingSetSubmodular(rankedAll, {
        k: kSpots,
        demandNodes,
        coverageTauMeters,
      });

      if (shadowLearnedModelEnabled && predictionModel !== "glm") {
        const shadowRankedAll = rankParking(
          parking,
          restaurants,
          parking,
          {
            hour,
            tauMeters,
            horizonMin,
            competitionStrength,
            residentialAnchors,
            residentialDemandWeight,
            rainBoost,
            tipEmphasis,
            predictionModel: "glm",
            useML,
            mlBeta,
          },
          heatResult.stats,
          Math.max(parking.length, 1)
        );

        console.info("[DGM] learned-model shadow audit", {
          activeModel: predictionModel,
          topLegacyIds: rankedAll.slice(0, 5).map((candidate) => candidate.id),
          topShadowIds: shadowRankedAll.slice(0, 5).map((candidate) => candidate.id),
          meanAbsTopDelta: rankedAll.slice(0, 10).reduce((sum, candidate, index) => {
            const shadowCandidate = shadowRankedAll[index];
            return sum + Math.abs((candidate?.pGood ?? 0) - (shadowCandidate?.pGood ?? 0));
          }, 0) / Math.max(1, Math.min(10, rankedAll.length, shadowRankedAll.length)),
        });
      }

      console.info("[DGM] selection coverage", {
        activeMode: "submodular",
        activeCoverage: evaluateParkingCoverage(ranked, demandNodes, { coverageTauMeters }),
        activeUtility: ranked.reduce((sum, candidate) => sum + (candidate.pGood ?? 0), 0),
      });

      addParkingMarkers(ranked);
      renderParkingList(ranked);
      renderSummaryCards(ranked, restaurants, parking, residentialAnchors, censusResidentialAnchors);
      updateCensusUi();
      updateWeatherUi();

      setLayerVisibility(restaurantLayerId, getShowRestaurantsChecked?.());
      setLayerVisibility(parkingLayerId, getShowParkingChecked?.());
    } finally {
      loadButton.disabled = false;
      loadButton.textContent = "Load / Refresh for current view";
    }
  }

  return {
    checkDataFreshness,
    loadForView,
    restoreMapDataSources,
    updateCensusUi,
    updateWeatherUi,
  };
}

export {
  createDataScoringRuntime,
};