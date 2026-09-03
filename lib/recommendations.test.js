import { describe, it, expect } from "vitest";
import {
  menuCategoryType, itemPriorScore, coOccurrenceCounts, shrunkSimilarity,
  blendedPairScore, buildRecModel, recommendationsFor,
} from "./recommendations";

// The real category names from sample-master-menu.csv — the classifier has to
// work for these without anyone hand-typing a rule per restaurant.
describe("menuCategoryType", () => {
  it("classifies every category in the sample menu", () => {
    expect(menuCategoryType("Starters")).toBe("STARTER");
    expect(menuCategoryType("Soups")).toBe("SOUP");
    expect(menuCategoryType("Mains")).toBe("MAIN");
    expect(menuCategoryType("Biryani")).toBe("MAIN");
    expect(menuCategoryType("Breads & Rice")).toBe("BREAD");
    expect(menuCategoryType("Sides")).toBe("SIDE");
    expect(menuCategoryType("Beverages")).toBe("BEVERAGE");
    expect(menuCategoryType("Desserts")).toBe("DESSERT");
    expect(menuCategoryType("Combo Packs")).toBe("COMBO");
  });

  it("is case-insensitive", () => {
    expect(menuCategoryType("BEVERAGES")).toBe("BEVERAGE");
    expect(menuCategoryType("mains")).toBe("MAIN");
  });

  it("falls back to OTHER for a name it cannot place, rather than guessing", () => {
    expect(menuCategoryType("Chef's Picks")).toBe("OTHER");
    expect(menuCategoryType("")).toBe("OTHER");
    expect(menuCategoryType(undefined)).toBe("OTHER");
  });
});

describe("itemPriorScore", () => {
  const dal = { id: "dal", category: "Mains" };
  const naan = { id: "naan", category: "Breads & Rice" };
  const cola = { id: "cola", category: "Beverages" };
  const gulab = { id: "gulab", category: "Desserts" };
  const thali = { id: "thali", category: "Combo Packs" };

  it("scores the classic curry-and-bread pairing highest", () => {
    const mainBread = itemPriorScore(dal, naan);
    expect(mainBread).toBeGreaterThan(itemPriorScore(dal, cola));
    expect(mainBread).toBeGreaterThan(itemPriorScore(dal, gulab));
  });

  it("is symmetric — order of the two items never matters", () => {
    expect(itemPriorScore(dal, naan)).toBe(itemPriorScore(naan, dal));
  });

  it("never recommends an item next to itself", () => {
    expect(itemPriorScore(dal, dal)).toBe(0);
  });

  it("suppresses a combo against everything, since it is already a full meal", () => {
    expect(itemPriorScore(thali, dal)).toBeLessThan(itemPriorScore(dal, naan));
    expect(itemPriorScore(thali, naan)).toBeLessThan(0.2);
  });

  it("handles a missing item gracefully", () => {
    expect(itemPriorScore(null, naan)).toBe(0);
    expect(itemPriorScore(dal, undefined)).toBe(0);
  });
});

describe("coOccurrenceCounts", () => {
  it("counts each item and each pair once per basket", () => {
    const { singleCounts, pairCounts, basketCount } = coOccurrenceCounts([
      ["dal", "naan"],
      ["dal", "naan"],
      ["dal", "rice"],
    ]);
    expect(singleCounts).toEqual({ dal: 3, naan: 2, rice: 1 });
    expect(pairCounts["dal::naan"]).toBe(2);
    expect(pairCounts["dal::rice"]).toBe(1);
    expect(basketCount).toBe(3);
  });

  it("de-duplicates repeats of the same item within one basket", () => {
    // Two portions of naan in one order is not two independent co-occurrences.
    const { singleCounts } = coOccurrenceCounts([["naan", "naan", "dal"]]);
    expect(singleCounts.naan).toBe(1);
  });

  it("keys a pair the same way regardless of item order", () => {
    const a = coOccurrenceCounts([["dal", "naan"]]).pairCounts;
    const b = coOccurrenceCounts([["naan", "dal"]]).pairCounts;
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });

  it("handles no baskets at all", () => {
    expect(coOccurrenceCounts([])).toEqual({ singleCounts: {}, pairCounts: {}, basketCount: 0 });
    expect(coOccurrenceCounts(undefined).basketCount).toBe(0);
  });
});

describe("shrunkSimilarity", () => {
  it("shrinks a pair seen only once each toward zero, not toward a perfect score", () => {
    // Raw cosine similarity here would be 1/sqrt(1*1) = 1.0 — a single
    // coincidence should not read as a proven pairing.
    expect(shrunkSimilarity(1, 1, 1)).toBeLessThan(0.1);
  });

  it("rises toward the raw similarity as counts grow", () => {
    const small = shrunkSimilarity(5, 5, 3);
    const large = shrunkSimilarity(500, 500, 300);
    expect(large).toBeGreaterThan(small);
  });

  it("is zero when the pair never actually co-occurred", () => {
    expect(shrunkSimilarity(50, 50, 0)).toBe(0);
  });

  it("is zero if either single count is zero (cannot happen, but must not divide oddly)", () => {
    expect(shrunkSimilarity(0, 10, 0)).toBe(0);
  });
});

