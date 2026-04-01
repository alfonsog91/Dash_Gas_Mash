import {
  PROBABILITY_HORIZON_MINUTES,
  buildDemandCoverageNodes,
  haversineMeters,
  scorePointAgainstRestaurants,
  probabilityOfGoodOrder,
  buildGridProbabilityHeat,
  filterOpenRestaurants,
  isOpenNow,
  timeBucket,
  rankParking,
  topLikelyMerchantsForParking,
} from "../model.js";
import {
  evaluateParkingCoverage,
  selectParkingSetSubmodular,
} from "../optimizer.js";
import {
  brierScore,
  expectedCalibrationError,
  generateSyntheticPredictionDataset,
} from "../learned_predictor.js";

const PASS = "\u2705";
const FAIL = "\u274c";
let total = 0;
let passed = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    log(`${PASS} ${label}`);
  } else {
    log(`${FAIL} ${label}`);
  }
}

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

function log(msg) {
  if (typeof document !== "undefined") {
    const el = document.getElementById("log");
    if (el) {
      el.textContent += msg + "\n";
    }
  }
  console.log(msg);
}

// ─── Baseline fixtures ────────────────────────────────────────

const fixtureRestaurants = [
  { lat: 34.1060, lon: -117.5930, tags: { amenity: "restaurant", cuisine: "sushi", name: "Sushi Place" } },
  { lat: 34.1070, lon: -117.5920, tags: { amenity: "fast_food", cuisine: "burger", name: "Burger Joint" } },
  { lat: 34.1055, lon: -117.5940, tags: { amenity: "cafe", name: "Morning Cafe" } },
  { lat: 34.1080, lon: -117.5910, tags: { amenity: "restaurant", cuisine: "italian", name: "Italian Bistro" } },
  { lat: 34.1045, lon: -117.5950, tags: { amenity: "fast_food", cuisine: "chicken", name: "Chicken Stop" } },
];

const fixtureParking = [
  { lat: 34.1062, lon: -117.5932, tags: { amenity: "parking" } },
  { lat: 34.1075, lon: -117.5915, tags: { amenity: "parking" } },
];

const baseParams = {
  tauMeters: 1200,
  hour: 14,
  horizonMin: 10,
  competitionStrength: 0.35,
  rainBoost: 0,
  tipEmphasis: 0.55,
  useML: false,
  mlBeta: 2.0,
};

// Pre-compute a baseline result to compare against.
// This is computed once and the test verifies subsequent calls produce identical outputs.
function computeBaselineResult() {
  return probabilityOfGoodOrder(
    { lat: 34.1064, lon: -117.5931 },
    fixtureRestaurants,
    fixtureParking,
    { ...baseParams, lambdaRef: 1.0 }
  );
}

// ─── Test suites ──────────────────────────────────────────────

function testHaversine() {
  log("\n--- Haversine ---");
  const d = haversineMeters(34.1064, -117.5931, 34.1070, -117.5920);
  assert(typeof d === "number" && d > 0, "haversine returns positive number");
  assert(d > 50 && d < 300, `haversine distance reasonable: ${d.toFixed(1)}m`);
  const dSelf = haversineMeters(34.1064, -117.5931, 34.1064, -117.5931);
  assert(approx(dSelf, 0, 0.1), "haversine self-distance is 0");
}

function testTimeBucket() {
  log("\n--- Time Bucket (\u00a73 Temporal Structure) ---");
  const buckets = new Set();
  for (let h = 0; h < 24; h++) {
    const b = timeBucket(h);
    assert(typeof b.name === "string" && b.name.length > 0, `hour ${h}: has name '${b.name}'`);
    assert(typeof b.label === "string", `hour ${h}: has label`);
    assert(b.wI >= 0 && b.wM >= 0 && b.wR >= 0 && b.wD >= 0, `hour ${h}: weights non-negative`);
    buckets.add(b.name);
  }
  assert(buckets.size >= 5, `disjoint buckets cover 24h (${buckets.size} distinct)`);
}

