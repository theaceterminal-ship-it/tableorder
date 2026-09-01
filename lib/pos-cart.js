// lib/pos-cart.js
//
// The waiter-side cart: how a tapped menu item becomes a priced order line.
// Pure functions over plain data, so the pricing of variations and add-ons —
// which decides what a guest is charged — can be tested.

/**
 * The key that decides whether two taps merge into one line or stay apart.
 *
 * Add-on ids are sorted, so picking cheese-then-bacon and bacon-then-cheese
 * produce the same line rather than two identical-looking rows on the bill.
 */
export function posLineKey(itemId, variationId, addonIds) {
  return `${itemId}::${variationId || "base"}::${[...(addonIds || [])].sort().join("+")}`;
}

export function itemHasOptions(item) {
  return Boolean(item?.variations?.length) || Boolean(item?.addons?.length);
}

/**
 * Price and label one line.
 *
 * A variation REPLACES the base price rather than adding to it — a half portion
 * costs its own price, not the full price plus a half. Add-ons are additive on
 * top of whichever base applies.
 */
export function priceLine(item, variationId, addonIds = []) {
  const variation = (item.variations || []).find((v) => v.id === variationId);
  const addons = (item.addons || []).filter((a) => addonIds.includes(a.id));
  const base = variation ? variation.price : item.price;
  const price = base + addons.reduce((s, a) => s + (a.price || 0), 0);
  const name =
    item.name +
    (variation ? ` (${variation.name})` : "") +
    (addons.length ? ` + ${addons.map((a) => a.name).join(", ")}` : "");
  return { price, name, variation: variation || null, addons };
}

/** Add to the cart, merging with an identical existing line. */
export function addLine(cart, item, { variationId = null, addonIds = [], qty = 1 } = {}) {
  const key = posLineKey(item.id, variationId, addonIds);
  const { price, name } = priceLine(item, variationId, addonIds);
  const existing = cart[key];
  return {
    ...cart,
    [key]: {
      itemId: item.id, key, name, price,
      qty: (existing?.qty || 0) + qty,
      variationId: variationId || null,
      addonIds: [...addonIds],
    },
  };
}

/** Change a line's quantity; zero or below removes it entirely. */
export function adjustLineQty(cart, key, delta) {
  const line = cart[key];
  if (!line) return cart;
  const qty = line.qty + delta;
  if (qty <= 0) {
    const next = { ...cart };
    delete next[key];
    return next;
  }
  return { ...cart, [key]: { ...line, qty } };
}

export function cartLines(cart) {
  return Object.values(cart || {}).map((l) => ({
    itemId: l.itemId, key: l.key, name: l.name, price: l.price, qty: l.qty,
  }));
}

export function cartSubtotal(cart) {
  return cartLines(cart).reduce((s, l) => s + l.price * l.qty, 0);
}

/** Total units of one menu item across every line, however it was customised. */
export function qtyForItem(cart, itemId) {
  return Object.values(cart || {})
    .filter((l) => l.itemId === itemId)
    .reduce((s, l) => s + l.qty, 0);
}

/** The quantity of the plain, uncustomised line — what the tile's +/- shows. */
export function plainQtyForItem(cart, itemId) {
  return cart?.[posLineKey(itemId, null, [])]?.qty || 0;
}

/**
 * Longest prep time in the cart, not the sum.
 *
 * A kitchen cooks in parallel, so a 10-minute dish alongside a 25-minute one is
 * ready in 25, not 35. Summing would quote guests wildly pessimistic waits.
 *
 * `fallback` is a FLOOR, not just a default: a basket of quick items still
 * quotes at least that long, because an order takes time to reach the pass even
 * when nothing on it is slow. Lines are matched by id and then by name, so
 * orders placed before itemId existed still find their prep time.
 */
export function estimatedEta(lines, menuItems, fallback = 15) {
  let eta = fallback;
  (lines || []).forEach((l) => {
    const mi = (menuItems || []).find((m) => m.id === l.itemId || m.name === l.name);
    const t = mi?.etaMinutes;
    if (typeof t === "number" && t > eta) eta = t;
  });
  return eta;
}
