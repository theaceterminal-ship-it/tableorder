// lib/plans.js

export const PLAN_FEATURES = {
  base: {
    floors: false, vipTables: false, combos: false, customization: false,
    splitBill: false, upiQr: false, analytics: "none",
    brandColor: false, promoBanner: false, rating: false,
  },
  mid: {
    floors: true, vipTables: true, combos: true, customization: true,
    splitBill: false, upiQr: true, analytics: "basic",
    brandColor: true, promoBanner: false, rating: true,
  },
  pro: {
    floors: true, vipTables: true, combos: true, customization: true,
    splitBill: true, upiQr: true, analytics: "full",
    brandColor: true, promoBanner: true, rating: true,
  },
};

export function getPlanFeatures(plan) {
  return PLAN_FEATURES[plan] || PLAN_FEATURES.base;
}

export const PLAN_LABELS = { base: "Base", mid: "Mid", pro: "Pro" };

// Pricing shown on /signup and the receptionist upgrade screen.
// Single source of truth — never hardcode a price anywhere else.
//
// `amount` is what the customer is actually charged (it goes straight into the
// UPI payment link). The displayed label is DERIVED from it, because these two
// previously disagreed on every single tier — base charged ₹499 while showing
// "₹1,999 / month", mid charged ₹999 showing ₹2,999, pro charged ₹1,799 showing
// ₹3,799. Deriving the label makes that class of bug impossible to reintroduce.
//
// NOTE: the amounts below are the ones the code was actually charging. If the
// intended prices are the higher numbers that used to be displayed, change
// `amount` here and the labels follow automatically.
const PLAN_AMOUNTS = {
  base: 499,
  mid: 999,
  pro: 1799,
};

export function formatPlanPrice(amount) {
  return `₹${amount.toLocaleString("en-IN")} / month`;
}

export const PLAN_PRICING = Object.fromEntries(
  Object.entries(PLAN_AMOUNTS).map(([key, amount]) => [
    key,
    { amount, cycleDays: 30, label: formatPlanPrice(amount) },
  ])
);

export const PLAN_ORDER = ["base", "mid", "pro"];

// NEW: hotel account lifecycle states — single source of truth so admin
// panel, login, and auth-guard all reference the same strings.
export const HOTEL_STATUS = {
  PENDING_PAYMENT: "pending_payment",
  PENDING_APPROVAL: "pending_approval",
  ACTIVE: "active",
  SUSPENDED: "suspended",
  EXPIRED: "expired",
  REJECTED: "rejected",
};

// Your business UPI ID that customers pay signup/renewal fees to.
// (Separate from a restaurant's own billing.upiId, which is hotel->diner.)
export const PLATFORM_UPI_ID = "bhurk7@okhdfcbank"; // <-- replace with your real UPI ID
export const PLATFORM_PAYEE_NAME = "Cabadra";   // <-- replace with your business name