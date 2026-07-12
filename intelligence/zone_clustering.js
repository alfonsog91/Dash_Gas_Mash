const EARTH_METERS_PER_DEGREE = 111320;
const ALGORITHM_USED = "deterministic-dbscan-eps-hull-v1";

function toFiniteNumber(value, fallback = null) {
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

function validatePositiveParam(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function validateMinSamples(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError("minSamples must be a positive finite number");
  }
  return number;
}

function getSampleValue(sample) {
  return toFiniteNumber(
    sample?.avgEV
      ?? sample?.aggregateEV
      ?? sample?.expectedValue
      ?? sample?.value
      ?? sample?.opportunity,
    0
  );
}

function normalizeHour(value) {
  const hour = Math.floor(toFiniteNumber(value, Number.NaN));
  return Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : null;
}

function normalizeSamples(samples) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample, index) => {
      const lat = toFiniteNumber(sample?.lat ?? sample?.latitude, null);
      const lng = toFiniteNumber(sample?.lng ?? sample?.lon ?? sample?.longitude, null);
      const count = Math.max(0, toFiniteNumber(sample?.count ?? sample?.sampleCount, 1));
      if (lat === null || lng === null || count <= 0 || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return null;
      }

      return {
        index,
        lat,
        lng,
        count,
        value: getSampleValue(sample),
        hour: normalizeHour(sample?.hour ?? sample?.peakHour ?? sample?.bucketHour),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.lat - right.lat || left.lng - right.lng || left.index - right.index);
}

function getWeightedOrigin(samples) {
  const totalCount = samples.reduce((sum, sample) => sum + sample.count, 0);
  if (totalCount <= 0) {
    return { lat: 0, lng: 0 };
  }

  return {
    lat: samples.reduce((sum, sample) => sum + sample.lat * sample.count, 0) / totalCount,
    lng: samples.reduce((sum, sample) => sum + sample.lng * sample.count, 0) / totalCount,
  };
}

function getProjection(origin) {
  const metersPerDegreeLng = Math.max(1, EARTH_METERS_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180));
  return {
    originLat: origin.lat,
    originLng: origin.lng,
    metersPerDegreeLng,
    project(point) {
      return {
        x: (point.lng - origin.lng) * metersPerDegreeLng,
        y: (point.lat - origin.lat) * EARTH_METERS_PER_DEGREE,
      };
    },
    unproject(point) {
      return {
        lat: origin.lat + point.y / EARTH_METERS_PER_DEGREE,
        lng: origin.lng + point.x / metersPerDegreeLng,
      };
    },
  };
}

function distanceMeters(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function getNeighbors(points, pointIndex, eps) {
  return points
    .map((point, index) => ({ index, point, distance: distanceMeters(points[pointIndex], point) }))
    .filter((entry) => entry.distance <= eps)
    .sort((left, right) => left.distance - right.distance || left.point.lat - right.point.lat || left.point.lng - right.point.lng || left.index - right.index)
    .map((entry) => entry.index);
}

function getNeighborhoodSupport(points, neighborIndexes) {
  return neighborIndexes.reduce((sum, index) => sum + points[index].count, 0);
}

function addUnique(queue, seen, indexes) {
  for (const index of indexes) {
    if (!seen.has(index)) {
      seen.add(index);
      queue.push(index);
    }
  }
}

function runDbscan(points, eps, minSamples) {
  const visited = new Set();
  const labels = new Map();
  const clusters = [];
  const noise = [];

  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    if (visited.has(pointIndex)) {
      continue;
    }

    visited.add(pointIndex);
    const neighbors = getNeighbors(points, pointIndex, eps);
    if (getNeighborhoodSupport(points, neighbors) < minSamples) {
      labels.set(pointIndex, -1);
      noise.push(pointIndex);
      continue;
    }

    const clusterIndex = clusters.length;
    const clusterPoints = [];
    const queue = [pointIndex];
    const queued = new Set(queue);
    addUnique(queue, queued, neighbors);

    while (queue.length) {
      const currentIndex = queue.shift();
      if (!visited.has(currentIndex)) {
        visited.add(currentIndex);
        const currentNeighbors = getNeighbors(points, currentIndex, eps);
        if (getNeighborhoodSupport(points, currentNeighbors) >= minSamples) {
          addUnique(queue, queued, currentNeighbors);
        }
      }

      if (!labels.has(currentIndex) || labels.get(currentIndex) === -1) {
        labels.set(currentIndex, clusterIndex);
        clusterPoints.push(currentIndex);
      }
    }

    clusters.push([...clusterPoints].sort((left, right) => left - right));
  }

  return {
    clusters,
    noise: noise.filter((pointIndex) => labels.get(pointIndex) === -1),
  };
}

