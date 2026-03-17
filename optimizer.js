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