function testNonNegativity() {
  log("\n--- Non-negativity (\u00a71 I-1) ---");
  const r = computeBaselineResult();
  assert(r.pGood >= 0, `pGood >= 0: ${r.pGood}`);
  assert(r.pAny >= 0, `pAny >= 0: ${r.pAny}`);
  assert(r.composite >= 0, `composite >= 0: ${r.composite}`);
  assert(r.quality >= 0, `quality >= 0: ${r.quality}`);
  assert(r.signals.I >= 0, `signal I >= 0`);
  assert(r.signals.M >= 0, `signal M >= 0`);
  assert(r.signals.R >= 0, `signal R >= 0`);
  assert(r.signals.D >= 0, `signal D >= 0`);
  assert(r.pGood_low >= 0, `pGood_low >= 0: ${r.pGood_low}`);
  assert(r.pGood_high >= 0, `pGood_high >= 0: ${r.pGood_high}`);
}

function testOrderPreservation() {
  log("\n--- Order Preservation (\u00a71 I-2) ---");
  const r1 = probabilityOfGoodOrder(
    { lat: 34.1064, lon: -117.5931 },
    fixtureRestaurants,
    fixtureParking,
    { ...baseParams, lambdaRef: 1.0 }
  );
  // Point far from all restaurants should score lower.
  const r2 = probabilityOfGoodOrder(
    { lat: 34.2000, lon: -117.7000 },
    fixtureRestaurants,
    fixtureParking,
    { ...baseParams, lambdaRef: 1.0 }
  );
  assert(r1.pGood >= r2.pGood, `closer point scores >= distant point: ${r1.pGood.toFixed(4)} >= ${r2.pGood.toFixed(4)}`);
  assert(r1.merchantIntensity >= r2.merchantIntensity, "closer point has higher merchant intensity");
}

function testSignalIndependence() {
  log("\n--- Signal Independence (\u00a72 S-1, S-3) ---");
  const r = computeBaselineResult();
  // Each signal is in [0,1] (S-2 normalization).
  assert(r.signals.I >= 0 && r.signals.I <= 1, `I in [0,1]: ${r.signals.I}`);
  assert(r.signals.M >= 0 && r.signals.M <= 1, `M in [0,1]: ${r.signals.M}`);
  assert(r.signals.R >= 0 && r.signals.R <= 1, `R in [0,1]: ${r.signals.R}`);
  assert(r.signals.D >= 0 && r.signals.D <= 1, `D in [0,1]: ${r.signals.D}`);
}

function testDeterminism() {
  log("\n--- Determinism (runtime invariance) ---");
  const r1 = computeBaselineResult();
  const r2 = computeBaselineResult();
  assert(r1.pGood === r2.pGood, "pGood identical across calls");
  assert(r1.pAny === r2.pAny, "pAny identical across calls");
  assert(r1.composite === r2.composite, "composite identical across calls");
  assert(r1.advisory === r2.advisory, "advisory identical across calls");
  assert(r1.signals.I === r2.signals.I, "signal I identical");
  assert(r1.signals.M === r2.signals.M, "signal M identical");
  assert(r1.signals.R === r2.signals.R, "signal R identical");
  assert(r1.signals.D === r2.signals.D, "signal D identical");
}

function testNoActionabilitySemantics() {
  log("\n--- No Actionability (\u00a76, \u00a75) ---");
  const r = computeBaselineResult();
  // advisory is a string label only, not a function or action-bearing object.
  assert(typeof r.advisory === "string", "advisory is a string label");
  assert(r.advisory === "hold" || r.advisory === "rotate", `advisory is one of two bands: '${r.advisory}'`);
  // pGood is a number, not a recommendation object.
  assert(typeof r.pGood === "number", "pGood is a plain number, not an action");
  // No 'recommend', 'action', 'decision' keys in output.
  const keys = Object.keys(r);
  assert(!keys.includes("recommendation"), "no 'recommendation' key in output");
  assert(!keys.includes("action"), "no 'action' key in output");
  assert(!keys.includes("decision"), "no 'decision' key in output");
  assert(!keys.includes("command"), "no 'command' key in output");
}

function testPGoodBoundedByPAny() {
  log("\n--- pGood <= pAny (structural consistency) ---");
  const r = computeBaselineResult();
  assert(r.pGood <= r.pAny + 1e-9, `pGood (${r.pGood.toFixed(4)}) <= pAny (${r.pAny.toFixed(4)})`);
}

