import {
  createHistoricalAggregateCache,
  deserializeHistoricalAggregateCache,
} from "../../intelligence/historical_aggregates.js";

const PASS = "PASS";
const FAIL = "FAIL";
const MONDAY_18_UTC = Date.UTC(2026, 4, 25, 18, 20, 0);
const NEXT_MONDAY_18_UTC = MONDAY_18_UTC + 7 * 24 * 60 * 60 * 1000;

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

export function runHistoricalAggregatesTests() {
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

  log.write("DGM historical aggregate tests");

  runTest("ingests only aggregate fields and queries zone density", () => {
    const cache = createHistoricalAggregateCache({ retentionWeeks: 4, now: NEXT_MONDAY_18_UTC });
    const ingest = cache.ingest([
      { zoneId: "zone-1", gridCellId: "g:0:0", count: 4, aggregateEV: 0.7, timestamp: MONDAY_18_UTC, orderId: "raw-should-not-store" },
      { zoneId: "zone-1", gridCellId: "g:0:0", count: 2, aggregateEV: 0.4, timestamp: MONDAY_18_UTC, rawPayload: { secret: true } },
      { zoneId: "zone-2", gridCellId: "g:1:0", count: 3, aggregateEV: 0.5, timestamp: MONDAY_18_UTC },
    ]);
    assertEqual(ingest.ingested, 3, "all aggregate samples ingest");
    assertDeepEqual(cache.queryZoneDensity("zone-1", { timestamp: NEXT_MONDAY_18_UTC }), {
      id: "zone-1",
      hourOfWeek: 42,
      count: 6,
      density: 1,
      avgEV: 0.6,
      metadata: {
        gridResolution: null,
        smoothingSigma: 0,
        sampleCount: 6,
        heuristicConfidenceScore: 0.4255,
      },
    }, "zone density aggregates counts and weighted EV");
    assert(!cache.serialize().includes("raw-should-not-store"), "raw order id is never serialized");
    assert(!cache.serialize().includes("secret"), "raw payload content is never serialized");
  });

  runTest("queries grid cell density by hour-of-week bucket", () => {
    const cache = createHistoricalAggregateCache({ retentionWeeks: 4 });
    cache.ingest([
      { zoneId: "zone-1", gridCellId: "g:0:0", count: 5, aggregateEV: 0.8, timestamp: MONDAY_18_UTC },
      { zoneId: "zone-1", gridCellId: "g:0:1", count: 10, aggregateEV: 0.3, timestamp: MONDAY_18_UTC },
    ]);
    assertDeepEqual(cache.queryGridCellDensity("g:0:0", { hourOfWeek: 42 }), {
      id: "g:0:0",
      hourOfWeek: 42,
      count: 5,
      density: 0.5,
      avgEV: 0.8,
      metadata: {
        gridResolution: null,
        smoothingSigma: 0,
        sampleCount: 5,
        heuristicConfidenceScore: 0.4116,
      },
    }, "cell density is relative to peer cells in the same bucket");
  });

  runTest("retention policy removes old bucketed aggregates", () => {
    const now = Date.UTC(2026, 5, 29, 18, 0, 0);
    const cache = createHistoricalAggregateCache({ retentionWeeks: 2, now });
    cache.ingest([
      { zoneId: "old-zone", gridCellId: "old-cell", count: 2, aggregateEV: 0.9, timestamp: now - 21 * 24 * 60 * 60 * 1000 },
      { zoneId: "new-zone", gridCellId: "new-cell", count: 3, aggregateEV: 0.6, timestamp: now - 2 * 24 * 60 * 60 * 1000 },
    ], { now });
    const retention = cache.enforceRetentionPolicy({ now });
    assertEqual(retention.removed, 0, "old entries were already removed during ingest enforcement");
    assertEqual(cache.queryZoneDensity("old-zone", { timestamp: now - 21 * 24 * 60 * 60 * 1000 }).count, 0, "old zone is gone");
    assertEqual(cache.queryZoneDensity("new-zone", { timestamp: now - 2 * 24 * 60 * 60 * 1000 }).count, 3, "new zone remains");
  });

  runTest("serialization and deserialization preserve aggregate queries", () => {
    const cache = createHistoricalAggregateCache({ retentionWeeks: 6 });
    cache.ingest([
      { zoneId: "zone-9", gridCellId: "g:9:9", count: 7, aggregateEV: 0.55, timestamp: MONDAY_18_UTC },
    ]);
    const restored = deserializeHistoricalAggregateCache(cache.serialize());
    assertDeepEqual(restored.queryZoneDensity("zone-9", { hourOfWeek: 42 }), cache.queryZoneDensity("zone-9", { hourOfWeek: 42 }), "zone query survives serialization");
    assertDeepEqual(restored.queryGridCellDensity("g:9:9", { hourOfWeek: 42 }), cache.queryGridCellDensity("g:9:9", { hourOfWeek: 42 }), "cell query survives serialization");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} historical aggregate tests passed`
      : `${failed}/${passed + failed} historical aggregate tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runHistoricalAggregatesTests);
}