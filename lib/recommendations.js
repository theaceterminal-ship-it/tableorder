// lib/recommendations.js
//
// What to suggest a diner add to their cart, and why.
//
// This replaces two ad hoc heuristics that used to live in app/table/page.js:
// a "same category, or featured" filter, and a hand-typed table of six
// category names ("Mains" needs "Breads & Rice", and so on) that silently did
// nothing for any category not spelled exactly that way — which was already
// most categories in the sample menu (Soups, Sides, Desserts were never
// covered at all). Neither ever looked at what people actually ordered
// together.
//
// The replacement is one blend, per pair of items:
//
//   score = w · (real co-occurrence, shrunk)  +  (1 − w) · (a category prior)
//   w     = pairCount / (pairCount + K)
//
// At zero orders, w is zero and the prior alone decides — a brand-new outlet
// gets sensible suggestions (a curry pairs with bread) from the moment its
// menu exists, with no fabricated orders required. As real baskets accumulate
// for a specific pair, w rises and what this restaurant's own customers
// actually do takes over from the generic prior. No fake data is ever mixed
// into the real counts — the prior is a separate number that fades out, not a
// planted co-occurrence.
//
// No Firebase imports, deliberately: this same code scores recommendations in
// the diner's browser AND builds the model in scripts/build-rec-models.mjs
// under the Admin SDK. One implementation, tested once.

// The explicit .js extension matters here, unusually for this codebase: this
// file is imported both by Next.js (which resolves extensionless imports
// fine) and directly by scripts/build-rec-models.mjs under plain Node ESM,
// which requires the extension and fails to resolve without it.
import { basketsFrom } from "./orders.js";

// ---------------------------------------------------------------------------
// Category priors
// ---------------------------------------------------------------------------
//
// A coarse type per category, guessed from its name so this works for any
// restaurant's own category naming — not just the exact strings one menu
// happened to use. Falls back to OTHER rather than guessing wrong.

const CATEGORY_KEYWORDS = [
  ["COMBO", ["combo", "thali", "platter", "meal box", "meal for"]],
  ["BREAD", ["bread", "naan", "roti", "paratha", "rice", "kulcha"]],
  ["MAIN", ["main", "curry", "gravy", "biryani", "indian", "chinese", "tandoor", "grill"]],
  ["STARTER", ["starter", "appetizer", "kebab", "tikka", "snack", "finger food"]],
  ["SOUP", ["soup", "shorba"]],
  ["SIDE", ["side", "salad", "raita", "papad", "pickle", "accompaniment"]],
  ["BEVERAGE", ["beverage", "drink", "juice", "mocktail", "lassi", "coffee", "tea", "chai", "shake", "soda", "water"]],
  ["DESSERT", ["dessert", "sweet", "ice cream", "kulfi", "gulab", "halwa", "cake"]],
];

export function menuCategoryType(categoryName) {
  const name = String(categoryName || "").toLowerCase();
  for (const [type, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => name.includes(k))) return type;
  }
  return "OTHER";
}

// How well two category TYPES complement each other, 0..1. Symmetric — order
// does not matter, a curry-and-bread pairing is the same fact either way.
// Deliberately coarse: this is a starting point real orders are meant to
// correct, not a claim of precision.
const PAIR_PRIOR = {
  "BREAD|MAIN": 0.9,
  "BEVERAGE|STARTER": 0.6,
  "BEVERAGE|MAIN": 0.55,
  "MAIN|SIDE": 0.5,
  "DESSERT|MAIN": 0.5,
  "DESSERT|STARTER": 0.45,
  "MAIN|STARTER": 0.4,
  "SOUP|STARTER": 0.4,
  "DESSERT|BEVERAGE": 0.4,
  "DESSERT|SIDE": 0.4,
  "MAIN|SOUP": 0.35,
  "DESSERT|BREAD": 0.35,
  "DESSERT|SOUP": 0.35,
  "BREAD|SIDE": 0.3,
  "BREAD|BEVERAGE": 0.3,
  "MAIN|MAIN": 0.3,
  "SIDE|STARTER": 0.3,
  "BREAD|STARTER": 0.25,
  "SIDE|BEVERAGE": 0.25,
  "SOUP|BEVERAGE": 0.25,
  "SOUP|SIDE": 0.25,
  "STARTER|STARTER": 0.2,
  "BREAD|BREAD": 0.15,
  "BEVERAGE|BEVERAGE": 0.15,
  "SIDE|SIDE": 0.15,
  "DESSERT|DESSERT": 0.15,
  "SOUP|SOUP": 0.1,
};
// Unlisted, ordinary pairs — mild curiosity, better than nothing.
const DEFAULT_PAIR_PRIOR = 0.2;
// A combo is usually already a full meal; it does not need much alongside it,
// and pairs poorly as a suggestion no matter what sits next to it.
const COMBO_PAIR_PRIOR = 0.1;

function pairPriorForTypes(typeA, typeB) {
  if (typeA === "COMBO" || typeB === "COMBO") return COMBO_PAIR_PRIOR;
  const key = [typeA, typeB].sort().join("|");
  return PAIR_PRIOR[key] ?? DEFAULT_PAIR_PRIOR;
}

/** How well two MENU ITEMS complement each other, before any order data. */
export function itemPriorScore(itemA, itemB) {
  if (!itemA || !itemB || itemA.id === itemB.id) return 0;
  return pairPriorForTypes(menuCategoryType(itemA.category), menuCategoryType(itemB.category));
}

// ---------------------------------------------------------------------------
// Real co-occurrence
// ---------------------------------------------------------------------------

function pairKey(idA, idB) {
  return [idA, idB].sort().join("::");
}