function testProbabilityContract() {
  log("\n--- Probability contract (10-minute field) ---");
  const r = computeBaselineResult();
  assert(r.horizonMin === PROBABILITY_HORIZON_MINUTES, `pGood horizon locked to ${PROBABILITY_HORIZON_MINUTES} minutes`);
  assert(r.pGood_low <= r.pGood_mid, `pGood_low <= pGood_mid (${r.pGood_low.toFixed(4)} <= ${r.pGood_mid.toFixed(4)})`);
  assert(r.pGood_mid <= r.pGood_high, `pGood_mid <= pGood_high (${r.pGood_mid.toFixed(4)} <= ${r.pGood_high.toFixed(4)})`);
  assert(typeof r.explain?.merchantShare === "string", "explain.merchantShare is human-readable text");
  assert(typeof r.explain?.residentialShare === "string", "explain.residentialShare is human-readable text");
  assert(typeof r.explain?.relativeIntensity === "string", "explain.relativeIntensity is human-readable text");
  assert(typeof r.explain?.rainLiftPercent === "string", "explain.rainLiftPercent is human-readable text");
}

function testGridHeatBaseline() {
  log("\n--- Grid heat baseline ---");
  // Minimal bounding box around fixtures.
  const bounds = {
    getSouth: () => 34.104,
    getNorth: () => 34.109,
    getWest: () => -117.596,
    getEast: () => -117.590,
  };
  const result = buildGridProbabilityHeat(bounds, fixtureRestaurants, fixtureParking, baseParams, 500);
  assert(Array.isArray(result.heatPoints), "heatPoints is an array");
  assert(result.heatPoints.length > 0, `heatPoints non-empty: ${result.heatPoints.length}`);
  assert(typeof result.stats === "object", "stats object returned");
  assert(typeof result.stats.lambdaRef === "number", "lambdaRef computed");
  assert(result.stats.lambdaRef > 0, "lambdaRef > 0");
  assert(result.stats.horizonMin === PROBABILITY_HORIZON_MINUTES, "heatmap stats report the fixed 10-minute horizon");
  // Every heat value should be non-negative (\u00a71 I-1).
  const allNonNeg = result.heatPoints.every(([, , v]) => v >= 0);
  assert(allNonNeg, "all heat values >= 0");
}

function testRankParkingDeterminism() {
  log("\n--- Rank parking determinism ---");
  const stats = { lambdaRef: 1.0 };
  const r1 = rankParking(fixtureParking, fixtureRestaurants, fixtureParking, baseParams, stats, 5);
  const r2 = rankParking(fixtureParking, fixtureRestaurants, fixtureParking, baseParams, stats, 5);
  assert(r1.length === r2.length, "same number of ranked results");
  if (r1.length > 0 && r2.length > 0) {
    assert(r1[0].pGood === r2[0].pGood, "top-ranked pGood identical");
  }
}

function testTopMerchantsDeterminism() {
  log("\n--- Top merchants determinism ---");
  const m1 = topLikelyMerchantsForParking(fixtureParking[0], fixtureRestaurants, 1200, 14, 3);
  const m2 = topLikelyMerchantsForParking(fixtureParking[0], fixtureRestaurants, 1200, 14, 3);
  assert(m1.length === m2.length, "same merchant count");
  if (m1.length > 0) {
    assert(m1[0].name === m2[0].name, "same top merchant name");
    assert(m1[0].distMeters === m2[0].distMeters, "same top merchant distance");
  }
}

function testOpeningHoursHelper() {
  log("\n--- Opening-hours eligibility ---");
  const lunchSpot = {
    lat: 34.1060,
    lon: -117.5930,
    tags: { amenity: "restaurant", name: "Lunch Only", opening_hours: "Mo-Su 10:00-22:00" },
  };
  const lateSpot = {
    lat: 34.1070,
    lon: -117.5920,
    tags: { amenity: "restaurant", name: "Late Spot", opening_hours: "Mo-Su 18:00-02:00" },
  };

  assert(isOpenNow(lunchSpot, new Date("2026-03-18T12:00:00")), "same-day hours open during service window");
  assert(!isOpenNow(lunchSpot, new Date("2026-03-18T23:00:00")), "same-day hours close after end time");
  assert(isOpenNow(lateSpot, new Date("2026-03-18T23:30:00")), "overnight hours open before midnight");
  assert(isOpenNow(lateSpot, new Date("2026-03-19T01:30:00")), "overnight hours stay open after midnight");
  assert(!isOpenNow(lateSpot, new Date("2026-03-19T03:00:00")), "overnight hours close after cutoff");
}

