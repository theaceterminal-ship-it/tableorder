// lib/pricing.js
//
// Every rupee the product charges is computed here. These are pure functions
// over plain data on purpose: this is the highest-risk code in the app, it used
// to live inline in a 3,900-line component (and in a second, subtly different
// copy on the diner side), and it now has tests.
//
// Amounts are whole rupees, rounded at each discount and at the tax/service
// lines, matching what is printed on the bill.

import { resolveItemId } from "./orders";

// ---------------------------------------------------------------------------
// Offer banners
// ---------------------------------------------------------------------------

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function isOfferActiveToday(banner, now = new Date()) {
  if (!banner?.days || banner.days.length === 0) return true; // no days picked = every day
  return banner.days.includes(DAY_KEYS[now.getDay()]);
}

// Discounted unit price for a banner's linked item today, or null when there is
// no discount configured or today isn't one of the chosen days.
export function computeOfferPrice(banner, item, now = new Date()) {
  if (!item || !banner?.discountPercent || banner.discountPercent <= 0) return null;
  if (!isOfferActiveToday(banner, now)) return null;
  return Math.max(0, Math.round(item.price * (1 - banner.discountPercent / 100)));
}

// ---------------------------------------------------------------------------
// Bundle rules and BOGO
// ---------------------------------------------------------------------------

function lineItemId(line, menuItems) {
  return line.itemId || line.id || resolveItemId(line, menuItems);
}

function menuItemFor(line, menuItems) {
  const id = lineItemId(line, menuItems);
  return id ? menuItems.find((m) => m.id === id) : undefined;
}

function cartHasAllItems(items, requiredItemIds, menuItems) {
  const present = items.map((it) => lineItemId(it, menuItems)).filter(Boolean);
  return requiredItemIds.every((id) => present.includes(id));
}

function cartSubtotalForCategories(items, menuItems, requiredCategories) {
  return items.reduce((sum, it) => {
    const mi = menuItemFor(it, menuItems);
    if (mi && requiredCategories.includes(mi.category)) return sum + it.price * it.qty;
    return sum;
  }, 0);
}

export function subtotalOf(items) {
  return (items || []).reduce((sum, it) => sum + it.price * it.qty, 0);
}

// Buy 1 Get 1 Free — driven purely by item.bogoEnabled, no rule needed to set
// it up. Expands every unit across all BOGO-flagged lines, sorts high to low,
// and frees every 2nd unit (the cheaper of each pair). An odd unit left over
// with no pair is charged in full.
//
// This is the single implementation. The diner-side cart preview calls it too,
// so the number shown to the guest and the number deducted at billing cannot
// drift apart.
export function computeBogoDiscount(items, menuItems) {
  const units = [];
  (items || []).forEach((it) => {
    const mi = menuItemFor(it, menuItems);
    if (mi?.bogoEnabled) {
      for (let i = 0; i < it.qty; i++) units.push(it.price);
    }
  });
  if (units.length < 2) return null;
  units.sort((a, b) => b - a);
  let amount = 0;
  for (let i = 1; i < units.length; i += 2) amount += units[i];
  return amount > 0 ? { name: "🎁 Buy 1 Get 1 Free", amount: Math.round(amount) } : null;
}

export function computeBundleDiscounts(items, menuItems, bundleRules) {
  const discounts = [];
  const menu = menuItems || [];

  // BOGO always evaluates first, ahead of manually-configured Smart Deals —
  // it's driven by the per-item bogoEnabled flag, not a bundleRules entry.
  const bogo = computeBogoDiscount(items, menu);
  if (bogo) discounts.push(bogo);

  for (const rule of (bundleRules || []).filter((r) => r.active)) {
    if (rule.type === "pairDiscount" && Array.isArray(rule.requiredItems) && rule.requiredItems.length >= 1) {
      if (!cartHasAllItems(items, rule.requiredItems, menu)) continue;
      let amt = 0;
      if (rule.discountType === "flat") {
        amt = Number(rule.discountValue) || 0;
      } else {
        // percent off the cheaper of the two required items
        const prices = rule.requiredItems
          .map((id) => items.find((it) => lineItemId(it, menu) === id)?.price || 0)
          .filter((p) => p > 0);
        const base = prices.length ? Math.min(...prices) : 0;
        amt = Math.round(base * ((Number(rule.discountValue) || 0) / 100));
      }
      if (amt > 0) discounts.push({ name: rule.name, amount: amt });
    } else if (rule.type === "thresholdFreeItem" && rule.threshold) {
      if (subtotalOf(items) >= Number(rule.threshold)) {
        const freeItem = menu.find((m) => m.id === rule.freeItemId);
        if (freeItem) discounts.push({ name: `${rule.name} (Free ${freeItem.name})`, amount: freeItem.price });
      }
    } else if (rule.type === "categoryBundle" && Array.isArray(rule.requiredCategories) && rule.requiredCategories.length >= 1) {
      const catsPresent = rule.requiredCategories.every((cat) =>
        items.some((it) => menuItemFor(it, menu)?.category === cat)
      );
      if (!catsPresent) continue;
      const relevantSubtotal = cartSubtotalForCategories(items, menu, rule.requiredCategories);
      const amt = Math.round(relevantSubtotal * ((Number(rule.discountValue) || 0) / 100));
      if (amt > 0) discounts.push({ name: rule.name, amount: amt });
    }
  }
  return discounts;
}

// ---------------------------------------------------------------------------
// The bill
// ---------------------------------------------------------------------------

// One place that turns a set of item lines into everything printed on a bill.
// Reception's Generate Bill, the POS preview, and the diner's cart total all
// call this, so all three agree by construction.
//
// Discounts come off the subtotal first; tax and service are charged on the
// discounted subtotal, never on the pre-discount amount.
export function computeBillTotals({
  items, menuItems, bundleRules, taxPercent = 0, servicePercent = 0, deliveryFee = 0,
}) {
  const subtotal = subtotalOf(items);
  const discounts = computeBundleDiscounts(items, menuItems, bundleRules);
  const discountTotal = discounts.reduce((s, d) => s + d.amount, 0);
  const discountedSubtotal = Math.max(0, subtotal - discountTotal);
  const taxAmount = Math.round((discountedSubtotal * (Number(taxPercent) || 0)) / 100);
  const serviceAmount = Math.round((discountedSubtotal * (Number(servicePercent) || 0)) / 100);

  // Delivery is charged on top of the taxed food total rather than being folded
  // into the subtotal, so it never moves the food tax or a percentage discount.
  // It is zero for every dine-in and takeaway bill, which is why adding it here
  // changes nothing for them.
  const delivery = Math.max(0, Math.round(Number(deliveryFee) || 0));
  const grandTotal = discountedSubtotal + taxAmount + serviceAmount + delivery;

  return {
    subtotal,
    discounts,
    discountTotal,
    discountedSubtotal,
    taxPercent: Number(taxPercent) || 0,
    taxAmount,
    servicePercent: Number(servicePercent) || 0,
    serviceAmount,
    deliveryFee: delivery,
    grandTotal,
  };
}
