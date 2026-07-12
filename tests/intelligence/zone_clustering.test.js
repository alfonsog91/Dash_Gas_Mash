import {
  ALGORITHM_USED,
  clusterOpportunityZones,
  queryZoneClusterIndex,
} from "../../intelligence/zone_clustering.js";

const PASS = "PASS";
const FAIL = "FAIL";

function createLogger() {
  const logEl = typeof document !== "undefined" ? document.getElementById("log") : null;
  const entries = [];
  return {
    write(message) {
      entries.push(message);
      if (logEl) {
        logEl.textContent = `${entries.join("\n")}\n`;
      }
      console.log(message);
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(fn, message) {
  let thrown = false;
  try {
    fn();
  } catch {
    thrown = true;
  }
  assert(thrown, message);
}

const CITY_SAMPLES = Object.freeze([
  Object.freeze({ lat: 34.0500, lng: -117.6500, count: 4, avgEV: 0.72, hour: 18 }),
  Object.freeze({ lat: 34.0504, lng: -117.6496, count: 3, avgEV: 0.64, hour: 18 }),
  Object.freeze({ lat: 34.0497, lng: -117.6503, count: 2, avgEV: 0.59, hour: 19 }),
  Object.freeze({ lat: 34.0600, lng: -117.6400, count: 5, avgEV: 0.48, hour: 12 }),
  Object.freeze({ lat: 34.0605, lng: -117.6404, count: 4, avgEV: 0.52, hour: 12 }),
  Object.freeze({ lat: 34.0597, lng: -117.6397, count: 3, avgEV: 0.44, hour: 13 }),
  Object.freeze({ lat: 34.0750, lng: -117.6200, count: 1, avgEV: 0.9, hour: 21 }),
]);

export function runZoneClusteringTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  function runTest(name, fn) {
    try {
      fn();
      passed += 1;
      log.write(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`${FAIL} ${name}: ${error.message}`);
    }
  }

  log.write("DGM zone clustering tests");

  runTest("invalid clustering params throw", () => {
    assertThrows(() => clusterOpportunityZones(CITY_SAMPLES, { eps: 0, minSamples: 3 }), "invalid eps throws");
    assertThrows(() => clusterOpportunityZones(CITY_SAMPLES, { eps: 160, minSamples: 0 }), "invalid minSamples throws");
  });

  runTest("deterministic DBSCAN-style clustering groups dense zones", () => {
    const result = clusterOpportunityZones(CITY_SAMPLES, { eps: 140, minSamples: 5 });
    assertEqual(result.metadata.algorithmUsed, ALGORITHM_USED, "algorithm id is exposed");
    assertEqual(result.metadata.clusterCount, 2, "two dense zones are found");
    assertEqual(result.noise.length, 1, "isolated point is noise");
    assertDeepEqual(result.clusters.map((cluster) => ({ id: cluster.id, stats: cluster.stats })), [
      { id: "zone-1", stats: { sampleCount: 9, avgEV: 0.6644, peakHour: 18 } },
      { id: "zone-2", stats: { sampleCount: 12, avgEV: 0.4833, peakHour: 12 } },
    ], "cluster stats are deterministic");
  });

  runTest("spatial index finds clusters by point lookup", () => {
    const result = clusterOpportunityZones(CITY_SAMPLES, { eps: 140, minSamples: 5 });
    assertDeepEqual(queryZoneClusterIndex(result.spatialIndex, { lat: 34.0501, lng: -117.6499 }), ["zone-1"], "first zone is queryable");
    assertDeepEqual(queryZoneClusterIndex(result.spatialIndex, { lat: 34.0601, lng: -117.6401 }), ["zone-2"], "second zone is queryable");
    assertDeepEqual(queryZoneClusterIndex(result.spatialIndex, { lat: 34.0750, lng: -117.6200 }), [], "noise is not indexed as a zone");
  });

  runTest("seeded synthetic city output stays stable", () => {
    const result = clusterOpportunityZones(CITY_SAMPLES, { eps: 140, minSamples: 5 });
    assertDeepEqual(result.metadata, {
      clusterCount: 2,
      avgClusterSize: 10.5,
      algorithmUsed: ALGORITHM_USED,
      gridResolution: 140,
      smoothingSigma: 0,
      sampleCount: 22,
      heuristicConfidenceScore: 0.5953,
    }, "metadata is stable");
    assertDeepEqual(result.clusters.map((cluster) => ({
      id: cluster.id,
      centroid: cluster.centroid,
      polygon: cluster.polygon,
    })), [
      {
        id: "zone-1",
        centroid: [-117.649933, 34.050067],
        polygon: [[-117.650573, 34.049474], [-117.649327, 34.049474], [-117.649327, 34.050626], [-117.650573, 34.050626]],
      },
      {
        id: "zone-2",
        centroid: [-117.640058, 34.060092],
        polygon: [[-117.640673, 34.059474], [-117.639427, 34.059474], [-117.639427, 34.060726], [-117.640673, 34.060726]],
      },
    ], "cluster hulls are stable");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} zone clustering tests passed`
      : `${failed}/${passed + failed} zone clustering tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runZoneClusteringTests);
}