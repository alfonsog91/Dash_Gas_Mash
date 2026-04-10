const CENSUS_DATA_URL = "./data/census-rancho-ontario-tracts-2023.json";

let cachedCensusDataset = null;

function boundsIntersect(a, b) {
  return !(
    a.east < b.west
    || a.west > b.east
    || a.north < b.south
    || a.south > b.north
  );
}

function normalizeDatasetBounds(dataset) {
  if (dataset?.bounds) {
    return {
      south: Number(dataset.bounds.south),
      west: Number(dataset.bounds.west),
      north: Number(dataset.bounds.north),
      east: Number(dataset.bounds.east),
    };
  }

  const anchors = Array.isArray(dataset?.anchors) ? dataset.anchors : [];
  const lats = anchors.map((anchor) => Number(anchor.lat)).filter(Number.isFinite);
  const lons = anchors.map((anchor) => Number(anchor.lon)).filter(Number.isFinite);
  if (!lats.length || !lons.length) {
    return null;
  }

  return {
    south: Math.min(...lats),
    west: Math.min(...lons),
    north: Math.max(...lats),
    east: Math.max(...lons),
  };
}

function filterCensusAnchorsForBounds(dataset, bounds) {
  const anchors = Array.isArray(dataset?.anchors) ? dataset.anchors : [];
  if (!bounds || !anchors.length) {
    return [];
  }

  const datasetBounds = normalizeDatasetBounds(dataset);
  const viewBounds = {
    south: Number(bounds.getSouth()),
    west: Number(bounds.getWest()),
    north: Number(bounds.getNorth()),
    east: Number(bounds.getEast()),
  };

  if (datasetBounds && !boundsIntersect(datasetBounds, viewBounds)) {
    return [];
  }

  return anchors.filter((anchor) => {
    const lat = Number(anchor.lat);
    const lon = Number(anchor.lon);
    return (
      Number.isFinite(lat)
      && Number.isFinite(lon)
      && lat >= viewBounds.south
      && lat <= viewBounds.north
      && lon >= viewBounds.west
      && lon <= viewBounds.east
    );
  });
}

function formatCensusSourceSummary(dataset, anchors) {
  const count = Array.isArray(anchors) ? anchors.length : 0;
  if (!count) {
    return "No Census tract anchors overlap the current view.";
  }

  const datasetName = dataset?.source?.dataset || "U.S. Census Bureau tract data";
  return `${count} Census tract anchors loaded from ${datasetName}.`;
}

async function fetchCensusResidentialAnchors(bounds, signal) {
  if (!cachedCensusDataset) {
    const response = await fetch(CENSUS_DATA_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Census static data request failed (${response.status}): ${details.slice(0, 200)}`);
    }

    cachedCensusDataset = await response.json();
  }

  const anchors = filterCensusAnchorsForBounds(cachedCensusDataset, bounds);
  return {
    dataset: cachedCensusDataset,
    anchors,
  };
}

export {
  fetchCensusResidentialAnchors,
  filterCensusAnchorsForBounds,
  formatCensusSourceSummary,
  normalizeDatasetBounds,
};