/** How often each item, and each pair of items, appears in the same order. */
export function coOccurrenceCounts(baskets) {
  const singleCounts = {};
  const pairCounts = {};
  for (const basket of baskets || []) {
    const ids = [...new Set(basket)];
    ids.forEach((id) => { singleCounts[id] = (singleCounts[id] || 0) + 1; });
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = pairKey(ids[i], ids[j]);
        pairCounts[key] = (pairCounts[key] || 0) + 1;
      }
    }
  }
  return { singleCounts, pairCounts, basketCount: (baskets || []).length };
}

/**
 * Cosine similarity, shrunk toward zero for pairs seen only a handful of
 * times — otherwise two items that happened to appear together exactly once
 * each would score as a PERFECT pairing (1.0), which a single coincidence
 * does not deserve. Larger lambda demands more repetition before trusting a
 * pair; ~20 is a light touch appropriate for a single outlet's order volume.
 */
export function shrunkSimilarity(countA, countB, countPair, lambda = 20) {
  if (!countA || !countB || !countPair) return 0;
  return countPair / (Math.sqrt(countA * countB) + lambda);
}

/**
 * Blend the prior with real data, trusting the data more as it accumulates.
 * K is "how many co-occurrences until the prior is half-weighted" — at
 * pairCount = K the blend is 50/50; well below it the prior dominates, well
 * above it the data does. This is the whole cold-start mechanism: no branch
 * anywhere asks "do we have enough data yet", the weight just answers it.
 */
export function blendedPairScore({ priorScore = 0, dataScore = 0, pairCount = 0, K = 20 } = {}) {
  const w = pairCount / (pairCount + K);
  return w * dataScore + (1 - w) * priorScore;
}

// ---------------------------------------------------------------------------
// The model: a compact, precomputed table of each item's best partners
// ---------------------------------------------------------------------------
//
// Built periodically (scripts/build-rec-models.mjs), not on every page load —
// mining every order to score every pair is batch work, not something a
// diner's browser should redo on each render. What ships to the browser is
// this small per-item shortlist, plain-object shaped so it is directly
// Firestore-document-safe (no Map, no Set).

export function buildRecModel({ orders = [], menuItems = [], lambda = 20, K = 20, topNPerItem = 8 } = {}) {
  const baskets = basketsFrom(orders, menuItems);
  const { singleCounts, pairCounts, basketCount } = coOccurrenceCounts(baskets);
  const byId = Object.fromEntries(menuItems.map((m) => [m.id, m]));

  const partners = {};
  for (const key of Object.keys(pairCounts)) {
    const [a, b] = key.split("::");
    const itemA = byId[a];
    const itemB = byId[b];
    // A pair once ordered together where one side has since left the menu —
    // nothing to recommend into, so it contributes nothing to the model.
    if (!itemA || !itemB) continue;

    const pairCount = pairCounts[key];
    const dataScore = shrunkSimilarity(singleCounts[a], singleCounts[b], pairCount, lambda);
    const priorScore = itemPriorScore(itemA, itemB);
    const score = blendedPairScore({ priorScore, dataScore, pairCount, K });

    (partners[a] ??= []).push({ itemId: b, score });
    (partners[b] ??= []).push({ itemId: a, score });
  }

  for (const id of Object.keys(partners)) {
    partners[id] = partners[id].sort((x, y) => y.score - x.score).slice(0, topNPerItem);
  }

  return { builtAt: Date.now(), orderCount: basketCount, partners };
}

// ---------------------------------------------------------------------------
// Scoring a cart
// ---------------------------------------------------------------------------

/**
 * What to suggest adding, given what is already in the cart.
 *
 * Two sources, used together: the precomputed model for pairs it has learned
 * about, and a live prior for everything else — a new item on the menu, or an
 * outlet with no model yet at all, still gets a sensible suggestion rather
 * than none, because the prior needs no precomputation.
 *
 * Ranked by score × price: an expected-contribution proxy, not a raw
 * likelihood. A menu item carries no cost/margin figure yet, so price is the
 * best stand-in available — true margin would sharpen this further later.
 */
export function recommendationsFor({ cartItemIds = [], model = null, menuItems = [], limit = 2 } = {}) {
  const inCart = new Set(cartItemIds);
  const byId = Object.fromEntries(menuItems.map((m) => [m.id, m]));
  const cartItems = cartItemIds.map((id) => byId[id]).filter(Boolean);
  if (cartItems.length === 0) return [];

  const bestScore = new Map();
  const isCandidate = (item) => item && !inCart.has(item.id) && item.available !== false;

  for (const cartItem of cartItems) {
    for (const { itemId, score } of model?.partners?.[cartItem.id] || []) {
      const candidate = byId[itemId];
      if (!isCandidate(candidate)) continue;
      bestScore.set(itemId, Math.max(bestScore.get(itemId) || 0, score));
    }
  }

  // Gap-fill with the live prior for anything the model has not scored —
  // covers both "no model yet" and "this item is on the menu but the model
  // has never seen it paired with anything," e.g. a dish added today.
  for (const candidate of menuItems) {
    if (!isCandidate(candidate) || bestScore.has(candidate.id)) continue;
    let best = 0;
    for (const cartItem of cartItems) best = Math.max(best, itemPriorScore(cartItem, candidate));
    if (best > 0) bestScore.set(candidate.id, best);
  }

  return [...bestScore.entries()]
    .map(([itemId, score]) => ({ item: byId[itemId], score }))
    .sort((a, b) => b.score * b.item.price - a.score * a.item.price)
    .slice(0, limit)
    .map((r) => r.item);
}
