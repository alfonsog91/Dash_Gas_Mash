// ──────────────────────────────────────────────────────────────────
// GOVERNANCE: This module implements the default-off learned predictor
// authorized in GOVERNANCE.md §8.4–§8.6. It is bounded to existing
// runtime features, emits descriptive probabilities only, and preserves
// rollback safety through shrinkage to the legacy scorer and a bootstrap
// feature flag. No element of this module constitutes decision authority.
// ──────────────────────────────────────────────────────────────────

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function sigmoid(value) {
  const x = Number(value) || 0;
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }

  const z = Math.exp(x);
  return z / (1 + z);
}

function safeProbability(value) {
  return Math.max(1e-6, Math.min(1 - 1e-6, clamp01(value)));
}

function dot(weights, features) {
  let total = Number(weights?.intercept) || 0;

  for (const [key, value] of Object.entries(features ?? {})) {
    total += (Number(weights?.[key]) || 0) * (Number(value) || 0);
  }

  return total;
}

function binaryEntropy(probability) {
  const p = safeProbability(probability);
  return -p * Math.log(p) - (1 - p) * Math.log(1 - p);
}

function betaCalibrate(probability, calibrator = {}) {
  const p = safeProbability(probability);
  const alpha = Number(calibrator.alpha ?? 1);
  const beta = Number(calibrator.beta ?? -1);
  const bias = Number(calibrator.bias ?? 0);
  return sigmoid(alpha * Math.log(p) + beta * Math.log(1 - p) + bias);
}

function timeBucketFlags(timeBucketName) {
  return {
    lunch: timeBucketName === "lunch" ? 1 : 0,
    dinner: timeBucketName === "dinner" ? 1 : 0,
    lateDinner: timeBucketName === "late_dinner" ? 1 : 0,
    lateNight: timeBucketName === "late_night" ? 1 : 0,
    postMidnight: timeBucketName === "post_midnight" ? 1 : 0,
  };
}

export const LEARNED_PREDICTION_MODEL = {
  version: "20260401-monotone-dual-glm",
  family: "monotone-calibrated-dual-logit",
  pAny: {
    weights: {
      intercept: -2.1,
      merchantSignal: 2.65,
      proximitySignal: 1.45,
      competitionSignal: -1.85,
      supportScore: 1.15,
      residentialShare: 0.75,
      horizonLog: 0.95,
      interactionDemandProximity: 1.35,
      interactionDemandSupport: 0.8,
      interactionCompetitionDemand: -0.9,
      lunch: 0.15,
      dinner: 0.32,
      lateDinner: 0.12,
      lateNight: -0.18,
      postMidnight: -0.28,
      weekend: 0.08,
      weekendDinner: 0.14,
    },
    calibrator: {
      alpha: 1.04,
      beta: -0.96,
      bias: 0.02,
    },
  },
  quality: {
    weights: {
      intercept: -0.95,
      incomeSignal: 2.4,
      proximitySignal: 0.9,
      competitionSignal: -0.35,
      supportScore: 0.45,
      residentialShare: -0.15,
      lateNight: -0.55,
      dinner: 0.12,
      weekend: 0.06,
      interactionIncomeProximity: 1.15,
    },
    calibrator: {
      alpha: 1.02,
      beta: -0.98,
      bias: -0.01,
    },
  },
  shrinkage: {
    minBlend: 0.04,
    supportWeight: 0.35,
    confidenceWeight: 0.18,
  },
  supportScale: {
    base: 0.7,
    confidenceWeight: 0.55,
  },
};

export function resolvePredictionModelName(predictionModel, useML) {
  const normalized = String(predictionModel || "").trim().toLowerCase();
  if (normalized === "glm") return "glm";
  if (normalized === "legacy" || normalized === "softplus") return normalized;
  return useML ? "softplus" : "legacy";
}

