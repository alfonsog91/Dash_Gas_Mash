// Phase G place photos handler.
//
// Wraps a provider photoRef into a UI-friendly photo pipeline:
//   - getThumbnail(): build a bounded, cacheable thumbnail (canvas downscale),
//   - getFullResolution(): lazily resolve the full-res URL on demand,
//   - getPlaceholder(): a network-free inline placeholder.
//
// Design notes / approximations (documented inline):
// - All DOM-dependent work (image decode, canvas resize) is injected so the
//   handler runs under Node tests with synthetic loaders. Browser defaults are
//   provided by createBrowserImageLoader/createBrowserCanvasFactory.
// - TOS respect: only bounded *thumbnails* (downscaled, re-encoded data URLs)
//   are cached, and only when canCacheThumbnail() allows it. Full-resolution
//   bytes are NEVER cached — getFullResolution() returns a URL for the UI/<img>
//   to fetch directly, so providers that forbid caching original imagery are
//   honored. Configure canCacheThumbnail to return false for such providers.
// - Privacy: no user identifiers are stored; the thumbnail cache holds only the
//   downscaled image and bounded attribution text.
// - Guard: when isGuardDisabled() reports the phaseGPlacePhotos effect tripped,
//   heavy work (decode/resize/network) is skipped and a placeholder is returned.

import { normalizePhotoRef } from "./place_model.js";

const DEFAULT_THUMBNAIL_MAX_EDGE = 160;
const DEFAULT_FULL_RES_MAX_EDGE = 1280;
const DEFAULT_MAX_THUMBNAILS = 120;
const DEFAULT_THUMBNAIL_MIME = "image/jpeg";
const DEFAULT_THUMBNAIL_QUALITY = 0.7;

// A 1x1 transparent PNG: network-free, deterministic, safe placeholder source.
const PLACEHOLDER_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function clampPositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }
  return Math.trunc(number);
}

function getImageDimensions(image) {
  const width = Number(image?.naturalWidth ?? image?.width);
  const height = Number(image?.naturalHeight ?? image?.height);
  return {
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
  };
}

// Compute aspect-ratio-preserving target dimensions bounded by maxEdge. Never
// upscales (scale is capped at 1).
function computeScaledDimensions(srcWidth, srcHeight, maxEdge) {
  const longestEdge = Math.max(srcWidth, srcHeight);
  const scale = Math.min(1, maxEdge / longestEdge);
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

function defaultBuildPhotoUrl(photoRef) {
  // Fallback: treat the ref itself as a URL when it is already an http(s) link.
  // Real providers should inject a buildPhotoUrl that signs/sizes the request.
  const ref = String(photoRef?.ref || "");
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return ref;
  }
  throw new Error("no buildPhotoUrl configured for opaque photo reference");
}

