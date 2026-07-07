import { getPhaseCManifest, PHASE_C_MANIFEST_VERSION } from "../phase_c_manifest.js";
import { DEFAULT_MAP_FEATURE_FLAGS } from "../map_config.js";

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

export function runPhaseCManifestTests() {
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

  log.write("DGM Phase C manifest tests");

  runTest("manifest returns expected top-level keys", () => {
    const manifest = getPhaseCManifest();
    assert(typeof manifest === "object" && manifest !== null, "manifest is an object");
    assert(typeof manifest.version === "string", "manifest has version");
    assert(typeof manifest.terrain === "object", "manifest has terrain");
    assert(typeof manifest.projection === "object", "manifest has projection");
    assert(typeof manifest.buildings3d === "object", "manifest has buildings3d");
    assert(typeof manifest.fog === "object", "manifest has fog");
    assert(typeof manifest.sky === "object", "manifest has sky");
    assert(typeof manifest.camera === "object", "manifest has camera");
  });

  runTest("all IDs follow dgm-phase-c-* naming convention", () => {
    const manifest = getPhaseCManifest();
    assert(
      manifest.terrain.sourceId.startsWith("dgm-phase-c-"),
      `terrain sourceId follows naming convention: ${manifest.terrain.sourceId}`
    );
    assert(
      manifest.buildings3d.layerId.startsWith("dgm-phase-c-"),
      `buildings3d layerId follows naming convention: ${manifest.buildings3d.layerId}`
    );
    assert(
      manifest.sky.layerId.startsWith("dgm-phase-c-"),
      `sky layerId follows naming convention: ${manifest.sky.layerId}`
    );
  });

  runTest("manifest version matches PHASE_C_MANIFEST_VERSION export", () => {
    const manifest = getPhaseCManifest();
    assert(
      manifest.version === PHASE_C_MANIFEST_VERSION,
      `manifest.version (${manifest.version}) matches named export`
    );
    assert(manifest.version.includes("inert"), "version string signals inert status");
  });

  runTest("getPhaseCManifest is idempotent", () => {
    const a = getPhaseCManifest();
    const b = getPhaseCManifest();
    assert(a.version === b.version, "repeated calls return the same version");
    assert(a.terrain.sourceId === b.terrain.sourceId, "repeated calls return the same sourceId");
    assert(a.projection.globe === b.projection.globe, "repeated calls return the same projection");
  });

  runTest("all Phase C feature flags default to false", () => {
    const phaseCFlags = ["phaseCTerrain", "phaseCGlobe", "phaseC3dBuildings", "phaseCFog", "phaseCAtmosphere"];
    for (const flag of phaseCFlags) {
      assert(
        flag in DEFAULT_MAP_FEATURE_FLAGS,
        `${flag} is present in DEFAULT_MAP_FEATURE_FLAGS`
      );
      assert(
        DEFAULT_MAP_FEATURE_FLAGS[flag] === false,
        `${flag} defaults to false`
      );
    }
  });

  runTest("manifest fog range is a two-element array with finite numbers", () => {
    const manifest = getPhaseCManifest();
    assert(Array.isArray(manifest.fog.range), "fog.range is an array");
    assert(manifest.fog.range.length === 2, "fog.range has exactly 2 elements");
    assert(
      Number.isFinite(manifest.fog.range[0]) && Number.isFinite(manifest.fog.range[1]),
      "fog.range elements are finite numbers"
    );
    assert(manifest.fog.range[0] < manifest.fog.range[1], "fog near < fog far");
  });

  log.write(`\n${passed} passed, ${failed} failed`);
  return { passed, failed };
}

runPhaseCManifestTests();
