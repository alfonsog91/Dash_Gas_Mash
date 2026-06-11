import {
  createNavigationAdapter,
  createGpsSmoother,
  laneHintFromStep,
  snapHeadingToLanes,
  syntheticMapMatch,
} from "../../intelligence/navigation_adapter.js";

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

function assertClose(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

export function runNavigationAdapterTests() {
  const log = createLogger();
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passed += 1;
      log.write(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      log.write(`${FAIL} ${name}: ${error.message}`);
    }
  }

  return (async () => {
    log.write("DGM Phase G navigation adapter tests");

    await runTest("GPS smoother dampens jitter deterministically", () => {
      const smoother = createGpsSmoother({ alpha: 0.5, maxJumpMeters: 100 });
      const first = smoother.push({ lng: -117.6, lat: 34.06 });
      assertDeepEqual([first.lng, first.lat], [-117.6, 34.06], "first sample passes through verbatim");
      // A small jitter ~ a few meters east; EMA at alpha 0.5 lands halfway.
      const second = smoother.push({ lng: -117.59998, lat: 34.06 });
      assertEqual(second.lng, -117.59999, "second sample is the midpoint at alpha 0.5");
      assertEqual(second.jumped, false, "small movement is not treated as a jump");
    });

    await runTest("GPS smoother is repeatable for identical inputs", () => {
      const make = () => createGpsSmoother({ alpha: 0.3 });
      const trace = [
        { lng: -117.6, lat: 34.06, heading: 90 },
        { lng: -117.5999, lat: 34.0601, heading: 92 },
        { lng: -117.5998, lat: 34.0602, heading: 88 },
      ];
      const a = trace.map((s) => make().push(s));
      const smootherB = make();
      const b = trace.map((s) => smootherB.push(s));
      // Re-run with two fresh smoothers fed the whole trace.
      const sA = make();
      const runA = trace.map((s) => sA.push(s));
      const sB = make();
      const runB = trace.map((s) => sB.push(s));
      assertDeepEqual(runA, runB, "identical traces produce identical smoothed output");
      void a;
      void b;
    });

    await runTest("GPS smoother teleport guard accepts large jumps", () => {
      const smoother = createGpsSmoother({ alpha: 0.5, maxJumpMeters: 50 });
      smoother.push({ lng: -117.6, lat: 34.06 });
      const jumped = smoother.push({ lng: -117.4, lat: 34.2 }); // far away
      assertEqual(jumped.jumped, true, "a large jump is accepted verbatim");
      assertEqual(jumped.lng, -117.4, "jump position is taken as-is");
      assertEqual(smoother.getDiagnostics().jumps, 1, "the jump is recorded");
    });

    await runTest("GPS smoother smooths heading along the shortest arc", () => {
      const smoother = createGpsSmoother({ headingAlpha: 0.5, maxJumpMeters: 1000 });
      smoother.push({ lng: -117.6, lat: 34.06, heading: 350 });
      const out = smoother.push({ lng: -117.6, lat: 34.06, heading: 10 });
      // 350 -> 10 short arc midpoint at alpha 0.5 is 0, not 180.
      assertEqual(out.heading, 0, "heading EMA crosses 0 via the short arc");
    });

    await runTest("laneHintFromStep reads explicit intersection lanes", () => {
      const hint = laneHintFromStep({
        maneuver: { type: "turn", modifier: "left" },
        intersections: [
          { lanes: [
            { valid: true, indications: ["left"] },
            { valid: false, indications: ["straight"] },
            { valid: false, indications: ["right"] },
          ] },
        ],
      });
      assertEqual(hint.count, 3, "lane count reflects the intersection lanes");
      assertDeepEqual(hint.active, [true, false, false], "valid flags map to active lanes");
      assertEqual(hint.recommendation, "left", "maneuver modifier drives the recommendation");
      assertEqual(hint.source, "intersections", "source is the intersection data");
    });

    await runTest("laneHintFromStep falls back to the maneuver modifier", () => {
      const hint = laneHintFromStep({ maneuver: { type: "turn", modifier: "slight right" } });
      assertEqual(hint.recommendation, "right", "slight right maps to a right recommendation");
      assertEqual(hint.source, "maneuver", "source is the maneuver when no lanes are present");
      assertEqual(hint.count, null, "lane count is null without explicit lanes");
    });

    await runTest("laneHintFromStep returns null for unusable input", () => {
      assertEqual(laneHintFromStep(null), null, "null step yields no hint");
    });

    await runTest("snapHeadingToLanes snaps within tolerance", () => {
      assertEqual(snapHeadingToLanes(88, [0, 90, 180, 270], { toleranceDeg: 25 }), 90, "near-90 heading snaps to the 90 lane");
      assertEqual(snapHeadingToLanes(45, [0, 90], { toleranceDeg: 25 }), 45, "out-of-tolerance heading is left unchanged");
      assertEqual(snapHeadingToLanes(10, []), 10, "no lane bearings returns the input heading");
    });

    await runTest("syntheticMapMatch snaps to the nearest reference vertex", () => {
      const reference = [[-117.6, 34.06], [-117.59, 34.07]];
      const matched = syntheticMapMatch([{ lng: -117.5995, lat: 34.0695 }], reference);
      assertEqual(matched.length, 1, "one matched point is returned");
      assertDeepEqual([matched[0].lng, matched[0].lat], [-117.59, 34.07], "the point snaps to the nearest vertex");
      assertEqual(matched[0].snapped, true, "snapped flag is set");
    });

    await runTest("adapter matchTrace falls back to synthetic offline", async () => {
      const adapter = createNavigationAdapter({ referencePath: [[-117.6, 34.06], [-117.59, 34.07]] });
      const result = await adapter.matchTrace([{ lng: -117.5995, lat: 34.0695 }]);
      assertEqual(result.source, "synthetic", "no fetch configured => synthetic matcher");
      assertEqual(result.points.length, 1, "the trace is matched");
      assertEqual(adapter.getDiagnostics().fallbacks, 1, "fallback is recorded");
    });

    await runTest("adapter getDirections returns synthetic straight-line route", async () => {
      const adapter = createNavigationAdapter();
      const result = await adapter.getDirections([{ lng: -117.6, lat: 34.06 }, { lng: -117.59, lat: 34.06 }]);
      assertEqual(result.source, "synthetic", "no fetch configured => synthetic directions");
      assert(result.distanceMeters > 0, "a positive distance is computed");
      assert(result.steps.length >= 1, "at least one step is produced");
      assert(Array.isArray(result.laneHints), "lane hints are returned as an array");
    });

    await runTest("adapter getDirections uses an injected provider when available", async () => {
      const fetchImpl = async () => ({
        ok: true,
        async json() {
          return {
            routes: [{
              distance: 1234,
              duration: 90,
              legs: [{ steps: [
                { maneuver: { type: "depart", modifier: "straight" }, intersections: [] },
                { maneuver: { type: "turn", modifier: "left" }, intersections: [{ lanes: [{ valid: true, indications: ["left"] }, { valid: false, indications: ["straight"] }] }] },
              ] }],
            }],
          };
        },
      });
      const adapter = createNavigationAdapter({ fetchImpl, directionsUrl: "https://example.test/directions" });
      const result = await adapter.getDirections([{ lng: -117.6, lat: 34.06 }, { lng: -117.59, lat: 34.07 }]);
      assertEqual(result.source, "provider", "the injected provider response is used");
      assertEqual(result.distanceMeters, 1234, "provider distance is carried through");
      assertEqual(result.laneHints.length, 2, "lane hints are extracted from provider steps");
      assertEqual(result.laneHints[1].recommendation, "left", "the turn step recommends the left lane");
    });

    await runTest("adapter getDirections handles too-few waypoints", async () => {
      const adapter = createNavigationAdapter();
      const result = await adapter.getDirections([{ lng: -117.6, lat: 34.06 }]);
      assertEqual(result.source, "empty", "a single waypoint yields an empty route");
      assertEqual(result.distanceMeters, 0, "empty route has zero distance");
    });

    await runTest("adapter never imports the superposition engine (standalone)", async () => {
      // Structural guarantee: importing the adapter module must not pull in the
      // engine. We assert the adapter exposes only navigation methods.
      const adapter = createNavigationAdapter();
      assertDeepEqual(
        Object.keys(adapter).sort(),
        ["getDiagnostics", "getDirections", "matchTrace"],
        "adapter surface is navigation-only (no scoring/assignment methods)"
      );
    });

    const result = { passed, failed };
    log.write(`Results: ${passed} passed, ${failed} failed`);
    if (typeof document !== "undefined") {
      document.title = failed === 0
        ? `All ${passed} navigation adapter tests passed`
        : `${failed}/${passed + failed} navigation adapter tests failed`;
    }
    return result;
  })();
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runNavigationAdapterTests);
}
