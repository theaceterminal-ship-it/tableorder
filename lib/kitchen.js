// lib/kitchen.js
//
// Moving an order through the kitchen. Shared by the kitchen screen and the
// Kitchen tab in the POS, so a manager watching from reception and a cook at
// the pass drive exactly the same logic.
//
// Every state change is a TRANSACTION that first checks the order is still in
// the state the caller thought it was. Two screens are now looking at the same
// queue; without compare-and-set, both could promote the same order, and the
// auto-start queue on two devices would double-start the whole backlog.

import { db } from "./firebase";
import { doc, runTransaction } from "firebase/firestore";
import { DEFAULT_ETA, nextToAutoStart } from "./kitchen-queue";

export {
  MAX_CONCURRENT_PREPARING, DEFAULT_ETA, ETA_PRESETS,
  kitchenQueue, hasOpenStove, nextToAutoStart,
} from "./kitchen-queue";

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Apply a status change only if the order is still in one of `fromStatuses`.
 * Returns true when this caller made the change, false when somebody else got
 * there first — which is not an error, just a race that was resolved.
 */
async function transition(restaurantId, orderId, fromStatuses, patch) {
  const ref = doc(db, "restaurants", restaurantId, "orders", orderId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return false;
    if (!fromStatuses.includes(snap.data().status)) return false;
    tx.update(ref, patch);
    return true;
  });
}

export function startCooking(restaurantId, orderId, minutes) {
  return transition(restaurantId, orderId, ["confirmed"], {
    status: "preparing",
    etaMinutes: minutes || DEFAULT_ETA,
    preparingAt: Date.now(),
  });
}

export function markReady(restaurantId, orderId) {
  return transition(restaurantId, orderId, ["preparing"], { status: "ready" });
}

export function markServed(restaurantId, orderId) {
  return transition(restaurantId, orderId, ["ready"], { status: "served" });
}

// Bumping a running timer must NOT reset preparingAt: the countdown is computed
// from the original start plus the new duration, so extending mid-cook adds
// time rather than restarting the clock.
export function adjustEta(restaurantId, orderId, currentEta, delta) {
  const next = Math.max(1, (currentEta || DEFAULT_ETA) + delta);
  return transition(restaurantId, orderId, ["preparing"], { etaMinutes: next });
}

export function setEta(restaurantId, orderId, minutes) {
  const next = Math.max(1, minutes || DEFAULT_ETA);
  return transition(restaurantId, orderId, ["preparing"], { etaMinutes: next });
}

/** Send an order back to the queue — a cook started the wrong ticket. */
export function returnToQueue(restaurantId, orderId) {
  return transition(restaurantId, orderId, ["preparing"], {
    status: "confirmed",
    preparingAt: null,
  });
}

/**
 * Promote the front of the queue if a stove is free.
 *
 * Safe to call from more than one screen at once: the transaction means only
 * one caller wins, and the loser simply gets false back.
 */
export async function autoStartNext(restaurantId, { confirmed, preparingCount, skipIds }) {
  const next = nextToAutoStart({ confirmed, preparingCount, skipIds });
  if (!next) return null;
  const started = await startCooking(restaurantId, next.id, next.presetEtaMinutes || DEFAULT_ETA);
  return started ? next.id : null;
}
