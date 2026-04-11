// ──────────────────────────────────────────────────────────────────
// GOVERNANCE: This module implements the scalar cost field C(x,t)
// (GOVERNANCE.md §1) and signal decomposition {I, M, R, D}
// (GOVERNANCE.md §2). All outputs are descriptive only (§1 I-4,
// §6 A-1..A-4). Temporal weighting follows §3. Thresholds in
// scoring helpers are interpretive bands only (§5 TH-1..TH-4).
// No element of this module constitutes decision authority.
// See docs/GOVERNANCE.md and docs/CLASSIFICATION_REGISTRY.md.
// ──────────────────────────────────────────────────────────────────

import {
  predictLearnedOrderModel,
  resolvePredictionModelName,
} from "./learned_predictor.js";
import { assignOrders as experimentalDispatch } from "./dispatch_assignment.js";

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine distance in meters.
export function haversineMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export const PROBABILITY_HORIZON_MINUTES = 10;

const OSM_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function jsDayToOsmDayIndex(jsDay) {
  return (jsDay + 6) % 7;
}

function parseTimeToMinutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function expandDayToken(token) {
  const trimmed = token.trim();
  if (!trimmed) return [];

  if (!trimmed.includes("-")) {
    const idx = OSM_WEEKDAYS.indexOf(trimmed);
    return idx === -1 ? null : [idx];
  }

  const [startDay, endDay] = trimmed.split("-").map((part) => part.trim());
  const startIdx = OSM_WEEKDAYS.indexOf(startDay);
  const endIdx = OSM_WEEKDAYS.indexOf(endDay);
  if (startIdx === -1 || endIdx === -1) return null;

  const expanded = [startIdx];
  let cursor = startIdx;
  while (cursor !== endIdx) {
    cursor = (cursor + 1) % OSM_WEEKDAYS.length;
    expanded.push(cursor);
  }

  return expanded;
}

function parseRuleDays(dayPart) {
  if (!dayPart) return [...OSM_WEEKDAYS.keys()];

  const days = [];
  for (const token of dayPart.split(",")) {
    const expanded = expandDayToken(token);
    if (expanded === null) return null;
    days.push(...expanded);
  }

  return [...new Set(days)];
}

function parseOpeningHoursRule(rule) {
  const trimmed = rule.trim();
  if (!trimmed) return null;

  const firstDigitIdx = trimmed.search(/\d/);
  const hasDigits = firstDigitIdx !== -1;
  const dayPart = hasDigits ? trimmed.slice(0, firstDigitIdx).trim() : trimmed;
  const timePart = hasDigits ? trimmed.slice(firstDigitIdx).trim() : "";

  if (/\b(off|closed)\b/i.test(trimmed) && !timePart) {
    const days = parseRuleDays(dayPart);
    return days ? { days, closed: true, ranges: [] } : null;
  }

  const days = parseRuleDays(dayPart);
  if (days === null || !timePart) return null;

  const ranges = [];
  for (const token of timePart.split(",")) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-3]):([0-5]\d)$/.exec(token.trim());
    if (!match) return null;
    const start = parseTimeToMinutes(`${match[1]}:${match[2]}`);
    const end = parseTimeToMinutes(`${match[3]}:${match[4]}`);
    if (start === null || end === null) return null;
    ranges.push({ start, end });
  }

  if (!ranges.length) return null;
  return { days, closed: false, ranges };
}

function ruleCouldApplyNow(rule, currentDay, previousDay) {
  if (rule.days.includes(currentDay)) return true;
  if (!rule.closed && rule.ranges.some((range) => range.start > range.end) && rule.days.includes(previousDay)) {
    return true;
  }
  return false;
}

function rangeMatchesNow(range, currentDay, previousDay, currentMinutes, ruleDays) {
  if (range.start === range.end) return ruleDays.includes(currentDay);
  if (range.start < range.end) {
    return ruleDays.includes(currentDay) && currentMinutes >= range.start && currentMinutes < range.end;
  }

  return (
    (ruleDays.includes(currentDay) && currentMinutes >= range.start) ||
    (ruleDays.includes(previousDay) && currentMinutes < range.end)
  );
}