function testClosedRestaurantsExcludedFromPipeline() {
  log("\n--- Opening-hours pipeline exclusion ---");

  const openRestaurant = {
    lat: 34.1060,
    lon: -117.5930,
    tags: { amenity: "restaurant", cuisine: "sushi", name: "Open Sushi", opening_hours: "Mo-Su 10:00-22:00" },
  };
  const closedRestaurant = {
    lat: 34.1061,
    lon: -117.5931,
    tags: { amenity: "restaurant", cuisine: "steak", name: "Closed Steak", opening_hours: "Mo-Su 06:00-12:00" },
  };
  const currentTime = new Date("2026-03-18T19:30:00");
  const eligibleRestaurants = filterOpenRestaurants([openRestaurant, closedRestaurant], currentTime);

  assert(eligibleRestaurants.length === 1, "filter keeps only currently open restaurants");
  assert(eligibleRestaurants[0].tags.name === "Open Sushi", "closed restaurant removed from candidate set");

  const point = { lat: 34.1062, lon: -117.5932 };
  const stats = { lambdaRef: 1.0 };
  const mixedScore = probabilityOfGoodOrder(point, eligibleRestaurants, fixtureParking, { ...baseParams, lambdaRef: 1.0 });
  const openOnlyScore = probabilityOfGoodOrder(point, [openRestaurant], fixtureParking, { ...baseParams, lambdaRef: 1.0 });
  assert(approx(mixedScore.pGood, openOnlyScore.pGood), "filtered scoring matches open-only scoring exactly");

  const bounds = {
    getSouth: () => 34.1055,
    getNorth: () => 34.1065,
    getWest: () => -117.5935,
    getEast: () => -117.5925,
  };
  const mixedHeat = buildGridProbabilityHeat(bounds, eligibleRestaurants, fixtureParking, baseParams, 100);
  const openOnlyHeat = buildGridProbabilityHeat(bounds, [openRestaurant], fixtureParking, baseParams, 100);
  assert(mixedHeat.heatPoints.length === openOnlyHeat.heatPoints.length, "heat grid size unchanged after filtering");
  assert(
    mixedHeat.heatPoints.every((pointValue, index) => approx(pointValue[2], openOnlyHeat.heatPoints[index][2])),
    "heatmap inputs exclude closed restaurants"
  );

  const mixedRank = rankParking(fixtureParking, eligibleRestaurants, fixtureParking, baseParams, stats, 5);
  const openOnlyRank = rankParking(fixtureParking, [openRestaurant], fixtureParking, baseParams, stats, 5);
  assert(mixedRank.length === openOnlyRank.length, "ranked parking count preserved after filtering");
  assert(
    mixedRank.every((parkingSpot, index) => approx(parkingSpot.pGood, openOnlyRank[index].pGood)),
    "assignment ranking uses only open restaurants"
  );
}

function testResidentialDemandPromotion() {
  log("\n--- Residential demand promotion ---");

  const symmetricRestaurants = [
    { id: "node/rest-west", lat: 34.1005, lon: -117.5900, tags: { amenity: "restaurant", cuisine: "pizza", name: "West Pizza" } },
    { id: "node/rest-east", lat: 34.1005, lon: -117.5800, tags: { amenity: "restaurant", cuisine: "pizza", name: "East Pizza" } },
  ];
  const symmetricParking = [
    { id: "node/park-west", lat: 34.1000, lon: -117.5900, tags: { amenity: "parking" } },
    { id: "node/park-east", lat: 34.1000, lon: -117.5800, tags: { amenity: "parking" } },
  ];
  const localResidential = [
    { id: "way/home-east", lat: 34.1002, lon: -117.5801, tags: { building: "apartments" } },
  ];
  const params = {
    ...baseParams,
    hour: 18,
    lambdaRef: 1.0,
    residentialAnchors: localResidential,
    residentialDemandWeight: 0.65,
  };

  const westNoResidential = probabilityOfGoodOrder(symmetricParking[0], symmetricRestaurants, symmetricParking, {
    ...baseParams,
    hour: 18,
    lambdaRef: 1.0,
    residentialDemandWeight: 0,
  });
  const eastNoResidential = probabilityOfGoodOrder(symmetricParking[1], symmetricRestaurants, symmetricParking, {
    ...baseParams,
    hour: 18,
    lambdaRef: 1.0,
    residentialDemandWeight: 0,
  });
  const westWithResidential = probabilityOfGoodOrder(symmetricParking[0], symmetricRestaurants, symmetricParking, params);
  const eastWithResidential = probabilityOfGoodOrder(symmetricParking[1], symmetricRestaurants, symmetricParking, params);

  assert(approx(westNoResidential.pGood, eastNoResidential.pGood, 1e-4), "symmetric points match before residential demand is added");
  assert(eastWithResidential.pGood > westWithResidential.pGood, "residential anchors lift the nearby parking score");
  assert(eastWithResidential.residentialShare > westWithResidential.residentialShare, "demand mix exposes the local residential contribution");

  const demandNodes = buildDemandCoverageNodes(symmetricRestaurants, {
    hour: 18,
    dayOfWeek: 3,
    residentialAnchors: localResidential,
    residentialDemandWeight: 0.65,
  });
  assert(demandNodes.some((node) => node.sourceType === "residential"), "demand coverage nodes include residential anchors when enabled");

  const ranked = rankParking(symmetricParking, symmetricRestaurants, symmetricParking, params, { lambdaRef: 1.0 }, 2);
  assert(ranked[0].id === "node/park-east", "parking ranking reflects residential demand after promotion");
}

