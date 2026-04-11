// Experimental dispatch assignment logic.
// It may be described as superposition-inspired, but that metaphor is explanatory only.
// This module is isolated and not integrated into runtime flow.
// It must not be promoted into active decision behavior without the documented governance process in docs/GOVERNANCE.md.

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_METERS = 6371000;
const EPSILON = 1e-9;
const SENTINEL_COST = 1e12;

const DEFAULT_PARAMS = {
  alpha: 1,
  beta: 1,
  gamma: 1,
  delta: 1,
  lambda: 0.5,
  meanCitySpeedMps: 8,
  pickupBufferMin: 2,
  latePenaltyWeight: 1,
  earlyPenaltyWeight: 0.7,
  batchingEnabled: true,
  maxBatchSize: 2,
};

const MOTION_MULTIPLIERS = {
  parked: 0.85,
  slow: 1,
  driving_away: 1.25,
  high_speed: 1.4,
};

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minValue, maxValue) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function sanitizeCost(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return SENTINEL_COST;
  if (numeric <= 0) return 0;
  return Math.min(SENTINEL_COST, numeric);
}

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function normalizeId(value, prefix, index) {
  const stringValue = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return stringValue || `${prefix}_${index + 1}`;
}

function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function stableSort(items, comparator) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const comparison = comparator(left.item, right.item);
      if (comparison !== 0) return comparison;
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

function compareDriverRecords(left, right) {
  const idComparison = compareStrings(left.id, right.id);
  if (idComparison !== 0) return idComparison;
  return left.originalIndex - right.originalIndex;
}

function compareOrderRecords(left, right) {
  const idComparison = compareStrings(left.id, right.id);
  if (idComparison !== 0) return idComparison;
  return left.originalIndex - right.originalIndex;
}

function hasValidCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon);
}

function normalizeLatitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, -90, 90);
}

function normalizeLongitude(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, -180, 180);
}

function normalizeMotionState(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MOTION_MULTIPLIERS[normalized] ? normalized : "slow";
}

function clampParkingFriction(value) {
  return clamp(toFiniteNumber(value, 0), 0, 1);
}

function normalizeCustomerWaitMinutes(value) {
  return Math.max(0, toFiniteNumber(value, 0));
}

function motionStateMultiplier(motionState) {
  return MOTION_MULTIPLIERS[motionState] ?? MOTION_MULTIPLIERS.slow;
}

function normalizeParams(params) {
  const source = params && typeof params === "object" ? params : {};

  return {
    alpha: Math.max(0, toFiniteNumber(source.alpha, DEFAULT_PARAMS.alpha)),
    beta: Math.max(0, toFiniteNumber(source.beta, DEFAULT_PARAMS.beta)),
    gamma: Math.max(0, toFiniteNumber(source.gamma, DEFAULT_PARAMS.gamma)),
    delta: Math.max(0, toFiniteNumber(source.delta, DEFAULT_PARAMS.delta)),
    lambda: Math.max(0, toFiniteNumber(source.lambda, DEFAULT_PARAMS.lambda)),
    meanCitySpeedMps: Math.max(0.1, toFiniteNumber(source.meanCitySpeedMps, DEFAULT_PARAMS.meanCitySpeedMps)),
    pickupBufferMin: Math.max(0, toFiniteNumber(source.pickupBufferMin, DEFAULT_PARAMS.pickupBufferMin)),
    latePenaltyWeight: Math.max(0, toFiniteNumber(source.latePenaltyWeight, DEFAULT_PARAMS.latePenaltyWeight)),
    earlyPenaltyWeight: Math.max(0, toFiniteNumber(source.earlyPenaltyWeight, DEFAULT_PARAMS.earlyPenaltyWeight)),
    batchingEnabled: normalizeBoolean(source.batchingEnabled, DEFAULT_PARAMS.batchingEnabled),
    maxBatchSize: 2,
  };
}

