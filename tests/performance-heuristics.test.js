import { evaluateVisualPerformanceHeuristics } from "../performance_heuristics.js";

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

export function runPerformanceHeuristicTests() {
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

  log.write("DGM performance heuristic tests");

  runTest("default disabled heuristics do not trigger", () => {
    const result = evaluateVisualPerformanceHeuristics({
      enabled: false,
      environment: { deviceMemory: 1, hardwareConcurrency: 2 },
    });

    assert(result.enabled === false, "heuristics remain disabled by default");
    assert(result.shouldDisableFutureVisualPolish === false, "disabled heuristics do not disable future polish");
  });

  runTest("enabled low device values only affect future visual polish", () => {
    const result = evaluateVisualPerformanceHeuristics({
      enabled: true,
      environment: { deviceMemory: 2, hardwareConcurrency: 2 },
    });

    assert(result.shouldDisableFutureVisualPolish === true, "low device values trigger future polish fallback");
    assert(result.disabledScope === "future_visual_polish", "fallback scope is limited to future visual polish");
    assert(result.reasons.includes("low_device_memory"), "device memory reason is included");
    assert(result.reasons.includes("low_hardware_concurrency"), "hardware concurrency reason is included");
  });

  runTest("enabled healthy device values do not trigger", () => {
    const result = evaluateVisualPerformanceHeuristics({
      enabled: true,
      environment: { deviceMemory: 8, hardwareConcurrency: 8 },
    });

    assert(result.shouldDisableFutureVisualPolish === false, "healthy device values do not trigger fallback");
    assert(result.reasons.length === 0, "no fallback reasons are emitted");
  });

  runTest("missing device values stay inert", () => {
    const result = evaluateVisualPerformanceHeuristics({ enabled: true, environment: {} });
    assert(result.shouldDisableFutureVisualPolish === false, "missing optional values stay inert");
    assert(result.deviceMemoryGb === null, "missing device memory normalizes to null");
    assert(result.hardwareConcurrency === null, "missing hardware concurrency normalizes to null");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} performance heuristic tests passed`
      : `${failed}/${passed + failed} performance heuristic tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPerformanceHeuristicTests);
}