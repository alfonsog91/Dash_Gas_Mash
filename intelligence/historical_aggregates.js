const HOURS_PER_WEEK = 168;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = HOURS_PER_WEEK * HOUR_MS;
const DEFAULT_RETENTION_WEEKS = 8;

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

function normalizeHourOfWeek(value) {
  const hour = Math.floor(toFiniteNumber(value, Number.NaN));
  return Number.isFinite(hour) ? ((hour % HOURS_PER_WEEK) + HOURS_PER_WEEK) % HOURS_PER_WEEK : null;
}

function getHourBucket(timestampMs) {
  const bucketStartMs = Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
  const date = new Date(bucketStartMs);
  const hourOfWeek = date.getUTCDay() * 24 + date.getUTCHours();
  return { bucketStartMs, hourOfWeek };
}

function getWeekStartMs(bucketStartMs) {
  return Math.floor(bucketStartMs / WEEK_MS) * WEEK_MS;
}

function getBucketFromSample(sample, fallbackTimestampMs) {
  const explicitHour = normalizeHourOfWeek(sample?.hourOfWeek ?? sample?.bucket ?? sample?.bucketHourOfWeek);
  const timestampMs = normalizeTimestampMs(sample?.timestamp ?? sample?.bucketTimestamp ?? sample?.updatedAt ?? fallbackTimestampMs);
  if (timestampMs !== null) {
    const bucket = getHourBucket(timestampMs);
    return explicitHour === null ? bucket : { ...bucket, hourOfWeek: explicitHour };
  }

  if (explicitHour !== null) {
    return { bucketStartMs: null, hourOfWeek: explicitHour };
  }

  return null;
}

function normalizeKey(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const key = String(value).trim();
  return key ? key : null;
}

function getSampleCount(sample) {
  return Math.max(0, toFiniteNumber(sample?.count ?? sample?.sampleCount, 1));
}

function getSampleAvgEV(sample) {
  return Math.max(0, toFiniteNumber(
    sample?.aggregateEV
      ?? sample?.avgEV
      ?? sample?.expectedValue
      ?? sample?.value,
    0
  ));
}

function makeEntryKey(kind, id, hourOfWeek, bucketStartMs) {
  const weekStartMs = bucketStartMs === null ? "rolling" : getWeekStartMs(bucketStartMs);
  return `${kind}:${id}|hour:${hourOfWeek}|week:${weekStartMs}`;
}

function createEmptyEntry(kind, id, hourOfWeek, bucketStartMs) {
  return {
    kind,
    id,
    hourOfWeek,
    bucketStartMs,
    count: 0,
    aggregateEV: 0,
  };
}

function cloneEntry(entry) {
  return {
    kind: entry.kind,
    id: entry.id,
    hourOfWeek: entry.hourOfWeek,
    bucketStartMs: entry.bucketStartMs,
    count: round6(entry.count),
    aggregateEV: round6(entry.aggregateEV),
  };
}

function getHeuristicConfidenceScore({ count, matchingBucketCount }) {
  const supportScore = clamp01(Math.log2(count + 1) / 8);
  const recurrenceScore = clamp01(matchingBucketCount / 6);
  return round4(clamp01(0.2 + supportScore * 0.5 + recurrenceScore * 0.3));
}

function normalizeRetentionWeeks(value) {
  const weeks = Math.floor(toFiniteNumber(value, DEFAULT_RETENTION_WEEKS));
  return weeks > 0 ? weeks : DEFAULT_RETENTION_WEEKS;
}

function parseSerializedState(serialized) {
  if (!serialized) {
    return null;
  }
  if (typeof serialized === "string") {
    try {
      return JSON.parse(serialized);
    } catch {
      return null;
    }
  }
  return typeof serialized === "object" ? serialized : null;
}

