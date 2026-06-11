// Phase G vegetation core (deterministic instance generator + LOD rules).
//
// Targets Mapbox GL JS v2.15.0 ONLY: there is no native GLTF/model layer in v2,
// so this module produces data for two v2-compatible render paths:
//   - sprite billboards  -> symbol-layer point features (mid/high zoom),
//   - aggregated polygons -> fill-extrusion polygon features (low zoom).
//
// It converts vegetation samples (OSM natural=wood/tree, landcover tiles, or a
// synthetic sample set) into a deterministic placement grid and emits both
// representations plus LOD metadata. No randomness: identical inputs always
// produce identical output (instance ids/order are stable and sorted).
//
// Approximations / assumptions (documented inline):
// - Projection is a local equirectangular (flat-earth) approximation anchored at
//   the south-west corner of the sample bounds. This is accurate enough for the
//   small areas vegetation covers and keeps grid math cheap and deterministic.
// - Polygon coverage uses an even-odd ray-cast point-in-polygon test on grid
//   cell centers; partial-cell coverage is treated as full coverage of the cell.
// - "Density" is an abstract per-sample weight accumulated per grid cell. A cell
//   becomes a vegetation instance when its accumulated weight >= densityThreshold.
// - heuristicConfidenceScore is a bounded [0,1] proxy for how well-supported the
//   generated field is (sample volume x qualifying-cell coverage). It is a rough
//   signal, not a calibrated probability.

const EARTH_METERS_PER_DEGREE_LAT = 111320;
const MAX_GRID_CELLS = 50000;
const DEFAULT_GRID_RESOLUTION = 30; // meters per sprite cell
const DEFAULT_DENSITY_THRESHOLD = 1;
const DEFAULT_AGGREGATION_FACTOR = 4; // aggregate tile = gridResolution * factor

const DEFAULT_LOD_RULES = Object.freeze({
  // At/above spriteMinZoom render individual sprite billboards.
  spriteMinZoom: 14,
  // Below spriteMinZoom (and at/above hideBelowZoom) render aggregated extrusions.
  hideBelowZoom: 8,
  aggregationFactor: DEFAULT_AGGREGATION_FACTOR,
});

