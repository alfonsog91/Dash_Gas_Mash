import {
  ALGORITHM_USED,
  evaluateSuperpositionCandidate,
  evaluateSuperpositionEngine,
} from "../../intelligence/superposition_engine.js";

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

const FIXTURE_CANDIDATES = Object.freeze([
  Object.freeze({ orderId: "alpha", basePay: 12, pickupMinutes: 8, driveMinutes: 10, distanceKm: 6, zoneOpportunity: 0.7, arrivalRatePerMinute: 0.22 }),
  Object.freeze({ orderId: "bravo", basePay: 9, pickupMinutes: 5, driveMinutes: 7, distanceKm: 3, zoneOpportunity: 0.55, arrivalRatePerMinute: 0.16 }),
  Object.freeze({ orderId: "charlie", basePay: 16, pickupMinutes: 11, driveMinutes: 17, distanceKm: 10, zoneOpportunity: 0.8, arrivalRatePerMinute: 0.12 }),
]);

export function runSuperpositionEngineTests() {
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

  log.write("DGM superposition engine tests");

  runTest("deterministic fixture returns stable numeric outputs", () => {
    const result = evaluateSuperpositionEngine({ candidates: FIXTURE_CANDIDATES, searchDepth: 2 });
    assertEqual(result.length, 3, "all fixture candidates are scored");
    assertDeepEqual(
      result.map(({ orderId, basePayScore, timePenalty, distancePenalty, zoneOpportunity }) => ({
        orderId,
        basePayScore,
        timePenalty,
        distancePenalty,
        zoneOpportunity,
      })),
      [
        { orderId: "alpha", basePayScore: 0.5, timePenalty: 0.36, distancePenalty: 0.3333, zoneOpportunity: 0.7 },
        { orderId: "bravo", basePayScore: 0.375, timePenalty: 0.24, distancePenalty: 0.1667, zoneOpportunity: 0.55 },
        { orderId: "charlie", basePayScore: 0.6667, timePenalty: 0.56, distancePenalty: 0.5556, zoneOpportunity: 0.8 },
      ],
      "base score components are deterministic"
    );
    assertDeepEqual(
      result.map(({ orderId, futureEV, assignmentProbabilityEstimate }) => ({ orderId, futureEV, assignmentProbabilityEstimate })),
      [
        { orderId: "alpha", futureEV: 0.2196, assignmentProbabilityEstimate: 0.3527 },
        { orderId: "bravo", futureEV: 0.185, assignmentProbabilityEstimate: 0.3127 },
        { orderId: "charlie", futureEV: 0.1289, assignmentProbabilityEstimate: 0.3346 },
      ],
      "future EV outputs remain deterministic"
    );
  });

  runTest("metadata exposes approximation transparency", () => {
    const [first] = evaluateSuperpositionEngine({ candidates: FIXTURE_CANDIDATES, searchDepth: 2 });
    assertEqual(first.metadata.searchDepth, 2, "metadata includes search depth");
    assertEqual(first.metadata.candidateCount, 3, "metadata includes candidate count");
    assertEqual(first.metadata.algorithmUsed, ALGORITHM_USED, "metadata includes algorithm id");
    assert(Array.isArray(first.metadata.pruningRules), "metadata includes pruning rules");
    assert(first.metadata.pruningRules.length >= 2, "metadata includes more than one pruning rule");
    assert(first.metadata.heuristicConfidenceScore >= 0 && first.metadata.heuristicConfidenceScore <= 1, "confidence is bounded");
  });

  runTest("single-candidate API returns the same result shape", () => {
    const result = evaluateSuperpositionCandidate({ order: FIXTURE_CANDIDATES[0], candidates: FIXTURE_CANDIDATES.slice(1), searchDepth: 2 });
    assertEqual(result.orderId, "alpha", "candidate API preserves order id");
    assertEqual(result.metadata.algorithmUsed, ALGORITHM_USED, "candidate API exposes metadata");
  });

  runTest("Opportunity Field input deterministically adjusts futureEV", () => {
    const candidates = [
      { orderId: "near", basePay: 10, pickupMinutes: 6, driveMinutes: 9, distanceKm: 4, zoneOpportunity: 0.4, arrivalRatePerMinute: 0.18, lat: 34.0501, lng: -117.6501 },
      { orderId: "far", basePay: 10, pickupMinutes: 6, driveMinutes: 9, distanceKm: 4, zoneOpportunity: 0.4, arrivalRatePerMinute: 0.18, lat: 34.0600, lng: -117.6400 },
    ];
    const opportunityField = {
      field: [
        { id: "hot", lat: 34.05, lng: -117.65, opportunity: 0.9 },
        { id: "cool", lat: 34.06, lng: -117.64, opportunity: 0.2 },
      ],
    };
    const result = evaluateSuperpositionEngine({
      candidates,
      searchDepth: 2,
      opportunityField,
      opportunityFieldMaxDistanceMeters: 1200,
      weights: { opportunityField: 0.25 },
    });
    assertDeepEqual(
      result.map(({ orderId, opportunityFieldScore, futureEV, assignmentProbabilityEstimate }) => ({
        orderId,
        opportunityFieldScore,
        futureEV,
        assignmentProbabilityEstimate,
      })),
      [
        { orderId: "near", opportunityFieldScore: 0.8892, futureEV: 0.3076, assignmentProbabilityEstimate: 0.5361 },
        { orderId: "far", opportunityFieldScore: 0.2, futureEV: 0.1353, assignmentProbabilityEstimate: 0.4639 },
      ],
      "Opportunity Field score changes future EV deterministically"
    );
    assertDeepEqual(result.map((entry) => entry.metadata.opportunityField), [
      { applied: true, score: 0.8892, cellId: "hot", distanceMeters: 14.4566, source: "nearest-cell", appliedWeight: 0.25, candidateFieldCount: 2 },
      { applied: true, score: 0.2, cellId: "cool", distanceMeters: 0, source: "nearest-cell", appliedWeight: 0.25, candidateFieldCount: 2 },
    ], "Opportunity Field metadata explains the adapter signal");
  });

  runTest("old behavior remains stable without Opportunity Field input", () => {
    const baseline = evaluateSuperpositionEngine({ candidates: FIXTURE_CANDIDATES, searchDepth: 2 });
    const explicitMissing = evaluateSuperpositionEngine({ candidates: FIXTURE_CANDIDATES, searchDepth: 2, opportunityField: null });
    assertDeepEqual(explicitMissing, baseline, "missing Opportunity Field preserves legacy output");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} superposition engine tests passed`
      : `${failed}/${passed + failed} superposition engine tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runSuperpositionEngineTests);
}