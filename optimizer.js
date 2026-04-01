// MIP-style selection using a pure-JS MILP solver (javascript-lp-solver loaded via CDN).
// This is a small demonstration of the “predict → optimize” pattern described in public dispatch blogs.
//
// Model:
//  maximize sum_i u_i x_i
//  s.t. sum_i x_i <= k
//       x_i + x_j <= 1 for pairs within minSepMeters
//       x_i ∈ {0,1}//
// ──────────────────────────────────────────────────────────────────
// GOVERNANCE: This optimizer is a pre-existing runtime component.
// The combinatorial structures in GOVERNANCE.md §4 (generating
// functions, inclusion-exclusion, Möbius inversion, Stirling/Bell
// numbers) are classified as analytical/bounding (ABS) or potential
// future executable candidates (FEC) and are NOT implemented here.
// No new optimization logic may be added without satisfying §8.
// See docs/GOVERNANCE.md and docs/CLASSIFICATION_REGISTRY.md.
// ──────────────────────────────────────────────────────────────────
import { haversineMeters } from "./model.js";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function parkingSelectionUtility(candidate) {
  const mean = clamp01(candidate?.pGood ?? 0);
  const lower = clamp01(candidate?.stabilityLow ?? mean);
  return clamp01(0.65 * mean + 0.35 * lower);
}

export function evaluateParkingCoverage(parkingSet, demandNodes, { coverageTauMeters = 700 } = {}) {
  const tau = Math.max(100, Number(coverageTauMeters ?? 700));
  if (!parkingSet?.length || !demandNodes?.length) return 0;

  let total = 0;

  for (const node of demandNodes) {
    let bestCoverage = 0;

    for (const candidate of parkingSet) {
      const utility = parkingSelectionUtility(candidate);
      if (utility <= 0) continue;

      const distanceMeters = haversineMeters(candidate.lat, candidate.lon, node.lat, node.lon);
      const coverage = Math.max(0, Number(node.weight) || 0) * utility * Math.exp(-distanceMeters / tau);
      if (coverage > bestCoverage) bestCoverage = coverage;
    }

    total += bestCoverage;
  }

  return total;
}

export function selectParkingSetSubmodular(
  parkingWithScores,
  {
    k = 5,
    demandNodes = [],
    coverageTauMeters = 700,
    maxCandidates,
  } = {}
) {
  const targetCount = Math.max(1, Number(k) || 1);
  const candidateLimit = Number.isFinite(Number(maxCandidates))
    ? Math.max(targetCount, Number(maxCandidates))
    : parkingWithScores.length;
  const candidates = [...parkingWithScores]
    .sort((a, b) => {
      const utilityGap = parkingSelectionUtility(b) - parkingSelectionUtility(a);
      if (Math.abs(utilityGap) > 1e-12) return utilityGap;
      return (b.pGood ?? 0) - (a.pGood ?? 0);
    })
    .slice(0, candidateLimit);

  if (candidates.length <= targetCount) return candidates;
  if (!demandNodes?.length) return candidates.slice(0, targetCount);

  // Weighted facility location is monotone submodular under a pure cardinality
  // constraint, so greedy selection attains the classic (1 - 1/e) approximation
  // guarantee on the supplied candidate pool.
  const tau = Math.max(100, Number(coverageTauMeters ?? 700));
  const currentCoverage = new Array(demandNodes.length).fill(0);
  const selected = [];
  const selectedIndices = new Set();

  while (selected.length < targetCount && selectedIndices.size < candidates.length) {
    let bestIndex = -1;
    let bestGain = -1;
    let bestCoverageByNode = null;

    for (let index = 0; index < candidates.length; index += 1) {
      if (selectedIndices.has(index)) continue;

      const candidate = candidates[index];
      const utility = parkingSelectionUtility(candidate);
      if (utility <= 0) continue;

      let marginalGain = 0;
      const nextCoverage = currentCoverage.slice();

      for (let nodeIndex = 0; nodeIndex < demandNodes.length; nodeIndex += 1) {
        const node = demandNodes[nodeIndex];
        const weight = Math.max(0, Number(node.weight) || 0);
        if (weight <= 0) continue;

        const distanceMeters = haversineMeters(candidate.lat, candidate.lon, node.lat, node.lon);
        const coverage = weight * utility * Math.exp(-distanceMeters / tau);
        if (coverage <= nextCoverage[nodeIndex]) continue;

        marginalGain += coverage - nextCoverage[nodeIndex];
        nextCoverage[nodeIndex] = coverage;
      }

      if (
        marginalGain > bestGain + 1e-12
        || (Math.abs(marginalGain - bestGain) <= 1e-12 && (candidate.pGood ?? 0) > (candidates[bestIndex]?.pGood ?? 0))
      ) {
        bestIndex = index;
        bestGain = marginalGain;
        bestCoverageByNode = nextCoverage;
      }
    }

    if (bestIndex === -1) break;

    selectedIndices.add(bestIndex);
    selected.push({
      ...candidates[bestIndex],
      selectionUtility: parkingSelectionUtility(candidates[bestIndex]),
      selectionMarginalGain: Math.max(0, bestGain),
    });

    for (let nodeIndex = 0; nodeIndex < currentCoverage.length; nodeIndex += 1) {
      currentCoverage[nodeIndex] = bestCoverageByNode[nodeIndex];
    }
  }

  if (selected.length >= targetCount) return selected;

  for (const candidate of candidates) {
    if (selected.length >= targetCount) break;
    if (selected.some((picked) => picked.id === candidate.id)) continue;
    selected.push(candidate);
  }

  return selected;
}

