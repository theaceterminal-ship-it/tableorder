// lib/riders.js
//
// The outlet's saved list of riders, so reception chooses a name at dispatch
// instead of typing a name and a phone number for every single delivery.
//
// A rider's name and phone are still copied onto the order at the moment of
// dispatch (see app/receptionist/page.js), not referenced by id. That is
// deliberate: a customer's tracker and a printed bill should keep showing
// exactly who picked up their food even if that rider is later renamed,
// deactivated, or removed from the roster.

import { validateRider } from "./order-types";

export { validateRider as validateRiderProfile };

/** Riders reception should be offered when assigning one. */
export function activeRiders(riders) {
  return (riders || []).filter((r) => r.active !== false);
}

/** Look up one saved rider, e.g. to fill the dispatch order from a picker. */
export function riderById(riders, riderId) {
  return (riders || []).find((r) => r.id === riderId) || null;
}
