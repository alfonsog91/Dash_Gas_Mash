const MAP_CONFIG_STORAGE_PREFIX = "dgm:map-config:";

const DEFAULT_MAP_FEATURE_FLAGS = Object.freeze({
  telemetry: true,
  trafficVisibilityController: true,
  trafficPaintVisibilityFallback: true,
  headingCompassAutoRequest: true,
  headingKeyboardShortcut: true,
  headingRelativeAlphaFallback: true,
  visualPerformanceHeuristics: false,
});

const DEFAULT_MAP_KILL_SWITCHES = Object.freeze({
  traffic: false,
  heading: false,
  compassPermission: false,
  runtimeDiagnostics: false,
});

const runtimeFeatureOverrides = new Map();
const runtimeKillSwitchOverrides = new Map();

const NON_CRITICAL_NEW_FEATURE_FLAGS = Object.freeze([
  "trafficVisibilityController",
  "trafficPaintVisibilityFallback",
  "headingCompassAutoRequest",
  "headingKeyboardShortcut",
  "headingRelativeAlphaFallback",
  "visualPerformanceHeuristics",
]);

function getWindowLike() {
  return typeof window !== "undefined" ? window : null;
}

function canUseLocalStorage() {
  return Boolean(getWindowLike()?.localStorage);
}

function normalizeToggle(value, fallback = null) {
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

function readWindowConfigBucket(bucketName) {
  const windowLike = getWindowLike();
  const config = windowLike?.DGM_MAP_CONFIG || windowLike?.DGM_CONFIG || {};
  return config && typeof config === "object" && config[bucketName] && typeof config[bucketName] === "object"
    ? config[bucketName]
    : {};
}

function getStorageKey(kind, name) {
  return `${MAP_CONFIG_STORAGE_PREFIX}${kind}:${name}`;
}

function readStoredToggle(kind, name) {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    return normalizeToggle(getWindowLike().localStorage.getItem(getStorageKey(kind, name)), null);
  } catch {
    return null;
  }
}

function writeStoredToggle(kind, name, value) {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    getWindowLike().localStorage.setItem(getStorageKey(kind, name), value ? "true" : "false");
  } catch {
    // Storage failures should not affect runtime rollback controls.
  }
}

function resolveToggle({ kind, name, defaults, runtimeOverrides, windowBucketName }) {
  if (runtimeOverrides.has(name)) {
    return runtimeOverrides.get(name);
  }

  const storedValue = readStoredToggle(kind, name);
  if (storedValue !== null) {
    return storedValue;
  }

  const windowBucket = readWindowConfigBucket(windowBucketName);
  const windowValue = normalizeToggle(windowBucket[name], null);
  if (windowValue !== null) {
    return windowValue;
  }

  return normalizeToggle(defaults[name], false);
}

function isMapFeatureEnabled(name) {
  return resolveToggle({
    kind: "feature",
    name,
    defaults: DEFAULT_MAP_FEATURE_FLAGS,
    runtimeOverrides: runtimeFeatureOverrides,
    windowBucketName: "featureFlags",
  });
}

function isMapKillSwitchEnabled(name) {
  return resolveToggle({
    kind: "kill",
    name,
    defaults: DEFAULT_MAP_KILL_SWITCHES,
    runtimeOverrides: runtimeKillSwitchOverrides,
    windowBucketName: "killSwitches",
  });
}

function getMapFeatureFlags() {
  return Object.fromEntries(
    Object.keys(DEFAULT_MAP_FEATURE_FLAGS).map((name) => [name, isMapFeatureEnabled(name)])
  );
}

function getMapKillSwitches() {
  return Object.fromEntries(
    Object.keys(DEFAULT_MAP_KILL_SWITCHES).map((name) => [name, isMapKillSwitchEnabled(name)])
  );
}

function logDgmTelemetry(event, payload = {}) {
  if (!isMapFeatureEnabled("telemetry")) {
    return false;
  }

  const telemetry = getWindowLike()?.__DGM_TELEMETRY;
  if (!telemetry || typeof telemetry.log !== "function") {
    return false;
  }

  try {
    telemetry.log(event, payload);
    return true;
  } catch {
    return false;
  }
}

function setMapFeatureFlag(name, enabled, { persist = true } = {}) {
  const nextValue = Boolean(enabled);
  runtimeFeatureOverrides.set(name, nextValue);
  if (persist) {
    writeStoredToggle("feature", name, nextValue);
  }
  logDgmTelemetry("map_config.feature_flag_changed", { name, enabled: nextValue, persist });
  return nextValue;
}

function setMapKillSwitch(name, enabled, { persist = true } = {}) {
  const nextValue = Boolean(enabled);
  runtimeKillSwitchOverrides.set(name, nextValue);
  if (persist) {
    writeStoredToggle("kill", name, nextValue);
  }
  logDgmTelemetry("map_config.kill_switch_changed", { name, enabled: nextValue, persist });
  return nextValue;
}

function disableAllNewFeatures({ persist = false, reason = "manual" } = {}) {
  const previousFeatureFlags = getMapFeatureFlags();
  const disabledFeatureFlags = [];

  for (const name of NON_CRITICAL_NEW_FEATURE_FLAGS) {
    if (isMapFeatureEnabled(name)) {
      disabledFeatureFlags.push(name);
    }
    setMapFeatureFlag(name, false, { persist });
  }

  const snapshot = getMapRuntimeConfigSnapshot();
  logDgmTelemetry("map_config.disable_all_new_features", {
    reason,
    persist,
    disabledFeatureFlags,
    previousFeatureFlags,
    snapshot,
  });

  return {
    disabledFeatureFlags,
    previousFeatureFlags,
    snapshot,
  };
}

function getMapRuntimeConfigSnapshot() {
  return {
    featureFlags: getMapFeatureFlags(),
    killSwitches: getMapKillSwitches(),
  };
}

function logMapFeatureFlagState({ reason = "snapshot", buildId = null } = {}) {
  const snapshot = getMapRuntimeConfigSnapshot();
  logDgmTelemetry("map.feature_flag_state", {
    reason,
    buildId,
    snapshot,
  });
  return snapshot;
}

function installMapConfigRuntimeSurface({ buildId = null } = {}) {
  const windowLike = getWindowLike();
  if (!windowLike) {
    return null;
  }

  const runtime = windowLike.DGM_RUNTIME && typeof windowLike.DGM_RUNTIME === "object"
    ? windowLike.DGM_RUNTIME
    : {};

  runtime.config = {
    buildId,
    disableAllNewFeatures,
    getSnapshot: getMapRuntimeConfigSnapshot,
    isFeatureEnabled: isMapFeatureEnabled,
    isKillSwitchEnabled: isMapKillSwitchEnabled,
    logFeatureFlagState: logMapFeatureFlagState,
    setFeatureFlag: setMapFeatureFlag,
    setKillSwitch: setMapKillSwitch,
  };
  windowLike.DGM_RUNTIME = runtime;
  return runtime.config;
}

export {
  DEFAULT_MAP_FEATURE_FLAGS,
  DEFAULT_MAP_KILL_SWITCHES,
  NON_CRITICAL_NEW_FEATURE_FLAGS,
  disableAllNewFeatures,
  getMapRuntimeConfigSnapshot,
  installMapConfigRuntimeSurface,
  isMapFeatureEnabled,
  isMapKillSwitchEnabled,
  logDgmTelemetry,
  logMapFeatureFlagState,
  setMapFeatureFlag,
  setMapKillSwitch,
};