function createHistoricalAggregateCache({ retentionWeeks = DEFAULT_RETENTION_WEEKS, initialState = null, now = null } = {}) {
  const normalizedRetentionWeeks = normalizeRetentionWeeks(retentionWeeks);
  const entries = new Map();

  function getEntries(kind, id, hourOfWeek = null) {
    return [...entries.values()].filter((entry) => {
      return entry.kind === kind
        && entry.id === id
        && (hourOfWeek === null || entry.hourOfWeek === hourOfWeek);
    });
  }

  function upsertEntry(kind, id, bucket, count, avgEV) {
    const key = makeEntryKey(kind, id, bucket.hourOfWeek, bucket.bucketStartMs);
    const entry = entries.get(key) || createEmptyEntry(kind, id, bucket.hourOfWeek, bucket.bucketStartMs);
    const nextCount = entry.count + count;
    const nextEVSum = entry.aggregateEV * entry.count + avgEV * count;
    entry.count = nextCount;
    entry.aggregateEV = nextCount > 0 ? nextEVSum / nextCount : 0;
    entries.set(key, entry);
  }

  function ingest(samples, options = {}) {
    const fallbackTimestampMs = normalizeTimestampMs(options.timestamp ?? now);
    let ingested = 0;
    for (const sample of Array.isArray(samples) ? samples : []) {
      const count = getSampleCount(sample);
      if (count <= 0) {
        continue;
      }

      const bucket = getBucketFromSample(sample, fallbackTimestampMs);
      if (!bucket) {
        continue;
      }

      const zoneId = normalizeKey(sample?.zoneId ?? sample?.zoneKey);
      const cellId = normalizeKey(sample?.gridCellId ?? sample?.cellId ?? sample?.gridId);
      const avgEV = getSampleAvgEV(sample);
      if (zoneId) {
        upsertEntry("zone", zoneId, bucket, count, avgEV);
      }
      if (cellId) {
        upsertEntry("cell", cellId, bucket, count, avgEV);
      }
      if (zoneId || cellId) {
        ingested += 1;
      }
    }

    enforceRetentionPolicy({ now: options.now ?? now });
    return { ingested, storedEntryCount: entries.size };
  }

  function getRelativeDensity(kind, id, hourOfWeek, count) {
    const peerCounts = [...entries.values()]
      .filter((entry) => entry.kind === kind && entry.hourOfWeek === hourOfWeek)
      .map((entry) => entry.count);
    const maxCount = Math.max(...peerCounts, count, 0);
    return maxCount > 0 ? round6(count / maxCount) : 0;
  }

  function query(kind, idInput, options = {}) {
    const id = normalizeKey(idInput);
    const timestampMs = normalizeTimestampMs(options.timestamp ?? options.now ?? now);
    const explicitHour = normalizeHourOfWeek(options.hourOfWeek ?? options.bucket ?? options.bucketHourOfWeek);
    const hourOfWeek = explicitHour ?? (timestampMs === null ? null : getHourBucket(timestampMs).hourOfWeek);
    if (!id || hourOfWeek === null) {
      return {
        id,
        hourOfWeek,
        count: 0,
        density: 0,
        avgEV: 0,
        metadata: {
          gridResolution: null,
          smoothingSigma: 0,
          sampleCount: 0,
          heuristicConfidenceScore: 0,
        },
      };
    }

    const matches = getEntries(kind, id, hourOfWeek);
    const count = matches.reduce((sum, entry) => sum + entry.count, 0);
    const evSum = matches.reduce((sum, entry) => sum + entry.aggregateEV * entry.count, 0);
    return {
      id,
      hourOfWeek,
      count: round6(count),
      density: getRelativeDensity(kind, id, hourOfWeek, count),
      avgEV: round4(count > 0 ? evSum / count : 0),
      metadata: {
        gridResolution: null,
        smoothingSigma: 0,
        sampleCount: round6(count),
        heuristicConfidenceScore: getHeuristicConfidenceScore({ count, matchingBucketCount: matches.length }),
      },
    };
  }

  function queryZoneDensity(zoneId, options = {}) {
    return query("zone", zoneId, options);
  }

  function queryGridCellDensity(cellId, options = {}) {
    return query("cell", cellId, options);
  }

  function enforceRetentionPolicy(options = {}) {
    const nowMs = normalizeTimestampMs(options.now ?? now);
    if (nowMs === null) {
      return { removed: 0, retained: entries.size };
    }

    const cutoffMs = nowMs - normalizedRetentionWeeks * WEEK_MS;
    let removed = 0;
    for (const [key, entry] of entries.entries()) {
      if (entry.bucketStartMs !== null && entry.bucketStartMs < cutoffMs) {
        entries.delete(key);
        removed += 1;
      }
    }
    return { removed, retained: entries.size };
  }

  function getSnapshot() {
    return {
      version: 1,
      retentionWeeks: normalizedRetentionWeeks,
      entries: [...entries.values()].map(cloneEntry).sort((left, right) => {
        return left.kind.localeCompare(right.kind)
          || left.id.localeCompare(right.id)
          || left.hourOfWeek - right.hourOfWeek
          || (left.bucketStartMs ?? 0) - (right.bucketStartMs ?? 0);
      }),
    };
  }

  function serialize() {
    return JSON.stringify(getSnapshot());
  }

  function loadState(stateInput) {
    const state = parseSerializedState(stateInput);
    if (!state || !Array.isArray(state.entries)) {
      return { loaded: 0 };
    }

    entries.clear();
    for (const entry of state.entries) {
      const kind = entry?.kind === "zone" || entry?.kind === "cell" ? entry.kind : null;
      const id = normalizeKey(entry?.id);
      const hourOfWeek = normalizeHourOfWeek(entry?.hourOfWeek);
      const bucketStartMs = normalizeTimestampMs(entry?.bucketStartMs);
      const count = Math.max(0, toFiniteNumber(entry?.count, 0));
      const aggregateEV = Math.max(0, toFiniteNumber(entry?.aggregateEV, 0));
      if (!kind || !id || hourOfWeek === null || count <= 0) {
        continue;
      }
      const safeEntry = {
        kind,
        id,
        hourOfWeek,
        bucketStartMs,
        count,
        aggregateEV,
      };
      entries.set(makeEntryKey(kind, id, hourOfWeek, bucketStartMs), safeEntry);
    }
    return { loaded: entries.size };
  }

  // Hour-of-week bucketing intentionally collapses timestamps into coarse recurring aggregates, preserving privacy while approximating weekly demand rhythm.
  loadState(initialState);

  return {
    ingest,
    queryZoneDensity,
    queryGridCellDensity,
    enforceRetentionPolicy,
    getSnapshot,
    serialize,
  };
}

function deserializeHistoricalAggregateCache(serialized, options = {}) {
  const state = parseSerializedState(serialized);
  return createHistoricalAggregateCache({
    ...options,
    retentionWeeks: options.retentionWeeks ?? state?.retentionWeeks ?? DEFAULT_RETENTION_WEEKS,
    initialState: state,
  });
}

export {
  DEFAULT_RETENTION_WEEKS,
  HOURS_PER_WEEK,
  createHistoricalAggregateCache,
  deserializeHistoricalAggregateCache,
};