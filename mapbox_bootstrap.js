const MAPBOX_STYLESHEET_ID = "dgm-mapbox-stylesheet";
const MAPBOX_SCRIPT_ID = "dgm-mapbox-script";
const APP_MODULE_URL = "./app_v2.js?v=20260711-phase-g-map-style-fix";

const MAPBOX_BUILDS = Object.freeze({
  v2: Object.freeze({
    major: "v2",
    version: "2.15.0",
    experimental: false,
    stylesheetUrl: "https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.css",
    scriptUrl: "https://api.mapbox.com/mapbox-gl-js/v2.15.0/mapbox-gl.js",
  }),
  v3: Object.freeze({
    major: "v3",
    version: "3.15.0",
    experimental: true,
    stylesheetUrl: "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.css",
    scriptUrl: "https://api.mapbox.com/mapbox-gl-js/v3.15.0/mapbox-gl.js",
  }),
});

function normalizeFlag(value, fallback = null) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function resolveMapboxBuild({ flags = {}, search = "" } = {}) {
  let queryFlag = null;
  try {
    const searchParams = new URLSearchParams(search);
    if (searchParams.has("mapboxV3")) {
      queryFlag = normalizeFlag(searchParams.get("mapboxV3"), null);
    }
  } catch {
    queryFlag = null;
  }

  const windowFlag = normalizeFlag(flags?.mapboxV3, null);
  return (queryFlag ?? windowFlag ?? false) ? MAPBOX_BUILDS.v3 : MAPBOX_BUILDS.v2;
}

function createMapboxAssetElements(documentLike, build) {
  if (!documentLike?.head || typeof documentLike.createElement !== "function") {
    throw new TypeError("Mapbox bootstrap requires a document with a head element");
  }
  if (documentLike.getElementById?.(MAPBOX_STYLESHEET_ID) || documentLike.getElementById?.(MAPBOX_SCRIPT_ID)) {
    throw new Error("Mapbox bootstrap assets are already present");
  }

  const stylesheet = documentLike.createElement("link");
  stylesheet.id = MAPBOX_STYLESHEET_ID;
  stylesheet.rel = "stylesheet";
  stylesheet.href = build.stylesheetUrl;
  stylesheet.crossOrigin = "";
  stylesheet.dataset.mapboxMajor = build.major;

  const script = documentLike.createElement("script");
  script.id = MAPBOX_SCRIPT_ID;
  script.src = build.scriptUrl;
  script.crossOrigin = "";
  script.dataset.mapboxMajor = build.major;

  return { stylesheet, script };
}

function loadMapboxAssets(documentLike, build) {
  const { stylesheet, script } = createMapboxAssetElements(documentLike, build);

  const stylesheetLoaded = new Promise((resolve, reject) => {
    stylesheet.addEventListener("load", resolve, { once: true });
    stylesheet.addEventListener("error", () => reject(new Error(`Mapbox GL CSS stylesheet ${build.version} failed to load`)), { once: true });
  });
  const scriptLoaded = new Promise((resolve, reject) => {
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", () => reject(new Error(`Mapbox GL JS ${build.version} failed to load`)), { once: true });
  });

  documentLike.head.append(stylesheet, script);
  return Promise.all([stylesheetLoaded, scriptLoaded])
    .then(() => ({ build, script, stylesheet }));
}

function renderBootstrapError(documentLike, error) {
  const host = documentLike?.getElementById?.("main") || documentLike?.body;
  if (!host || typeof documentLike.createElement !== "function") {
    return;
  }
  const message = documentLike.createElement("div");
  message.className = "map-fatal-overlay";
  message.textContent = error instanceof Error ? error.message : String(error);
  host.append(message);
}

async function bootstrapMapbox({
  windowLike = globalThis.window,
  documentLike = globalThis.document,
  importApp = (moduleUrl) => import(moduleUrl),
  appModuleUrl = APP_MODULE_URL,
} = {}) {
  const build = resolveMapboxBuild({
    flags: windowLike?.DASH_FLAGS,
    search: windowLike?.location?.search,
  });

  windowLike.__DGM_MAPBOX_BUILD = {
    major: build.major,
    version: build.version,
    experimental: build.experimental,
  };

  await loadMapboxAssets(documentLike, build);
  if (!windowLike.mapboxgl) {
    throw new Error(`Mapbox GL JS ${build.version} loaded without window.mapboxgl`);
  }
  await importApp(appModuleUrl);
  return build;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootstrapMapbox().catch((error) => {
    console.error(error);
    renderBootstrapError(document, error);
  });
}

export {
  APP_MODULE_URL,
  MAPBOX_BUILDS,
  MAPBOX_SCRIPT_ID,
  MAPBOX_STYLESHEET_ID,
  bootstrapMapbox,
  createMapboxAssetElements,
  loadMapboxAssets,
  normalizeFlag,
  resolveMapboxBuild,
};
