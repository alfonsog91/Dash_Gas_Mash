import { generateOpportunityGrid } from "./opportunity_core.js";
import {
  clusterOpportunityZones,
  queryZoneClusterIndex,
} from "./zone_clustering.js";

const DEFAULT_FIELD_WEIGHTS = Object.freeze({
  recentDensity: 0.46,
  historicalDensity: 0.28,
  zoneBoost: 0.2,
  travelCost: 0.16,
});

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp01(value) {
  const number = toFiniteNumber(value, 0);
  return Math.min(Math.max(number, 0), 1);
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeWeights(weights = {}) {
  const source = weights && typeof weights === "object" ? weights : {};
  return {
    recentDensity: Math.max(0, toFiniteNumber(source.recentDensity ?? source.w1, DEFAULT_FIELD_WEIGHTS.recentDensity)),
    historicalDensity: Math.max(0, toFiniteNumber(source.historicalDensity ?? source.w2, DEFAULT_FIELD_WEIGHTS.historicalDensity)),
    zoneBoost: Math.max(0, toFiniteNumber(source.zoneBoost ?? source.w3, DEFAULT_FIELD_WEIGHTS.zoneBoost)),
    travelCost: Math.max(0, toFiniteNumber(source.travelCost ?? source.w4, DEFAULT_FIELD_WEIGHTS.travelCost)),
  };
}

function getClusterBundle(samples, options) {
  if (options?.clusters && Array.isArray(options.clusters.clusters)) {
    return options.clusters;
  }

  if (Array.isArray(options?.clusters)) {
    return {
      clusters: options.clusters,
      spatialIndex: options.spatialIndex || null,
      metadata: options.clusterMetadata || null,
    };
  }

  if (options?.generateClusters === false) {
    return { clusters: [], spatialIndex: null, metadata: null };
  }

  const eps = Math.max(options.gridResolution * 2, options.smoothingSigma || options.gridResolution);
  const minSamples = options.clusterMinSamples || 3;
  return clusterOpportunityZones(samples, { eps, minSamples });
}

function getClusterById(clusters) {
  return new Map((Array.isArray(clusters) ? clusters : []).map((cluster) => [cluster.id, cluster]));
}

function getZoneBoost(clusterIds, clusterById, maxClusterCount) {
  return clusterIds.reduce((best, clusterId) => {
    const cluster = clusterById.get(clusterId);
    if (!cluster) {
      return best;
    }
    const countScore = maxClusterCount > 0 ? cluster.stats.sampleCount / maxClusterCount : 0;
    const boost = clamp01(cluster.stats.avgEV * 0.7 + countScore * 0.3);
    return Math.max(best, boost);
  }, 0);
}

function queryHistoricalDensity(historicalAggregates, cell, zoneIds, timestamp) {
  if (!historicalAggregates) {
    return { density: 0, sampleCount: 0 };
  }

  const cellQuery = typeof historicalAggregates.queryGridCellDensity === "function"
    ? historicalAggregates.queryGridCellDensity(cell.id, { timestamp })
    : null;
  const zoneQueries = typeof historicalAggregates.queryZoneDensity === "function"
    ? zoneIds.map((zoneId) => historicalAggregates.queryZoneDensity(zoneId, { timestamp }))
    : [];
  const candidates = [cellQuery, ...zoneQueries].filter(Boolean);
  return candidates.reduce((best, query) => {
    const density = clamp01(query.density || 0);
    if (density > best.density) {
      return {
        density,
        sampleCount: toFiniteNumber(query.count ?? query.metadata?.sampleCount, 0),
      };
    }
    return best;
  }, { density: 0, sampleCount: 0 });
}

function getTravelCost(cell, options) {
  if (typeof options?.travelCostProvider === "function") {
    return clamp01(options.travelCostProvider(cell));
  }

  if (options?.travelCostByCell && typeof options.travelCostByCell === "object") {
    return clamp01(options.travelCostByCell[cell.id]);
  }

  return clamp01(options?.travelCost || 0);
}

function getHeuristicConfidenceScore({ gridConfidence, clusterConfidence, historicalSampleCount, fieldCellCount }) {
  const historicalScore = clamp01(Math.log2(historicalSampleCount + 1) / 8);
  const coverageScore = clamp01(fieldCellCount / 48);
  return round4(clamp01(gridConfidence * 0.46 + clusterConfidence * 0.22 + historicalScore * 0.18 + coverageScore * 0.14));
}

function getEmptyClusterMetadata() {
  return {
    clusterCount: 0,
    avgClusterSize: 0,
    algorithmUsed: null,
    gridResolution: null,
    smoothingSigma: 0,
    sampleCount: 0,
    heuristicConfidenceScore: 0,
  };
}

function generateOpportunityField(samples, options = {}) {
  const gridResult = generateOpportunityGrid(samples, options);
  const weights = normalizeWeights(options.weights);
  const clusterBundle = getClusterBundle(samples, options);
  const clusters = Array.isArray(clusterBundle.clusters) ? clusterBundle.clusters : [];
  const clusterById = getClusterById(clusters);
  const maxClusterCount = clusters.reduce((max, cluster) => Math.max(max, cluster.stats?.sampleCount || 0), 0);
  const clusterMetadata = clusterBundle.metadata || getEmptyClusterMetadata();
  let historicalSampleCount = 0;

  // The field combines recent, recurring, zone, and travel-cost terms as a transparent heuristic surface rather than a causal forecast.
  const field = gridResult.grid.map((cell) => {
    const zoneIds = clusterBundle.spatialIndex
      ? queryZoneClusterIndex(clusterBundle.spatialIndex, { lat: cell.lat, lng: cell.lng })
      : [];
    const historical = queryHistoricalDensity(options.historicalAggregates, cell, zoneIds, gridResult.metadata.timestamp);
    historicalSampleCount += historical.sampleCount;
    const recentDensity = clamp01(cell.value);
    const historicalDensity = clamp01(historical.density);
    const zoneBoost = getZoneBoost(zoneIds, clusterById, maxClusterCount);
    const travelCost = getTravelCost(cell, options);
    const opportunity = clamp01(
      weights.recentDensity * recentDensity
      + weights.historicalDensity * historicalDensity
      + weights.zoneBoost * zoneBoost
      - weights.travelCost * travelCost
    );

    return {
      id: cell.id,
      lat: cell.lat,
      lng: cell.lng,
      opportunity: round6(opportunity),
      recentDensity: round6(recentDensity),
      historicalDensity: round6(historicalDensity),
      zoneBoost: round6(zoneBoost),
      travelCost: round6(travelCost),
      zoneIds,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    field,
    grid: gridResult.grid,
    clusters,
    metadata: {
      weights,
      gridResolution: gridResult.metadata.gridResolution,
      smoothingSigma: gridResult.metadata.smoothingSigma,
      sampleCount: gridResult.metadata.sampleCount,
      timestamp: gridResult.metadata.timestamp,
      heuristicConfidenceScore: getHeuristicConfidenceScore({
        gridConfidence: gridResult.metadata.heuristicConfidenceScore,
        clusterConfidence: clusterMetadata.heuristicConfidenceScore || 0,
        historicalSampleCount,
        fieldCellCount: field.length,
      }),
    },
    components: {
      grid: gridResult.metadata,
      clusters: clusterMetadata,
    },
  };
}

export {
  DEFAULT_FIELD_WEIGHTS,
  generateOpportunityField,
};