function cross(origin, left, right) {
  return (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
}

function getConvexHull(points) {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y || left.lat - right.lat || left.lng - right.lng);
  if (sorted.length <= 1) {
    return sorted;
  }

  const lower = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }

  const upper = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function getBounds(points) {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function buildFallbackBox(points, eps) {
  const bounds = getBounds(points);
  const padding = Math.max(12, eps * 0.18);
  return [
    { x: bounds.minX - padding, y: bounds.minY - padding },
    { x: bounds.maxX + padding, y: bounds.minY - padding },
    { x: bounds.maxX + padding, y: bounds.maxY + padding },
    { x: bounds.minX - padding, y: bounds.maxY + padding },
  ];
}

function getPolygonAreaMeters(points) {
  if (points.length < 3) {
    return 0;
  }

  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function buildPolygon(points, projection, eps) {
  const hull = getConvexHull(points);
  const polygonPoints = hull.length >= 3 && getPolygonAreaMeters(hull) >= eps * eps * 0.06
    ? hull
    : buildFallbackBox(points, eps);
  return polygonPoints.map((point) => {
    const projected = projection.unproject(point);
    return [round6(projected.lng), round6(projected.lat)];
  });
}

function getPeakHour(points) {
  const countsByHour = new Map();
  for (const point of points) {
    if (point.hour === null) {
      continue;
    }
    countsByHour.set(point.hour, (countsByHour.get(point.hour) || 0) + point.count);
  }

  if (!countsByHour.size) {
    return null;
  }

  return [...countsByHour.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
}

function buildCluster(points, clusterPointIndexes, projection, eps, ordinal) {
  const clusterPoints = clusterPointIndexes.map((index) => points[index]);
  const sampleCount = clusterPoints.reduce((sum, point) => sum + point.count, 0);
  const weightedEV = clusterPoints.reduce((sum, point) => sum + point.value * point.count, 0);
  const bounds = getBounds(clusterPoints);
  const centroidProjected = {
    x: clusterPoints.reduce((sum, point) => sum + point.x * point.count, 0) / sampleCount,
    y: clusterPoints.reduce((sum, point) => sum + point.y * point.count, 0) / sampleCount,
  };
  const centroid = projection.unproject(centroidProjected);

  return {
    id: `zone-${ordinal}`,
    polygon: buildPolygon(clusterPoints, projection, eps),
    centroid: [round6(centroid.lng), round6(centroid.lat)],
    stats: {
      sampleCount: round6(sampleCount),
      avgEV: round4(sampleCount > 0 ? weightedEV / sampleCount : 0),
      peakHour: getPeakHour(clusterPoints),
    },
    bboxMeters: {
      minX: round6(bounds.minX),
      maxX: round6(bounds.maxX),
      minY: round6(bounds.minY),
      maxY: round6(bounds.maxY),
    },
  };
}

function getBucketKey(ix, iy) {
  return `${ix}:${iy}`;
}

function addBucketEntry(buckets, ix, iy, clusterId) {
  const key = getBucketKey(ix, iy);
  if (!buckets[key]) {
    buckets[key] = [];
  }
  if (!buckets[key].includes(clusterId)) {
    buckets[key].push(clusterId);
    buckets[key].sort();
  }
}

function buildSpatialIndex(clusters, projection, eps) {
  const cellSizeMeters = eps;
  const buckets = {};
  const indexClusters = clusters.map((cluster) => {
    const expanded = {
      minX: cluster.bboxMeters.minX - eps * 0.5,
      maxX: cluster.bboxMeters.maxX + eps * 0.5,
      minY: cluster.bboxMeters.minY - eps * 0.5,
      maxY: cluster.bboxMeters.maxY + eps * 0.5,
    };
    const minIx = Math.floor(expanded.minX / cellSizeMeters);
    const maxIx = Math.floor(expanded.maxX / cellSizeMeters);
    const minIy = Math.floor(expanded.minY / cellSizeMeters);
    const maxIy = Math.floor(expanded.maxY / cellSizeMeters);
    for (let ix = minIx; ix <= maxIx; ix += 1) {
      for (let iy = minIy; iy <= maxIy; iy += 1) {
        addBucketEntry(buckets, ix, iy, cluster.id);
      }
    }
    return {
      id: cluster.id,
      polygon: cluster.polygon,
      centroid: cluster.centroid,
      bboxMeters: cluster.bboxMeters,
    };
  });

  return {
    cellSizeMeters,
    origin: {
      lat: round6(projection.originLat),
      lng: round6(projection.originLng),
      metersPerDegreeLng: round6(projection.metersPerDegreeLng),
    },
    buckets,
    clusters: indexClusters,
  };
}

function getHeuristicConfidenceScore({ sampleCount, clusterCount, noiseCount }) {
  const supportScore = clamp01(Math.log2(sampleCount + 1) / 7);
  const clusterScore = clamp01(clusterCount / 6);
  const noisePenalty = clamp01(noiseCount / Math.max(1, sampleCount)) * 0.18;
  return round4(clamp01(0.22 + supportScore * 0.48 + clusterScore * 0.22 - noisePenalty));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = ((yi > point.lat) !== (yj > point.lat))
      && point.lng < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function projectWithIndex(spatialIndex, point) {
  const metersPerDegreeLng = spatialIndex?.origin?.metersPerDegreeLng;
  return {
    x: (point.lng - spatialIndex.origin.lng) * metersPerDegreeLng,
    y: (point.lat - spatialIndex.origin.lat) * EARTH_METERS_PER_DEGREE,
  };
}

function queryZoneClusterIndex(spatialIndex, point) {
  const lat = toFiniteNumber(point?.lat ?? point?.latitude, null);
  const lng = toFiniteNumber(point?.lng ?? point?.lon ?? point?.longitude, null);
  if (!spatialIndex || lat === null || lng === null || !spatialIndex.origin || !spatialIndex.cellSizeMeters) {
    return [];
  }

  const projected = projectWithIndex(spatialIndex, { lat, lng });
  const ix = Math.floor(projected.x / spatialIndex.cellSizeMeters);
  const iy = Math.floor(projected.y / spatialIndex.cellSizeMeters);
  const candidateIds = new Set();
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const clusterId of spatialIndex.buckets?.[getBucketKey(ix + dx, iy + dy)] || []) {
        candidateIds.add(clusterId);
      }
    }
  }

  return [...candidateIds]
    .map((clusterId) => spatialIndex.clusters.find((cluster) => cluster.id === clusterId))
    .filter(Boolean)
    .filter((cluster) => pointInPolygon({ lat, lng }, cluster.polygon))
    .map((cluster) => cluster.id)
    .sort();
}

function clusterOpportunityZones(samples, { eps, minSamples } = {}) {
  const normalizedEps = validatePositiveParam(eps, "eps");
  const normalizedMinSamples = validateMinSamples(minSamples);
  const normalizedSamples = normalizeSamples(samples);
  const sampleCount = round6(normalizedSamples.reduce((sum, sample) => sum + sample.count, 0));
  if (!normalizedSamples.length) {
    return {
      clusters: [],
      noise: [],
      spatialIndex: buildSpatialIndex([], getProjection({ lat: 0, lng: 0 }), normalizedEps),
      metadata: {
        clusterCount: 0,
        avgClusterSize: 0,
        algorithmUsed: ALGORITHM_USED,
        gridResolution: normalizedEps,
        smoothingSigma: 0,
        sampleCount: 0,
        heuristicConfidenceScore: 0,
      },
    };
  }

  const projection = getProjection(getWeightedOrigin(normalizedSamples));
  const projectedSamples = normalizedSamples.map((sample) => ({ ...sample, ...projection.project(sample) }));
  const clustered = runDbscan(projectedSamples, normalizedEps, normalizedMinSamples);

  // DBSCAN neighborhoods use weighted aggregate counts and hulls use a simplified convex/bounding polygon, so zones are stable approximations rather than exact service boundaries.
  const clusters = clustered.clusters.map((clusterPointIndexes, index) => buildCluster(
    projectedSamples,
    clusterPointIndexes,
    projection,
    normalizedEps,
    index + 1
  ));
  const noise = clustered.noise.map((pointIndex) => ({
    lat: round6(projectedSamples[pointIndex].lat),
    lng: round6(projectedSamples[pointIndex].lng),
    sampleCount: round6(projectedSamples[pointIndex].count),
  }));
  const clusterCount = clusters.length;
  const avgClusterSize = clusterCount > 0
    ? round4(clusters.reduce((sum, cluster) => sum + cluster.stats.sampleCount, 0) / clusterCount)
    : 0;

  return {
    clusters,
    noise,
    spatialIndex: buildSpatialIndex(clusters, projection, normalizedEps),
    metadata: {
      clusterCount,
      avgClusterSize,
      algorithmUsed: ALGORITHM_USED,
      gridResolution: normalizedEps,
      smoothingSigma: 0,
      sampleCount,
      heuristicConfidenceScore: getHeuristicConfidenceScore({
        sampleCount,
        clusterCount,
        noiseCount: noise.reduce((sum, point) => sum + point.sampleCount, 0),
      }),
    },
  };
}

export {
  ALGORITHM_USED,
  clusterOpportunityZones,
  queryZoneClusterIndex,
};