function normalizeDrivers(drivers) {
  const source = Array.isArray(drivers) ? drivers : [];
  const normalized = source.map((driver, index) => {
    const lat = normalizeLatitude(driver?.lat);
    const lon = normalizeLongitude(driver?.lon);
    const capacity = Math.max(0, Math.floor(toFiniteNumber(driver?.capacity, 1)));

    return {
      id: normalizeId(driver?.id, "driver", index),
      lat,
      lon,
      headingDeg: toFiniteNumber(driver?.headingDeg, 0),
      speedMps: Math.max(0, toFiniteNumber(driver?.speedMps, 0)),
      motionState: normalizeMotionState(driver?.motionState),
      availableAtMin: toFiniteNumber(driver?.availableAtMin, 0),
      capacity,
      originalIndex: index,
      isAssignable: capacity >= 1 && hasValidCoordinates(lat, lon),
    };
  });

  return stableSort(normalized, compareDriverRecords);
}

function normalizeOrders(orders) {
  const source = Array.isArray(orders) ? orders : [];
  const normalized = source.map((order, index) => {
    const pickupLat = normalizeLatitude(order?.pickupLat);
    const pickupLon = normalizeLongitude(order?.pickupLon);
    const dropoffLat = normalizeLatitude(order?.dropoffLat);
    const dropoffLon = normalizeLongitude(order?.dropoffLon);

    return {
      id: normalizeId(order?.id, "order", index),
      pickupLat,
      pickupLon,
      dropoffLat,
      dropoffLon,
      prepTimeMin: Math.max(0, toFiniteNumber(order?.prepTimeMin, 0)),
      parkingFriction: clampParkingFriction(order?.parkingFriction),
      customerWaitMin: normalizeCustomerWaitMinutes(order?.customerWaitMin),
      createdAtMin: toFiniteNumber(order?.createdAtMin, 0),
      originalIndex: index,
      isAssignable:
        hasValidCoordinates(pickupLat, pickupLon)
        && hasValidCoordinates(dropoffLat, dropoffLon),
    };
  });

  return stableSort(normalized, compareOrderRecords);
}

function haversineMeters(aLat, aLon, bLat, bLon) {
  if (!hasValidCoordinates(aLat, aLon) || !hasValidCoordinates(bLat, bLon)) {
    return SENTINEL_COST;
  }

  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLon = (bLon - aLon) * DEG_TO_RAD;
  const lat1 = aLat * DEG_TO_RAD;
  const lat2 = bLat * DEG_TO_RAD;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const haversine = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const centralAngle = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
  return sanitizeCost(EARTH_RADIUS_METERS * centralAngle);
}

function etaMinutes(distanceMeters, meanCitySpeedMps) {
  const speed = Math.max(0.1, toFiniteNumber(meanCitySpeedMps, DEFAULT_PARAMS.meanCitySpeedMps));
  return sanitizeCost(toFiniteNumber(distanceMeters, SENTINEL_COST) / speed / 60);
}

function deliveryMinutes(order, params) {
  return etaMinutes(
    haversineMeters(order.pickupLat, order.pickupLon, order.dropoffLat, order.dropoffLon),
    params.meanCitySpeedMps
  );
}

function pickupMinutes(driver, order, params) {
  const travelEtaMin = etaMinutes(
    haversineMeters(driver.lat, driver.lon, order.pickupLat, order.pickupLon),
    params.meanCitySpeedMps
  );
  const availabilityGapMin = toFiniteNumber(driver.availableAtMin, 0) - toFiniteNumber(order.createdAtMin, 0);
  return sanitizeCost(Math.max(travelEtaMin, availabilityGapMin));
}

function prepTimePenalty(pickupEtaMin, prepTimeMin, params) {
  const arrivalMin = Math.max(0, toFiniteNumber(pickupEtaMin, 0));
  const prepReadyMin = Math.max(0, toFiniteNumber(prepTimeMin, 0));
  const earlyGapMin = Math.max(0, prepReadyMin - arrivalMin);
  const lateGapMin = Math.max(0, arrivalMin - prepReadyMin);
  const lateScale = 1 / (1 + Math.max(0, params.pickupBufferMin));

  return sanitizeCost(
    params.earlyPenaltyWeight * earlyGapMin
      + params.latePenaltyWeight * lateGapMin * lateScale
  );
}

