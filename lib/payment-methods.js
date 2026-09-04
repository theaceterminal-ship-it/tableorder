// lib/payment-methods.js
//
// The ways a bill can be settled in person — cash at the table, a card
// machine, a UPI scan, or something the restaurant handles its own way.
// Shared between the diner's "Request Bill" screen and reception's own
// Generate Bill modal so the two can never quietly drift out of sync with
// each other, the way two independently-typed copies of the same list
// eventually do.
//
// Dine-in has no per-restaurant "which methods do you accept" toggle the way
// delivery does (acceptsCod / acceptsUpi in website settings) — a restaurant
// handles its own card machine and cash drawer regardless of what this app
// configures, so every outlet is simply offered the same four options.

export const PAYMENT_METHODS = [
  { key: "cash", label: "Cash", icon: "💵" },
  { key: "card", label: "Card", icon: "💳" },
  { key: "upi", label: "UPI", icon: "📱" },
  { key: "other", label: "Other", icon: "🔖" },
];

export const PAYMENT_METHOD_KEYS = PAYMENT_METHODS.map((m) => m.key);

export function isValidPaymentMethod(key) {
  return PAYMENT_METHOD_KEYS.includes(key);
}