export function buildLearnedFeatureMaps({
  sigI,
  sigM,
  sigR,
  sigD,
  supportScore,
  residentialShare,
  horizonMin,
  timeBucketName,
  isWeekend,
}) {
  const merchantSignal = clamp01(sigM);
  const proximitySignal = clamp01(sigR);
  const competitionSignal = clamp01(sigD);
  const incomeSignal = clamp01(sigI);
  const support = clamp01(supportScore);
  const residential = clamp01(residentialShare);
  const weekend = isWeekend ? 1 : 0;
  const horizonLog = Math.log1p(Math.max(1, Number(horizonMin) || 10) / 10);
  const bucketFlags = timeBucketFlags(timeBucketName);

  return {
    pAny: {
      merchantSignal,
      proximitySignal,
      competitionSignal,
      supportScore: support,
      residentialShare: residential,
      horizonLog,
      interactionDemandProximity: merchantSignal * proximitySignal,
      interactionDemandSupport: merchantSignal * support,
      interactionCompetitionDemand: merchantSignal * competitionSignal,
      lunch: bucketFlags.lunch,
      dinner: bucketFlags.dinner,
      lateDinner: bucketFlags.lateDinner,
      lateNight: bucketFlags.lateNight,
      postMidnight: bucketFlags.postMidnight,
      weekend,
      weekendDinner: weekend * bucketFlags.dinner,
    },
    quality: {
      incomeSignal,
      proximitySignal,
      competitionSignal,
      supportScore: support,
      residentialShare: residential,
      lateNight: bucketFlags.lateNight + bucketFlags.postMidnight,
      dinner: bucketFlags.dinner + bucketFlags.lateDinner,
      weekend,
      interactionIncomeProximity: incomeSignal * proximitySignal,
    },
  };
}

export function predictLearnedOrderModel(context, model = LEARNED_PREDICTION_MODEL) {
  const featureMaps = buildLearnedFeatureMaps(context);
  const rawPAny = sigmoid(dot(model.pAny.weights, featureMaps.pAny));
  const calibratedPAny = betaCalibrate(rawPAny, model.pAny.calibrator);
  const rawQuality = sigmoid(dot(model.quality.weights, featureMaps.quality));
  const calibratedQuality = betaCalibrate(rawQuality, model.quality.calibrator);

  const entropyScale = Math.log(2);
  const confidence = clamp01(
    1 - ((binaryEntropy(calibratedPAny) + binaryEntropy(calibratedQuality)) / 2) / entropyScale
  );
  const supportMass = clamp01(0.55 * clamp01(context.supportScore) + 0.45 * clamp01(context.sigM));
  const blend = clamp01(
    model.shrinkage.minBlend
    + model.shrinkage.supportWeight * supportMass
    + model.shrinkage.confidenceWeight * confidence
  );

  const baselinePAny = clamp01(context.baselinePAny ?? calibratedPAny);
  const baselineQuality = clamp01(context.baselineQuality ?? calibratedQuality);
  const pAny = clamp01((1 - blend) * baselinePAny + blend * calibratedPAny);
  const quality = clamp01((1 - blend) * baselineQuality + blend * calibratedQuality);
  const supportScale = Math.max(
    0.4,
    Number(model.supportScale.base) + Number(model.supportScale.confidenceWeight) * (0.5 * confidence + 0.5 * supportMass)
  );

  return {
    pAny,
    quality,
    rawPAny,
    calibratedPAny,
    rawQuality,
    calibratedQuality,
    confidence,
    blend,
    supportMass,
    supportScale,
    family: model.family,
    version: model.version,
  };
}

function projectWeight(weight, key, positive, negative) {
  if (positive.has(key)) return Math.max(0, weight);
  if (negative.has(key)) return Math.min(0, weight);
  return weight;
}

function logisticLoss(probability, label) {
  const p = safeProbability(probability);
  const y = clamp01(label);
  return -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
}