function testRainDemandLift() {
  log("\n--- Rain demand lift ---");

  const dry = probabilityOfGoodOrder(
    { lat: 34.1064, lon: -117.5931 },
    fixtureRestaurants,
    fixtureParking,
    { ...baseParams, lambdaRef: 1.0, rainBoost: 0 }
  );
  const rainy = probabilityOfGoodOrder(
    { lat: 34.1064, lon: -117.5931 },
    fixtureRestaurants,
    fixtureParking,
    { ...baseParams, lambdaRef: 1.0, rainBoost: 0.2 }
  );

  assert(rainy.pAny > dry.pAny, "rain lift increases modeled arrival probability");
  assert(rainy.pGood > dry.pGood, "rain lift increases good-order probability at the same point");

  const bounds = {
    getSouth: () => 34.104,
    getNorth: () => 34.109,
    getWest: () => -117.596,
    getEast: () => -117.590,
  };
  const dryHeat = buildGridProbabilityHeat(bounds, fixtureRestaurants, fixtureParking, { ...baseParams, rainBoost: 0 }, 500);
  const rainyHeat = buildGridProbabilityHeat(bounds, fixtureRestaurants, fixtureParking, { ...baseParams, rainBoost: 0.2 }, 500);

  const dryMean = dryHeat.heatPoints.reduce((sum, [, , value]) => sum + value, 0) / dryHeat.heatPoints.length;
  const rainyMean = rainyHeat.heatPoints.reduce((sum, [, , value]) => sum + value, 0) / rainyHeat.heatPoints.length;
  assert(rainyMean > dryMean, "rain lift raises average heatmap intensity");
}

function combinations(items, pickCount) {
  const results = [];

  function visit(startIndex, current) {
    if (current.length === pickCount) {
      results.push([...current]);
      return;
    }

    for (let index = startIndex; index < items.length; index += 1) {
      current.push(items[index]);
      visit(index + 1, current);
      current.pop();
    }
  }

  visit(0, []);
  return results;
}

function testSubmodularFallbackSelection() {
  log("\n--- Submodular fallback selection ---");

  const candidateScores = [
    { id: "west-a", lat: 34.1000, lon: -117.5900, pGood: 0.91, stabilityLow: 0.84 },
    { id: "west-b", lat: 34.1001, lon: -117.5897, pGood: 0.88, stabilityLow: 0.82 },
    { id: "east-a", lat: 34.1000, lon: -117.5800, pGood: 0.74, stabilityLow: 0.69 },
    { id: "east-b", lat: 34.1001, lon: -117.5797, pGood: 0.71, stabilityLow: 0.66 },
  ];
  const demandNodes = [
    { id: "merchant-west", lat: 34.1004, lon: -117.5901, weight: 1.0, sourceType: "merchant" },
    { id: "merchant-east", lat: 34.1004, lon: -117.5801, weight: 1.0, sourceType: "merchant" },
    { id: "res-east", lat: 34.1002, lon: -117.5799, weight: 0.9, sourceType: "residential" },
  ];
  const coverageTauMeters = 650;

  const naiveTopK = candidateScores.slice().sort((a, b) => b.pGood - a.pGood).slice(0, 2);
  const selected = selectParkingSetSubmodular(candidateScores, {
    k: 2,
    demandNodes,
    coverageTauMeters,
  });

  const selectedIds = selected.map((candidate) => candidate.id);
  assert(selectedIds.some((id) => id.startsWith("west-")), "fallback keeps western coverage");
  assert(selectedIds.some((id) => id.startsWith("east-")), "fallback also covers the eastern demand cluster");

  const naiveCoverage = evaluateParkingCoverage(naiveTopK, demandNodes, { coverageTauMeters });
  const selectedCoverage = evaluateParkingCoverage(selected, demandNodes, { coverageTauMeters });
  assert(selectedCoverage > naiveCoverage, "submodular selector improves total demand coverage over naive top-K");

  const optimalCoverage = Math.max(
    ...combinations(candidateScores, 2).map((candidateSet) =>
      evaluateParkingCoverage(candidateSet, demandNodes, { coverageTauMeters })
    )
  );
  assert(selectedCoverage / optimalCoverage >= 0.63, "greedy selector stays near the brute-force optimum on a small instance");
}