function createPlacePhotosHandler({
  buildPhotoUrl = defaultBuildPhotoUrl,
  loadImage = null,
  createCanvas = null,
  canCacheThumbnail = () => true,
  isGuardDisabled = () => false,
  shouldExposeDebug = () => false,
  thumbnailMaxEdge = DEFAULT_THUMBNAIL_MAX_EDGE,
  fullResMaxEdge = DEFAULT_FULL_RES_MAX_EDGE,
  maxThumbnails = DEFAULT_MAX_THUMBNAILS,
  thumbnailMime = DEFAULT_THUMBNAIL_MIME,
  thumbnailQuality = DEFAULT_THUMBNAIL_QUALITY,
} = {}) {
  const thumbEdge = clampPositiveInteger(thumbnailMaxEdge, DEFAULT_THUMBNAIL_MAX_EDGE);
  const fullEdge = clampPositiveInteger(fullResMaxEdge, DEFAULT_FULL_RES_MAX_EDGE);
  const thumbCapacity = clampPositiveInteger(maxThumbnails, DEFAULT_MAX_THUMBNAILS);

  // Bounded thumbnail cache (insertion-order Map used as a simple LRU).
  const thumbnailCache = new Map();
  const diagnostics = {
    generated: 0,
    cacheHits: 0,
    cacheMisses: 0,
    failures: 0,
    guardSkips: 0,
    placeholders: 0,
    fullResRequests: 0,
  };

  function evictThumbnails() {
    while (thumbnailCache.size > thumbCapacity) {
      const oldestKey = thumbnailCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      thumbnailCache.delete(oldestKey);
    }
  }

  function buildPlaceholder(photoRef, reason) {
    diagnostics.placeholders += 1;
    return {
      ref: photoRef?.ref || null,
      dataUrl: PLACEHOLDER_DATA_URL,
      width: thumbEdge,
      height: thumbEdge,
      attribution: photoRef?.attribution || null,
      placeholder: true,
      reason,
      fromCache: false,
    };
  }

  function getPlaceholder() {
    return {
      dataUrl: PLACEHOLDER_DATA_URL,
      width: thumbEdge,
      height: thumbEdge,
      placeholder: true,
      reason: "explicit",
    };
  }

  async function resizeToThumbnail(image) {
    if (typeof createCanvas !== "function") {
      throw new Error("no createCanvas configured for thumbnail generation");
    }
    const { width: srcWidth, height: srcHeight } = getImageDimensions(image);
    if (srcWidth === null || srcHeight === null) {
      throw new Error("decoded image has no usable dimensions");
    }

    const { width, height } = computeScaledDimensions(srcWidth, srcHeight, thumbEdge);
    const canvas = createCanvas(width, height);
    const context = typeof canvas?.getContext === "function" ? canvas.getContext("2d") : null;
    if (!context || typeof context.drawImage !== "function") {
      throw new Error("canvas 2d context is unavailable");
    }
    context.drawImage(image, 0, 0, width, height);

    if (typeof canvas.toDataURL !== "function") {
      throw new Error("canvas cannot export a data URL");
    }
    const dataUrl = canvas.toDataURL(thumbnailMime, thumbnailQuality);
    return { dataUrl, width, height };
  }

  // Produce a bounded thumbnail for a photoRef. Returns a placeholder (never
  // throws) on invalid refs, a tripped guard, or any decode/resize failure.
  async function getThumbnail(photoRef, { signal } = {}) {
    const ref = normalizePhotoRef(photoRef);
    if (!ref) {
      return buildPlaceholder(photoRef, "invalid_ref");
    }

    if (isGuardDisabled()) {
      diagnostics.guardSkips += 1;
      return buildPlaceholder(ref, "guard_disabled");
    }

    const cached = thumbnailCache.get(ref.ref);
    if (cached) {
      diagnostics.cacheHits += 1;
      // Touch LRU recency.
      thumbnailCache.delete(ref.ref);
      thumbnailCache.set(ref.ref, cached);
      return { ...cached, fromCache: true };
    }
    diagnostics.cacheMisses += 1;

    if (typeof loadImage !== "function") {
      return buildPlaceholder(ref, "no_image_loader");
    }

    try {
      const url = buildPhotoUrl(ref, { maxEdge: thumbEdge });
      const image = await loadImage(url, { signal });
      const { dataUrl, width, height } = await resizeToThumbnail(image);
      const record = {
        ref: ref.ref,
        dataUrl,
        width,
        height,
        attribution: ref.attribution,
        placeholder: false,
      };

      if (canCacheThumbnail(ref) !== false) {
        thumbnailCache.set(ref.ref, record);
        evictThumbnails();
      }

      diagnostics.generated += 1;
      return { ...record, fromCache: false };
    } catch {
      diagnostics.failures += 1;
      return buildPlaceholder(ref, "load_failed");
    }
  }

  // Lazily resolve the full-resolution photo URL for the UI to fetch directly.
  // Full-res bytes are intentionally NOT cached (TOS); returns a descriptor with
  // the URL or a skipped marker when the guard has tripped.
  function getFullResolution(photoRef, { maxEdge } = {}) {
    const ref = normalizePhotoRef(photoRef);
    if (!ref) {
      return null;
    }

    if (isGuardDisabled()) {
      diagnostics.guardSkips += 1;
      return { ref: ref.ref, url: null, skipped: true, reason: "guard_disabled" };
    }

    try {
      const url = buildPhotoUrl(ref, { maxEdge: clampPositiveInteger(maxEdge, fullEdge) });
      diagnostics.fullResRequests += 1;
      return {
        ref: ref.ref,
        url,
        attribution: ref.attribution,
        cached: false,
        skipped: false,
      };
    } catch {
      diagnostics.failures += 1;
      return { ref: ref.ref, url: null, skipped: true, reason: "url_unavailable" };
    }
  }

  function getThumbnailCacheSize() {
    return thumbnailCache.size;
  }

  function clearThumbnailCache() {
    thumbnailCache.clear();
  }

  // Diagnostics are exposed only behind the debug gate (shouldExposeDebug()).
  function getDiagnostics() {
    if (typeof shouldExposeDebug !== "function" || !shouldExposeDebug()) {
      return null;
    }
    return {
      ...diagnostics,
      thumbnailCacheSize: thumbnailCache.size,
      thumbnailMaxEdge: thumbEdge,
      fullResMaxEdge: fullEdge,
      maxThumbnails: thumbCapacity,
    };
  }

  return {
    getThumbnail,
    getFullResolution,
    getPlaceholder,
    getThumbnailCacheSize,
    clearThumbnailCache,
    getDiagnostics,
  };
}

// Browser default: decode an image URL into an HTMLImageElement. Honors an
// optional AbortSignal. crossOrigin is set so the canvas stays untainted when
// the host serves CORS headers (required for toDataURL).
function createBrowserImageLoader({ documentLike = typeof document !== "undefined" ? document : null, ImageCtor = typeof Image !== "undefined" ? Image : null } = {}) {
  if (!ImageCtor && !documentLike) {
    return null;
  }
  return function loadImage(url, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const image = ImageCtor ? new ImageCtor() : documentLike.createElement("img");
      const cleanup = () => {
        image.onload = null;
        image.onerror = null;
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = () => {
        cleanup();
        image.src = "";
        reject(new Error("image load aborted"));
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("image failed to load"));
      };
      try {
        image.crossOrigin = "anonymous";
      } catch {
        // crossOrigin is advisory; ignore environments that disallow setting it.
      }
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      image.src = url;
    });
  };
}

// Browser default: a canvas factory backed by <canvas>.
function createBrowserCanvasFactory({ documentLike = typeof document !== "undefined" ? document : null } = {}) {
  if (!documentLike || typeof documentLike.createElement !== "function") {
    return null;
  }
  return function createCanvas(width, height) {
    const canvas = documentLike.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

export {
  createPlacePhotosHandler,
  createBrowserImageLoader,
  createBrowserCanvasFactory,
  computeScaledDimensions,
  PLACEHOLDER_DATA_URL,
  DEFAULT_THUMBNAIL_MAX_EDGE,
};
