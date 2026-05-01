const DEFAULT_MAP_RUNTIME_READY_EVENTS = Object.freeze(["style.load", "styledata", "idle"]);

function safeBooleanCall(target, methodName, fallback = false) {
  if (!target || typeof target[methodName] !== "function") {
    return fallback;
  }

  try {
    return Boolean(target[methodName]());
  } catch {
    return fallback;
  }
}

function isMapStyleReady(map) {
  return safeBooleanCall(map, "isStyleLoaded", false);
}

function queueTask(fn) {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(fn);
    return;
  }

  Promise.resolve().then(fn);
}

function createMapRuntimeReadyGate(
  map,
  onReady,
  {
    events = DEFAULT_MAP_RUNTIME_READY_EVENTS,
    isReady = isMapStyleReady,
    fireImmediately = true,
    dedupeReadyCycle = true,
  } = {}
) {
  if (!map || typeof onReady !== "function") {
    return () => {};
  }

  const eventNames = Array.from(new Set((Array.isArray(events) ? events : [])
    .map((eventName) => String(eventName || "").trim())
    .filter(Boolean)));
  const listeners = [];
  let disposed = false;
  let queued = false;
  let lastEventName = fireImmediately ? "immediate" : null;
  let firedForReadyCycle = false;

  const flush = () => {
    queued = false;
    if (disposed) {
      return;
    }

    const ready = Boolean(isReady(map));
    if (!ready) {
      firedForReadyCycle = false;
      return;
    }

    if (dedupeReadyCycle && firedForReadyCycle) {
      return;
    }

    firedForReadyCycle = true;
    onReady({ map, eventName: lastEventName || "unknown" });
  };

  const schedule = (eventName) => {
    lastEventName = eventName || lastEventName || "unknown";
    if (queued || disposed) {
      return;
    }

    queued = true;
    queueTask(flush);
  };

  for (const eventName of eventNames) {
    if (typeof map.on !== "function") {
      continue;
    }

    const listener = () => schedule(eventName);
    map.on(eventName, listener);
    listeners.push({ eventName, listener });
  }

  if (fireImmediately) {
    schedule("immediate");
  }

  return () => {
    disposed = true;
    for (const { eventName, listener } of listeners) {
      if (typeof map.off === "function") {
        map.off(eventName, listener);
      }
    }
  };
}

export {
  DEFAULT_MAP_RUNTIME_READY_EVENTS,
  createMapRuntimeReadyGate,
  isMapStyleReady,
};