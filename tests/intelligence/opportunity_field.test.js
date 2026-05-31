import { createHistoricalAggregateCache } from "../../intelligence/historical_aggregates.js";
import { generateOpportunityField } from "../../intelligence/opportunity_field.js";

const PASS = "PASS";
const FAIL = "FAIL";
const TIMESTAMP = 1_700_000_000_000;

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

const FIELD_SAMPLES = Object.freeze([
  Object.freeze({ lat: 34.0500, lng: -117.6500, count: 6, aggregateEV: 0.78, timestamp: TIMESTAMP, hourOfWeek: 157, zoneId: "zone-a", gridCellId: "g:-1:-1" }),
  Object.freeze({ lat: 34.0505, lng: -117.6495, count: 4, aggregateEV: 0.62, timestamp: TIMESTAMP - 120000, hourOfWeek: 157, zoneId: "zone-a", gridCellId: "g:0:0" }),
  Object.freeze({ lat: 34.0496, lng: -117.6504, count: 3, aggregateEV: 0.5, timestamp: TIMESTAMP - 240000, hourOfWeek: 157, zoneId: "zone-a", gridCellId: "g:-1:0" }),
]);

function createHistory() {
  const cache = createHistoricalAggregateCache({ retentionWeeks: 4 });
  cache.ingest([
    { zoneId: "zone-1", gridCellId: "g:-1:-1", count: 8, aggregateEV: 0.7, timestamp: TIMESTAMP },
    { zoneId: "zone-1", gridCellId: "g:0:0", count: 4, aggregateEV: 0.4, timestamp: TIMESTAMP },
  ]);
  return cache;
}

export function runOpportunityFieldTests() {
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

  log.write("DGM Opportunity Field tests");

  runTest("deterministic scoring combines recent historical zone and cost terms", () => {
    const result = generateOpportunityField(FIELD_SAMPLES, {
      gridResolution: 120,
      smoothingSigma: 140,
      decayWindow: 60,
      timestamp: TIMESTAMP,
      historicalAggregates: createHistory(),
      weights: { w1: 0.5, w2: 0.25, w3: 0.2, w4: 0.1 },
      travelCostByCell: { "g:-1:-1": 0.2, "g:0:0": 0.05 },
    });
    assertEqual(result.field.length, 36, "field cell count is stable");
    assertDeepEqual(result.metadata, {
      weights: { recentDensity: 0.5, historicalDensity: 0.25, zoneBoost: 0.2, travelCost: 0.1 },
      gridResolution: 120,
      smoothingSigma: 140,
      sampleCount: 13,
      timestamp: TIMESTAMP,
      heuristicConfidenceScore: 0.6737,
    }, "field metadata is stable");
    assertDeepEqual(
      result.field.filter((cell) => ["g:-1:-1", "g:0:0"].includes(cell.id)).map((cell) => ({
        id: cell.id,
        opportunity: cell.opportunity,
        recentDensity: cell.recentDensity,
        historicalDensity: cell.historicalDensity,
        zoneBoost: cell.zoneBoost,
        travelCost: cell.travelCost,
        zoneIds: cell.zoneIds,
      })),
      [
        { id: "g:-1:-1", opportunity: 0.876682, recentDensity: 0.986828, historicalDensity: 1, zoneBoost: 0.76634, travelCost: 0.2, zoneIds: ["zone-1"] },
        { id: "g:0:0", opportunity: 0.898268, recentDensity: 1, historicalDensity: 1, zoneBoost: 0.76634, travelCost: 0.05, zoneIds: ["zone-1"] },
      ],
      "selected cells score deterministically"
    );
  });

  runTest("parameter sensitivity changes weighted output", () => {
    const base = generateOpportunityField(FIELD_SAMPLES, {
      gridResolution: 120,
      smoothingSigma: 140,
      decayWindow: 60,
      timestamp: TIMESTAMP,
      historicalAggregates: createHistory(),
      weights: { recentDensity: 0.2, historicalDensity: 0.1, zoneBoost: 0.1, travelCost: 0 },
    });
    const historicalHeavy = generateOpportunityField(FIELD_SAMPLES, {
      gridResolution: 120,
      smoothingSigma: 140,
      decayWindow: 60,
      timestamp: TIMESTAMP,
      historicalAggregates: createHistory(),
      weights: { recentDensity: 0.2, historicalDensity: 0.5, zoneBoost: 0.1, travelCost: 0 },
    });
    const cellId = "g:-1:-1";
    const baseCell = base.field.find((cell) => cell.id === cellId);
    const heavyCell = historicalHeavy.field.find((cell) => cell.id === cellId);
    assert(heavyCell.opportunity > baseCell.opportunity, "higher historical weight increases a historically dense cell");
  });

  runTest("missing historical input and missing clusters remain deterministic", () => {
    const result = generateOpportunityField(FIELD_SAMPLES, {
      gridResolution: 120,
      smoothingSigma: 140,
      decayWindow: 60,
      timestamp: TIMESTAMP,
      generateClusters: false,
      travelCost: 0,
    });
    const peak = result.field.reduce((best, cell) => cell.opportunity > best.opportunity ? cell : best, result.field[0]);
    assert(peak.opportunity > 0, "recent density still drives the field");
    assertEqual(peak.historicalDensity, 0, "missing historical density is zero");
    assertEqual(peak.zoneBoost, 0, "missing clusters produce zero zone boost");
    assertEqual(peak.travelCost, 0, "zero travel-cost case is explicit");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} Opportunity Field tests passed`
      : `${failed}/${passed + failed} Opportunity Field tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runOpportunityFieldTests);
}