export function trainRegularizedLogisticModel(
  samples,
  {
    featureKeys,
    iterations = 400,
    learningRate = 0.2,
    l2 = 0.02,
    positive = [],
    negative = [],
    initialWeights = {},
  } = {}
) {
  const keys = [...(featureKeys ?? [])];
  const positiveConstraints = new Set(positive);
  const negativeConstraints = new Set(negative);
  const weights = { intercept: Number(initialWeights.intercept) || 0 };
  for (const key of keys) {
    weights[key] = Number(initialWeights[key]) || 0;
  }

  const rows = (samples ?? []).filter((sample) => sample && sample.features);
  if (!rows.length) return { weights, averageLoss: 0 };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradients = { intercept: 0 };
    for (const key of keys) gradients[key] = 0;

    for (const sample of rows) {
      const weight = Math.max(0, Number(sample.weight) || 1);
      const label = clamp01(sample.label);
      const score = sigmoid(dot(weights, sample.features));
      const error = (score - label) * weight;

      gradients.intercept += error;
      for (const key of keys) {
        gradients[key] += error * (Number(sample.features[key]) || 0);
      }
    }

    const scale = 1 / rows.length;
    weights.intercept -= learningRate * gradients.intercept * scale;
    for (const key of keys) {
      const penalty = 2 * l2 * weights[key];
      const nextWeight = weights[key] - learningRate * (gradients[key] * scale + penalty);
      weights[key] = projectWeight(nextWeight, key, positiveConstraints, negativeConstraints);
    }
  }

  const averageLoss = rows.reduce((sum, sample) => {
    const probability = sigmoid(dot(weights, sample.features));
    return sum + logisticLoss(probability, sample.label) * Math.max(0, Number(sample.weight) || 1);
  }, 0) / rows.length;

  return { weights, averageLoss };
}

export function fitBetaCalibrator(samples, { iterations = 250, learningRate = 0.15, l2 = 0.005 } = {}) {
  const trainingRows = (samples ?? []).map((sample) => ({
    features: {
      logPositive: Math.log(safeProbability(sample.rawProbability)),
      logNegative: Math.log(1 - safeProbability(sample.rawProbability)),
    },
    label: clamp01(sample.label),
    weight: Math.max(0, Number(sample.weight) || 1),
  }));

  const trained = trainRegularizedLogisticModel(trainingRows, {
    featureKeys: ["logPositive", "logNegative"],
    iterations,
    learningRate,
    l2,
  });

  return {
    alpha: trained.weights.logPositive,
    beta: trained.weights.logNegative,
    bias: trained.weights.intercept,
    averageLoss: trained.averageLoss,
  };
}

export function expectedCalibrationError(samples, { bins = 10 } = {}) {
  const count = Math.max(1, Number(bins) || 10);
  const buckets = Array.from({ length: count }, () => ({ total: 0, probability: 0, positive: 0 }));

  for (const sample of samples ?? []) {
    const probability = clamp01(sample.probability);
    const bucketIndex = Math.min(count - 1, Math.floor(probability * count));
    const bucket = buckets[bucketIndex];
    bucket.total += 1;
    bucket.probability += probability;
    bucket.positive += clamp01(sample.label);
  }

  const totalCount = Math.max(1, buckets.reduce((sum, bucket) => sum + bucket.total, 0));
  let ece = 0;

  for (const bucket of buckets) {
    if (!bucket.total) continue;
    const meanProbability = bucket.probability / bucket.total;
    const empiricalRate = bucket.positive / bucket.total;
    ece += (bucket.total / totalCount) * Math.abs(meanProbability - empiricalRate);
  }

  return ece;
}

export function brierScore(samples) {
  if (!samples?.length) return 0;
  const total = samples.reduce((sum, sample) => {
    const probability = clamp01(sample.probability);
    const label = clamp01(sample.label);
    return sum + (probability - label) * (probability - label);
  }, 0);
  return total / samples.length;
}

const SYNTHETIC_TRUTH_MODEL = {
  pAny: {
    weights: {
      intercept: -2.25,
      merchantSignal: 2.85,
      proximitySignal: 1.55,
      competitionSignal: -2.05,
      supportScore: 1.35,
      residentialShare: 0.82,
      horizonLog: 1.02,
      interactionDemandProximity: 1.55,
      interactionDemandSupport: 0.92,
      interactionCompetitionDemand: -1.05,
      lunch: 0.12,
      dinner: 0.4,
      lateDinner: 0.2,
      lateNight: -0.25,
      postMidnight: -0.35,
      weekend: 0.1,
      weekendDinner: 0.18,
    },
  },
  quality: {
    weights: {
      intercept: -1.05,
      incomeSignal: 2.6,
      proximitySignal: 0.98,
      competitionSignal: -0.4,
      supportScore: 0.52,
      residentialShare: -0.18,
      lateNight: -0.62,
      dinner: 0.16,
      weekend: 0.05,
      interactionIncomeProximity: 1.25,
    },
  },
};