function zeroComponents(multiplier = MOTION_MULTIPLIERS.slow) {
  return {
    pickupMinutes: 0,
    deliveryMinutes: 0,
    parkingFriction: 0,
    customerWaitMinutes: 0,
    motionMultiplier: multiplier,
    prepPenalty: 0,
    sharedRouteSavings: 0,
  };
}

function buildSingleCostDetail(driver, order, params) {
  const multiplier = motionStateMultiplier(driver.motionState);
  if (!driver.isAssignable || !order.isAssignable) {
    return {
      finalCost: SENTINEL_COST,
      components: zeroComponents(multiplier),
    };
  }

  const pickupEtaMin = pickupMinutes(driver, order, params);
  const deliveryEtaMin = deliveryMinutes(order, params);
  const parkingFriction = clampParkingFriction(order.parkingFriction);
  const customerWaitMinutes = normalizeCustomerWaitMinutes(order.customerWaitMin);
  const prepPenaltyCost = prepTimePenalty(pickupEtaMin, order.prepTimeMin, params);

  const baseCost = sanitizeCost(
    params.alpha * pickupEtaMin
      + params.beta * deliveryEtaMin
      + params.gamma * parkingFriction
      + params.delta * customerWaitMinutes
  );
  const motionAdjustedCost = sanitizeCost(baseCost * multiplier);
  const finalCost = sanitizeCost(motionAdjustedCost + prepPenaltyCost);

  return {
    finalCost,
    components: {
      pickupMinutes: pickupEtaMin,
      deliveryMinutes: deliveryEtaMin,
      parkingFriction,
      customerWaitMinutes,
      motionMultiplier: multiplier,
      prepPenalty: prepPenaltyCost,
      sharedRouteSavings: 0,
    },
  };
}

function buildSingleCostMatrix(drivers, orders, params) {
  return drivers.map((driver) => orders.map((order) => buildSingleCostDetail(driver, order, params)));
}

function buildBestSingleCosts(singleCostMatrix, orderCount) {
  const bestCosts = new Array(orderCount).fill(Number.POSITIVE_INFINITY);

  for (let driverIndex = 0; driverIndex < singleCostMatrix.length; driverIndex += 1) {
    for (let orderIndex = 0; orderIndex < orderCount; orderIndex += 1) {
      const cost = singleCostMatrix[driverIndex][orderIndex].finalCost;
      if (cost >= SENTINEL_COST) continue;
      if (cost < bestCosts[orderIndex] - EPSILON) {
        bestCosts[orderIndex] = cost;
      }
    }
  }

  return bestCosts;
}

function computeDummyCost(singleCostMatrix) {
  let maxFiniteCost = 0;

  for (let driverIndex = 0; driverIndex < singleCostMatrix.length; driverIndex += 1) {
    for (let orderIndex = 0; orderIndex < singleCostMatrix[driverIndex].length; orderIndex += 1) {
      const cost = singleCostMatrix[driverIndex][orderIndex].finalCost;
      if (cost >= SENTINEL_COST) continue;
      if (cost > maxFiniteCost) maxFiniteCost = cost;
    }
  }

  return sanitizeCost(
    Math.min(
      SENTINEL_COST / 4,
      Math.max(1000000, maxFiniteCost + 1000, maxFiniteCost * 10 + 1000)
    )
  );
}

function createSquareMatrix(size, fillValue) {
  return Array.from({ length: size }, () => new Array(size).fill(fillValue));
}

