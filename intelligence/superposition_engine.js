const DEFAULT_SEARCH_DEPTH = 3;
const DEFAULT_HORIZON_MINUTES = 10;
const DEFAULT_ARRIVAL_RATE_PER_MINUTE = 0.18;
const DEFAULT_WEIGHTS = Object.freeze({
  basePay: 0.38,
  timePenalty: 0.22,
  distancePenalty: 0.16,
  zoneOpportunity: 0.24,
  futureEV: 0.28,
  futureDiscount: 0.62,
});

const PRUNING_RULES = Object.freeze([
  "dominance: remove candidates no better on pay/opportunity and no worse on time/distance",
  "beam: rank deterministic successors by EV score and keep searchDepth candidates",
]);

const ALGORITHM_USED = "deterministic-poisson-dominance-pruned-ev-v1";

// This module implements a deterministic approximation of combinatorial assignment families (resembles NP-hard route/assignment problems). It exposes approximation metadata for transparency; it does not claim optimality.

function clamp(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return minimum;
  }
  return Math.min(Math.max(number, minimum), maximum);
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function round4(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function getFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeWeights(weights = {}) {
  return {
    ...DEFAULT_WEIGHTS,
    ...(weights && typeof weights === "object" ? weights : {}),
  };
}

function getCandidateId(candidate, index) {
  const id = candidate?.orderId ?? candidate?.id ?? candidate?.key ?? `candidate-${index + 1}`;
  return String(id);
}

function getCandidateDurationMinutes(candidate) {
  const explicit = getFiniteNumber(candidate?.durationMinutes, Number.NaN);
  if (Number.isFinite(explicit)) {
    return Math.max(0, explicit);
  }

  return Math.max(0,
    getFiniteNumber(candidate?.pickupMinutes, 0)
    + getFiniteNumber(candidate?.driveMinutes, 0)
    + getFiniteNumber(candidate?.dropoffMinutes, 0)
  );
}

function getCandidateDistanceKm(candidate) {
  const distanceKm = getFiniteNumber(candidate?.distanceKm, Number.NaN);
  if (Number.isFinite(distanceKm)) {
    return Math.max(0, distanceKm);
  }

  return Math.max(0, getFiniteNumber(candidate?.distanceMeters, 0) / 1000);
}

function normalizeCandidate(candidate, index) {
  return {
    orderId: getCandidateId(candidate, index),
    basePay: Math.max(0, getFiniteNumber(candidate?.basePay ?? candidate?.pay ?? candidate?.estimatedPay, 0)),
    durationMinutes: getCandidateDurationMinutes(candidate),
    distanceKm: getCandidateDistanceKm(candidate),
    zoneOpportunity: clamp01(candidate?.zoneOpportunity ?? candidate?.opportunity ?? 0),
    arrivalRatePerMinute: Math.max(0, getFiniteNumber(candidate?.arrivalRatePerMinute, DEFAULT_ARRIVAL_RATE_PER_MINUTE)),
  };
}

function scoreCandidateParts(candidate) {
  return {
    orderId: candidate.orderId,
    basePayScore: round4(clamp01(candidate.basePay / 24)),
    timePenalty: round4(clamp01(candidate.durationMinutes / 50)),
    distancePenalty: round4(clamp01(candidate.distanceKm / 18)),
    zoneOpportunity: round4(candidate.zoneOpportunity),
  };
}

function getDeterministicUtility(parts, weights) {
  return (
    parts.basePayScore * weights.basePay
    + parts.zoneOpportunity * weights.zoneOpportunity
    - parts.timePenalty * weights.timePenalty
    - parts.distancePenalty * weights.distancePenalty
  );
}

function dominates(left, right) {
  const noWorse = left.parts.basePayScore >= right.parts.basePayScore
    && left.parts.zoneOpportunity >= right.parts.zoneOpportunity
    && left.parts.timePenalty <= right.parts.timePenalty
    && left.parts.distancePenalty <= right.parts.distancePenalty;
  const strictlyBetter = left.parts.basePayScore > right.parts.basePayScore
    || left.parts.zoneOpportunity > right.parts.zoneOpportunity
    || left.parts.timePenalty < right.parts.timePenalty
    || left.parts.distancePenalty < right.parts.distancePenalty;
  return noWorse && strictlyBetter;
}

function pruneDominatedNodes(nodes) {
  const dominated = new Set();
  for (let rightIndex = 0; rightIndex < nodes.length; rightIndex += 1) {
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      if (leftIndex === rightIndex) {
        continue;
      }
      if (dominates(nodes[leftIndex], nodes[rightIndex])) {
        dominated.add(nodes[rightIndex].orderId);
        break;
      }
    }
  }

  return {
    remaining: nodes.filter((node) => !dominated.has(node.orderId)),
    prunedCount: dominated.size,
  };
}

function rankNodes(nodes) {
  return [...nodes].sort((left, right) => {
    const utilityDelta = right.utility - left.utility;
    if (Math.abs(utilityDelta) > 0.000001) {
      return utilityDelta;
    }
    return left.orderId.localeCompare(right.orderId);
  });
}

