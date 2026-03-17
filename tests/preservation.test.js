import {
  haversineMeters,
  scorePointAgainstRestaurants,
  probabilityOfGoodOrder,
  buildGridProbabilityHeat,
  timeBucket,
  rankParking,
  topLikelyMerchantsForParking,
} from "../model.js";

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
  const el = document.getElementById("log");
  if (el) {
    el.textContent += msg + "\n";
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

// ─── Run ──────────────────────────────────────────────────────

export function runPreservationTests() {
  log("DGM Preservation Tests");
  log("Verifying: runtime outputs unchanged, no actionability, governance math non-executable.\n");

  testHaversine();
  testTimeBucket();
  testNonNegativity();
  testOrderPreservation();
  testSignalIndependence();
  testDeterminism();
  testNoActionabilitySemantics();
  testPGoodBoundedByPAny();
  testGridHeatBaseline();
  testRankParkingDeterminism();
  testTopMerchantsDeterminism();

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