function decorateRealCost(cost, rowIndex, colIndex, size) {
  if (cost >= SENTINEL_COST) return SENTINEL_COST;

  const dimension = Math.max(1, size);
  const unit = EPSILON / (16 * Math.pow(dimension + 1, 4));
  const rowScale = unit * Math.pow(dimension + 1, 2);
  const colScale = unit;
  return sanitizeCost(cost + (rowIndex + 1) * rowScale + (colIndex + 1) * colScale);
}

function buildOptionalAssignmentMatrix(singleCostMatrix, drivers, orders) {
  const driverCount = drivers.length;
  const orderCount = orders.length;
  const size = driverCount + orderCount;
  const matrix = createSquareMatrix(size, SENTINEL_COST);
  const dummyCost = computeDummyCost(singleCostMatrix);

  for (let driverIndex = 0; driverIndex < driverCount; driverIndex += 1) {
    for (let orderIndex = 0; orderIndex < orderCount; orderIndex += 1) {
      matrix[driverIndex][orderIndex] = decorateRealCost(
        singleCostMatrix[driverIndex][orderIndex].finalCost,
        driverIndex,
        orderIndex,
        size
      );
    }

    matrix[driverIndex][orderCount + driverIndex] = dummyCost;
  }

  for (let orderIndex = 0; orderIndex < orderCount; orderIndex += 1) {
    const dummyRowIndex = driverCount + orderIndex;
    matrix[dummyRowIndex][orderIndex] = dummyCost;

    for (let driverIndex = 0; driverIndex < driverCount; driverIndex += 1) {
      matrix[dummyRowIndex][orderCount + driverIndex] = 0;
    }
  }

  return {
    matrix,
    dummyCost,
    driverCount,
    orderCount,
  };
}

function solveHungarian(costMatrix) {
  const rowCount = costMatrix.length;
  const colCount = rowCount ? costMatrix[0].length : 0;
  const u = new Array(rowCount + 1).fill(0);
  const v = new Array(colCount + 1).fill(0);
  const p = new Array(colCount + 1).fill(0);
  const way = new Array(colCount + 1).fill(0);

  for (let row = 1; row <= rowCount; row += 1) {
    p[0] = row;
    const minValues = new Array(colCount + 1).fill(SENTINEL_COST);
    const used = new Array(colCount + 1).fill(false);
    let currentColumn = 0;

    do {
      used[currentColumn] = true;
      const currentRow = p[currentColumn];
      let delta = SENTINEL_COST;
      let nextColumn = 0;

      for (let column = 1; column <= colCount; column += 1) {
        if (used[column]) continue;

        const reducedCost = sanitizeCost(costMatrix[currentRow - 1][column - 1] - u[currentRow] - v[column]);
        if (
          reducedCost < minValues[column] - EPSILON
          || (Math.abs(reducedCost - minValues[column]) <= EPSILON && currentColumn < way[column])
        ) {
          minValues[column] = reducedCost;
          way[column] = currentColumn;
        }

        if (
          minValues[column] < delta - EPSILON
          || (Math.abs(minValues[column] - delta) <= EPSILON && column < nextColumn)
        ) {
          delta = minValues[column];
          nextColumn = column;
        }
      }

      for (let column = 0; column <= colCount; column += 1) {
        if (used[column]) {
          u[p[column]] += delta;
          v[column] -= delta;
        } else {
          minValues[column] = sanitizeCost(minValues[column] - delta);
        }
      }

      currentColumn = nextColumn;
    } while (p[currentColumn] !== 0);

    do {
      const nextColumn = way[currentColumn];
      p[currentColumn] = p[nextColumn];
      currentColumn = nextColumn;
    } while (currentColumn !== 0);
  }

  const assignment = new Array(rowCount).fill(-1);
  for (let column = 1; column <= colCount; column += 1) {
    if (p[column] !== 0) assignment[p[column] - 1] = column - 1;
  }

  return assignment;
}