export function isOpenNow(restaurant, currentTime = new Date()) {
  const openingHours = restaurant?.tags?.opening_hours;
  if (typeof openingHours !== "string" || !openingHours.trim()) return true;

  const normalized = openingHours.trim();
  if (normalized === "24/7") return true;

  const currentDay = jsDayToOsmDayIndex(currentTime.getDay());
  const previousDay = (currentDay + OSM_WEEKDAYS.length - 1) % OSM_WEEKDAYS.length;
  const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

  let sawRelevantRule = false;

  for (const rawRule of normalized.split(";")) {
    const rule = parseOpeningHoursRule(rawRule);
    if (!rule || !ruleCouldApplyNow(rule, currentDay, previousDay)) continue;

    sawRelevantRule = true;
    if (rule.closed) continue;

    if (rule.ranges.some((range) => rangeMatchesNow(range, currentDay, previousDay, currentMinutes, rule.days))) {
      return true;
    }
  }

  return sawRelevantRule ? false : true;
}

export function filterOpenRestaurants(restaurants, currentTime = new Date()) {
  return restaurants.filter((restaurant) => isOpenNow(restaurant, currentTime));
}

function foodWeight(tags, hour) {
  // Late night proxy: fast food tends to remain open later.
  const amenity = (tags.amenity || "").toLowerCase();

  const isLate = hour >= 22 || hour <= 4;

  let base = 1.0;
  if (amenity === "fast_food") base = 1.3;
  if (amenity === "cafe") base = 0.8;
  if (amenity === "food_court") base = 1.15;

  if (isLate) {
    if (amenity === "fast_food") base *= 1.25;
    if (amenity === "restaurant") base *= 0.85;
    if (amenity === "cafe") base *= 0.6;
  }

  return base;
}

function residentialWeight(tags, hour, dayOfWeek) {
  const explicitWeight = Number(tags?.dgm_weight);
  if (Number.isFinite(explicitWeight) && explicitWeight > 0) {
    let base = explicitWeight;
    const weekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (hour >= 17 && hour < 22) base *= weekend ? 1.18 : 1.1;
    else if (hour >= 11 && hour < 14) base *= weekend ? 0.95 : 0.85;
    else if (hour >= 22 || hour < 5) base *= weekend ? 1.05 : 0.92;

    return base;
  }

  const building = (tags?.building ?? "").toLowerCase();
  const landuse = (tags?.landuse ?? "").toLowerCase();
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;

  let base = 0.75;
  if (building === "apartments") base = 1.4;
  else if (building === "dormitory") base = 1.3;
  else if (building === "residential") base = 1.0;
  else if (building === "terrace" || building === "semidetached_house") base = 0.85;
  else if (building === "house" || building === "detached") base = 0.65;
  else if (landuse === "residential") base = 0.9;

  if (hour >= 17 && hour < 22) base *= weekend ? 1.18 : 1.1;
  else if (hour >= 11 && hour < 14) base *= weekend ? 0.95 : 0.85;
  else if (hour >= 22 || hour < 5) base *= weekend ? 1.05 : 0.92;

  return base;
}

function temporalDemandProfile(hour, dayOfWeek) {
  const weekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (hour >= 6 && hour < 11) return { merchant: 0.75, residential: weekend ? 0.85 : 0.8 };
  if (hour >= 11 && hour < 14) return { merchant: weekend ? 1.05 : 1.15, residential: weekend ? 0.8 : 0.72 };
  if (hour >= 14 && hour < 17) return { merchant: 0.82, residential: weekend ? 0.9 : 0.78 };
  if (hour >= 17 && hour < 20) return { merchant: weekend ? 1.22 : 1.15, residential: weekend ? 1.22 : 1.08 };
  if (hour >= 20 && hour < 22) return { merchant: weekend ? 1.08 : 0.98, residential: weekend ? 1.15 : 1.02 };
  if (hour >= 22) return { merchant: 0.82, residential: weekend ? 1.05 : 0.95 };
  return { merchant: 0.72, residential: weekend ? 0.95 : 0.88 };
}

