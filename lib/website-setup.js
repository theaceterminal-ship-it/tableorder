// lib/website-setup.js
//
// The public ordering site: the link a restaurant puts on its Google profile,
// and the rules that decide whether it will take an order right now.
//
// All of this is enforced twice. Here, so the customer is told BEFORE they
// build a basket that the kitchen is closed or they are ten rupees short of the
// minimum; and again at the reception end, because a client-side check is a
// courtesy, not a control.

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const DAY_LABELS = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

export const DEFAULT_HOURS = DAY_KEYS.reduce((acc, d) => {
  acc[d] = { open: "11:00", close: "23:00", closed: false };
  return acc;
}, {});

export const DEFAULT_WEBSITE = {
  slug: "",
  enabled: false,
  deliveryEnabled: false,
  pickupEnabled: true,
  deliveryFee: 0,
  freeDeliveryAbove: 0,
  minimumOrder: 0,
  deliveryEtaMinutes: 40,
  deliveryRadiusKm: 5,
  deliveryNote: "",
  acceptsCod: true,
  acceptsUpi: true,
  requirePhoneVerification: false,
  hours: DEFAULT_HOURS,
};

/**
 * A slug is the restaurant's address on the web, so it has to be predictable:
 * lowercase, words joined by single hyphens, nothing else.
 */
export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Reserved because they are real routes in this app; a restaurant claiming
// "login" would make the staff sign-in page unreachable.
const RESERVED_SLUGS = ["order", "table", "login", "signup", "admin", "brand", "kitchen", "receptionist", "setup", "api", "pending"];

export function validateSlug(slug) {
  const s = String(slug || "").trim();
  if (!s) return "Choose a web address for your restaurant.";
  if (s.length < 3) return "Too short — use at least 3 characters.";
  if (s !== slugify(s)) return "Use lowercase letters, numbers and hyphens only.";
  if (RESERVED_SLUGS.includes(s)) return `"${s}" is reserved. Please choose another.`;
  return null;
}

// ---------------------------------------------------------------------------
// Opening hours
// ---------------------------------------------------------------------------

function minutesOf(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Is the restaurant taking orders at this moment?
 *
 * Handles closing after midnight, which most restaurants do: 18:00–01:00 means
 * a customer at half past midnight is still inside Tuesday's service, not
 * outside Wednesday's.
 */
export function isOpenAt(hours, at = new Date()) {
  const today = DAY_KEYS[at.getDay()];
  const yesterday = DAY_KEYS[(at.getDay() + 6) % 7];
  const nowMins = at.getHours() * 60 + at.getMinutes();

  const spans = [];
  const todayCfg = hours?.[today];
  if (todayCfg && !todayCfg.closed) {
    const open = minutesOf(todayCfg.open);
    const close = minutesOf(todayCfg.close);
    if (open != null && close != null) {
      if (close > open) spans.push([open, close]);
      else spans.push([open, 24 * 60]); // runs past midnight
    }
  }
  // Yesterday's late service can still be running.
  const yCfg = hours?.[yesterday];
  if (yCfg && !yCfg.closed) {
    const open = minutesOf(yCfg.open);
    const close = minutesOf(yCfg.close);
    if (open != null && close != null && close <= open) spans.push([0, close]);
  }

  return spans.some(([from, to]) => nowMins >= from && nowMins < to);
}

/** A human sentence about today's hours, for the site header. */
export function todayHoursLabel(hours, at = new Date()) {
  const cfg = hours?.[DAY_KEYS[at.getDay()]];
  if (!cfg || cfg.closed) return "Closed today";
  return `Open ${cfg.open} – ${cfg.close}`;
}

// ---------------------------------------------------------------------------
// What an order costs to deliver
// ---------------------------------------------------------------------------

/**
 * Delivery charge for a basket.
 *
 * freeDeliveryAbove is a threshold, not a discount: at or above it the fee is
 * simply zero, which is what the customer was promised on the banner.
 */
export function deliveryFeeFor(subtotal, website) {
  const w = { ...DEFAULT_WEBSITE, ...(website || {}) };
  if (!w.deliveryFee) return 0;
  if (w.freeDeliveryAbove > 0 && subtotal >= w.freeDeliveryAbove) return 0;
  return w.deliveryFee;
}

export function shortfallToMinimum(subtotal, website) {
  const min = Number(website?.minimumOrder) || 0;
  return subtotal >= min ? 0 : min - subtotal;
}

export function shortfallToFreeDelivery(subtotal, website) {
  const threshold = Number(website?.freeDeliveryAbove) || 0;
  if (!threshold || !website?.deliveryFee) return 0;
  return subtotal >= threshold ? 0 : threshold - subtotal;
}

/**
 * Why this order cannot be placed right now, or null when it can.
 *
 * A reason rather than a boolean, so the customer is told what to do about it.
 */
export function orderingBlockedReason({ website, subtotal, mode = "delivery", at = new Date() }) {
  const w = { ...DEFAULT_WEBSITE, ...(website || {}) };
  if (!w.enabled) return "site-off";
  if (mode === "delivery" && !w.deliveryEnabled) return "delivery-off";
  if (mode === "pickup" && !w.pickupEnabled) return "pickup-off";
  if (!isOpenAt(w.hours, at)) return "closed";
  if (mode === "delivery" && shortfallToMinimum(subtotal, w) > 0) return "below-minimum";
  return null;
}

export function blockedMessage(reason, { website, subtotal } = {}) {
  const w = { ...DEFAULT_WEBSITE, ...(website || {}) };
  switch (reason) {
    case "site-off": return "Online ordering isn't available right now.";
    case "delivery-off": return "This restaurant isn't delivering at the moment.";
    case "pickup-off": return "Pickup isn't available at the moment.";
    case "closed": return "The kitchen is closed right now. Please check back during opening hours.";
    case "below-minimum": return `Add ₹${shortfallToMinimum(subtotal, w)} more to reach the ₹${w.minimumOrder} minimum for delivery.`;
    default: return null;
  }
}

/** The public link a restaurant puts on its Google profile. */
export function publicOrderUrl(origin, { slug, outletId }) {
  return slug ? `${origin}/r/${slug}` : `${origin}/order?restaurant=${outletId}`;
}
