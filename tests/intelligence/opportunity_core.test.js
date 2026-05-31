import { generateOpportunityGrid } from "../../intelligence/opportunity_core.js";

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

const GRID_OPTIONS = Object.freeze({
  gridResolution: 120,
  smoothingSigma: 180,
  decayWindow: 90,
  timestamp: 1_700_000_000_000,
});

const SEEDED_SAMPLES = Object.freeze([
  Object.freeze({ lat: 34.0500, lng: -117.6500, count: 8, aggregateEV: 0.72, timestamp: 1_699_999_820_000 }),
  Object.freeze({ lat: 34.0510, lng: -117.6488, count: 5, aggregateEV: 0.45, timestamp: 1_699_999_640_000 }),
  Object.freeze({ lat: 34.0489, lng: -117.6511, count: 3, aggregateEV: 0.31, timestamp: 1_699_999_460_000 }),
]);

export function runOpportunityCoreTests() {
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

  log.write("DGM Opportunity Grid tests");

  runTest("empty samples return deterministic empty metadata", () => {
    const result = generateOpportunityGrid([], GRID_OPTIONS);
    assertDeepEqual(result.grid, [], "empty grid is stable");
    assertDeepEqual(result.metadata, {
      gridResolution: 120,
      smoothingSigma: 180,
      sampleCount: 0,
      timestamp: 1_700_000_000_000,
      heuristicConfidenceScore: 0,
    }, "empty metadata is stable");
  });

  runTest("single sample produces a smoothed local peak", () => {
    const result = generateOpportunityGrid([
      { lat: 34.05, lng: -117.65, count: 4, aggregateEV: 0.8, timestamp: 1_700_000_000_000 },
    ], GRID_OPTIONS);
    const peak = result.grid.reduce((best, cell) => cell.value > best.value ? cell : best, result.grid[0]);
    const farthest = result.grid.toSorted((left, right) => left.value - right.value)[0];
    assertEqual(result.metadata.sampleCount, 4, "single sample count is carried into metadata");
    assert(peak.value === 1, "peak cell is normalized to one");
    assert(farthest.value < peak.value, "smoothing decays away from the sample");
  });

  runTest("invalid parameters fail before generating cells", () => {
    assertThrows(() => generateOpportunityGrid([], { ...GRID_OPTIONS, gridResolution: 0 }), "invalid gridResolution throws");
    assertThrows(() => generateOpportunityGrid([], { ...GRID_OPTIONS, smoothingSigma: -1 }), "invalid smoothingSigma throws");
    assertThrows(() => generateOpportunityGrid([], { ...GRID_OPTIONS, decayWindow: Number.NaN }), "invalid decayWindow throws");
  });

  runTest("seeded inputs produce stable expected grid values", () => {
    const result = generateOpportunityGrid(SEEDED_SAMPLES, GRID_OPTIONS);
    assertEqual(result.grid.length, 72, "seeded grid cell count is stable");
    assertDeepEqual(result.metadata, {
      gridResolution: 120,
      smoothingSigma: 180,
      sampleCount: 16,
      timestamp: 1_700_000_000_000,
      heuristicConfidenceScore: 0.7644,
    }, "seeded metadata is stable");
    assertDeepEqual(
      result.grid.filter((cell) => ["g:-2:-2", "g:-1:-1", "g:0:0", "g:1:1"].includes(cell.id)).map((cell) => ({
        id: cell.id,
        value: cell.value,
        rawValue: cell.rawValue,
        support: cell.support,
      })),
      [
        { id: "g:-2:-2", value: 0.47527, rawValue: 3.334846, support: 6.202958 },
        { id: "g:-1:-1", value: 0.98756, rawValue: 6.929445, support: 11.791503 },
        { id: "g:0:0", value: 1, rawValue: 7.016732, support: 11.957842 },
        { id: "g:1:1", value: 0.498941, rawValue: 3.500934, support: 6.368785 },
      ],
      "selected seeded cells are stable"
    );
  });

  runTest("older aggregate samples decay below newer samples", () => {
    const result = generateOpportunityGrid([
      { lat: 34.05, lng: -117.65, count: 6, aggregateEV: 1, timestamp: 1_700_000_000_000 },
      { lat: 34.052, lng: -117.648, count: 6, aggregateEV: 1, timestamp: 1_699_994_600_000 },
    ], { ...GRID_OPTIONS, smoothingSigma: 90, decayWindow: 30 });
    const bySupport = result.grid.toSorted((left, right) => right.support - left.support);
    assert(bySupport[0].support > bySupport.at(-1).support, "support reflects exponential time decay");
    assert(result.metadata.heuristicConfidenceScore > 0 && result.metadata.heuristicConfidenceScore <= 1, "confidence stays bounded");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} Opportunity Grid tests passed`
      : `${failed}/${passed + failed} Opportunity Grid tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runOpportunityCoreTests);
}