function cuisineList(tags) {
  const c = (tags?.cuisine ?? "").toLowerCase().trim();
  if (!c) return [];
  return c
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ticketIndex(tags) {
  // Public-data proxy for “higher ticket size” (and thus potentially higher tips).
  // This is heuristic and will be wrong sometimes; keep it transparent.
  const amenity = (tags?.amenity ?? "").toLowerCase();
  const name = (tags?.name ?? "").toLowerCase();
  const cuisines = cuisineList(tags);

  // Base assumptions by amenity type.
  let idx = 0.9;
  if (amenity === "restaurant") idx = 1.0;
  if (amenity === "food_court") idx = 0.95;
  if (amenity === "cafe") idx = 0.85;
  if (amenity === "fast_food") idx = 0.75;

  // Cuisine heuristics (rough correlation with higher ticket size).
  const high = [
    "sushi",
    "steak_house",
    "steak",
    "seafood",
    "korean",
    "thai",
    "indian",
    "japanese",
    "mediterranean",
    "persian",
    "vietnamese",
    "ramen",
  ];
  const mid = ["mexican", "pizza", "burger", "bbq", "chicken", "chinese", "italian"];
  const low = ["coffee_shop", "ice_cream", "donut", "sandwich", "bagel", "dessert"];

  const has = (arr, key) => arr.includes(key) || name.includes(key.replaceAll("_", " "));

  if (cuisines.some((c) => high.includes(c)) || high.some((k) => has(cuisines, k))) idx += 0.18;
  else if (cuisines.some((c) => mid.includes(c)) || mid.some((k) => has(cuisines, k))) idx += 0.06;
  else if (cuisines.some((c) => low.includes(c)) || low.some((k) => has(cuisines, k))) idx -= 0.08;

  return Math.max(0.5, Math.min(1.3, idx));
}

export function scorePointAgainstRestaurants({ lat, lon }, restaurants, tauMeters, hour) {
  return merchantIntensityAtPoint({ lat, lon }, restaurants, tauMeters, hour).total;
}

function amenityKey(tags) {
  const a = (tags?.amenity ?? "").toLowerCase();
  if (a === "restaurant") return "restaurant";
  if (a === "fast_food") return "fast_food";
  if (a === "cafe") return "cafe";
  if (a === "food_court") return "food_court";
  return "other";
}

function merchantIntensityAtPoint({ lat, lon }, restaurants, tauMeters, hour) {
  // Intensity proxy: sum of distance-decayed merchant contributions.
  // This is a *public-data heuristic*, not DoorDash’s model.
  const tau = Math.max(1, tauMeters);

  let total = 0;
  let distWeighted = 0;
  let ticketWeighted = 0;
  let sumSquares = 0;
  let nearbyCount = 0;
  let nearestDist = 1e9;
  const by = {
    restaurant: 0,
    fast_food: 0,
    cafe: 0,
    food_court: 0,
    other: 0,
  };

  for (const r of restaurants) {
    const w = foodWeight(r.tags ?? {}, hour);
    const d = haversineMeters(lat, lon, r.lat, r.lon);
    const k = Math.exp(-d / tau);
    const t = ticketIndex(r.tags ?? {});
    const c = w * k;
    total += c;
    distWeighted += c * d;
    ticketWeighted += c * t;
    sumSquares += c * c;
    nearestDist = Math.min(nearestDist, d);
    if (d <= tau * 1.25) nearbyCount += 1;

    by[amenityKey(r.tags)] += c;
  }

  const expectedDist = total > 0 ? distWeighted / total : 1e9;
  const ticketMean = total > 0 ? ticketWeighted / total : 0;
  const effectiveMerchants = total > 0 && sumSquares > 0 ? (total * total) / sumSquares : 0;
  return { total, by, expectedDist, ticketMean, effectiveMerchants, nearbyCount, nearestDist };
}

function parkingIntensityAtPoint({ lat, lon }, parkingCandidates, tauMeters) {
  const tau = Math.max(1, tauMeters);
  let sum = 0;
  for (const p of parkingCandidates) {
    const d = haversineMeters(lat, lon, p.lat, p.lon);
    sum += Math.exp(-d / tau);
  }
  return sum;
}

function residentialIntensityAtPoint({ lat, lon }, residentialAnchors, tauMeters, hour, dayOfWeek) {
  const tau = Math.max(1, tauMeters);
  let sum = 0;

  for (const anchor of residentialAnchors ?? []) {
    const d = haversineMeters(lat, lon, anchor.lat, anchor.lon);
    const weight = residentialWeight(anchor.tags ?? {}, hour, dayOfWeek);
    sum += weight * Math.exp(-d / tau);
  }

  return sum;
}

export function buildDemandCoverageNodes(
  restaurants,
  {
    hour,
    dayOfWeek,
    residentialAnchors = [],
    residentialDemandWeight = 0.35,
  } = {}
) {
  // Coverage nodes parameterize the fallback facility-location objective.
  const resolvedHour = Number.isFinite(Number(hour)) ? Number(hour) : new Date().getHours();
  const resolvedDayOfWeek = Number.isFinite(Number(dayOfWeek)) ? Number(dayOfWeek) : new Date().getDay();
  const demandProfile = temporalDemandProfile(resolvedHour, resolvedDayOfWeek);
  const merchantScale = Math.max(0, demandProfile.merchant);
  const residentialScale = Math.max(0, Number(residentialDemandWeight ?? 0.35)) * Math.max(0, demandProfile.residential);

  const nodes = (restaurants ?? [])
    .map((restaurant) => ({
      id: restaurant.id,
      lat: restaurant.lat,
      lon: restaurant.lon,
      weight: merchantScale * foodWeight(restaurant.tags ?? {}, resolvedHour),
      sourceType: "merchant",
    }))
    .filter((node) => node.weight > 0);

  if (residentialScale <= 0) return nodes;

  for (const anchor of residentialAnchors ?? []) {
    const weight = residentialScale * residentialWeight(anchor.tags ?? {}, resolvedHour, resolvedDayOfWeek);
    if (weight <= 0) continue;

    nodes.push({
      id: anchor.id,
      lat: anchor.lat,
      lon: anchor.lon,
      weight,
      sourceType: "residential",
    });
  }

  return nodes;
}

// GOVERNANCE §3: Time partition {T_k} — disjoint buckets with
// non-negative weights. Retrospective only (T-1); no extrapolation
// (T-2); boundaries explicit (T-3). See CLASSIFICATION_REGISTRY 3.1–3.5.
export function timeBucket(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 6  && h < 11) return { name: 'morning',       label: 'Morning',       wI: 0.20, wM: 0.40, wR: 0.30, wD: 0.10 };
  if (h >= 11 && h < 14) return { name: 'lunch',          label: 'Lunch rush',     wI: 0.25, wM: 0.35, wR: 0.25, wD: 0.15 };
  if (h >= 14 && h < 17) return { name: 'afternoon',      label: 'Afternoon',      wI: 0.25, wM: 0.30, wR: 0.25, wD: 0.20 };
  if (h >= 17 && h < 20) return { name: 'dinner',         label: 'Dinner rush',    wI: 0.30, wM: 0.30, wR: 0.20, wD: 0.20 };
  if (h >= 20 && h < 22) return { name: 'late_dinner',    label: 'Late dinner',    wI: 0.30, wM: 0.25, wR: 0.25, wD: 0.20 };
  if (h >= 22)           return { name: 'late_night',     label: 'Late night',     wI: 0.20, wM: 0.20, wR: 0.40, wD: 0.20 };
  return                        { name: 'post_midnight',  label: 'Post-midnight',  wI: 0.15, wM: 0.15, wR: 0.50, wD: 0.20 };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

function softplus(x) {
  // Stable softplus.
  if (x > 30) return x;
  if (x < -30) return Math.exp(x);
  return Math.log1p(Math.exp(x));
}

function betaStabilityBand(p, effectiveSupport) {
  const n = Math.max(2, Number(effectiveSupport ?? 0) * 2.5);
  const alpha = 1 + clamp01(p) * n;
  const beta = 1 + (1 - clamp01(p)) * n;
  const total = alpha + beta;
  const mean = alpha / total;
  const variance = (alpha * beta) / ((total * total) * (total + 1));
  const stdDev = Math.sqrt(Math.max(0, variance));
  const z = 1.28;
  return {
    low: clamp01(mean - z * stdDev),
    high: clamp01(mean + z * stdDev),
  };
}

function arrivalProbabilityFromLambda(
  lambdaEff,
  {
    ref,
    horizonMin,
    rainArrivalMultiplier,
    useSoftplus,
    mlBeta,
  }
) {
  const safeRef = Math.max(1e-9, Number(ref ?? 0) || 1e-9);
  const T = Math.max(1, Number(horizonMin ?? PROBABILITY_HORIZON_MINUTES) || PROBABILITY_HORIZON_MINUTES);
  const baseRateAtRef = Math.log(2) / PROBABILITY_HORIZON_MINUTES;

  if (useSoftplus) {
    const beta = Math.max(0, Number(mlBeta ?? 2.0));
    const bias = Math.log(Math.exp(baseRateAtRef) - 1);
    const logRatio = Math.log(Math.max(1e-9, lambdaEff) / safeRef);
    const rate = Math.max(0, Number(rainArrivalMultiplier ?? 1)) * softplus(bias + beta * logRatio);
    return clamp01(1 - Math.exp(-rate * T));
  }

  return clamp01(1 - Math.exp(-Math.max(0, Number(rainArrivalMultiplier ?? 1)) * baseRateAtRef * (lambdaEff / safeRef) * T));
}

function formatExplainShare(label, share) {
  return `${Math.round(clamp01(share) * 100)}% of this 10-minute probability comes from ${label}.`;
}

function formatExplainRelativeIntensity(relativeIntensity) {
  const pct = Math.round(Math.max(0, Number(relativeIntensity ?? 0)) * 100);
  if (pct >= 125) {
    return `This spot is running well above the map's reference intensity at about ${pct}% of baseline.`;
  }
  if (pct >= 95) {
    return `This spot is running near the map's reference intensity at about ${pct}% of baseline.`;
  }
  return `This spot is running below the map's reference intensity at about ${pct}% of baseline.`;
}

function formatExplainRainLiftPercent(rainLiftPercent) {
  const pct = Math.max(0, Math.round(Number(rainLiftPercent ?? 0)));
  return pct > 0
    ? `Rain is adding about ${pct}% lift to modeled demand right now.`
    : "Rain lift is off right now.";
}

function resolveExperimentalDispatchInputs(params) {
  return {
    drivers: Array.isArray(params?.drivers) ? params.drivers : [],
    orders: Array.isArray(params?.orders) ? params.orders : [],
  };
}

function buildExperimentalDispatchCostMatrix(drivers, orders, params) {
  const singleOrderParams = {
    ...params,
    batchingEnabled: false,
    maxBatchSize: 1,
  };

  return drivers.map((driver) => ({
    driverId: driver?.id ?? null,
    entries: orders.map((order) => {
      const pairResult = experimentalDispatch([driver], [order], singleOrderParams);
      const assignment = Array.isArray(pairResult.assignments) ? pairResult.assignments[0] ?? null : null;

      return {
        orderId: order?.id ?? null,
        totalCost: assignment ? assignment.totalCost : null,
        matched: Boolean(assignment),
      };
    }),
  }));
}

function buildExperimentalDispatchResult(params) {
  if (params?.experimentalDispatch !== true) {
    return null;
  }

  const { drivers, orders } = resolveExperimentalDispatchInputs(params);
  const dispatchDiagnostics = experimentalDispatch(drivers, orders, params);

  return {
    assignments: dispatchDiagnostics.assignments,
    diagnostics: dispatchDiagnostics.diagnostics,
    costMatrix: buildExperimentalDispatchCostMatrix(drivers, orders, params),
    batched: dispatchDiagnostics.diagnostics.batchedCount > 0,
    matchedCount: dispatchDiagnostics.diagnostics.matchedCount,
  };
}

export function probabilityOfGoodOrder(
  { lat, lon },
  restaurants,
  parkingCandidates,
  {
    tauMeters,
    hour,
    dayOfWeek,
    horizonMin,
    competitionStrength,
    competitionTauMeters,
    residentialAnchors,
    residentialTauMeters,
    residentialDemandWeight,
    rainBoost,
    lambdaRef,
    tipEmphasis,
    predictionModel,
    useML,
    mlBeta,
  }
) {
  // Contract: pGood is always the probability of a good order within
  // the next 10 minutes at this location under current modeled
  // conditions. Public proxies shape the probability field, but the
  // exposed horizon stays fixed for comparability across the map.
  //
  // Interpretable probability model built from public proxies:
  // - Merchant intensity ~ demand opportunity
  // - Parking intensity ~ (very rough) competition proxy
  // - Calibrate to the current view by mapping a reference intensity -> 50% in T_ref minutes
  const m = merchantIntensityAtPoint({ lat, lon }, restaurants, tauMeters, hour);

  const compTau = Math.max(
    100,
    competitionTauMeters ?? Math.max(250, Math.min(1200, Math.round(tauMeters * 0.8)))
  );
  const pIntensity = parkingCandidates?.length
    ? parkingIntensityAtPoint({ lat, lon }, parkingCandidates, compTau)
    : 0;

  const residentialTau = Math.max(250, Number(residentialTauMeters ?? Math.max(400, tauMeters * 1.6)));
  const residentialIntensity = residentialAnchors?.length
    ? residentialIntensityAtPoint({ lat, lon }, residentialAnchors, residentialTau, hour, dayOfWeek ?? new Date().getDay())
    : 0;

  const resolvedDayOfWeek = dayOfWeek ?? new Date().getDay();
  const demandProfile = temporalDemandProfile(hour, resolvedDayOfWeek);
  const residentialWeighting = Math.max(0, Number(residentialDemandWeight ?? 0.35));
  const resolvedRainBoost = Math.max(0, Math.min(0.25, Number(rainBoost ?? 0)));
  const merchantRainMultiplier = 1 + resolvedRainBoost;
  const residentialRainMultiplier = 1 + resolvedRainBoost * 1.35;

  const comp = Math.max(0, competitionStrength ?? 0);
  const merchantDemand = merchantRainMultiplier * demandProfile.merchant * m.total;
  const residentialDemand = residentialRainMultiplier * residentialWeighting * demandProfile.residential * residentialIntensity;
  const totalDemand = merchantDemand + residentialDemand;
  const rainArrivalMultiplier = 1 + resolvedRainBoost * (1.1 + 0.35 * (totalDemand > 0 ? residentialDemand / totalDemand : 0));
  const lambdaEff = (merchantDemand + residentialDemand) / (1 + comp * pIntensity);

  const ref = Math.max(1e-9, lambdaRef ?? lambdaEff ?? 1e-9);
  const T = PROBABILITY_HORIZON_MINUTES;

  // Calibrate so that when lambdaEff==ref and T==10 min, P(any order) ≈ 50%.
  const Tref = PROBABILITY_HORIZON_MINUTES;
  const baseRateAtRef = Math.log(2) / Tref;

  const closeness = Math.exp(-m.expectedDist / 900);
  const isLate = hour >= 22 || hour <= 4;
  const tipProxy = clamp01((m.ticketMean - 0.75) / 0.45);
  const tipW = clamp01(tipEmphasis ?? 0.55);
  const tipAdj = isLate ? clamp01(tipProxy * 0.85) : tipProxy;
  const legacyQuality = clamp01((1 - tipW) * closeness + tipW * tipAdj);
  const supportScore = clamp01((m.effectiveMerchants - 1) / 7);
  const bucket = timeBucket(hour);
  const sigI = clamp01((m.ticketMean - 0.5) / 0.8);
  const sigM = clamp01(m.total / (2 * ref));
  const sigR = closeness;
  const sigD = comp > 0 ? (comp * pIntensity) / (1 + comp * pIntensity) : 0;
  const selectedPredictionModel = resolvePredictionModelName(predictionModel, useML);
  const usesSoftplusRate = selectedPredictionModel === "softplus";
  const isWeekend = resolvedDayOfWeek === 0 || resolvedDayOfWeek === 6;

  const baselinePAny = arrivalProbabilityFromLambda(lambdaEff, {
    ref,
    horizonMin: T,
    rainArrivalMultiplier,
    useSoftplus: usesSoftplusRate,
    mlBeta,
  });

  let pAny = baselinePAny;
  let quality = legacyQuality;
  let predictionModelFamily = selectedPredictionModel === "softplus"
    ? "softplus-rate-proxy"
    : "legacy-rate-proxy";
  let predictionModelVersion = null;
  let modelConfidence = 1;
  let modelBlend = 1;
  let stabilitySupport = m.effectiveMerchants;

  if (selectedPredictionModel === "glm") {
    const learned = predictLearnedOrderModel({
      sigI,
      sigM,
      sigR,
      sigD,
      supportScore,
      residentialShare: totalDemand > 0 ? residentialDemand / totalDemand : 0,
      horizonMin: T,
      timeBucketName: bucket.name,
      isWeekend,
      baselinePAny,
      baselineQuality: legacyQuality,
    });

    pAny = learned.pAny;
    quality = learned.quality;
    predictionModelFamily = learned.family;
    predictionModelVersion = learned.version;
    modelConfidence = learned.confidence;
    modelBlend = learned.blend;
    stabilitySupport = m.effectiveMerchants * learned.supportScale;
  }

  // Ensure “good” is always <= “any” and never collapses too low.
  const pGood = clamp01(pAny * (0.25 + 0.75 * quality));
  const band = betaStabilityBand(pGood, stabilitySupport);
  const qualityMultiplier = 0.25 + 0.75 * quality;
  const pAnyLow = Math.min(
    arrivalProbabilityFromLambda(lambdaEff * 0.7, {
      ref,
      horizonMin: T,
      rainArrivalMultiplier,
      useSoftplus: usesSoftplusRate,
      mlBeta,
    }),
    pAny,
  );
  const pAnyHigh = Math.max(
    arrivalProbabilityFromLambda(lambdaEff * 1.3, {
      ref,
      horizonMin: T,
      rainArrivalMultiplier,
      useSoftplus: usesSoftplusRate,
      mlBeta,
    }),
    pAny,
  );
  const pGoodLow = Math.min(clamp01(pAnyLow * qualityMultiplier), pGood);
  const pGoodHigh = Math.max(clamp01(pAnyHigh * qualityMultiplier), pGood);
  const merchantShare = totalDemand > 0 ? merchantDemand / totalDemand : 0;
  const residentialShare = totalDemand > 0 ? residentialDemand / totalDemand : 0;
  const relativeIntensity = lambdaEff / ref;
  const rainLiftPercent = resolvedRainBoost * 100;

  // --- Four-signal decomposition ---
  // GOVERNANCE §2: Signals {I, M, R, D} are semantically independent
  // (S-1), individually normalized to [0,1] (S-2), with no cross-signal
  // inference (S-3). Aggregation A is monotone per component.
  // S(p) = w_I·I + w_M·M + w_R·R − w_D·D

  const composite = clamp01(
    bucket.wI * sigI + bucket.wM * sigM + bucket.wR * sigR - bucket.wD * sigD
  );

  // GOVERNANCE §5: advisory is an interpretive band label (TH-4),
  // not a trigger (TH-1), alert (TH-2), or action (TH-3).
  const advisory = composite >= 0.5 && m.effectiveMerchants >= 3 ? 'hold' : 'rotate';

  return {
    pGood,
    pGood_low: pGoodLow,
    pGood_mid: pGood,
    pGood_high: pGoodHigh,
    pAny,
    pAny_low: pAnyLow,
    pAny_mid: pAny,
    pAny_high: pAnyHigh,
    quality,
    tipProxy: tipAdj,
    lambdaEff,
    lambdaRef: ref,
    horizonMin: T,
    expectedDistMeters: Math.round(m.expectedDist),
    merchantIntensity: m.total,
    merchantDemand,
    residentialIntensity,
    residentialDemand,
    merchantShare,
    residentialShare,
    relativeIntensity,
    rainBoost: resolvedRainBoost,
    rainLiftPercent,
    competitionIntensity: pIntensity,
    ticketMean: m.ticketMean,
    effectiveMerchants: m.effectiveMerchants,
    nearbyMerchants: m.nearbyCount,
    nearestMerchantMeters: Math.round(m.nearestDist),
    supportScore,
    stabilityLow: band.low,
    stabilityHigh: band.high,
    stabilityWidth: band.high - band.low,
    baselinePAny,
    baselineQuality: legacyQuality,
    predictionModel: selectedPredictionModel,
    predictionModelFamily,
    predictionModelVersion,
    modelConfidence,
    modelBlend,
    useML: Boolean(useML),
    mlBeta: Number(mlBeta ?? 2.0),
    signals: { I: sigI, M: sigM, R: sigR, D: sigD },
    composite,
    timeBucketName: bucket.name,
    timeBucketLabel: bucket.label,
    advisory,
    explain: {
      merchantShare: formatExplainShare("nearby merchants", merchantShare),
      residentialShare: formatExplainShare("surrounding homes and apartments", residentialShare),
      relativeIntensity: formatExplainRelativeIntensity(relativeIntensity),
      rainLiftPercent: formatExplainRainLiftPercent(rainLiftPercent),
    },
  };
}

export function buildGridProbabilityHeat(bounds, restaurants, parkingCandidates, params, gridStepMeters) {
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();

  // Convert meter step to degree step. (Approx; ok for small-ish areas.)
  const midLat = (south + north) / 2;
  const metersPerDegLat = 111_320;
  const metersPerDegLon = Math.cos((midLat * Math.PI) / 180) * 111_320;

  const dLat = gridStepMeters / metersPerDegLat;
  const dLon = gridStepMeters / Math.max(1e-6, metersPerDegLon);

  const nodes = [];
  const lambdas = [];

  const hour = Number(params.hour);
  const dayOfWeek = Number(params.dayOfWeek ?? new Date().getDay());
  const tauMeters = Number(params.tauMeters);
  const horizonMin = Number(params.horizonMin);
  const competitionStrength = Number(params.competitionStrength);
  const residentialAnchors = params.residentialAnchors ?? [];
  const residentialTauMeters = Number(params.residentialTauMeters ?? Math.max(400, tauMeters * 1.6));
  const residentialDemandWeight = Number(params.residentialDemandWeight ?? 0.35);
  const rainBoost = Math.max(0, Math.min(0.25, Number(params.rainBoost ?? 0)));
  const tipEmphasis = Number(params.tipEmphasis ?? 0.55);
  const predictionModel = String(params.predictionModel ?? "legacy");
  const useML = Boolean(params.useML);
  const mlBeta = Number(params.mlBeta ?? 2.0);
  const competitionTauMeters = Number(params.competitionTauMeters ?? Math.round(tauMeters * 0.8));
  const demandProfile = temporalDemandProfile(hour, dayOfWeek);

  for (let lat = south; lat <= north; lat += dLat) {
    for (let lon = west; lon <= east; lon += dLon) {
      const m = merchantIntensityAtPoint({ lat, lon }, restaurants, tauMeters, hour);
      const pIntensity = parkingCandidates?.length
        ? parkingIntensityAtPoint({ lat, lon }, parkingCandidates, Math.max(250, competitionTauMeters))
        : 0;
      const residentialIntensity = residentialAnchors.length
        ? residentialIntensityAtPoint({ lat, lon }, residentialAnchors, residentialTauMeters, hour, dayOfWeek)
        : 0;
      const merchantDemand = (1 + rainBoost) * demandProfile.merchant * m.total;
      const residentialDemand = (1 + rainBoost * 1.35) * Math.max(0, residentialDemandWeight) * demandProfile.residential * residentialIntensity;
      const lambdaEff = (merchantDemand + residentialDemand) / (1 + Math.max(0, competitionStrength) * pIntensity);

      nodes.push({ lat, lon, m, pIntensity, residentialIntensity, lambdaEff });
      lambdas.push(lambdaEff);
    }
  }

  lambdas.sort((a, b) => a - b);
  const lambdaRef = Math.max(1e-9, quantile(lambdas, 0.7));

  const pts = [];
  const pGoodValues = [];
  const pGoodLowValues = [];
  const pGoodHighValues = [];
  const compositeValues = [];
  for (const n of nodes) {
    const r = probabilityOfGoodOrder(
      { lat: n.lat, lon: n.lon },
      restaurants,
      parkingCandidates,
      {
        tauMeters,
        hour,
        dayOfWeek,
        horizonMin,
        competitionStrength,
        competitionTauMeters,
        residentialAnchors,
        residentialTauMeters,
        residentialDemandWeight,
        rainBoost,
        tipEmphasis,
        predictionModel,
        lambdaRef,
        useML,
        mlBeta,
      }
    );
    pts.push([n.lat, n.lon, r.pGood]);
    pGoodValues.push(r.pGood);
    pGoodLowValues.push(r.pGood_low);
    pGoodHighValues.push(r.pGood_high);
    compositeValues.push(r.composite);
  }

  pGoodValues.sort((a, b) => a - b);
  pGoodLowValues.sort((a, b) => a - b);
  pGoodHighValues.sort((a, b) => a - b);
  compositeValues.sort((a, b) => a - b);

  const bucket = timeBucket(hour);

  const result = {
    heatPoints: pts,
    stats: {
      lambdaRef,
      scoreSamplesSorted: pGoodValues,
      compositeSamplesSorted: compositeValues,
      medianScore: quantile(pGoodValues, 0.5),
      topDecileScore: quantile(pGoodValues, 0.9),
      medianProbabilityLow: quantile(pGoodLowValues, 0.5),
      medianProbabilityMid: quantile(pGoodValues, 0.5),
      medianProbabilityHigh: quantile(pGoodHighValues, 0.5),
      topDecileProbabilityLow: quantile(pGoodLowValues, 0.9),
      topDecileProbabilityMid: quantile(pGoodValues, 0.9),
      topDecileProbabilityHigh: quantile(pGoodHighValues, 0.9),
      medianComposite: quantile(compositeValues, 0.5),
      topDecileComposite: quantile(compositeValues, 0.9),
      sampleCount: pGoodValues.length,
      hour,
      dayOfWeek,
      tauMeters,
      horizonMin: PROBABILITY_HORIZON_MINUTES,
      competitionStrength,
      residentialTauMeters,
      residentialDemandWeight,
      rainBoost,
      competitionTauMeters,
      predictionModel,
      timeBucketName: bucket.name,
      timeBucketLabel: bucket.label,
    },
  };

  const experimentalDispatchResult = buildExperimentalDispatchResult(params);
  if (experimentalDispatchResult) {
    result.experimentalDispatch = experimentalDispatchResult;
  }

  return result;
}

export function rankParking(parkingCandidates, restaurants, parkingAllCandidates, params, stats, limit = 12) {
  const scored = parkingCandidates
    .map((p) => {
      const r = probabilityOfGoodOrder(p, restaurants, parkingAllCandidates, {
        ...params,
        lambdaRef: stats?.lambdaRef,
      });
      return { ...p, ...r };
    })
    .sort((a, b) => b.pGood - a.pGood);

  return scored.slice(0, limit);
}

export function topLikelyMerchantsForParking(parkingPoint, restaurants, tauMeters, hour, limit = 6) {
  const tau = Math.max(1, tauMeters);

  const weighted = restaurants
    .map((r) => {
      const w = foodWeight(r.tags ?? {}, hour);
      const d = haversineMeters(parkingPoint.lat, parkingPoint.lon, r.lat, r.lon);
      const s = w * Math.exp(-d / tau);
      return { r, s, d };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);

  return weighted.map(({ r, d }) => ({
    id: r.id,
    name: r.tags?.name ?? r.tags?.brand ?? "(unnamed)",
    amenity: r.tags?.amenity ?? "food",
    lat: r.lat,
    lon: r.lon,
    tags: r.tags ?? {},
    distMeters: Math.round(d),
  }));
}