describe("blendedPairScore", () => {
  it("is exactly the prior when the pair has never co-occurred", () => {
    // This is the entire cold-start mechanism: no orders yet, so the weight
    // on real data is zero and the prior alone decides.
    expect(blendedPairScore({ priorScore: 0.7, dataScore: 0.9, pairCount: 0 })).toBe(0.7);
  });

  it("leans toward the data score as the pair count grows past K", () => {
    const withFewOrders = blendedPairScore({ priorScore: 0.2, dataScore: 0.9, pairCount: 2, K: 20 });
    const withManyOrders = blendedPairScore({ priorScore: 0.2, dataScore: 0.9, pairCount: 200, K: 20 });
    expect(withManyOrders).toBeGreaterThan(withFewOrders);
    // Not equal to the raw data score — the prior never fully disappears,
    // it just keeps shrinking — but the bulk of the weight has shifted to it.
    expect(withManyOrders).toBeGreaterThan(0.8);
  });

  it("splits the difference evenly when pairCount equals K", () => {
    expect(blendedPairScore({ priorScore: 0.2, dataScore: 0.8, pairCount: 20, K: 20 })).toBeCloseTo(0.5, 5);
  });
});

describe("buildRecModel", () => {
  const menuItems = [
    { id: "dal", name: "Dal Makhani", category: "Mains", price: 300, available: true },
    { id: "naan", name: "Butter Naan", category: "Breads & Rice", price: 60, available: true },
    { id: "cola", name: "Cola", category: "Beverages", price: 80, available: true },
  ];

  function order(items) {
    return { id: Math.random().toString(), status: "paid", items, createdAt: Date.now() };
  }

  it("learns a real pairing from repeated orders", () => {
    const orders = Array.from({ length: 30 }, () =>
      order([{ itemId: "dal", qty: 1, price: 300 }, { itemId: "naan", qty: 2, price: 60 }]));
    const model = buildRecModel({ orders, menuItems });
    expect(model.orderCount).toBe(30);
    const partners = model.partners.dal.map((p) => p.itemId);
    expect(partners).toContain("naan");
  });

  it("produces an empty model from no orders, without throwing", () => {
    const model = buildRecModel({ orders: [], menuItems });
    expect(model.orderCount).toBe(0);
    expect(model.partners).toEqual({});
  });

  it("ignores a pair where one item has since left the menu", () => {
    const orders = [order([{ itemId: "dal" }, { itemId: "discontinued" }])];
    const model = buildRecModel({ orders, menuItems });
    expect(model.partners.dal || []).toEqual([]);
  });

  it("keeps only the top N partners per item", () => {
    const bigMenu = Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, category: "Mains", price: 100, available: true }));
    const anchor = { id: "anchor", category: "Mains", price: 100, available: true };
    const orders = bigMenu.map((m) => order([{ itemId: "anchor" }, { itemId: m.id }]));
    const model = buildRecModel({ orders, menuItems: [anchor, ...bigMenu], topNPerItem: 5 });
    expect(model.partners.anchor.length).toBe(5);
  });
});

describe("recommendationsFor", () => {
  const dal = { id: "dal", category: "Mains", price: 300, available: true };
  const naan = { id: "naan", category: "Breads & Rice", price: 60, available: true };
  const cola = { id: "cola", category: "Beverages", price: 80, available: true };
  const gulab = { id: "gulab", category: "Desserts", price: 50, available: true };
  const soldOut = { id: "soldout", category: "Breads & Rice", price: 60, available: false };
  const menuItems = [dal, naan, cola, gulab, soldOut];

  it("suggests nothing for an empty cart", () => {
    expect(recommendationsFor({ cartItemIds: [], menuItems })).toEqual([]);
  });

  it("falls back to the category prior with no model at all — true cold start", () => {
    const recs = recommendationsFor({ cartItemIds: ["dal"], model: null, menuItems });
    expect(recs.map((r) => r.id)).toContain("naan");
  });

  it("never suggests something already in the cart", () => {
    const recs = recommendationsFor({ cartItemIds: ["dal", "naan"], menuItems });
    expect(recs.some((r) => r.id === "dal" || r.id === "naan")).toBe(false);
  });

  it("never suggests an unavailable item", () => {
    const recs = recommendationsFor({ cartItemIds: ["dal"], menuItems });
    expect(recs.some((r) => r.id === "soldout")).toBe(false);
  });

  it("respects the limit", () => {
    const recs = recommendationsFor({ cartItemIds: ["dal"], menuItems, limit: 1 });
    expect(recs.length).toBe(1);
  });

  it("prefers the model's learned score over the live prior when both exist", () => {
    // cola has a mediocre prior against dal, but a strong learned score here —
    // the model should win, or at minimum not be ignored in favour of the
    // weaker on-the-fly guess.
    const model = { partners: { dal: [{ itemId: "cola", score: 0.95 }] } };
    const recs = recommendationsFor({ cartItemIds: ["dal"], model, menuItems, limit: 1 });
    expect(recs[0].id).toBe("cola");
  });

  it("ranks by score times price, not score alone", () => {
    // naan: prior ~0.9 but cheap (60). gulab: lower prior (~0.5) but pricier.
    // Rig prices so the cheap-but-strong item and the pricey-but-weaker item
    // trade places under a pure-score ranking versus a score*price ranking.
    const pricedGulab = { ...gulab, price: 2000 };
    const recs = recommendationsFor({ cartItemIds: ["dal"], menuItems: [dal, naan, pricedGulab], limit: 1 });
    expect(recs[0].id).toBe("gulab");
  });

  it("fills gaps from the prior even when a model exists but has not seen this item", () => {
    const model = { partners: { dal: [] } }; // a real model, just with nothing learned yet
    const recs = recommendationsFor({ cartItemIds: ["dal"], model, menuItems });
    expect(recs.length).toBeGreaterThan(0);
  });

  it("combines signal across multiple cart items by taking the best", () => {
    const recs = recommendationsFor({ cartItemIds: ["dal", "cola"], menuItems, limit: 3 });
    expect(recs.length).toBeGreaterThan(0);
  });
});