function createSingleAssignment(driverIndex, orderIndex, detail) {
  return {
    driverIndex,
    primaryOrderIndex: orderIndex,
    orderIndices: [orderIndex],
    totalCost: sanitizeCost(detail.finalCost),
    components: {
      pickupMinutes: detail.components.pickupMinutes,
      deliveryMinutes: detail.components.deliveryMinutes,
      parkingFriction: detail.components.parkingFriction,
      customerWaitMinutes: detail.components.customerWaitMinutes,
      motionMultiplier: detail.components.motionMultiplier,
      prepPenalty: detail.components.prepPenalty,
      sharedRouteSavings: 0,
    },
  };
}

function buildBaseAssignmentState(hungarianAssignment, assignmentMatrix, singleCostMatrix, drivers, orders) {
  const driverAssignments = new Array(drivers.length).fill(null);
  const orderToDriver = new Array(orders.length).fill(-1);

  for (let driverIndex = 0; driverIndex < assignmentMatrix.driverCount; driverIndex += 1) {
    const columnIndex = hungarianAssignment[driverIndex];
    if (columnIndex < 0 || columnIndex >= assignmentMatrix.orderCount) continue;

    const detail = singleCostMatrix[driverIndex][columnIndex];
    if (detail.finalCost >= assignmentMatrix.dummyCost || detail.finalCost >= SENTINEL_COST) continue;

    driverAssignments[driverIndex] = createSingleAssignment(driverIndex, columnIndex, detail);
    orderToDriver[columnIndex] = driverIndex;
  }

  return {
    driverAssignments,
    orderToDriver,
  };
}

function vectorFromOrder(order) {
  return {
    x: haversineMeters(order.pickupLat, order.pickupLon, order.pickupLat, order.dropoffLon),
    y: haversineMeters(order.pickupLat, order.pickupLon, order.dropoffLat, order.pickupLon),
    signX: order.dropoffLon >= order.pickupLon ? 1 : -1,
    signY: order.dropoffLat >= order.pickupLat ? 1 : -1,
  };
}

function directionalSimilarity(orderA, orderB) {
  const vectorA = vectorFromOrder(orderA);
  const vectorB = vectorFromOrder(orderB);
  const ax = vectorA.x * vectorA.signX;
  const ay = vectorA.y * vectorA.signY;
  const bx = vectorB.x * vectorB.signX;
  const by = vectorB.y * vectorB.signY;
  const magnitudeA = Math.hypot(ax, ay);
  const magnitudeB = Math.hypot(bx, by);

  if (magnitudeA <= EPSILON || magnitudeB <= EPSILON) return 0;

  const cosine = clamp((ax * bx + ay * by) / (magnitudeA * magnitudeB), -1, 1);
  return (cosine + 1) / 2;
}

function sharedRouteSavings(orderA, orderB, params) {
  const pickupGapMin = etaMinutes(
    haversineMeters(orderA.pickupLat, orderA.pickupLon, orderB.pickupLat, orderB.pickupLon),
    params.meanCitySpeedMps
  );
  const dropoffGapMin = etaMinutes(
    haversineMeters(orderA.dropoffLat, orderA.dropoffLon, orderB.dropoffLat, orderB.dropoffLon),
    params.meanCitySpeedMps
  );
  const deliveryA = deliveryMinutes(orderA, params);
  const deliveryB = deliveryMinutes(orderB, params);
  const directionScore = directionalSimilarity(orderA, orderB);

  const pickupSavings = Math.exp(-pickupGapMin / 4) * 2;
  const directionalSavings = directionScore * 0.5 * Math.min(deliveryA, deliveryB);
  const overlapRatio = clamp(
    1 - dropoffGapMin / Math.max(deliveryA + deliveryB, EPSILON),
    0,
    1
  );
  const overlapSavings = overlapRatio * directionScore * 0.75 * Math.min(deliveryA, deliveryB);

  return sanitizeCost(pickupSavings + directionalSavings + overlapSavings);
}

