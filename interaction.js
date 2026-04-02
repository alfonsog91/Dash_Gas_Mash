export const STAT_PING_DOUBLE_TAP_THRESHOLD_MS = 325;
export const STAT_PING_TOUCH_CLICK_GRACE_MS = 700;
export const STAT_PING_TOUCH_SUPPRESS_AFTER_GESTURE_MS = 450;

export function createStatPingGestureState() {
  return {
    lastTouchStartAt: 0,
    lastTouchEndAt: 0,
    suppressUntil: 0,
    zoomGestureActive: false,
  };
}

export function suppressStatPing(state, now, durationMs = STAT_PING_TOUCH_SUPPRESS_AFTER_GESTURE_MS) {
  state.suppressUntil = Math.max(state.suppressUntil, now + durationMs);
  return state.suppressUntil;
}

export function noteStatPingTouchStart(state, now, touchCount) {
  state.lastTouchStartAt = now;
  if (touchCount > 1 || now - state.lastTouchEndAt <= STAT_PING_DOUBLE_TAP_THRESHOLD_MS) {
    state.zoomGestureActive = true;
    suppressStatPing(state, now);
  }
  return state;
}

export function noteStatPingTouchMove(state, now, touchCount) {
  if (touchCount > 1 || state.zoomGestureActive) {
    state.zoomGestureActive = true;
    suppressStatPing(state, now);
  }
  return state;
}

export function noteStatPingTouchEnd(state, now, remainingTouchCount) {
  state.lastTouchEndAt = now;
  if (remainingTouchCount > 0) {
    state.zoomGestureActive = true;
    suppressStatPing(state, now);
  }
  return state;
}

export function noteStatPingTouchCancel(state, now) {
  state.lastTouchEndAt = now;
  state.zoomGestureActive = true;
  suppressStatPing(state, now);
  return state;
}

export function shouldDelayStatPingFromTouch(state, now) {
  const lastTouchAt = Math.max(state.lastTouchStartAt, state.lastTouchEndAt);
  return lastTouchAt > 0 && now - lastTouchAt <= STAT_PING_TOUCH_CLICK_GRACE_MS;
}

export function shouldSuppressStatPing(state, now) {
  return state.zoomGestureActive || now < state.suppressUntil;
}

export function releaseStatPingGesture(state, now) {
  if (now >= state.suppressUntil) {
    state.zoomGestureActive = false;
  }
  return state;
}