const TYPE_DEFAULT_HEIGHTS = Object.freeze({
  tree: 8,
  wood: 12,
  forest: 14,
  scrub: 3,
  grass: 1,
});

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  const number = toFiniteNumber(value, 0);
  return Math.min(Math.max(number, 0), 1);
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function validatePositiveParam(value, name, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function coordPair(point) {
  if (Array.isArray(point)) {
    return { lng: toFiniteNumber(point[0]), lat: toFiniteNumber(point[1]) };
  }
  if (point && typeof point === "object") {
    return {
      lng: toFiniteNumber(point.lng ?? point.lon ?? point.longitude),
      lat: toFiniteNumber(point.lat ?? point.latitude),
    };
  }
  return { lng: null, lat: null };
}

function isValidLatLng(lat, lng) {
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

// Normalize an arbitrary sample into { kind, type, density, points[] }.
function normalizeSample(sample) {
  if (!sample || typeof sample !== "object") {
    return null;
  }

  const type = typeof sample.type === "string" && sample.type.trim() ? sample.type.trim().toLowerCase() : "tree";
  const density = Math.max(0, toFiniteNumber(sample.density ?? sample.weight ?? sample.count, 1));
  if (density <= 0) {
    return null;
  }

  const polygonSource = Array.isArray(sample.polygon) ? sample.polygon : Array.isArray(sample.geometry?.coordinates?.[0]) ? sample.geometry.coordinates[0] : null;
  if (polygonSource && polygonSource.length >= 3) {
    const ring = polygonSource.map(coordPair).filter((p) => isValidLatLng(p.lat, p.lng));
    if (ring.length >= 3) {
      return { kind: "polygon", type, density, points: ring, height: toFiniteNumber(sample.height, null) };
    }
  }

  const point = coordPair(sample);
  if (isValidLatLng(point.lat, point.lng)) {
    return { kind: "point", type, density, points: [point], height: toFiniteNumber(sample.height, null) };
  }

  return null;
}

function computeBounds(samples) {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const sample of samples) {
    for (const point of sample.points) {
      minLat = Math.min(minLat, point.lat);
      minLng = Math.min(minLng, point.lng);
      maxLat = Math.max(maxLat, point.lat);
      maxLng = Math.max(maxLng, point.lng);
    }
  }
  return { minLat, minLng, maxLat, maxLng };
}

function createProjection(originLat, originLng) {
  const metersPerDegLng = EARTH_METERS_PER_DEGREE_LAT * Math.cos((originLat * Math.PI) / 180);
  const safeMetersPerDegLng = Math.abs(metersPerDegLng) < 1 ? 1 : metersPerDegLng;
  return {
    project(lat, lng) {
      return {
        x: (lng - originLng) * safeMetersPerDegLng,
        y: (lat - originLat) * EARTH_METERS_PER_DEGREE_LAT,
      };
    },
    unproject(x, y) {
      return {
        lng: originLng + x / safeMetersPerDegLng,
        lat: originLat + y / EARTH_METERS_PER_DEGREE_LAT,
      };
    },
  };
}

// Even-odd ray-cast point-in-polygon on projected coordinates.
function pointInPolygon(x, y, projectedRing) {
  let inside = false;
  for (let i = 0, j = projectedRing.length - 1; i < projectedRing.length; j = i, i += 1) {
    const xi = projectedRing[i].x;
    const yi = projectedRing[i].y;
    const xj = projectedRing[j].x;
    const yj = projectedRing[j].y;
    const intersects = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function heightForType(type, explicitHeight) {
  if (isFiniteNumber(explicitHeight) && explicitHeight > 0) {
    return round2(explicitHeight);
  }
  return TYPE_DEFAULT_HEIGHTS[type] ?? TYPE_DEFAULT_HEIGHTS.tree;
}

// Compute the LOD render mode for a given zoom. Returns which representation is
// active so the UI layer (commit 9) can toggle Mapbox layer visibility.
function resolveLodMode(zoom, lodRules = DEFAULT_LOD_RULES) {
  const rules = { ...DEFAULT_LOD_RULES, ...(lodRules || {}) };
  const z = toFiniteNumber(zoom, 0);
  if (z < rules.hideBelowZoom) {
    return { mode: "hidden", renderSprites: false, renderExtrusions: false };
  }
  if (z >= rules.spriteMinZoom) {
    return { mode: "sprite", renderSprites: true, renderExtrusions: false };
  }
  return { mode: "extrusion", renderSprites: false, renderExtrusions: true };
}

// Generate deterministic vegetation instances + aggregated extrusions from
// samples. Returns { instances, aggregates, metadata }.
//   - instances:  sprite billboard points (GeoJSON-ready) for mid/high zoom.
//   - aggregates: fill-extrusion polygon features for low zoom.
function generateVegetationInstances(samples, {
  gridResolution = DEFAULT_GRID_RESOLUTION,
  densityThreshold = DEFAULT_DENSITY_THRESHOLD,
  lodRules = DEFAULT_LOD_RULES,
} = {}) {
  const resolution = validatePositiveParam(gridResolution, "gridResolution", DEFAULT_GRID_RESOLUTION);
  const threshold = validatePositiveParam(densityThreshold, "densityThreshold", DEFAULT_DENSITY_THRESHOLD);
  const rules = { ...DEFAULT_LOD_RULES, ...(lodRules || {}) };
  const aggregationFactor = Math.max(1, Math.trunc(validatePositiveParam(rules.aggregationFactor, "lodRules.aggregationFactor", DEFAULT_AGGREGATION_FACTOR)));

  const normalizedSamples = (Array.isArray(samples) ? samples : [])
    .map(normalizeSample)
    .filter((sample) => sample !== null);

  const emptyMetadata = {
    instanceCount: 0,
    aggregateCount: 0,
    gridResolution: resolution,
    densityThreshold: threshold,
    sampleCount: 0,
    heuristicConfidenceScore: 0,
  };

  if (normalizedSamples.length === 0) {
    return { instances: [], aggregates: [], metadata: emptyMetadata };
  }

  const bounds = computeBounds(normalizedSamples);
  const projection = createProjection(bounds.minLat, bounds.minLng);

  // Accumulate per-cell weight + per-type tallies.
  const cells = new Map();
  let touchedCells = 0;

  function cellKey(ix, iy) {
    return `${ix}:${iy}`;
  }

  function addToCell(ix, iy, weight, type) {
    const key = cellKey(ix, iy);
    let cell = cells.get(key);
    if (!cell) {
      if (cells.size >= MAX_GRID_CELLS) {
        return;
      }
      cell = { ix, iy, weight: 0, types: new Map() };
      cells.set(key, cell);
      touchedCells += 1;
    }
    cell.weight += weight;
    cell.types.set(type, (cell.types.get(type) || 0) + weight);
  }

  for (const sample of normalizedSamples) {
    if (sample.kind === "point") {
      const { x, y } = projection.project(sample.points[0].lat, sample.points[0].lng);
      addToCell(Math.floor(x / resolution), Math.floor(y / resolution), sample.density, sample.type);
      continue;
    }

    // Polygon: rasterize over its projected bounding box, testing cell centers.
    const projectedRing = sample.points.map((p) => projection.project(p.lat, p.lng));
    const xs = projectedRing.map((p) => p.x);
    const ys = projectedRing.map((p) => p.y);
    const minIx = Math.floor(Math.min(...xs) / resolution);
    const maxIx = Math.floor(Math.max(...xs) / resolution);
    const minIy = Math.floor(Math.min(...ys) / resolution);
    const maxIy = Math.floor(Math.max(...ys) / resolution);
    const cellCount = Math.max(0, maxIx - minIx + 1) * Math.max(0, maxIy - minIy + 1);
    if (cellCount > MAX_GRID_CELLS) {
      throw new RangeError(`vegetation polygon would rasterize ${cellCount} cells; increase gridResolution`);
    }

    for (let ix = minIx; ix <= maxIx; ix += 1) {
      for (let iy = minIy; iy <= maxIy; iy += 1) {
        const cx = (ix + 0.5) * resolution;
        const cy = (iy + 0.5) * resolution;
        if (pointInPolygon(cx, cy, projectedRing)) {
          addToCell(ix, iy, sample.density, sample.type);
        }
      }
    }
  }

  // Qualifying cells become sprite instances; sorted for determinism.
  const qualifying = Array.from(cells.values())
    .filter((cell) => cell.weight >= threshold)
    .sort((left, right) => left.ix - right.ix || left.iy - right.iy);

  const instances = qualifying.map((cell) => {
    const center = projection.unproject((cell.ix + 0.5) * resolution, (cell.iy + 0.5) * resolution);
    const dominantType = Array.from(cell.types.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    return {
      id: `veg:${cell.ix}:${cell.iy}`,
      lat: round6(center.lat),
      lng: round6(center.lng),
      type: dominantType,
      height: heightForType(dominantType, null),
      weight: round4(cell.weight),
      minZoom: rules.spriteMinZoom,
    };
  });

  // Aggregate qualifying cells into coarse extrusion tiles for low-zoom rendering.
  const aggregateResolution = resolution * aggregationFactor;
  const aggregateTiles = new Map();
  for (const cell of qualifying) {
    const aix = Math.floor(cell.ix / aggregationFactor);
    const aiy = Math.floor(cell.iy / aggregationFactor);
    const key = cellKey(aix, aiy);
    let tile = aggregateTiles.get(key);
    if (!tile) {
      tile = { aix, aiy, instanceCount: 0, weight: 0, types: new Map() };
      aggregateTiles.set(key, tile);
    }
    tile.instanceCount += 1;
    tile.weight += cell.weight;
    for (const [type, typeWeight] of cell.types) {
      tile.types.set(type, (tile.types.get(type) || 0) + typeWeight);
    }
  }

  const aggregates = Array.from(aggregateTiles.values())
    .sort((left, right) => left.aix - right.aix || left.aiy - right.aiy)
    .map((tile) => {
      const x0 = tile.aix * aggregateResolution;
      const y0 = tile.aiy * aggregateResolution;
      const x1 = x0 + aggregateResolution;
      const y1 = y0 + aggregateResolution;
      const sw = projection.unproject(x0, y0);
      const se = projection.unproject(x1, y0);
      const ne = projection.unproject(x1, y1);
      const nw = projection.unproject(x0, y1);
      const dominantType = Array.from(tile.types.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      // Extrusion height grows with instance density but is bounded (log curve)
      // so dense tiles do not produce absurdly tall columns.
      const baseHeight = heightForType(dominantType, null);
      const height = round2(baseHeight * (1 + Math.log10(1 + tile.instanceCount)));
      return {
        type: "Feature",
        properties: {
          id: `vegagg:${tile.aix}:${tile.aiy}`,
          instanceCount: tile.instanceCount,
          vegetationType: dominantType,
          height,
          maxZoom: rules.spriteMinZoom,
        },
        geometry: {
          type: "Polygon",
          coordinates: [[
            [round6(sw.lng), round6(sw.lat)],
            [round6(se.lng), round6(se.lat)],
            [round6(ne.lng), round6(ne.lat)],
            [round6(nw.lng), round6(nw.lat)],
            [round6(sw.lng), round6(sw.lat)],
          ]],
        },
      };
    });

  // Confidence: more samples and a higher qualifying-cell ratio => higher score.
  // Deterministic, bounded [0,1]; this is a rough support proxy, not calibrated.
  const coverageRatio = touchedCells > 0 ? qualifying.length / touchedCells : 0;
  const volumeSignal = 1 - Math.exp(-normalizedSamples.length / 10);
  const heuristicConfidenceScore = round4(clamp01(coverageRatio * volumeSignal));

  return {
    instances,
    aggregates,
    metadata: {
      instanceCount: instances.length,
      aggregateCount: aggregates.length,
      gridResolution: resolution,
      densityThreshold: threshold,
      sampleCount: normalizedSamples.length,
      heuristicConfidenceScore,
    },
  };
}

export {
  generateVegetationInstances,
  resolveLodMode,
  normalizeSample,
  DEFAULT_LOD_RULES,
  DEFAULT_GRID_RESOLUTION,
  TYPE_DEFAULT_HEIGHTS,
};
