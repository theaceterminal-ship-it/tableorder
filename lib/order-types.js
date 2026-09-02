// lib/order-types.js
//
// The three ways an order reaches the kitchen, and what each one needs.
//
// Delivery exists partly as a security measure. Before it, the only way to
// order without being in the restaurant was to abuse a table's QR code, so
// every such attempt looked identical to an attack. Giving people a legitimate
// route removes the motive, and leaves the QR path to be locked down without
// arguing about who genuinely wanted to order from their sofa.

export const ORDER_TYPES = {
  DINE_IN: "dinein",
  TAKEAWAY: "takeaway",
  DELIVERY: "delivery",
};

// A table number is a seat. These two are placeholders for orders that have no
// seat, so every order still has something to group and display by.
export const TAKEAWAY_TABLE = "TAKEAWAY";
export const DELIVERY_TABLE = "DELIVERY";

export const ORDER_TYPE_META = {
  dinein:   { label: "Dine-in",  short: "Dine-in",  icon: "🍽️", color: "#1a1a2e", bg: "#f0ebe3" },
  takeaway: { label: "Takeaway", short: "Pickup",   icon: "📦", color: "#6d28d9", bg: "#ede9fe" },
  delivery: { label: "Delivery", short: "Delivery", icon: "🛵", color: "#0369a1", bg: "#e0f2fe" },
};

export function orderTypeMeta(type) {
  return ORDER_TYPE_META[type] || ORDER_TYPE_META.dinein;
}

export function isDelivery(order) {
  return order?.orderType === ORDER_TYPES.DELIVERY;
}

export function tableForOrderType(type, tableNumber) {
  if (type === ORDER_TYPES.TAKEAWAY) return TAKEAWAY_TABLE;
  if (type === ORDER_TYPES.DELIVERY) return DELIVERY_TABLE;
  return tableNumber;
}

/**
 * How an order should be labelled wherever it is shown.
 *
 * The kitchen especially must not confuse delivery with takeaway: one is
 * collected at the counter, the other leaves with a rider, and packing them
 * the same way is how cold food goes out.
 */
export function orderDestinationLabel(order) {
  const meta = orderTypeMeta(order?.orderType);
  if (order?.orderType === ORDER_TYPES.DELIVERY) return `${meta.icon} Delivery`;
  if (order?.orderType === ORDER_TYPES.TAKEAWAY) return `${meta.icon} Takeaway`;
  return `Table ${order?.table}`;
}

// ---------------------------------------------------------------------------
// Delivery details
// ---------------------------------------------------------------------------

const PHONE_DIGITS = /\D/g;

export function normalizePhone(raw) {
  return String(raw || "").replace(PHONE_DIGITS, "");
}

/**
 * Validate what a delivery order needs before it can be placed.
 *
 * Returns a field-keyed map of problems, empty when it is good to go. A rider
 * cannot deliver to a half-written address and a kitchen cannot chase a missing
 * phone number, so these are refused at the door rather than becoming a
 * reception problem twenty minutes later.
 */
export function validateDeliveryDetails({ name, phone, address, landmark } = {}) {
  const errors = {};
  if (!String(name || "").trim()) errors.name = "Please enter your name.";

  const digits = normalizePhone(phone);
  // Indian mobile numbers are ten digits; allow a country code in front rather
  // than rejecting someone who typed +91.
  if (!digits) errors.phone = "Please enter a phone number.";
  else if (digits.length < 10) errors.phone = "That phone number looks too short.";
  else if (digits.length > 13) errors.phone = "That phone number looks too long.";

  const addr = String(address || "").trim();
  if (!addr) errors.address = "Please enter a delivery address.";
  else if (addr.length < 12) errors.address = "Please give a fuller address so the rider can find you.";

  return errors;
}

export function isDeliveryValid(details) {
  return Object.keys(validateDeliveryDetails(details)).length === 0;
}

