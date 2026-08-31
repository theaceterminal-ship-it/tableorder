// lib/orders.js
//
// Pure helpers for reading and normalizing order data. No Firestore imports,
// no React — everything here is a plain function over plain data so it can be
// unit tested and shared between the diner (table), kitchen, and reception
// clients without dragging any of them into each other.

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function daysAgo(n, now = Date.now()) {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function isToday(ts, now = Date.now()) {
  if (!ts) return false;
  return startOfDay(ts) === startOfDay(now);
}

// The analytics UI offers today / 3days / week / month. Anything else means
// "as far back as we hold", which is bounded by RECEPTION_ORDER_WINDOW_DAYS.
export function filterRangeStart(filterKey, now = Date.now()) {
  if (filterKey === "today") return daysAgo(0, now);
  if (filterKey === "3days") return daysAgo(3, now);
  if (filterKey === "week") return daysAgo(7, now);
  if (filterKey === "month") return daysAgo(30, now);
  return 0;
}

// How much order history each client subscribes to. These exist because both
// clients previously subscribed to *every order ever written* — unbounded, so
// read cost and page-load time grew linearly forever.
//
// Reception needs 30 days for the "Last Month" analytics filter; 31 gives a
// day of slack around timezone boundaries. Anything older is served from
// rollups rather than from the live listener.
export const RECEPTION_ORDER_WINDOW_DAYS = 31;

// A diner's table session is never longer than one sitting. 12 hours covers a
// lunch service that runs into dinner while still cutting the diner's read set
// from "every order this table has ever had" down to "today's".
export const TABLE_SESSION_WINDOW_HOURS = 12;

export function receptionOrderWindowStart(now = Date.now()) {
  return daysAgo(RECEPTION_ORDER_WINDOW_DAYS, now);
}

export function tableSessionWindowStart(now = Date.now()) {
  return now - TABLE_SESSION_WINDOW_HOURS * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Item identity
// ---------------------------------------------------------------------------

// Order lines historically stored only a *composed display name* — the dish
// name with its variation and add-ons appended — and no itemId. That made every
// variation look like a separate dish to analytics and made renaming a dish
// orphan its entire sales history.
//
// New lines carry itemId. These helpers recover it for the lines already
// written, by peeling the composed suffixes off one at a time and trying an
// exact menu match at each step. Exact match is always attempted first so a
// dish genuinely named "Chicken 65 (Boneless)" is never mangled.
const COMPOSED_SUFFIX_PATTERNS = [
  / \+ [^+]+$/,        // POS add-ons:   "Burger + Cheese, Bacon"
  / \([^()]*\)$/,      // POS variation: "Biryani (Full)"
  / — .+$/,            // table variation: "Paneer Tikka — Half"
  / - .+$/,            // hyphen fallback for older/imported data
];

export function nameCandidates(composedName) {
  const out = [];
  let name = (composedName || "").trim();
  if (!name) return out;
  out.push(name);
  // Peel repeatedly: "Burger (Large) + Cheese" -> "Burger (Large)" -> "Burger".
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of COMPOSED_SUFFIX_PATTERNS) {
      const stripped = name.replace(re, "").trim();
      if (stripped && stripped !== name) {
        name = stripped;
        if (!out.includes(name)) out.push(name);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// Returns the menu item id for an order line, or null when it genuinely cannot
// be resolved (dish deleted, or renamed past recognition). Never guesses when
// a name is ambiguous across two menu items — a wrong join is worse than none.
export function resolveItemId(line, menuItems) {
  if (!line) return null;
  if (line.itemId) return line.itemId;
  if (!Array.isArray(menuItems) || menuItems.length === 0) return null;

  for (const candidate of nameCandidates(line.name)) {
    const matches = menuItems.filter((m) => m.name === candidate);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) return null; // ambiguous — refuse to guess
  }
  return null;
}

// Adds a resolved itemId to every line that lacks one. Lines that already have
// an itemId pass through untouched.
export function withItemIds(items, menuItems) {
  return (items || []).map((it) => ({ ...it, itemId: resolveItemId(it, menuItems) }));
}

// The grouping key used when consolidating duplicate lines onto one bill row.
// Prefers itemId so two lines of the same dish merge even if one was written
// before itemId existed; falls back to the display name for unresolvable lines.
export function orderLineKey(line) {
  const identity = line.itemId || line.name;
  return [identity, line.price, line.notes || "", line.spiceLevel || ""].join("|");
}

// Merge duplicate line items so combining several orders (or several merged
// tables) doesn't produce separate rows for the same dish at the same price.
export function mergeItemLines(items) {
  const map = new Map();
  (items || []).forEach((it) => {
    const key = orderLineKey(it);
    const existing = map.get(key);
    if (existing) existing.qty += it.qty;
    else map.set(key, { ...it });
  });
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Revenue orders
// ---------------------------------------------------------------------------

export function isRevenueOrder(o) {
  return o?.status === "billed" || o?.status === "paid";
}

// When several merged tables are billed together, every order in the group is
// given the same consolidated bill so each table's own device can display it.
// That is correct for *display* and catastrophic for *totals*: summing
// billTotal across them counts a three-table party's revenue three times, and
// counts its items three times too.
//
// Orders written from now on carry isBillPrimary, so exactly one sibling counts.
// Orders written before that carry only mergedTables, so they are de-duplicated
// on the bill's own signature (which tables, what totals, which day).
export function revenueOrders(orders) {
  const out = [];
  const seenLegacyBills = new Set();

  for (const o of orders || []) {
    if (!isRevenueOrder(o)) continue;

    if (o.isBillPrimary === false) continue;
    if (o.isBillPrimary === true) { out.push(o); continue; }

    // Legacy rows: no isBillPrimary flag was ever written.
    if (Array.isArray(o.mergedTables) && o.mergedTables.length > 1) {
      const signature = [
        [...o.mergedTables].sort().join("-"),
        o.billTotal,
        o.billSubtotal,
        startOfDay(o.createdAt),
      ].join("|");
      if (seenLegacyBills.has(signature)) continue;
      seenLegacyBills.add(signature);
    }
    out.push(o);
  }
  return out;
}

// Total revenue across a set of orders, counting each bill exactly once.
export function sumRevenue(orders) {
  return revenueOrders(orders).reduce((sum, o) => sum + (o.billTotal || 0), 0);
}

// Quantity sold per item id across a set of orders, counting each bill exactly
// once. Lines whose item cannot be resolved are grouped under their name so
// they still show up in reports rather than vanishing.
export function soldQtyByItem(orders, menuItems) {
  const counts = {};
  revenueOrders(orders).forEach((o) => {
    withItemIds(o.items || [], menuItems).forEach((it) => {
      const key = it.itemId || it.name;
      if (!key) return;
      counts[key] = (counts[key] || 0) + (it.qty || 0);
    });
  });
  return counts;
}

// Every distinct basket, as arrays of resolved item ids. This is the unit the
// recommendation model is eventually built from, which is exactly why itemId
// and the merged-bill de-duplication above have to be right first.
export function basketsFrom(orders, menuItems) {
  return revenueOrders(orders)
    .map((o) => {
      const ids = withItemIds(o.items || [], menuItems)
        .map((it) => it.itemId)
        .filter(Boolean);
      return [...new Set(ids)];
    })
    .filter((b) => b.length > 0);
}
