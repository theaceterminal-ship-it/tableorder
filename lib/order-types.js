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
