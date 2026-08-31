import { describe, it, expect } from "vitest";
import {
  computeBogoDiscount,
  computeBundleDiscounts,
  computeBillTotals,
  computeOfferPrice,
  isOfferActiveToday,
  subtotalOf,
} from "./pricing";

const MENU = [
  { id: "paneer", name: "Paneer Tikka", category: "Starters", price: 280, bogoEnabled: true },
  { id: "naan", name: "Butter Naan", category: "Breads & Rice", price: 60 },
  { id: "dal", name: "Dal Makhani", category: "Mains", price: 320 },
  { id: "gulab", name: "Gulab Jamun", category: "Desserts", price: 120, bogoEnabled: true },
  { id: "lassi", name: "Sweet Lassi", category: "Beverages", price: 90 },
];

const line = (itemId, qty, price) => ({
  itemId,
  name: MENU.find((m) => m.id === itemId).name,
  qty,
  price: price ?? MENU.find((m) => m.id === itemId).price,
});

describe("subtotalOf", () => {
  it("multiplies price by quantity across lines", () => {
    expect(subtotalOf([line("naan", 3), line("dal", 1)])).toBe(500);
  });

  it("treats an empty cart as zero", () => {
    expect(subtotalOf([])).toBe(0);
    expect(subtotalOf(null)).toBe(0);
  });
});

describe("computeBogoDiscount", () => {
  it("returns nothing for a single BOGO unit", () => {
    expect(computeBogoDiscount([line("paneer", 1)], MENU)).toBeNull();
  });

  it("frees the cheaper unit of a pair", () => {
    // two paneer at 280 -> one is free
    expect(computeBogoDiscount([line("paneer", 2)], MENU).amount).toBe(280);
  });

  it("charges the odd unit left over", () => {
    // three paneer -> one free, two charged
    expect(computeBogoDiscount([line("paneer", 3)], MENU).amount).toBe(280);
  });

  it("pairs across different BOGO items, always freeing the cheaper of each pair", () => {
    // units sorted desc: 280, 280, 120, 120 -> free index 1 and 3 = 280 + 120
    const discount = computeBogoDiscount([line("paneer", 2), line("gulab", 2)], MENU);
    expect(discount.amount).toBe(400);
  });

  it("never frees a unit of an item that is not BOGO-enabled", () => {
    expect(computeBogoDiscount([line("naan", 4)], MENU)).toBeNull();
  });

  it("uses the line's actual price, not the menu price, so variations are honoured", () => {
    // a half-portion paneer line priced at 160, two of them
    expect(computeBogoDiscount([line("paneer", 2, 160)], MENU).amount).toBe(160);
  });

  it("resolves items by name for legacy lines that carry no itemId", () => {
    const legacy = [{ name: "Paneer Tikka", qty: 2, price: 280 }];
    expect(computeBogoDiscount(legacy, MENU).amount).toBe(280);
  });

  it("resolves a composed variation name back to its menu item", () => {
    const legacy = [{ name: "Paneer Tikka — Half", qty: 2, price: 160 }];
    expect(computeBogoDiscount(legacy, MENU).amount).toBe(160);
  });
});