function combineBatchComponents(primaryDetail, secondaryDetail, savings) {
  return {
    pickupMinutes: sanitizeCost(
      primaryDetail.components.pickupMinutes + secondaryDetail.components.pickupMinutes
    ),
    deliveryMinutes: sanitizeCost(
      primaryDetail.components.deliveryMinutes + secondaryDetail.components.deliveryMinutes
    ),
    parkingFriction: sanitizeCost(
      primaryDetail.components.parkingFriction + secondaryDetail.components.parkingFriction
    ),
    customerWaitMinutes: sanitizeCost(
      primaryDetail.components.customerWaitMinutes + secondaryDetail.components.customerWaitMinutes
    ),
    motionMultiplier: primaryDetail.components.motionMultiplier,
    prepPenalty: sanitizeCost(
      primaryDetail.components.prepPenalty + secondaryDetail.components.prepPenalty
    ),
    sharedRouteSavings: sanitizeCost(savings),
  };
}

function applyBatchAugmentation(baseState, singleCostMatrix, bestSingleCosts, drivers, orders, params) {
  const driverAssignments = baseState.driverAssignments.map((assignment) => {
    if (!assignment) return null;
    return {
      driverIndex: assignment.driverIndex,
      primaryOrderIndex: assignment.primaryOrderIndex,
      orderIndices: assignment.orderIndices.slice(),
      totalCost: assignment.totalCost,
      components: { ...assignment.components },
    };
  });
  const orderToDriver = baseState.orderToDriver.slice();

  const sortedSeeds = stableSort(
    driverAssignments
      .filter(Boolean)
      .map((assignment) => ({
        driverIndex: assignment.driverIndex,
        primaryOrderIndex: assignment.primaryOrderIndex,
      })),
    (left, right) => {
      const driverComparison = compareStrings(drivers[left.driverIndex].id, drivers[right.driverIndex].id);
      if (driverComparison !== 0) return driverComparison;
      return compareStrings(orders[left.primaryOrderIndex].id, orders[right.primaryOrderIndex].id);
    }
  );

  for (const seed of sortedSeeds) {
    const assignment = driverAssignments[seed.driverIndex];
    if (!assignment || assignment.orderIndices.length !== 1) continue;

    const driver = drivers[seed.driverIndex];
    if (driver.capacity < 2) continue;

    const primaryOrderIndex = assignment.primaryOrderIndex;
    const primaryDetail = singleCostMatrix[seed.driverIndex][primaryOrderIndex];

    for (let candidateOrderIndex = 0; candidateOrderIndex < orders.length; candidateOrderIndex += 1) {
      if (candidateOrderIndex === primaryOrderIndex) continue;
      if (orderToDriver[candidateOrderIndex] === seed.driverIndex) continue;

      const currentOwner = orderToDriver[candidateOrderIndex];
      if (currentOwner !== -1) {
        const ownerAssignment = driverAssignments[currentOwner];
        if (
          !ownerAssignment
          || ownerAssignment.orderIndices.length !== 1
          || ownerAssignment.primaryOrderIndex !== candidateOrderIndex
        ) {
          continue;
        }
      }

      const candidateDetail = singleCostMatrix[seed.driverIndex][candidateOrderIndex];
      if (candidateDetail.finalCost >= SENTINEL_COST) continue;

      const savings = sharedRouteSavings(orders[primaryOrderIndex], orders[candidateOrderIndex], params);
      const batchCost = sanitizeCost(primaryDetail.finalCost + candidateDetail.finalCost - params.lambda * savings);
      const bestSingleCost = sanitizeCost(bestSingleCosts[candidateOrderIndex]);
      const baselineCost = sanitizeCost(primaryDetail.finalCost + bestSingleCost);

      if (batchCost >= baselineCost - EPSILON) continue;

      if (currentOwner !== -1) {
        driverAssignments[currentOwner] = null;
      }

      orderToDriver[candidateOrderIndex] = seed.driverIndex;
      assignment.orderIndices = [primaryOrderIndex, candidateOrderIndex];
      assignment.totalCost = batchCost;
      assignment.components = combineBatchComponents(primaryDetail, candidateDetail, savings);
      break;
    }
  }

  return {
    driverAssignments,
    orderToDriver,
  };
}

