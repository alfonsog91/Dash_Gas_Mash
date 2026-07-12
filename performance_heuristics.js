const DEFAULT_VISUAL_PERFORMANCE_THRESHOLDS = Object.freeze({
  minDeviceMemoryGb: 4,
  minHardwareConcurrency: 4,
});

function toFinitePositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function evaluateVisualPerformanceHeuristics({
  enabled = false,
  environment = {},
  thresholds = DEFAULT_VISUAL_PERFORMANCE_THRESHOLDS,
} = {}) {
  const deviceMemoryGb = toFinitePositiveNumber(environment?.deviceMemory);
  const hardwareConcurrency = toFinitePositiveNumber(environment?.hardwareConcurrency);
  const reasons = [];

  if (enabled && deviceMemoryGb !== null && deviceMemoryGb < thresholds.minDeviceMemoryGb) {
    reasons.push("low_device_memory");
  }

  if (enabled && hardwareConcurrency !== null && hardwareConcurrency < thresholds.minHardwareConcurrency) {
    reasons.push("low_hardware_concurrency");
  }

  return {
    enabled: Boolean(enabled),
    deviceMemoryGb,
    hardwareConcurrency,
    disabledScope: "future_visual_polish",
    shouldDisableFutureVisualPolish: Boolean(enabled && reasons.length > 0),
    reasons,
  };
}

export {
  DEFAULT_VISUAL_PERFORMANCE_THRESHOLDS,
  evaluateVisualPerformanceHeuristics,
};