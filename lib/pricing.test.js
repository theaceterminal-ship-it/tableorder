import { describe, it, expect } from "vitest";
import {
  computeBogoDiscount,
  computeBundleDiscounts,
  computeBillTotals,
  computeOfferPrice,
  isOfferActiveToday,
  subtotalOf,
  receiptFor,
  authoritativeUnitPrice,
  authoritativeItems,
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

describe("delivery fee on the bill", () => {
  // The fee was quoted to the customer on the checkout screen but never
  // reached the bill, so every delivery was billed short by exactly the fee
  // and the restaurant absorbed it silently.
  const items = [{ itemId: "a", name: "Dal", qty: 2, price: 100 }];

  it("adds the fee to the total", () => {
    const bill = computeBillTotals({ items, menuItems: [], bundleRules: [], deliveryFee: 40 });
    expect(bill.subtotal).toBe(200);
    expect(bill.deliveryFee).toBe(40);
    expect(bill.grandTotal).toBe(240);
  });

  it("changes nothing when there is no fee", () => {
    const bill = computeBillTotals({ items, menuItems: [], bundleRules: [] });
    expect(bill.deliveryFee).toBe(0);
    expect(bill.grandTotal).toBe(200);
  });

  it("does not let the fee move the food tax", () => {
    // Charging tax on delivery would quietly overcharge, and would make the
    // same food cost different amounts depending on how far away someone lives.
    const withFee = computeBillTotals({ items, menuItems: [], bundleRules: [], taxPercent: 5, deliveryFee: 40 });
    const without = computeBillTotals({ items, menuItems: [], bundleRules: [], taxPercent: 5 });
    expect(withFee.taxAmount).toBe(without.taxAmount);
    expect(withFee.grandTotal).toBe(without.grandTotal + 40);
  });

  it("ignores a negative or nonsense fee", () => {
    for (const bad of [-50, null, undefined, "abc"]) {
      expect(computeBillTotals({ items, menuItems: [], bundleRules: [], deliveryFee: bad }).deliveryFee).toBe(0);
    }
  });
});

describe("receiptFor — what a customer sees of their own order", () => {
  const items = [{ itemId: "dal", name: "Dal Makhani", qty: 2, price: 100 }];

  it("estimates from the current menu before the order is billed", () => {
    const r = receiptFor({ items, deliveryFee: 40 }, { menuItems: [], bundleRules: [] });
    expect(r.isFinal).toBe(false);
    expect(r.subtotal).toBe(200);
    expect(r.deliveryFee).toBe(40);
    expect(r.total).toBe(240);
    // Tax and service are only decided at billing time — showing a guess here
    // would be a number the customer was never actually charged.
    expect(r.taxAmount).toBe(0);
  });

  it("reflects a bundle discount in the estimate", () => {
    const menuItems = [{ id: "dal", name: "Dal Makhani", price: 100, bogoEnabled: true }];
    const r = receiptFor({ items: [{ itemId: "dal", name: "Dal Makhani", qty: 2, price: 100 }] }, { menuItems, bundleRules: [] });
    expect(r.discountTotal).toBeGreaterThan(0);
    expect(r.total).toBe(200 - r.discountTotal);
  });

  it("uses the stored final figures once billed, not a recomputation", () => {
    // Reception may have adjusted the order before billing, and tax/service
    // are only known at that point. Recomputing here could show a number
    // that no longer matches what the customer was actually charged.
    const order = {
      items, deliveryFee: 999, // stale — must be ignored once billed
      billId: "b1",
      billSubtotal: 200, billDiscounts: [{ name: "Happy Hour", amount: 20 }],
      billDiscountTotal: 20, billTaxPercent: 5, billTaxAmount: 9,
      billServicePercent: 0, billServiceAmount: 0,
      billDeliveryFee: 40, billTotal: 229,
    };
    const r = receiptFor(order, { menuItems: [], bundleRules: [] });
    expect(r.isFinal).toBe(true);
    expect(r.discounts).toEqual([{ name: "Happy Hour", amount: 20 }]);
    expect(r.deliveryFee).toBe(40);
    expect(r.taxAmount).toBe(9);
    expect(r.total).toBe(229);
  });

  it("handles an order with nothing on it yet", () => {
    const r = receiptFor(null, { menuItems: [], bundleRules: [] });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe("authoritativeUnitPrice — closing the price-tampering hole", () => {
  const menuItems = [
    {
      id: "burger", name: "Cheese Burger", price: 200,
      variations: [{ id: "reg", name: "Regular", price: 200 }, { id: "large", name: "Large", price: 280 }],
      addons: [{ id: "extra-cheese", name: "Extra Cheese", price: 40 }, { id: "bacon", name: "Bacon", price: 60 }],
    },
    { id: "naan", name: "Butter Naan", price: 60 },
  ];

  it("this is the actual exploit: a tampered price is ignored, the real menu price wins", () => {
    // The order was written by whoever's phone pointed at the QR code — there
    // is no login to check it against, so a diner's client could submit any
    // number here. ₹420 Butter Chicken submitted as ₹1 is exactly this shape.
    const line = { itemId: "naan", price: 1, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(60);
  });

  it("trusts a genuinely correct submitted price too — this is not about distrust, only about verifying", () => {
    const line = { itemId: "naan", price: 60, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(60);
  });

  it("prices a real variation correctly, not the base item price", () => {
    const line = { itemId: "burger", variationId: "large", price: 280, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(280);
  });

  it("does not let a fabricated variationId claim an arbitrary price", () => {
    // A diner submitting a variationId that does not exist on this item
    // should not be able to smuggle a number in through it — falls back to
    // the item's own price rather than trusting anything about the claim.
    const line = { itemId: "burger", variationId: "does-not-exist", price: 1, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(200);
  });

  it("adds real add-ons correctly", () => {
    const line = { itemId: "burger", variationId: "reg", addonIds: ["extra-cheese", "bacon"], price: 999, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(200 + 40 + 60);
  });

  it("silently ignores a fabricated add-on id rather than charging for something that does not exist", () => {
    const line = { itemId: "burger", addonIds: ["extra-cheese", "free-lambo"], price: 999, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(200 + 40);
  });

  it("falls back to the submitted price only when the item itself no longer exists on the menu", () => {
    // The one case with nothing real left to check against — a menu item
    // deleted after the order was placed. Not exploitable as a normal attack
    // path since it requires staff to have removed the item first.
    const line = { itemId: "long-gone", price: 150, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems })).toBe(150);
  });

  it("falls back to zero, not undefined, when even the submitted price is missing", () => {
    expect(authoritativeUnitPrice({ line: { itemId: "long-gone" }, menuItems })).toBe(0);
  });

  it("applies a genuinely active offer for this item — a diner can benefit from a real discount", () => {
    const offerBanners = [{ linkedItemId: "naan", discountPercent: 50, days: [] }];
    const line = { itemId: "naan", price: 60, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems, offerBanners })).toBe(30);
  });

  it("never applies a discount just because the order claims one — it must be a real, currently active offer", () => {
    // No offer configured at all: a diner submitting a suspiciously low price
    // gets corrected to the real price, not granted a discount because they
    // asked nicely.
    const line = { itemId: "naan", price: 1, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems, offerBanners: [] })).toBe(60);
  });

  it("ignores an offer that targets a different item", () => {
    const offerBanners = [{ linkedItemId: "burger", discountPercent: 90, days: [] }];
    const line = { itemId: "naan", price: 1, qty: 1 };
    expect(authoritativeUnitPrice({ line, menuItems, offerBanners })).toBe(60);
  });

  it("ignores an offer that is not active today", () => {
    const notToday = { linkedItemId: "naan", discountPercent: 50, days: ["mon"] };
    const line = { itemId: "naan", price: 60, qty: 1 };
    // A Wednesday, deliberately not in the offer's days list.
    expect(authoritativeUnitPrice({ line, menuItems, offerBanners: [notToday], now: new Date(2026, 8, 2) })).toBe(60);
  });

  it("applies an offer on top of a variation and add-ons together", () => {
    const offerBanners = [{ linkedItemId: "burger", discountPercent: 10, days: [] }];
    const line = { itemId: "burger", variationId: "large", addonIds: ["bacon"], price: 1, qty: 1 };
    // (280 + 60) * 0.9 = 306
    expect(authoritativeUnitPrice({ line, menuItems, offerBanners })).toBe(306);
  });
});

describe("authoritativeItems", () => {
  const menuItems = [{ id: "dal", name: "Dal Makhani", price: 320 }, { id: "naan", name: "Butter Naan", price: 60 }];

  it("reprices every line, preserving everything else about it", () => {
    const items = [
      { itemId: "dal", name: "Dal Makhani", qty: 2, price: 1, notes: "less spicy" },
      { itemId: "naan", name: "Butter Naan", qty: 3, price: 999 },
    ];
    const fixed = authoritativeItems({ items, menuItems });
    expect(fixed).toEqual([
      { itemId: "dal", name: "Dal Makhani", qty: 2, price: 320, notes: "less spicy" },
      { itemId: "naan", name: "Butter Naan", qty: 3, price: 60 },
    ]);
  });

  it("handles an empty order", () => {
    expect(authoritativeItems({ items: [], menuItems })).toEqual([]);
  });
});

describe("the tampering exploit closed end to end, through computeBillTotals", () => {
  const menuItems = [{ id: "chicken", name: "Butter Chicken", price: 420 }];

  it("a bill generated from a tampered order charges the real price, not the submitted one", () => {
    // This is the actual attack: submit an order for a ₹420 dish at ₹1.
    const tamperedOrder = [{ itemId: "chicken", name: "Butter Chicken", qty: 1, price: 1 }];
    const realItems = authoritativeItems({ items: tamperedOrder, menuItems });
    const bill = computeBillTotals({ items: realItems, menuItems, bundleRules: [] });
    expect(bill.grandTotal).toBe(420);
  });
});
