const EARTH_METERS_PER_DEGREE = 111320;
const DEFAULT_DECAY_WINDOW_MINUTES = 60;
const MAX_GRID_CELLS = 20000;

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

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function normalizeTimestampMs(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validatePositiveParam(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return number;
}

function getSampleValue(sample) {
  return toFiniteNumber(
    sample?.aggregateEV
      ?? sample?.avgEV
      ?? sample?.expectedValue
      ?? sample?.value
      ?? sample?.opportunity,
    0
  );
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
        timestampMs: normalizeTimestampMs(sample?.timestamp ?? sample?.bucketTimestamp ?? sample?.updatedAt),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const latDelta = left.lat - right.lat;
      if (Math.abs(latDelta) > 0.000000001) {
        return latDelta;
      }
      const lngDelta = left.lng - right.lng;
      if (Math.abs(lngDelta) > 0.000000001) {
        return lngDelta;
      }
      return left.index - right.index;
    });
}

function getReferenceTimestampMs(samples, options) {
  const requested = normalizeTimestampMs(options?.timestamp ?? options?.now);
  if (requested !== null) {
    return requested;
  }

  const sampleTimestamps = samples.map((sample) => sample.timestampMs).filter(isFiniteNumber);
  return sampleTimestamps.length ? Math.max(...sampleTimestamps) : 0;
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

function getDecayMultiplier(sample, referenceTimestampMs, decayWindow) {
  if (!isFiniteNumber(sample.timestampMs)) {
    return 1;
  }

  const ageMinutes = Math.max(0, (referenceTimestampMs - sample.timestampMs) / 60000);
  return Math.exp(-ageMinutes / decayWindow);
}

function getHeuristicConfidenceScore({ sampleCount, smoothingSigma, gridResolution, decayedSupport }) {
  const supportScore = clamp01(Math.log2(sampleCount + 1) / 7);
  const smoothingScore = clamp01(smoothingSigma / Math.max(1, gridResolution * 2));
  const decayScore = clamp01(decayedSupport / Math.max(1, sampleCount));
  return round4(clamp01(0.18 + supportScore * 0.42 + smoothingScore * 0.2 + decayScore * 0.2));
}

function createEmptyResult({ gridResolution, smoothingSigma, timestamp }) {
  return {
    grid: [],
    metadata: {
      gridResolution,
      smoothingSigma,
      sampleCount: 0,
      timestamp,
      heuristicConfidenceScore: 0,
    },
  };
}

function getGridBounds(projectedSamples, gridResolution, smoothingSigma) {
  const padding = Math.max(gridResolution, smoothingSigma * 2);
  const minX = Math.floor((Math.min(...projectedSamples.map((sample) => sample.x)) - padding) / gridResolution);
  const maxX = Math.ceil((Math.max(...projectedSamples.map((sample) => sample.x)) + padding) / gridResolution);
  const minY = Math.floor((Math.min(...projectedSamples.map((sample) => sample.y)) - padding) / gridResolution);
  const maxY = Math.ceil((Math.max(...projectedSamples.map((sample) => sample.y)) + padding) / gridResolution);
  return { minX, maxX, minY, maxY };
}

function generateOpportunityGrid(samples, options = {}) {
  const gridResolution = validatePositiveParam(options.gridResolution, "gridResolution");
  const smoothingSigma = validatePositiveParam(options.smoothingSigma, "smoothingSigma");
  const decayWindow = validatePositiveParam(options.decayWindow ?? DEFAULT_DECAY_WINDOW_MINUTES, "decayWindow");
  const normalizedSamples = normalizeSamples(samples);
  const timestamp = getReferenceTimestampMs(normalizedSamples, options);

  if (!normalizedSamples.length) {
    return createEmptyResult({ gridResolution, smoothingSigma, timestamp });
  }

  const origin = getWeightedOrigin(normalizedSamples);
  const projection = getProjection(origin);
  const projectedSamples = normalizedSamples.map((sample) => {
    const projected = projection.project(sample);
    const decay = getDecayMultiplier(sample, timestamp, decayWindow);
    return {
      ...sample,
      ...projected,
      decay,
      weightedValue: Math.max(0, sample.value) * sample.count * decay,
      weightedCount: sample.count * decay,
    };
  });
  const sampleCount = round6(normalizedSamples.reduce((sum, sample) => sum + sample.count, 0));
  const decayedSupport = projectedSamples.reduce((sum, sample) => sum + sample.weightedCount, 0);
  const { minX, maxX, minY, maxY } = getGridBounds(projectedSamples, gridResolution, smoothingSigma);
  const cellCount = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  if (cellCount > MAX_GRID_CELLS) {
    throw new RangeError(`opportunity grid would create ${cellCount} cells; reduce bounds or increase gridResolution`);
  }

  const sigmaSquared = smoothingSigma * smoothingSigma;
  const rawGrid = [];

  // Gaussian smoothing with exponential age decay approximates a continuous opportunity surface from anonymized aggregate samples.
  for (let ix = minX; ix < maxX; ix += 1) {
    for (let iy = minY; iy < maxY; iy += 1) {
      const x = (ix + 0.5) * gridResolution;
      const y = (iy + 0.5) * gridResolution;
      const rawValue = projectedSamples.reduce((sum, sample) => {
        const dx = x - sample.x;
        const dy = y - sample.y;
        const kernel = Math.exp(-((dx * dx + dy * dy) / (2 * sigmaSquared)));
        return sum + sample.weightedValue * kernel;
      }, 0);
      const localSupport = projectedSamples.reduce((sum, sample) => {
        const dx = x - sample.x;
        const dy = y - sample.y;
        const kernel = Math.exp(-((dx * dx + dy * dy) / (2 * sigmaSquared)));
        return sum + sample.weightedCount * kernel;
      }, 0);
      const center = projection.unproject({ x, y });
      rawGrid.push({
        id: `g:${ix}:${iy}`,
        x: ix,
        y: iy,
        lat: round6(center.lat),
        lng: round6(center.lng),
        rawValue,
        support: localSupport,
      });
    }
  }

  const maxRawValue = Math.max(...rawGrid.map((cell) => cell.rawValue), 0);
  const grid = rawGrid
    .map((cell) => ({
      id: cell.id,
      x: cell.x,
      y: cell.y,
      lat: cell.lat,
      lng: cell.lng,
      value: round6(maxRawValue > 0 ? cell.rawValue / maxRawValue : 0),
      rawValue: round6(cell.rawValue),
      support: round6(cell.support),
    }))
    .sort((left, right) => left.x - right.x || left.y - right.y || left.id.localeCompare(right.id));

  return {
    grid,
    metadata: {
      gridResolution,
      smoothingSigma,
      sampleCount,
      timestamp,
      heuristicConfidenceScore: getHeuristicConfidenceScore({
        sampleCount,
        smoothingSigma,
        gridResolution,
        decayedSupport,
      }),
    },
  };
}

export {
  generateOpportunityGrid,
};