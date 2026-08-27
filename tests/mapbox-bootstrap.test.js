import { readFile } from "node:fs/promises";
import {
  MAPBOX_BUILDS,
  bootstrapMapbox,
  loadMapboxAssets,
  resolveMapboxBuild,
} from "../mapbox_bootstrap.js";

const PASS = "PASS";
const FAIL = "FAIL";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createDocumentFixture() {
  const nodes = [];
  const byId = new Map();
  const head = {
    append(...elements) {
      for (const element of elements) {
        nodes.push(element);
        if (element.id) {
          byId.set(element.id, element);
        }
      }
    },
  };

  return {
    documentLike: {
      head,
      createElement(tagName) {
        const listeners = {};
        return {
          tagName: tagName.toUpperCase(),
          dataset: {},
          listeners,
          addEventListener(eventName, listener) {
            listeners[eventName] = listener;
          },
        };
      },
      getElementById: (id) => byId.get(id) || null,
    },
    nodes,
  };
}

export async function runMapboxBootstrapTests() {
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

  await runTest("flag off resolves unchanged Mapbox v2 build", () => {
    const build = resolveMapboxBuild();
    assert(build === MAPBOX_BUILDS.v2, "default selection is the pinned v2 build");
    assert(build.scriptUrl.includes("/v2.15.0/"), "default script remains v2.15.0");
  });

  await runTest("window flag and query parameter select the experimental build", () => {
    assert(resolveMapboxBuild({ flags: { mapboxV3: true } }) === MAPBOX_BUILDS.v3, "window flag enables v3");
    assert(resolveMapboxBuild({ search: "?mapboxV3=true" }) === MAPBOX_BUILDS.v3, "query flag enables v3");
    assert(
      resolveMapboxBuild({ flags: { mapboxV3: true }, search: "?mapboxV3=false" }) === MAPBOX_BUILDS.v2,
      "explicit query false overrides the window flag"
    );
  });

  await runTest("v2 selection appends one v2 script and stylesheet only", async () => {
    const fixture = createDocumentFixture();
    const loaded = loadMapboxAssets(fixture.documentLike, MAPBOX_BUILDS.v2);
    const scripts = fixture.nodes.filter((node) => node.tagName === "SCRIPT");
    const stylesheets = fixture.nodes.filter((node) => node.tagName === "LINK");
    assert(scripts.length === 1 && stylesheets.length === 1, "one script and one stylesheet are appended");
    assert(scripts[0].src === MAPBOX_BUILDS.v2.scriptUrl, "only the v2 script is selected");
    assert(stylesheets[0].href === MAPBOX_BUILDS.v2.stylesheetUrl, "only the v2 stylesheet is selected");
    assert(!fixture.nodes.some((node) => String(node.src || node.href).includes("/v3.")), "no v3 asset is present");
    scripts[0].listeners.load();
    stylesheets[0].listeners.load();
    await loaded;
  });

  await runTest("v3 flag loads one v3 pair before importing the app", async () => {
    const fixture = createDocumentFixture();
    const importedModules = [];
    const windowLike = {
      DASH_FLAGS: { mapboxV3: true },
      location: { search: "" },
    };
    const booted = bootstrapMapbox({
      windowLike,
      documentLike: fixture.documentLike,
      importApp: async (moduleUrl) => importedModules.push(moduleUrl),
    });
    const scripts = fixture.nodes.filter((node) => node.tagName === "SCRIPT");
    const stylesheets = fixture.nodes.filter((node) => node.tagName === "LINK");
    assert(scripts.length === 1, "only one Mapbox script is appended");
    assert(scripts[0].src === MAPBOX_BUILDS.v3.scriptUrl, "the selected script is v3.15.0");
    assert(importedModules.length === 0, "the app waits for Mapbox to load");
    windowLike.mapboxgl = {};
    scripts[0].listeners.load();
    await Promise.resolve();
    assert(importedModules.length === 0, "the app also waits for Mapbox CSS");
    stylesheets[0].listeners.load();
    const build = await booted;
    assert(build === MAPBOX_BUILDS.v3, "bootstrap reports the experimental v3 build");
    assert(importedModules.length === 1, "the app imports after Mapbox is ready");
    assert(windowLike.__DGM_MAPBOX_BUILD.experimental === true, "runtime metadata marks v3 experimental");
    assert(!fixture.nodes.some((node) => String(node.src || node.href).includes("/v2.")), "no v2 asset is present");
  });

  await runTest("stylesheet failure rejects before importing the app", async () => {
    const fixture = createDocumentFixture();
    const importedModules = [];
    const windowLike = { DASH_FLAGS: {}, location: { search: "" }, mapboxgl: {} };
    const booted = bootstrapMapbox({
      windowLike,
      documentLike: fixture.documentLike,
      importApp: async (moduleUrl) => importedModules.push(moduleUrl),
    });
    const script = fixture.nodes.find((node) => node.tagName === "SCRIPT");
    const stylesheet = fixture.nodes.find((node) => node.tagName === "LINK");
    script.listeners.load();
    stylesheet.listeners.error();

    let rejection = null;
    try {
      await booted;
    } catch (error) {
      rejection = error;
    }

    assert(rejection?.message.includes("stylesheet"), "failure identifies the stylesheet");
    assert(importedModules.length === 0, "the app is not imported without Mapbox CSS");
  });

  await runTest("index delegates exclusive Mapbox selection and app startup to the bootstrap", async () => {
    const indexHtml = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert(!indexHtml.includes("api.mapbox.com/mapbox-gl-js/v2"), "index has no hardcoded v2 asset");
    assert(!indexHtml.includes("api.mapbox.com/mapbox-gl-js/v3"), "index has no hardcoded v3 asset");
    assert(!indexHtml.includes('src="./app_v2.js'), "index does not import the app before Mapbox");
    assert(indexHtml.includes('src="./mapbox_bootstrap.js'), "index starts through the exclusive selector");
  });

  console.log(`Results: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

if (typeof window !== "undefined") {
  window.addEventListener("load", runMapboxBootstrapTests);
}