function testLearnedModelAgreement() {
  log("\n--- Learned model agreement ---");

  const nearPoint = { lat: 34.1064, lon: -117.5931 };
  const farPoint = { lat: 34.2000, lon: -117.7000 };
  const legacyNear = probabilityOfGoodOrder(nearPoint, fixtureRestaurants, fixtureParking, {
    ...baseParams,
    lambdaRef: 1.0,
    predictionModel: "legacy",
  });
  const learnedNear = probabilityOfGoodOrder(nearPoint, fixtureRestaurants, fixtureParking, {
    ...baseParams,
    lambdaRef: 1.0,
    predictionModel: "glm",
  });
  const legacyFar = probabilityOfGoodOrder(farPoint, fixtureRestaurants, fixtureParking, {
    ...baseParams,
    lambdaRef: 1.0,
    predictionModel: "legacy",
  });
  const learnedFar = probabilityOfGoodOrder(farPoint, fixtureRestaurants, fixtureParking, {
    ...baseParams,
    lambdaRef: 1.0,
    predictionModel: "glm",
  });

  assert(Math.abs(learnedNear.pGood - legacyNear.pGood) <= 0.12, "learned model stays close to legacy on a representative high-support point");
  assert(learnedNear.pGood >= learnedFar.pGood, "learned model preserves simple near-vs-far ordering");
  assert(Math.abs(learnedFar.pGood - legacyFar.pGood) <= 0.08, "learned model shrinks back toward legacy in sparse regimes");
  assert(learnedNear.predictionModel === "glm", "learned path reports the glm prediction model");
}

function testLearnedModelSyntheticCalibration() {
  log("\n--- Learned model synthetic calibration ---");

  const heldOut = generateSyntheticPredictionDataset(600, 42);
  const legacySamples = heldOut.map((sample) => ({
    probability: sample.legacy.pGood,
    label: sample.label,
  }));
  const learnedSamples = heldOut.map((sample) => ({
    probability: sample.learned.pGood,
    label: sample.label,
  }));

  const legacyEce = expectedCalibrationError(legacySamples);
  const learnedEce = expectedCalibrationError(learnedSamples);
  const legacyBrier = brierScore(legacySamples);
  const learnedBrier = brierScore(learnedSamples);

  assert(learnedEce < legacyEce, `learned model improves ECE on synthetic held-out data (${learnedEce.toFixed(4)} < ${legacyEce.toFixed(4)})`);
  assert(learnedBrier < legacyBrier, `learned model improves Brier score on synthetic held-out data (${learnedBrier.toFixed(4)} < ${legacyBrier.toFixed(4)})`);
}

// ─── Run ──────────────────────────────────────────────────────

export function runPreservationTests() {
  log("DGM Preservation Tests");
  log("Verifying: invariants preserved, promoted math bounded, and no actionability introduced.\n");

  testHaversine();
  testTimeBucket();
  testNonNegativity();
  testOrderPreservation();
  testSignalIndependence();
  testDeterminism();
  testNoActionabilitySemantics();
  testPGoodBoundedByPAny();
  testProbabilityContract();
  testGridHeatBaseline();
  testRankParkingDeterminism();
  testTopMerchantsDeterminism();
  testOpeningHoursHelper();
  testClosedRestaurantsExcludedFromPipeline();
  testResidentialDemandPromotion();
  testRainDemandLift();
  testSubmodularFallbackSelection();
  testLearnedModelAgreement();
  testLearnedModelSyntheticCalibration();

  log(`\n════════════════════════════════════════`);
  log(`Results: ${passed}/${total} passed`);
  if (passed === total) {
    log("PRESERVATION CONFIRMED: All checks pass.");
  } else {
    log(`WARNING: ${total - passed} check(s) failed.`);
  }
  log(`════════════════════════════════════════`);

  return { total, passed, failed: total - passed };
}