function getPoissonExpectedArrivals(arrivalRatePerMinute, horizonMinutes) {
  return Math.max(0, arrivalRatePerMinute * horizonMinutes);
}

function getFutureEV(node, allNodes, { searchDepth, horizonMinutes, weights }) {
  const successors = allNodes.filter((candidateNode) => candidateNode.orderId !== node.orderId);
  const { remaining, prunedCount } = pruneDominatedNodes(successors);
  const sequence = rankNodes(remaining).slice(0, searchDepth);
  const expectedArrivals = getPoissonExpectedArrivals(node.arrivalRatePerMinute, horizonMinutes);
  const arrivalCoverage = clamp01(expectedArrivals / Math.max(1, searchDepth));
  const sequenceValue = sequence.reduce((sum, candidateNode, index) => {
    return sum + Math.max(0, candidateNode.utility) * (weights.futureDiscount ** (index + 1));
  }, 0);

  return {
    futureEV: round4(clamp01(sequenceValue * arrivalCoverage)),
    sequenceCandidateCount: sequence.length,
    prunedCount,
    expectedArrivals: round4(expectedArrivals),
  };
}

function getHeuristicConfidenceScore({ candidateCount, searchDepth, prunedCount, expectedArrivals }) {
  // Calibrated heuristic for transparency only; this is not statistical certainty.
  const supportScore = clamp01(Math.log2(candidateCount + 1) / 4);
  const depthScore = clamp01(searchDepth / 5);
  const arrivalScore = clamp01(expectedArrivals / Math.max(1, searchDepth));
  const pruningPenalty = clamp01(prunedCount / Math.max(1, candidateCount)) * 0.18;
  return round4(clamp01(0.34 + supportScore * 0.3 + depthScore * 0.24 + arrivalScore * 0.22 - pruningPenalty));
}

function softmaxProbabilities(nodes) {
  const exponentials = nodes.map((node) => Math.exp(node.adjustedUtility * 3));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => total > 0 ? value / total : 0);
}

function evaluateSuperpositionEngine({
  candidates = [],
  searchDepth = DEFAULT_SEARCH_DEPTH,
  horizonMinutes = DEFAULT_HORIZON_MINUTES,
  weights = {},
} = {}) {
  const normalizedWeights = normalizeWeights(weights);
  const normalizedSearchDepth = Math.max(1, Math.floor(getFiniteNumber(searchDepth, DEFAULT_SEARCH_DEPTH)));
  const normalizedHorizonMinutes = Math.max(1, getFiniteNumber(horizonMinutes, DEFAULT_HORIZON_MINUTES));
  const candidateNodes = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeCandidate)
    .map((candidate) => {
      const parts = scoreCandidateParts(candidate);
      return {
        ...candidate,
        parts,
        utility: getDeterministicUtility(parts, normalizedWeights),
      };
    });

  const scoredNodes = candidateNodes.map((node) => {
    const future = getFutureEV(node, candidateNodes, {
      searchDepth: normalizedSearchDepth,
      horizonMinutes: normalizedHorizonMinutes,
      weights: normalizedWeights,
    });
    return {
      ...node,
      future,
      adjustedUtility: node.utility + future.futureEV * normalizedWeights.futureEV,
    };
  });
  const probabilities = softmaxProbabilities(scoredNodes);

  return scoredNodes.map((node, index) => ({
    orderId: node.orderId,
    basePayScore: node.parts.basePayScore,
    timePenalty: node.parts.timePenalty,
    distancePenalty: node.parts.distancePenalty,
    zoneOpportunity: node.parts.zoneOpportunity,
    futureEV: node.future.futureEV,
    assignmentProbabilityEstimate: round4(clamp01(probabilities[index])),
    metadata: {
      searchDepth: normalizedSearchDepth,
      candidateCount: candidateNodes.length,
      pruningRules: [...PRUNING_RULES],
      algorithmUsed: ALGORITHM_USED,
      heuristicConfidenceScore: getHeuristicConfidenceScore({
        candidateCount: candidateNodes.length,
        searchDepth: normalizedSearchDepth,
        prunedCount: node.future.prunedCount,
        expectedArrivals: node.future.expectedArrivals,
      }),
      prunedCandidateCount: node.future.prunedCount,
      sequenceCandidateCount: node.future.sequenceCandidateCount,
      poissonExpectedArrivals: node.future.expectedArrivals,
    },
  }));
}

function evaluateSuperpositionCandidate({ order, candidates = [], ...options } = {}) {
  const candidateList = [order, ...(Array.isArray(candidates) ? candidates : [])].filter(Boolean);
  return evaluateSuperpositionEngine({ ...options, candidates: candidateList })[0] || null;
}

export {
  ALGORITHM_USED,
  DEFAULT_SEARCH_DEPTH,
  DEFAULT_WEIGHTS,
  evaluateSuperpositionCandidate,
  evaluateSuperpositionEngine,
};