const SYNTHETIC_LEGACY_MODEL = {
  pAny: {
    weights: {
      intercept: -1.75,
      merchantSignal: 2.1,
      proximitySignal: 0.9,
      competitionSignal: -1.15,
      residentialShare: 0.15,
      horizonLog: 0.55,
    },
  },
  quality: {
    weights: {
      intercept: -0.65,
      incomeSignal: 1.6,
      proximitySignal: 0.6,
      lateNight: -0.25,
    },
  },
};

function createSeededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleTimeBucket(random) {
  const buckets = ["morning", "lunch", "afternoon", "dinner", "late_dinner", "late_night", "post_midnight"];
  return buckets[Math.floor(random() * buckets.length)] ?? "afternoon";
}

export function generateSyntheticPredictionDataset(sampleCount = 320, seed = 7) {
  const random = createSeededRandom(seed);
  const rows = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const timeBucketName = sampleTimeBucket(random);
    const isWeekend = random() < 0.32;
    const sigM = clamp01(Math.pow(random(), 0.72));
    const sigR = clamp01(Math.pow(random(), 0.85));
    const sigI = clamp01(0.12 + 0.74 * random() + (timeBucketName === "dinner" ? 0.08 : 0));
    const baseResidential = timeBucketName === "dinner"
      ? 0.34
      : (timeBucketName === "late_night" || timeBucketName === "post_midnight" ? 0.42 : 0.2);
    const residentialShare = clamp01(baseResidential + (random() - 0.5) * 0.28);
    const competitionCore = 0.15 + 0.65 * sigM * random() + 0.15 * residentialShare;
    const sigD = clamp01(competitionCore + (random() - 0.5) * 0.18);
    const supportScore = clamp01(0.1 + 0.58 * sigM + 0.18 * sigR + 0.15 * (1 - sigD) + (random() - 0.5) * 0.16);
    const horizonMin = 3 + Math.floor(random() * 24);
    const baseContext = {
      sigI,
      sigM,
      sigR,
      sigD,
      supportScore,
      residentialShare,
      horizonMin,
      timeBucketName,
      isWeekend,
    };

    const featureMaps = buildLearnedFeatureMaps(baseContext);
    const truthPAny = sigmoid(dot(SYNTHETIC_TRUTH_MODEL.pAny.weights, featureMaps.pAny));
    const truthQuality = sigmoid(dot(SYNTHETIC_TRUTH_MODEL.quality.weights, featureMaps.quality));
    const legacyPAny = sigmoid(dot(SYNTHETIC_LEGACY_MODEL.pAny.weights, featureMaps.pAny));
    const legacyQuality = sigmoid(dot(SYNTHETIC_LEGACY_MODEL.quality.weights, featureMaps.quality));
    const learned = predictLearnedOrderModel({
      ...baseContext,
      baselinePAny: legacyPAny,
      baselineQuality: legacyQuality,
    });

    const truthPGood = clamp01(truthPAny * (0.25 + 0.75 * truthQuality));
    rows.push({
      context: baseContext,
      label: random() < truthPGood ? 1 : 0,
      truth: {
        pAny: truthPAny,
        quality: truthQuality,
        pGood: truthPGood,
      },
      legacy: {
        pAny: legacyPAny,
        quality: legacyQuality,
        pGood: clamp01(legacyPAny * (0.25 + 0.75 * legacyQuality)),
      },
      learned: {
        ...learned,
        pGood: clamp01(learned.pAny * (0.25 + 0.75 * learned.quality)),
      },
    });
  }

  return rows;
}