describe("computeBundleDiscounts", () => {
  it("applies a flat pair discount only when both items are present", () => {
    const rules = [{
      active: true, type: "pairDiscount", name: "Dal + Naan",
      requiredItems: ["dal", "naan"], discountType: "flat", discountValue: 50,
    }];
    expect(computeBundleDiscounts([line("dal", 1), line("naan", 1)], MENU, rules))
      .toEqual([{ name: "Dal + Naan", amount: 50 }]);
    expect(computeBundleDiscounts([line("dal", 1)], MENU, rules)).toEqual([]);
  });

  it("takes a percent pair discount off the cheaper required item", () => {
    const rules = [{
      active: true, type: "pairDiscount", name: "Combo",
      requiredItems: ["dal", "naan"], discountType: "percent", discountValue: 50,
    }];
    // cheaper of (320, 60) is 60 -> 50% = 30
    expect(computeBundleDiscounts([line("dal", 1), line("naan", 1)], MENU, rules)[0].amount).toBe(30);
  });

  it("ignores inactive rules", () => {
    const rules = [{
      active: false, type: "pairDiscount", name: "Off",
      requiredItems: ["dal", "naan"], discountType: "flat", discountValue: 50,
    }];
    expect(computeBundleDiscounts([line("dal", 1), line("naan", 1)], MENU, rules)).toEqual([]);
  });

  it("gives a free item once the spend threshold is met", () => {
    const rules = [{
      active: true, type: "thresholdFreeItem", name: "Big spender",
      threshold: 500, freeItemId: "gulab",
    }];
    expect(computeBundleDiscounts([line("dal", 2)], MENU, rules)[0])
      .toEqual({ name: "Big spender (Free Gulab Jamun)", amount: 120 });
    expect(computeBundleDiscounts([line("naan", 1)], MENU, rules)).toEqual([]);
  });

  it("discounts only the qualifying categories in a category bundle", () => {
    const rules = [{
      active: true, type: "categoryBundle", name: "Meal deal",
      requiredCategories: ["Mains", "Breads & Rice"], discountType: "percent", discountValue: 10,
    }];
    // qualifying subtotal is dal 320 + naan 60 = 380; the lassi is excluded
    const items = [line("dal", 1), line("naan", 1), line("lassi", 1)];
    expect(computeBundleDiscounts(items, MENU, rules)[0].amount).toBe(38);
  });

  it("stacks BOGO ahead of configured rules", () => {
    const rules = [{
      active: true, type: "thresholdFreeItem", name: "Big spender",
      threshold: 500, freeItemId: "lassi",
    }];
    const discounts = computeBundleDiscounts([line("paneer", 2)], MENU, rules);
    expect(discounts.map((d) => d.amount)).toEqual([280, 90]);
    expect(discounts[0].name).toContain("Buy 1 Get 1 Free");
  });

  it("survives a missing rules array", () => {
    expect(computeBundleDiscounts([line("dal", 1)], MENU, null)).toEqual([]);
  });

  // Documents existing behaviour rather than endorsing it: a threshold of 0 is
  // falsy, so a "free item on any order" rule silently does nothing. Reception
  // has no way to express that today — worth revisiting when the rule builder
  // is rebuilt, but changing it here would alter live bills.
  it("treats a zero threshold as a disabled rule", () => {
    const rules = [{
      active: true, type: "thresholdFreeItem", name: "Always free",
      threshold: 0, freeItemId: "gulab",
    }];
    expect(computeBundleDiscounts([line("dal", 1)], MENU, rules)).toEqual([]);
  });
});

describe("computeBillTotals", () => {
  it("charges tax and service on the discounted subtotal, not the gross", () => {
    const rules = [{
      active: true, type: "pairDiscount", name: "Dal + Naan",
      requiredItems: ["dal", "naan"], discountType: "flat", discountValue: 50,
    }];
    const bill = computeBillTotals({
      items: [line("dal", 1), line("naan", 1)],
      menuItems: MENU, bundleRules: rules, taxPercent: 5, servicePercent: 10,
    });
    expect(bill.subtotal).toBe(380);
    expect(bill.discountTotal).toBe(50);
    expect(bill.discountedSubtotal).toBe(330);
    expect(bill.taxAmount).toBe(17);      // round(330 * 0.05) = 16.5 -> 17
    expect(bill.serviceAmount).toBe(33);
    expect(bill.grandTotal).toBe(380);
  });

  it("never lets discounts push the bill below zero", () => {
    // one ₹60 naan qualifies for a free ₹320 dal — the discount exceeds the bill
    const rules = [{
      active: true, type: "thresholdFreeItem", name: "Freebie",
      threshold: 50, freeItemId: "dal",
    }];
    const bill = computeBillTotals({
      items: [line("naan", 1)], menuItems: MENU, bundleRules: rules,
      taxPercent: 5, servicePercent: 5,
    });
    expect(bill.discountTotal).toBe(320);
    expect(bill.discountedSubtotal).toBe(0);
    expect(bill.grandTotal).toBe(0);
  });

  it("defaults tax and service to zero when unset", () => {
    const bill = computeBillTotals({ items: [line("dal", 1)], menuItems: MENU, bundleRules: [] });
    expect(bill.grandTotal).toBe(320);
  });
});

describe("offer banners", () => {
  const monday = new Date("2026-08-24T12:00:00");  // a Monday
  const tuesday = new Date("2026-08-25T12:00:00");

  it("is active every day when no days are chosen", () => {
    expect(isOfferActiveToday({ days: [] }, monday)).toBe(true);
    expect(isOfferActiveToday({}, monday)).toBe(true);
  });

  it("honours the chosen days", () => {
    expect(isOfferActiveToday({ days: ["mon"] }, monday)).toBe(true);
    expect(isOfferActiveToday({ days: ["mon"] }, tuesday)).toBe(false);
  });

  it("returns no price when the offer is not running today", () => {
    const banner = { discountPercent: 20, days: ["mon"] };
    expect(computeOfferPrice(banner, MENU[2], tuesday)).toBeNull();
  });

  it("rounds the discounted price", () => {
    const banner = { discountPercent: 15, days: ["mon"] };
    // 320 * 0.85 = 272
    expect(computeOfferPrice(banner, MENU[2], monday)).toBe(272);
  });

  it("returns no price without a discount", () => {
    expect(computeOfferPrice({ discountPercent: 0 }, MENU[2], monday)).toBeNull();
    expect(computeOfferPrice({}, MENU[2], monday)).toBeNull();
  });
});
