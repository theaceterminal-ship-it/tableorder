import { describe, it, expect } from "vitest";
import {
  posLineKey, itemHasOptions, priceLine, addLine, adjustLineQty,
  cartLines, cartSubtotal, qtyForItem, plainQtyForItem, estimatedEta,
} from "./pos-cart";

const BURGER = {
  id: "burger", name: "Burger", price: 200, etaMinutes: 12,
  variations: [{ id: "v_l", name: "Large", price: 280 }],
  addons: [{ id: "a_cheese", name: "Cheese", price: 40 }, { id: "a_bacon", name: "Bacon", price: 60 }],
};
const NAAN = { id: "naan", name: "Butter Naan", price: 60, etaMinutes: 6 };
const BIRYANI = { id: "biryani", name: "Biryani", price: 400, etaMinutes: 35 };
const MENU = [BURGER, NAAN, BIRYANI];

describe("posLineKey", () => {
  it("sorts add-ons, so pick order does not create a duplicate line", () => {
    expect(posLineKey("burger", null, ["a_cheese", "a_bacon"]))
      .toBe(posLineKey("burger", null, ["a_bacon", "a_cheese"]));
  });

  it("keeps different variations apart", () => {
    expect(posLineKey("burger", "v_l", [])).not.toBe(posLineKey("burger", null, []));
  });
});

describe("itemHasOptions", () => {
  it("is true only when there is something to choose", () => {
    expect(itemHasOptions(BURGER)).toBe(true);
    expect(itemHasOptions(NAAN)).toBe(false);
    expect(itemHasOptions({})).toBe(false);
  });
});

describe("priceLine", () => {
  it("uses the base price when nothing is chosen", () => {
    expect(priceLine(BURGER, null, [])).toMatchObject({ price: 200, name: "Burger" });
  });

  it("REPLACES the base price with the variation's, rather than adding to it", () => {
    // A large burger costs 280, not 200 + 280.
    expect(priceLine(BURGER, "v_l", []).price).toBe(280);
  });

  it("adds add-ons on top of whichever base applies", () => {
    expect(priceLine(BURGER, null, ["a_cheese"]).price).toBe(240);
    expect(priceLine(BURGER, "v_l", ["a_cheese", "a_bacon"]).price).toBe(380);
  });

  it("labels the line with what was chosen", () => {
    expect(priceLine(BURGER, "v_l", ["a_cheese"]).name).toBe("Burger (Large) + Cheese");
  });

  it("ignores add-on ids the item does not have", () => {
    expect(priceLine(BURGER, null, ["a_nonsense"]).price).toBe(200);
  });
});

describe("addLine", () => {
  it("merges a repeat tap into one line", () => {
    let cart = addLine({}, NAAN);
    cart = addLine(cart, NAAN);
    expect(Object.keys(cart)).toHaveLength(1);
    expect(cartLines(cart)[0].qty).toBe(2);
  });

  it("keeps differently customised lines apart", () => {
    let cart = addLine({}, BURGER);
    cart = addLine(cart, BURGER, { variationId: "v_l" });
    expect(Object.keys(cart)).toHaveLength(2);
  });

  it("merges the same add-ons picked in a different order", () => {
    let cart = addLine({}, BURGER, { addonIds: ["a_cheese", "a_bacon"] });
    cart = addLine(cart, BURGER, { addonIds: ["a_bacon", "a_cheese"] });
    expect(Object.keys(cart)).toHaveLength(1);
    expect(cartLines(cart)[0].qty).toBe(2);
  });

  it("does not mutate the cart it was given", () => {
    const cart = addLine({}, NAAN);
    addLine(cart, NAAN);
    expect(cartLines(cart)[0].qty).toBe(1);
  });
});

describe("adjustLineQty", () => {
  it("removes the line at zero rather than leaving a 0x row", () => {
    const cart = addLine({}, NAAN);
    const key = Object.keys(cart)[0];
    expect(Object.keys(adjustLineQty(cart, key, -1))).toHaveLength(0);
  });

  it("never goes negative", () => {
    const cart = addLine({}, NAAN);
    const key = Object.keys(cart)[0];
    expect(Object.keys(adjustLineQty(cart, key, -5))).toHaveLength(0);
  });

  it("ignores a key that is not in the cart", () => {
    const cart = addLine({}, NAAN);
    expect(adjustLineQty(cart, "nope", 1)).toBe(cart);
  });
});

describe("totals", () => {
  it("multiplies price by quantity across lines", () => {
    let cart = addLine({}, NAAN, { qty: 3 });          // 180
    cart = addLine(cart, BURGER, { variationId: "v_l" }); // 280
    expect(cartSubtotal(cart)).toBe(460);
  });

  it("counts every unit of an item however it was customised", () => {
    let cart = addLine({}, BURGER, { qty: 2 });
    cart = addLine(cart, BURGER, { variationId: "v_l" });
    expect(qtyForItem(cart, "burger")).toBe(3);
    expect(plainQtyForItem(cart, "burger")).toBe(2);
  });

  it("is zero for an empty cart", () => {
    expect(cartSubtotal({})).toBe(0);
    expect(qtyForItem({}, "burger")).toBe(0);
  });
});

describe("estimatedEta", () => {
  it("takes the longest prep time, not the sum, because a kitchen cooks in parallel", () => {
    const lines = [{ itemId: "naan" }, { itemId: "biryani" }, { itemId: "burger" }];
    expect(estimatedEta(lines, MENU)).toBe(35);
  });

  it("treats the fallback as a FLOOR, not merely a default", () => {
    // A basket of quick items still quotes at least the minimum: an order takes
    // time to reach the pass even when nothing on it is slow.
    expect(estimatedEta([{ itemId: "naan" }], MENU, 15)).toBe(15); // naan is 6
  });

  it("falls back when nothing has a prep time", () => {
    expect(estimatedEta([{ itemId: "unknown" }], MENU, 15)).toBe(15);
    expect(estimatedEta([], MENU, 15)).toBe(15);
  });

  it("matches legacy lines by name when they carry no itemId", () => {
    expect(estimatedEta([{ name: "Biryani" }], MENU, 15)).toBe(35);
  });
});
