import {
  createPlacePhotosHandler,
  computeScaledDimensions,
  PLACEHOLDER_DATA_URL,
} from "../../intelligence/place_photos.js";

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

// Synthetic image loader: resolves to an object with declared dimensions and
// records every requested URL. Can be made to fail for specific refs.
function createSyntheticImageLoader({ width = 1600, height = 1200, failUrls = [] } = {}) {
  const requested = [];
  const loader = (url) => {
    requested.push(url);
    if (failUrls.some((needle) => url.includes(needle))) {
      return Promise.reject(new Error("synthetic load failure"));
    }
    return Promise.resolve({ naturalWidth: width, naturalHeight: height });
  };
  loader.requested = requested;
  return loader;
}

// Synthetic canvas: captures drawImage calls and returns a deterministic data
// URL that encodes the target dimensions so tests can assert the resize.
function createSyntheticCanvasFactory() {
  const draws = [];
  const factory = (width, height) => ({
    width,
    height,
    getContext: () => ({
      drawImage: (image, x, y, w, h) => draws.push({ w, h }),
    }),
    toDataURL: (mime) => `data:${mime};base64,SYNTH-${width}x${height}`,
  });
  factory.draws = draws;
  return factory;
}

function buildSyntheticUrl(photoRef, { maxEdge } = {}) {
  return `https://synthetic.test/photo/${photoRef.ref}?maxedge=${maxEdge}`;
}