export function isMipAvailable() {
  // `solver` is a global from javascript-lp-solver.
  // eslint-disable-next-line no-undef
  return typeof solver !== "undefined" && typeof solver?.Solve === "function";
}

function getSolverOrNull() {
  if (!isMipAvailable()) return null;
  // eslint-disable-next-line no-undef
  return solver;
}

export function optimizeParkingSet(parkingWithScores, { k = 5, minSepMeters = 600, maxCandidates = 40 }) {
  const candidates = [...parkingWithScores]
    .sort((a, b) => (b.pGood ?? 0) - (a.pGood ?? 0))
    .slice(0, Math.max(1, maxCandidates));

  if (candidates.length <= k) return candidates;

  const s = getSolverOrNull();
  if (!s) {
    // CDN blocked/offline: fall back to greedy selection.
    return greedyParkingSet(candidates, { k, minSepMeters });
  }

  const model = {
    optimize: "u",
    opType: "max",
    constraints: {
      pickLimit: { max: k },
    },
    variables: {},
    ints: {},
  };

  for (let i = 0; i < candidates.length; i++) {
    const vName = `x_${i}`;
    model.variables[vName] = {
      u: Math.max(0, Number(candidates[i].pGood ?? 0)),
      pickLimit: 1,
    };
    model.ints[vName] = 1;
  }

  // Pairwise separation constraints.
  let cIdx = 0;
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const d = haversineMeters(
        candidates[i].lat,
        candidates[i].lon,
        candidates[j].lat,
        candidates[j].lon
      );
      if (d < minSepMeters) {
        const cname = `sep_${cIdx++}`;
        model.constraints[cname] = { max: 1 };
        model.variables[`x_${i}`][cname] = 1;
        model.variables[`x_${j}`][cname] = 1;
      }
    }
  }

  const result = s.Solve(model);
  if (!result.feasible) {
    // If infeasible (e.g., too many separation constraints), fall back to greedy.
    return greedyParkingSet(candidates, { k, minSepMeters });
  }

  const chosen = [];
  for (let i = 0; i < candidates.length; i++) {
    const vName = `x_${i}`;
    if ((result[vName] ?? 0) > 0.5) chosen.push(candidates[i]);
  }

  // Solver can sometimes return fewer than k if separation is tight.
  if (chosen.length === 0) return greedyParkingSet(candidates, { k, minSepMeters });
  chosen.sort((a, b) => (b.pGood ?? 0) - (a.pGood ?? 0));
  return chosen;
}

function greedyParkingSet(candidates, { k, minSepMeters }) {
  const picked = [];

  for (const c of candidates) {
    if (picked.length >= k) break;
    const ok = picked.every((p) =>
      haversineMeters(p.lat, p.lon, c.lat, c.lon) >= minSepMeters
    );
    if (ok) picked.push(c);
  }

  return picked;
}
