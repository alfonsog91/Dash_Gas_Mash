import {
  createMapRuntimeReadyGate,
  isMapStyleReady,
} from "../runtime_ready.js";

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

function createMockMap({ ready = false } = {}) {
  const listeners = new Map();
  return {
    onCalls: [],
    offCalls: [],
    setReady(nextReady) {
      ready = Boolean(nextReady);
    },
    isStyleLoaded() {
      return ready;
    },
    on(eventName, listener) {
      this.onCalls.push(eventName);
      const bucket = listeners.get(eventName) || [];
      bucket.push(listener);
      listeners.set(eventName, bucket);
    },
    off(eventName, listener) {
      this.offCalls.push(eventName);
      listeners.set(eventName, (listeners.get(eventName) || []).filter((candidate) => candidate !== listener));
    },
    emit(eventName) {
      for (const listener of listeners.get(eventName) || []) {
        listener();
      }
    },
  };
}

function nextMicrotask() {
  return Promise.resolve();
}

export async function runRuntimeReadyTests() {
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

  log.write("DGM runtime readiness tests");

  await runTest("isMapStyleReady reflects Mapbox style readiness", () => {
    const map = createMockMap({ ready: true });
    assert(isMapStyleReady(map), "ready style should be true");
    map.setReady(false);
    assert(!isMapStyleReady(map), "unready style should be false");
    assert(!isMapStyleReady({ isStyleLoaded: () => { throw new Error("boom"); } }), "throwing style readiness is false");
  });

  await runTest("ready gate coalesces duplicate ready events", async () => {
    const map = createMockMap({ ready: true });
    const events = [];
    createMapRuntimeReadyGate(map, ({ eventName }) => events.push(eventName), { fireImmediately: false });

    map.emit("style.load");
    map.emit("styledata");
    map.emit("idle");
    await nextMicrotask();

    assert(events.length === 1, `expected one callback, got ${events.length}`);
  });

  await runTest("ready gate resets after an unready cycle", async () => {
    const map = createMockMap({ ready: true });
    const events = [];
    createMapRuntimeReadyGate(map, ({ eventName }) => events.push(eventName), { fireImmediately: false });

    map.emit("style.load");
    await nextMicrotask();
    map.setReady(false);
    map.emit("styledata");
    await nextMicrotask();
    map.setReady(true);
    map.emit("style.load");
    await nextMicrotask();

    assert(events.length === 2, `expected callbacks for two ready cycles, got ${events.length}`);
  });

  await runTest("ready gate cleanup removes event listeners", () => {
    const map = createMockMap({ ready: true });
    const dispose = createMapRuntimeReadyGate(map, () => {}, { fireImmediately: false });
    dispose();

    assert(map.offCalls.includes("style.load"), "style.load listener removed");
    assert(map.offCalls.includes("styledata"), "styledata listener removed");
    assert(map.offCalls.includes("idle"), "idle listener removed");
  });

  const result = { passed, failed };
  log.write(`Results: ${passed} passed, ${failed} failed`);
  if (typeof document !== "undefined") {
    document.title = failed === 0
      ? `All ${passed} runtime readiness tests passed`
      : `${failed}/${passed + failed} runtime readiness tests failed`;
  }
  return result;
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => {
    runRuntimeReadyTests();
  });
}