function finalizeAssignments(state, drivers, orders, params) {
  const assignments = [];
  const assignedDriverIds = new Set();
  const assignedOrderIds = new Set();
  let batchedCount = 0;

  for (let driverIndex = 0; driverIndex < state.driverAssignments.length; driverIndex += 1) {
    const assignment = state.driverAssignments[driverIndex];
    if (!assignment) continue;

    const orderIds = assignment.orderIndices.map((orderIndex) => orders[orderIndex].id);
    if (orderIds.length > 1) batchedCount += 1;

    assignments.push({
      driverId: drivers[driverIndex].id,
      orderIds,
      totalCost: sanitizeCost(assignment.totalCost),
      components: {
        pickupMinutes: sanitizeCost(assignment.components.pickupMinutes),
        deliveryMinutes: sanitizeCost(assignment.components.deliveryMinutes),
        parkingFriction: sanitizeCost(assignment.components.parkingFriction),
        customerWaitMinutes: sanitizeCost(assignment.components.customerWaitMinutes),
        motionMultiplier: sanitizeCost(assignment.components.motionMultiplier),
        prepPenalty: sanitizeCost(assignment.components.prepPenalty),
        sharedRouteSavings: sanitizeCost(assignment.components.sharedRouteSavings),
      },
    });

    assignedDriverIds.add(drivers[driverIndex].id);
    for (const orderId of orderIds) assignedOrderIds.add(orderId);
  }

  const unassignedDrivers = drivers
    .filter((driver) => !assignedDriverIds.has(driver.id))
    .map((driver) => driver.id);
  const unassignedOrders = orders
    .filter((order) => !assignedOrderIds.has(order.id))
    .map((order) => order.id);

  return {
    assignments,
    unassignedDrivers,
    unassignedOrders,
    diagnostics: {
      solver: "hungarian",
      batchingEnabled: params.batchingEnabled,
      driverCount: drivers.length,
      orderCount: orders.length,
      matchedCount: assignedOrderIds.size,
      batchedCount,
    },
  };
}

function emptyResult(drivers, orders, params) {
  return {
    assignments: [],
    unassignedDrivers: drivers.map((driver) => driver.id),
    unassignedOrders: orders.map((order) => order.id),
    diagnostics: {
      solver: "hungarian",
      batchingEnabled: params.batchingEnabled,
      driverCount: drivers.length,
      orderCount: orders.length,
      matchedCount: 0,
      batchedCount: 0,
    },
  };
}

export function assignOrders(drivers, orders, params) {
  const normalizedParams = normalizeParams(params);
  const normalizedDrivers = normalizeDrivers(drivers);
  const normalizedOrders = normalizeOrders(orders);

  if (!normalizedDrivers.length || !normalizedOrders.length) {
    return emptyResult(normalizedDrivers, normalizedOrders, normalizedParams);
  }

  const singleCostMatrix = buildSingleCostMatrix(normalizedDrivers, normalizedOrders, normalizedParams);
  const bestSingleCosts = buildBestSingleCosts(singleCostMatrix, normalizedOrders.length);
  const assignmentMatrix = buildOptionalAssignmentMatrix(singleCostMatrix, normalizedDrivers, normalizedOrders);
  const hungarianAssignment = solveHungarian(assignmentMatrix.matrix);
  const baseState = buildBaseAssignmentState(
    hungarianAssignment,
    assignmentMatrix,
    singleCostMatrix,
    normalizedDrivers,
    normalizedOrders
  );

  const finalState = normalizedParams.batchingEnabled && normalizedParams.maxBatchSize >= 2
    ? applyBatchAugmentation(
      baseState,
      singleCostMatrix,
      bestSingleCosts,
      normalizedDrivers,
      normalizedOrders,
      normalizedParams
    )
    : baseState;

  return finalizeAssignments(finalState, normalizedDrivers, normalizedOrders, normalizedParams);
}