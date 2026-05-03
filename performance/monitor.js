const PHASE_E_PERFORMANCE_GUARD_EFFECTS = Object.freeze({
  COLOR_GRADING: "phaseDColorGrading",
  FOG_TUNING: "phaseDFogTuning",
  LABEL_OPACITY: "phaseDLabelOpacity",
  DGM_TRAFFIC_STYLING: "dgmTrafficStyling",
});

const PHASE_E_PERFORMANCE_GUARD_EFFECT_LIST = Object.freeze(Object.values(PHASE_E_PERFORMANCE_GUARD_EFFECTS));

const DEFAULT_PHASE_E_PERFORMANCE_GUARD_THRESHOLDS = Object.freeze({
  minMobileFps: 30,
  sustainedFrameSamples: 45,
});

function toFinitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function roundMetric(value, digits = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getAvailableGpuMemoryMb(environment = {}) {
  const directValue = toFinitePositiveNumber(environment?.gpuMemoryMb);
  if (directValue !== null) {
    return directValue;
  }

  const gpuValue = toFinitePositiveNumber(environment?.gpu?.memoryMb);
  return gpuValue === null ? null : gpuValue;
}

function detectMobileViewport(windowLike = null) {
  if (!windowLike) {
    return false;
  }

  try {
    if (typeof windowLike.matchMedia === "function" && windowLike.matchMedia("(pointer: coarse)").matches) {
      return true;
    }
  } catch {
    // Viewport checks are advisory only; width fallback below is enough for tests and older browsers.
  }

  const width = toFinitePositiveNumber(windowLike.innerWidth);
  return width !== null && width <= 768;
}

function getFrameStats(frameDurationsMs = []) {
  const validDurations = frameDurationsMs.map(toFinitePositiveNumber).filter((value) => value !== null);
  const frameSamples = validDurations.length;
  if (frameSamples === 0) {
    return {
      averageFps: null,
      averageFrameTimeMs: null,
      worstFrameTimeMs: null,
      frameSamples,
    };
  }

  const totalFrameTimeMs = validDurations.reduce((sum, value) => sum + value, 0);
  const averageFrameTimeMs = totalFrameTimeMs / frameSamples;
  return {
    averageFps: roundMetric(1000 / averageFrameTimeMs),
    averageFrameTimeMs: roundMetric(averageFrameTimeMs),
    worstFrameTimeMs: roundMetric(Math.max(...validDurations)),
    frameSamples,
  };
}

function evaluatePhaseEPerformanceGuard({
  isMobile = false,
  frameDurationsMs = [],
  thresholds = DEFAULT_PHASE_E_PERFORMANCE_GUARD_THRESHOLDS,
  environment = {},
} = {}) {
  const stats = getFrameStats(frameDurationsMs);
  const sustained = stats.frameSamples >= thresholds.sustainedFrameSamples;
  const active = Boolean(
    isMobile
    && sustained
    && stats.averageFps !== null
    && stats.averageFps < thresholds.minMobileFps
  );
  const reason = active ? "sustained_mobile_fps_below_30" : null;

  return {
    active,
    reason,
    disabledEffects: active ? [...PHASE_E_PERFORMANCE_GUARD_EFFECT_LIST] : [],
    averageFps: stats.averageFps,
    averageFrameTimeMs: stats.averageFrameTimeMs,
    worstFrameTimeMs: stats.worstFrameTimeMs,
    frameSamples: stats.frameSamples,
    minMobileFps: thresholds.minMobileFps,
    sustainedFrameSamples: thresholds.sustainedFrameSamples,
    isMobile: Boolean(isMobile),
    gpuMemoryMb: getAvailableGpuMemoryMb(environment),
  };
}

function createPhaseEFrameAnalyzer({ thresholds = DEFAULT_PHASE_E_PERFORMANCE_GUARD_THRESHOLDS } = {}) {
  const frameDurationsMs = [];
  let lastFrameTimestamp = null;

  function trimSamples() {
    const maxSamples = Math.max(thresholds.sustainedFrameSamples * 2, thresholds.sustainedFrameSamples);
    while (frameDurationsMs.length > maxSamples) {
      frameDurationsMs.shift();
    }
  }

  return {
    recordFrame(timestampMs) {
      const timestamp = toFinitePositiveNumber(timestampMs);
      if (timestamp === null) {
        return this.getFrameDurations();
      }

      if (lastFrameTimestamp !== null && timestamp > lastFrameTimestamp) {
        frameDurationsMs.push(timestamp - lastFrameTimestamp);
        trimSamples();
      }
      lastFrameTimestamp = timestamp;
      return this.getFrameDurations();
    },
    getFrameDurations() {
      return frameDurationsMs.slice();
    },
    getSnapshot(options = {}) {
      return evaluatePhaseEPerformanceGuard({
        ...options,
        thresholds,
        frameDurationsMs: frameDurationsMs.slice(),
      });
    },
    reset() {
      frameDurationsMs.length = 0;
      lastFrameTimestamp = null;
    },
  };
}

function emitTelemetry(telemetryEmitter, eventName, payload) {
  try {
    if (typeof telemetryEmitter === "function") {
      telemetryEmitter(eventName, payload);
      return true;
    }

    if (telemetryEmitter && typeof telemetryEmitter.emit === "function") {
      telemetryEmitter.emit(eventName, payload);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function createPhaseEPerformanceMonitor({
  windowLike = typeof window !== "undefined" ? window : null,
  environment = typeof navigator !== "undefined" ? navigator : {},
  telemetryEmitter = null,
  shouldExposeDebug = () => false,
  onFallback = null,
  thresholds = DEFAULT_PHASE_E_PERFORMANCE_GUARD_THRESHOLDS,
} = {}) {
  const analyzer = createPhaseEFrameAnalyzer({ thresholds });
  let animationFrameId = null;
  let started = false;
  let activeGuard = null;

  function getIsMobile() {
    return detectMobileViewport(windowLike);
  }

  function getCurrentSnapshot() {
    const snapshot = analyzer.getSnapshot({ isMobile: getIsMobile(), environment });
    if (!activeGuard) {
      return snapshot;
    }

    return {
      ...snapshot,
      active: true,
      reason: activeGuard.reason,
      disabledEffects: activeGuard.disabledEffects.slice(),
      triggeredAt: activeGuard.triggeredAt,
    };
  }

  function getTelemetryPayload(snapshot) {
    const payload = {
      reason: snapshot.reason,
      disabledEffects: snapshot.disabledEffects,
      averageFps: snapshot.averageFps,
      averageFrameTimeMs: snapshot.averageFrameTimeMs,
      worstFrameTimeMs: snapshot.worstFrameTimeMs,
      frameSamples: snapshot.frameSamples,
      isMobile: snapshot.isMobile,
    };

    if (snapshot.gpuMemoryMb !== null) {
      payload.gpuMemoryMb = snapshot.gpuMemoryMb;
    }

    return payload;
  }

  function exposeDebugSurface() {
    if (!windowLike || typeof shouldExposeDebug !== "function" || !shouldExposeDebug()) {
      return;
    }

    windowLike.__DGM_DEBUG = Object.assign(windowLike.__DGM_DEBUG || {}, {
      phaseEPerformance: getCurrentSnapshot(),
      getPhaseEPerformanceDashboard: getCurrentSnapshot,
    });
  }

  function triggerGuard(snapshot) {
    if (activeGuard || !snapshot.active) {
      return;
    }

    activeGuard = {
      reason: snapshot.reason,
      disabledEffects: snapshot.disabledEffects.slice(),
      triggeredAt: Date.now(),
    };

    const guardedSnapshot = getCurrentSnapshot();
    emitTelemetry(telemetryEmitter, "map.phase_e_performance_guard_triggered", getTelemetryPayload(guardedSnapshot));
    exposeDebugSurface();

    if (typeof onFallback === "function") {
      onFallback(guardedSnapshot);
    }
  }

  function handleFrame(timestampMs) {
    analyzer.recordFrame(timestampMs);
    const snapshot = getCurrentSnapshot();
    triggerGuard(snapshot);
    exposeDebugSurface();

    if (started && typeof windowLike?.requestAnimationFrame === "function") {
      animationFrameId = windowLike.requestAnimationFrame(handleFrame);
    }
  }

  return {
    start() {
      if (started || typeof windowLike?.requestAnimationFrame !== "function") {
        exposeDebugSurface();
        return false;
      }

      started = true;
      animationFrameId = windowLike.requestAnimationFrame(handleFrame);
      exposeDebugSurface();
      return true;
    },
    stop() {
      started = false;
      if (animationFrameId !== null && typeof windowLike?.cancelAnimationFrame === "function") {
        windowLike.cancelAnimationFrame(animationFrameId);
      }
      animationFrameId = null;
    },
    getDashboard: getCurrentSnapshot,
    getGuardSnapshot: getCurrentSnapshot,
    isEffectDisabled(effectName) {
      return getCurrentSnapshot().disabledEffects.includes(effectName);
    },
    recordFrameForTest(timestampMs) {
      analyzer.recordFrame(timestampMs);
      const snapshot = getCurrentSnapshot();
      triggerGuard(snapshot);
      return getCurrentSnapshot();
    },
  };
}

export {
  DEFAULT_PHASE_E_PERFORMANCE_GUARD_THRESHOLDS,
  PHASE_E_PERFORMANCE_GUARD_EFFECTS,
  createPhaseEFrameAnalyzer,
  createPhaseEPerformanceMonitor,
  detectMobileViewport,
  evaluatePhaseEPerformanceGuard,
  getAvailableGpuMemoryMb,
};
