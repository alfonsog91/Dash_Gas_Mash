import {
  generateVegetationInstances,
  resolveLodMode,
  normalizeSample,
  DEFAULT_LOD_RULES,
} from "../../intelligence/vegetation_core.js";

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
  gridResolution: 30,
  densityThreshold: 1,
});

// A small wood polygon plus a couple of standalone trees near Guasti.
const WOOD_POLYGON = Object.freeze({
  type: "wood",
  density: 2,
  polygon: [
    [-117.6510, 34.0500],
    [-117.6490, 34.0500],
    [-117.6490, 34.0512],
    [-117.6510, 34.0512],
    [-117.6510, 34.0500],
  ],
});

const TREE_POINTS = Object.freeze([
  Object.freeze({ type: "tree", lat: 34.0600, lng: -117.6000 }),
  Object.freeze({ type: "tree", lat: 34.0601, lng: -117.6001 }),
]);

export function runVegetationCoreTests() {
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

  log.write("DGM Phase G vegetation core tests");

  runTest("empty samples produce deterministic empty output", () => {
    const result = generateVegetationInstances([], GRID_OPTIONS);
    assertDeepEqual(result.instances, [], "no instances for empty input");
    assertDeepEqual(result.aggregates, [], "no aggregates for empty input");
    assertDeepEqual(result.metadata, {
      instanceCount: 0,
      aggregateCount: 0,
      gridResolution: 30,
      densityThreshold: 1,
      sampleCount: 0,
      heuristicConfidenceScore: 0,
    }, "empty metadata is stable");
  });

  runTest("point samples produce sprite instances", () => {
    const result = generateVegetationInstances(TREE_POINTS, GRID_OPTIONS);
    assert(result.instances.length >= 1, "points generate at least one instance");
    assert(result.instances.every((i) => i.id.startsWith("veg:")), "instances carry stable veg ids");
    assert(result.instances.every((i) => typeof i.lat === "number" && typeof i.lng === "number"), "instances carry coordinates");
    assert(result.instances.every((i) => i.height > 0), "instances carry a positive height");
    assertEqual(result.metadata.sampleCount, 2, "sample count is reported");
  });

  runTest("polygon rasterizes into multiple instances", () => {
    const result = generateVegetationInstances([WOOD_POLYGON], GRID_OPTIONS);
    assert(result.instances.length > 1, "a wood polygon fills multiple grid cells");
    assert(result.instances.every((i) => i.type === "wood"), "instances inherit the dominant sample type");
    assert(result.aggregates.length >= 1, "aggregated extrusion tiles are produced");
    assert(result.aggregates.every((f) => f.type === "Feature" && f.geometry.type === "Polygon"), "aggregates are polygon features");
    assert(result.aggregates.every((f) => f.properties.height > 0), "extrusion features carry a positive height");
  });

  runTest("generation is fully deterministic", () => {
    const a = generateVegetationInstances([WOOD_POLYGON, ...TREE_POINTS], GRID_OPTIONS);
    const b = generateVegetationInstances([WOOD_POLYGON, ...TREE_POINTS], GRID_OPTIONS);
    assertDeepEqual(a, b, "identical inputs produce identical output");
  });

  runTest("instances are sorted by grid index", () => {
    const result = generateVegetationInstances([WOOD_POLYGON], GRID_OPTIONS);
    const ids = result.instances.map((i) => i.id);
    const sorted = [...ids].sort((left, right) => {
      const [, lx, ly] = left.split(":").map(Number);
      const [, rx, ry] = right.split(":").map(Number);
      return lx - rx || ly - ry;
    });
    assertDeepEqual(ids, sorted, "instance order is stable and sorted by grid index");
  });

  runTest("density threshold filters sparse cells", () => {
    // Two coincident points accumulate weight 2 in one cell.
    const coincident = [
      { type: "tree", lat: 34.06, lng: -117.6, density: 1 },
      { type: "tree", lat: 34.06, lng: -117.6, density: 1 },
    ];
    const belowThreshold = generateVegetationInstances([{ type: "tree", lat: 34.06, lng: -117.6, density: 1 }], { gridResolution: 30, densityThreshold: 2 });
    assertEqual(belowThreshold.instances.length, 0, "a single-weight cell is filtered out at threshold 2");

    const atThreshold = generateVegetationInstances(coincident, { gridResolution: 30, densityThreshold: 2 });
    assertEqual(atThreshold.instances.length, 1, "accumulated weight meeting the threshold yields one instance");
    assertEqual(atThreshold.instances[0].weight, 2, "instance weight reflects accumulated density");
  });

  runTest("higher density threshold reduces instance count", () => {
    const low = generateVegetationInstances([WOOD_POLYGON], { gridResolution: 30, densityThreshold: 1 });
    const high = generateVegetationInstances([WOOD_POLYGON], { gridResolution: 30, densityThreshold: 3 });
    assert(high.instances.length <= low.instances.length, "raising the threshold never increases instances");
  });

  runTest("LOD switching follows zoom thresholds", () => {
    const low = resolveLodMode(6, DEFAULT_LOD_RULES);
    assertEqual(low.mode, "hidden", "below hideBelowZoom vegetation is hidden");

    const mid = resolveLodMode(10, DEFAULT_LOD_RULES);
    assertEqual(mid.mode, "extrusion", "mid zoom uses aggregated extrusions");
    assert(mid.renderExtrusions === true && mid.renderSprites === false, "extrusion flags are set at mid zoom");

    const high = resolveLodMode(16, DEFAULT_LOD_RULES);
    assertEqual(high.mode, "sprite", "high zoom uses sprite billboards");
    assert(high.renderSprites === true && high.renderExtrusions === false, "sprite flags are set at high zoom");
  });

  runTest("LOD boundary is inclusive at spriteMinZoom", () => {
    const atSprite = resolveLodMode(14, DEFAULT_LOD_RULES);
    assertEqual(atSprite.mode, "sprite", "exactly spriteMinZoom renders sprites");
    const justBelow = resolveLodMode(13.9, DEFAULT_LOD_RULES);
    assertEqual(justBelow.mode, "extrusion", "just below spriteMinZoom renders extrusions");
  });

  runTest("custom LOD rules are honored", () => {
    const rules = { spriteMinZoom: 18, hideBelowZoom: 12, aggregationFactor: 2 };
    assertEqual(resolveLodMode(15, rules).mode, "extrusion", "custom sprite threshold shifts the sprite band");
    assertEqual(resolveLodMode(11, rules).mode, "hidden", "custom hide threshold shifts the hidden band");
    assertEqual(resolveLodMode(18, rules).mode, "sprite", "custom sprite threshold is inclusive");
  });

  runTest("aggregation factor controls extrusion tile count", () => {
    const coarse = generateVegetationInstances([WOOD_POLYGON], { gridResolution: 30, densityThreshold: 1, lodRules: { aggregationFactor: 8 } });
    const fine = generateVegetationInstances([WOOD_POLYGON], { gridResolution: 30, densityThreshold: 1, lodRules: { aggregationFactor: 2 } });
    assert(coarse.aggregates.length <= fine.aggregates.length, "coarser aggregation never produces more tiles");
  });

  runTest("confidence score stays bounded", () => {
    const result = generateVegetationInstances([WOOD_POLYGON, ...TREE_POINTS], GRID_OPTIONS);
    assert(result.metadata.heuristicConfidenceScore >= 0 && result.metadata.heuristicConfidenceScore <= 1, "confidence is within [0, 1]");
  });

  runTest("invalid parameters are rejected", () => {
    assertThrows(() => generateVegetationInstances([], { gridResolution: 0 }), "non-positive gridResolution throws");
    assertThrows(() => generateVegetationInstances([], { densityThreshold: -1 }), "non-positive densityThreshold throws");
  });

  runTest("normalizeSample classifies points and polygons", () => {
    assertEqual(normalizeSample({ lat: 34.05, lng: -117.65 }).kind, "point", "lat/lng is a point");
    assertEqual(normalizeSample(WOOD_POLYGON).kind, "polygon", "polygon ring is a polygon");
    assertEqual(normalizeSample({ foo: "bar" }), null, "invalid sample is rejected");
    assertEqual(normalizeSample({ lat: 34.05, lng: -117.65, density: 0 }), null, "zero-density sample is rejected");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} vegetation core tests passed`
      : `${failed}/${passed + failed} vegetation core tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runVegetationCoreTests);
}