export function runPlacePhotosTests() {
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
    log.write("DGM Phase G place photos tests");

    await runTest("computeScaledDimensions preserves aspect ratio and never upscales", () => {
      assertEqual(JSON.stringify(computeScaledDimensions(1600, 1200, 160)), JSON.stringify({ width: 160, height: 120 }), "landscape scales to max edge");
      assertEqual(JSON.stringify(computeScaledDimensions(800, 1600, 160)), JSON.stringify({ width: 80, height: 160 }), "portrait scales to max edge");
      assertEqual(JSON.stringify(computeScaledDimensions(100, 80, 160)), JSON.stringify({ width: 100, height: 80 }), "small source is not upscaled");
    });

    await runTest("getThumbnail generates a bounded downscaled thumbnail", async () => {
      const loadImage = createSyntheticImageLoader({ width: 1600, height: 1200 });
      const createCanvas = createSyntheticCanvasFactory();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas,
        thumbnailMaxEdge: 160,
      });

      const thumb = await handler.getThumbnail({ ref: "ref-a" });
      assertEqual(thumb.placeholder, false, "real thumbnail is not a placeholder");
      assertEqual(thumb.width, 160, "thumbnail width is bounded by max edge");
      assertEqual(thumb.height, 120, "thumbnail height preserves aspect ratio");
      assertEqual(thumb.dataUrl, "data:image/jpeg;base64,SYNTH-160x120", "thumbnail data URL reflects resized canvas");
      assertEqual(loadImage.requested[0], "https://synthetic.test/photo/ref-a?maxedge=160", "thumbnail requests the bounded edge");
    });

    await runTest("getThumbnail caches by ref and reports cache hits", async () => {
      const loadImage = createSyntheticImageLoader();
      const createCanvas = createSyntheticCanvasFactory();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas,
        shouldExposeDebug: () => true,
      });

      await handler.getThumbnail({ ref: "ref-a" });
      const second = await handler.getThumbnail({ ref: "ref-a" });
      assertEqual(second.fromCache, true, "second fetch is served from cache");
      assertEqual(loadImage.requested.length, 1, "image is decoded only once for the same ref");
      assertEqual(handler.getDiagnostics().cacheHits, 1, "diagnostics record the cache hit");
      assertEqual(handler.getThumbnailCacheSize(), 1, "one thumbnail is cached");
    });

    await runTest("thumbnail cache is bounded and evicts oldest", async () => {
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage: createSyntheticImageLoader(),
        createCanvas: createSyntheticCanvasFactory(),
        maxThumbnails: 2,
      });
      await handler.getThumbnail({ ref: "a" });
      await handler.getThumbnail({ ref: "b" });
      await handler.getThumbnail({ ref: "c" });
      assertEqual(handler.getThumbnailCacheSize(), 2, "cache stays within the bound");
    });

    await runTest("canCacheThumbnail=false respects provider TOS (no caching)", async () => {
      const loadImage = createSyntheticImageLoader();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas: createSyntheticCanvasFactory(),
        canCacheThumbnail: () => false,
      });
      await handler.getThumbnail({ ref: "ref-a" });
      const second = await handler.getThumbnail({ ref: "ref-a" });
      assertEqual(handler.getThumbnailCacheSize(), 0, "nothing is cached when caching is forbidden");
      assertEqual(second.fromCache, false, "each request re-generates when caching is forbidden");
      assertEqual(loadImage.requested.length, 2, "image is re-decoded when caching is forbidden");
    });

    await runTest("guard trip skips heavy work and returns a placeholder", async () => {
      const loadImage = createSyntheticImageLoader();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas: createSyntheticCanvasFactory(),
        isGuardDisabled: () => true,
        shouldExposeDebug: () => true,
      });
      const thumb = await handler.getThumbnail({ ref: "ref-a" });
      assertEqual(thumb.placeholder, true, "thumbnail is a placeholder when the guard trips");
      assertEqual(thumb.reason, "guard_disabled", "placeholder reason cites the guard");
      assertEqual(thumb.dataUrl, PLACEHOLDER_DATA_URL, "guard placeholder uses the inline placeholder");
      assertEqual(loadImage.requested.length, 0, "no image is decoded when the guard trips");
      assertEqual(handler.getDiagnostics().guardSkips, 1, "guard skip is recorded");
    });

    await runTest("decode failure falls back to a placeholder", async () => {
      const loadImage = createSyntheticImageLoader({ failUrls: ["ref-bad"] });
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas: createSyntheticCanvasFactory(),
      });
      const thumb = await handler.getThumbnail({ ref: "ref-bad" });
      assertEqual(thumb.placeholder, true, "failed decode returns a placeholder");
      assertEqual(thumb.reason, "load_failed", "placeholder reason cites the load failure");
    });

    await runTest("getFullResolution lazily returns a URL and never caches bytes", () => {
      const loadImage = createSyntheticImageLoader();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas: createSyntheticCanvasFactory(),
        fullResMaxEdge: 1280,
        shouldExposeDebug: () => true,
      });
      const full = handler.getFullResolution({ ref: "ref-a" });
      assertEqual(full.url, "https://synthetic.test/photo/ref-a?maxedge=1280", "full-res URL uses the full-res edge");
      assertEqual(full.cached, false, "full-res bytes are never cached");
      assertEqual(loadImage.requested.length, 0, "getFullResolution does not eagerly decode (lazy)");
      assertEqual(handler.getDiagnostics().fullResRequests, 1, "full-res request is recorded");
    });

    await runTest("getFullResolution is skipped when the guard trips", () => {
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage: createSyntheticImageLoader(),
        createCanvas: createSyntheticCanvasFactory(),
        isGuardDisabled: () => true,
      });
      const full = handler.getFullResolution({ ref: "ref-a" });
      assertEqual(full.skipped, true, "full-res is skipped under the guard");
      assertEqual(full.url, null, "no URL is produced when the guard trips");
    });

    await runTest("invalid ref returns a placeholder without loading", async () => {
      const loadImage = createSyntheticImageLoader();
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage,
        createCanvas: createSyntheticCanvasFactory(),
      });
      const thumb = await handler.getThumbnail({ notARef: true });
      assertEqual(thumb.placeholder, true, "invalid ref returns a placeholder");
      assertEqual(loadImage.requested.length, 0, "invalid ref does not trigger a load");
    });

    await runTest("diagnostics are gated behind the debug flag", async () => {
      const handler = createPlacePhotosHandler({
        buildPhotoUrl: buildSyntheticUrl,
        loadImage: createSyntheticImageLoader(),
        createCanvas: createSyntheticCanvasFactory(),
        shouldExposeDebug: () => false,
      });
      await handler.getThumbnail({ ref: "ref-a" });
      assertEqual(handler.getDiagnostics(), null, "diagnostics are null when debug is off");
    });

    const result = { passed, failed };
    log.write(`Results: ${passed} passed, ${failed} failed`);
    if (typeof document !== "undefined") {
      document.title = failed === 0
        ? `All ${passed} place photos tests passed`
        : `${failed}/${passed + failed} place photos tests failed`;
    }
    return result;
  })();
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runPlacePhotosTests);
}
