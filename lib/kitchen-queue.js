// lib/kitchen-queue.js
//
// How the kitchen queue behaves: what cooks next, when a stove is free, and
// what the auto-start queue should promote.
//
// Deliberately imports NOTHING. Keeping it clear of the Firestore client is
// what lets it be tested in plain Node — lib/kitchen.js holds the writes.

export const MAX_CONCURRENT_PREPARING = 5;
export const DEFAULT_ETA = 20;
export const ETA_PRESETS = [10, 15, 20, 25, 30];

// VIP first, then oldest. The order the kitchen should cook in, and the order
// the auto-start queue promotes from.
export function kitchenQueue(orders) {
  return [...(orders || [])].sort(
    (a, b) => (b.isVIP ? 1 : 0) - (a.isVIP ? 1 : 0) || a.createdAt - b.createdAt
  );
}

export function hasOpenStove(preparingCount) {
  return preparingCount < MAX_CONCURRENT_PREPARING;
}

/**
 * The next order to auto-start, or null when there is nothing to do.
 * Pure, so the rule "only when a stove is free" is testable without Firestore.
 */
export function nextToAutoStart({ confirmed, preparingCount, skipIds = [] }) {
  if (!hasOpenStove(preparingCount)) return null;
  const skip = new Set(skipIds);
  return kitchenQueue(confirmed).find((o) => !skip.has(o.id)) || null;
}