/** One line for the kitchen ticket and the reception card. */
export function formatDeliveryAddress({ address, landmark } = {}) {
  return [String(address || "").trim(), String(landmark || "").trim()].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// The delivery lifecycle
// ---------------------------------------------------------------------------
//
// The kitchen statuses (pending → confirmed → preparing → ready) describe FOOD.
// They stop at the pass, which is where a dine-in order ends but a delivery
// order is only half done. Without the two stages below, an order sat at
// "ready" forever, the customer's tracker never said delivered, and nothing
// ever closed it out.
//
// Modelled as a separate field rather than new statuses so the kitchen board,
// the order filters and the security rules keep working unchanged: the kitchen
// still only cares whether food is ready.

export const DELIVERY_STAGES = {
  KITCHEN: "kitchen",       // still being cooked, or waiting at the pass
  DISPATCHED: "dispatched", // a rider has it
  DELIVERED: "delivered",   // handed over
};

export function deliveryStage(order) {
  if (!isDelivery(order)) return null;
  if (order.deliveredAt) return DELIVERY_STAGES.DELIVERED;
  if (order.dispatchedAt) return DELIVERY_STAGES.DISPATCHED;
  return DELIVERY_STAGES.KITCHEN;
}

/**
 * What reception should be offered next for a delivery order.
 *
 * Returns null when there is nothing to do yet — food that is not ready cannot
 * be handed to a rider, and offering the button anyway is how orders leave the
 * kitchen before they are cooked.
 */
export function nextDeliveryAction(order) {
  if (!isDelivery(order)) return null;
  const stage = deliveryStage(order);
  if (stage === DELIVERY_STAGES.DELIVERED) return null;
  if (stage === DELIVERY_STAGES.DISPATCHED) return "deliver";
  return order.status === "ready" ? "dispatch" : null;
}

export function validateRider({ name, phone } = {}) {
  const errors = {};
  if (!String(name || "").trim()) errors.name = "Who is taking it?";
  const digits = normalizePhone(phone);
  // The customer is shown this number so they can be reached about the door
  // code or a wrong turn. A rider with no reachable number is the single most
  // common reason a delivery fails.
  if (!digits) errors.phone = "A contact number is required.";
  else if (digits.length < 10) errors.phone = "That number looks too short.";
  return errors;
}

/**
 * The customer's view of where their food is.
 *
 * `done` drives ticks; `active` is the one step to highlight. Both are derived
 * rather than stored, so a status changed anywhere is reflected everywhere.
 */
export function deliveryTimeline(order) {
  const status = order?.status || "pending";
  const stage = deliveryStage(order) || DELIVERY_STAGES.KITCHEN;
  const cooked = ["preparing", "ready", "served", "billed", "paid"].includes(status);
  const readyToGo = ["ready", "served", "billed", "paid"].includes(status);
  const dispatched = stage === DELIVERY_STAGES.DISPATCHED || stage === DELIVERY_STAGES.DELIVERED;
  const delivered = stage === DELIVERY_STAGES.DELIVERED;

  const steps = [
    { key: "placed", label: "Order placed", done: true },
    { key: "confirmed", label: "Confirmed by the restaurant", done: ["confirmed", "preparing", "ready", "served", "billed", "paid"].includes(status) },
    { key: "cooking", label: "Being cooked", done: cooked },
    { key: "ready", label: "Ready", done: readyToGo },
    { key: "dispatched", label: "Out for delivery", done: dispatched },
    { key: "delivered", label: "Delivered", done: delivered },
  ];
  const firstPending = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ ...s, active: i === firstPending || (delivered && s.key === "delivered") }));
}

/** True once the customer's journey is over and the tracker can be cleared. */
export function isDeliveryComplete(order) {
  return deliveryStage(order) === DELIVERY_STAGES.DELIVERED
    || ["paid", "cancelled", "declined"].includes(order?.status);
}
