import { createMapInteractionRuntime } from "../map_interaction_runtime.js";

const PASS = "PASS";
const FAIL = "FAIL";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createDeferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createDocumentFixture() {
  const body = { innerHTML: "", scrollTop: 0 };
  const root = {
    hidden: true,
    innerHTML: "",
    classList: { add() {}, remove() {} },
    addEventListener() {},
    querySelector: () => body,
  };
  return {
    body,
    documentLike: {
      addEventListener() {},
      createElement: () => root,
    },
    root,
  };
}

export async function runMapInteractionRuntimeTests() {
  let passed = 0;
  let failed = 0;

  async function runTest(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`${PASS} ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`${FAIL} ${name}: ${error.message}`);
    }
  }

  await runTest("cancelled place route summary leaves loading and rejects a late result", async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const routeResult = createDeferred();
    const documentFixture = createDocumentFixture();
    const renderedStatuses = [];
    const signals = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentFixture.documentLike,
    });

    try {
      const runtime = createMapInteractionRuntime({
        getElMain: () => ({ append() {} }),
        getLastCurrentLocation: () => ({ lat: 34.05, lng: -117.65 }),
        renderPlaceSheetHtml: (activeState) => {
          renderedStatuses.push(activeState?.routeStatus);
          return "";
        },
        fetchDrivingRoute: (_origin, _destination, { signal }) => {
          signals.push(signal);
          return routeResult.promise;
        },
      });

      runtime.openPlaceSheet({ key: "place-a", lat: 34.1, lng: -117.6 });
      assert(renderedStatuses.at(-1) === "loading", "the pending summary begins in loading state");
      runtime.cancelInFlightPlaceRouteSummaries();
      assert(signals[0]?.aborted, "the summary signal is aborted");
      assert(renderedStatuses.at(-1) === "cancelled", "cancellation leaves a stable non-loading state");

      routeResult.resolve({ distanceMeters: 1000, durationSeconds: 300 });
      await Promise.resolve();
      await Promise.resolve();
      assert(!renderedStatuses.includes("ready"), "the late summary never renders as ready");
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        delete globalThis.document;
      }
    }
  });

  console.log(`Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runMapInteractionRuntimeTests);
}
