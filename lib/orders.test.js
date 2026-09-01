import { describe, it, expect } from "vitest";
import {
  nameCandidates,
  resolveItemId,
  withItemIds,
  mergeItemLines,
  revenueOrders,
  sumRevenue,
  soldQtyByItem,
  basketsFrom,
  collapseBillSiblings,
  isToday,
  startOfDay,
  filterRangeStart,
} from "./orders";

const MENU = [
  { id: "paneer", name: "Paneer Tikka", price: 280 },
  { id: "naan", name: "Butter Naan", price: 60 },
  { id: "dal", name: "Dal Makhani", price: 320 },
  { id: "c65", name: "Chicken 65 (Boneless)", price: 340 },
];

describe("nameCandidates", () => {
  it("keeps a plain name as the only candidate", () => {
    expect(nameCandidates("Butter Naan")).toEqual(["Butter Naan"]);
  });

  it("peels a table-side variation suffix", () => {
    expect(nameCandidates("Paneer Tikka — Half")).toEqual(["Paneer Tikka — Half", "Paneer Tikka"]);
  });

  it("peels POS add-ons then the variation", () => {
    expect(nameCandidates("Burger (Large) + Cheese, Bacon"))
      .toEqual(["Burger (Large) + Cheese, Bacon", "Burger (Large)", "Burger"]);
  });

  it("returns nothing for an empty name", () => {
    expect(nameCandidates("")).toEqual([]);
    expect(nameCandidates(undefined)).toEqual([]);
  });
});

describe("resolveItemId", () => {
  it("passes an existing itemId straight through", () => {
    expect(resolveItemId({ itemId: "dal", name: "anything" }, MENU)).toBe("dal");
  });

  it("resolves a legacy line by exact name", () => {
    expect(resolveItemId({ name: "Dal Makhani" }, MENU)).toBe("dal");
  });

  it("resolves a legacy line carrying a variation suffix", () => {
    expect(resolveItemId({ name: "Paneer Tikka — Half" }, MENU)).toBe("paneer");
  });

  it("prefers an exact match over peeling, so a dish with brackets in its real name survives", () => {
    expect(resolveItemId({ name: "Chicken 65 (Boneless)" }, MENU)).toBe("c65");
  });

  it("refuses to guess when two menu items share a name", () => {
    const ambiguous = [{ id: "a", name: "Special" }, { id: "b", name: "Special" }];
    expect(resolveItemId({ name: "Special" }, ambiguous)).toBeNull();
  });

  it("returns null for a dish that is no longer on the menu", () => {
    expect(resolveItemId({ name: "Discontinued Thing" }, MENU)).toBeNull();
  });

  it("returns null with no menu to match against", () => {
    expect(resolveItemId({ name: "Dal Makhani" }, [])).toBeNull();
  });
});

describe("withItemIds", () => {
  it("fills in missing ids and leaves present ones alone", () => {
    const items = [{ name: "Butter Naan", qty: 2, price: 60 }, { itemId: "dal", name: "renamed", qty: 1, price: 320 }];
    expect(withItemIds(items, MENU).map((i) => i.itemId)).toEqual(["naan", "dal"]);
  });
});

describe("mergeItemLines", () => {
  it("merges lines of the same item at the same price", () => {
    const merged = mergeItemLines([
      { itemId: "naan", name: "Butter Naan", qty: 2, price: 60 },
      { itemId: "naan", name: "Butter Naan", qty: 3, price: 60 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].qty).toBe(5);
  });

  it("keeps lines of the same item at different prices apart", () => {
    const merged = mergeItemLines([
      { itemId: "paneer", name: "Paneer Tikka", qty: 1, price: 280 },
      { itemId: "paneer", name: "Paneer Tikka — Half", qty: 1, price: 160 },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps lines with different notes apart", () => {
    const merged = mergeItemLines([
      { itemId: "dal", name: "Dal Makhani", qty: 1, price: 320, notes: "no cream" },
      { itemId: "dal", name: "Dal Makhani", qty: 1, price: 320, notes: "" },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const input = [{ itemId: "naan", name: "Butter Naan", qty: 2, price: 60 }];
    mergeItemLines([...input, { itemId: "naan", name: "Butter Naan", qty: 1, price: 60 }]);
    expect(input[0].qty).toBe(2);
  });
});

describe("revenueOrders — merged-table de-duplication", () => {
  const items = [{ itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 }];

  it("ignores orders that are not billed or paid", () => {
    const orders = [
      { id: "1", status: "pending", billTotal: 500, items },
      { id: "2", status: "served", billTotal: 500, items },
      { id: "3", status: "billed", billTotal: 500, items },
      { id: "4", status: "paid", billTotal: 300, items },
    ];
    expect(revenueOrders(orders).map((o) => o.id)).toEqual(["3", "4"]);
  });

  it("counts a merged bill once when siblings are flagged", () => {
    const orders = [
      { id: "a", status: "billed", billTotal: 3000, isBillPrimary: true, mergedTables: [1, 2, 3], items },
      { id: "b", status: "billed", billTotal: 3000, isBillPrimary: false, mergedTables: [1, 2, 3], items },
      { id: "c", status: "billed", billTotal: 3000, isBillPrimary: false, mergedTables: [1, 2, 3], items },
    ];
    expect(sumRevenue(orders)).toBe(3000);
  });

  it("counts a legacy merged bill once, using its signature", () => {
    const day = new Date("2026-08-20T13:00:00").getTime();
    const orders = [
      { id: "a", status: "billed", billTotal: 3000, billSubtotal: 2800, mergedTables: [1, 2, 3], table: 1, createdAt: day, items },
      { id: "b", status: "billed", billTotal: 3000, billSubtotal: 2800, mergedTables: [1, 2, 3], table: 2, createdAt: day + 60000, items },
      { id: "c", status: "billed", billTotal: 3000, billSubtotal: 2800, mergedTables: [1, 2, 3], table: 3, createdAt: day + 120000, items },
    ];
    expect(sumRevenue(orders)).toBe(3000);
  });

  it("keeps two separate un-merged bills that happen to have the same total", () => {
    const orders = [
      { id: "a", status: "billed", billTotal: 500, table: 4, createdAt: 1, items },
      { id: "b", status: "billed", billTotal: 500, table: 5, createdAt: 2, items },
    ];
    expect(sumRevenue(orders)).toBe(1000);
  });

  it("keeps the same merged group billed on two different days apart", () => {
    const mon = new Date("2026-08-24T13:00:00").getTime();
    const tue = new Date("2026-08-25T13:00:00").getTime();
    const orders = [
      { id: "a", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 1, createdAt: mon, items },
      { id: "b", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 2, createdAt: mon, items },
      { id: "c", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 1, createdAt: tue, items },
      { id: "d", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 2, createdAt: tue, items },
    ];
    expect(sumRevenue(orders)).toBe(1800);
  });

  it("does not de-duplicate a single-table bill that carries a one-element mergedTables", () => {
    const orders = [
      { id: "a", status: "paid", billTotal: 400, mergedTables: [7], table: 7, createdAt: 1, items },
      { id: "b", status: "paid", billTotal: 400, mergedTables: [7], table: 7, createdAt: 2, items },
    ];
    expect(sumRevenue(orders)).toBe(800);
  });
});

describe("soldQtyByItem", () => {
  it("counts a merged bill's items once, not once per table", () => {
    const items = [
      { itemId: "dal", name: "Dal Makhani", qty: 2, price: 320 },
      { itemId: "naan", name: "Butter Naan", qty: 4, price: 60 },
    ];
    const orders = [
      { id: "a", status: "billed", billTotal: 1000, isBillPrimary: true, mergedTables: [1, 2], items },
      { id: "b", status: "billed", billTotal: 1000, isBillPrimary: false, mergedTables: [1, 2], items },
    ];
    expect(soldQtyByItem(orders, MENU)).toEqual({ dal: 2, naan: 4 });
  });

  it("resolves legacy lines by name so variations roll up to one dish", () => {
    const orders = [{
      id: "a", status: "paid", billTotal: 440,
      items: [
        { name: "Paneer Tikka", qty: 1, price: 280 },
        { name: "Paneer Tikka — Half", qty: 1, price: 160 },
      ],
    }];
    expect(soldQtyByItem(orders, MENU)).toEqual({ paneer: 2 });
  });

  it("keeps unresolvable lines under their name rather than dropping them", () => {
    const orders = [{ id: "a", status: "paid", billTotal: 100, items: [{ name: "Mystery Dish", qty: 3, price: 100 }] }];
    expect(soldQtyByItem(orders, MENU)).toEqual({ "Mystery Dish": 3 });
  });
});

describe("basketsFrom", () => {
  it("returns one de-duplicated basket per bill", () => {
    const orders = [{
      id: "a", status: "paid", billTotal: 700,
      items: [
        { itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 },
        { itemId: "naan", name: "Butter Naan", qty: 2, price: 60 },
        { itemId: "naan", name: "Butter Naan", qty: 1, price: 60 },
      ],
    }];
    expect(basketsFrom(orders, MENU)).toEqual([["dal", "naan"]]);
  });

  it("skips baskets with nothing resolvable", () => {
    const orders = [{ id: "a", status: "paid", billTotal: 100, items: [{ name: "Mystery", qty: 1, price: 100 }] }];
    expect(basketsFrom(orders, MENU)).toEqual([]);
  });
});

describe("date helpers", () => {
  it("recognises today and rejects yesterday", () => {
    const now = new Date("2026-08-24T15:00:00").getTime();
    expect(isToday(new Date("2026-08-24T01:00:00").getTime(), now)).toBe(true);
    expect(isToday(new Date("2026-08-23T23:59:00").getTime(), now)).toBe(false);
    expect(isToday(null, now)).toBe(false);
  });

  it("starts the analytics ranges at midnight", () => {
    const now = new Date("2026-08-24T15:00:00").getTime();
    expect(filterRangeStart("today", now)).toBe(startOfDay(now));
    expect(filterRangeStart("week", now)).toBe(new Date("2026-08-17T00:00:00").getTime());
    expect(filterRangeStart("anything-else", now)).toBe(0);
  });
});

describe("collapseBillSiblings", () => {
  const items = [{ itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 }];

  it("shows a merged bill once, not once per table", () => {
    // The exact symptom: a party across tables 1 and 2 listed twice in Order
    // History, each row carrying the full 1250 total.
    const rows = collapseBillSiblings([
      { id: "a", status: "paid", billId: "b1", billTotal: 1250, table: 1, createdAt: 2, items },
      { id: "b", status: "paid", billId: "b1", billTotal: 1250, table: 2, createdAt: 1, items },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].billTotal).toBe(1250);
  });

  it("leaves unbilled orders alone, because they really are separate", () => {
    const rows = collapseBillSiblings([
      { id: "a", status: "pending", table: 1, createdAt: 1, items },
      { id: "b", status: "pending", table: 2, createdAt: 2, items },
      { id: "c", status: "preparing", table: 1, createdAt: 3, items },
    ]);
    expect(rows).toHaveLength(3);
  });

  it("keeps two different bills that happen to total the same", () => {
    const rows = collapseBillSiblings([
      { id: "a", status: "paid", billId: "b1", billTotal: 500, table: 4, createdAt: 1, items },
      { id: "b", status: "paid", billId: "b2", billTotal: 500, table: 5, createdAt: 2, items },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("collapses older bills that predate billId, on their signature", () => {
    const day = new Date("2026-08-20T13:00:00").getTime();
    const rows = collapseBillSiblings([
      { id: "a", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 1, createdAt: day, items },
      { id: "b", status: "billed", billTotal: 900, billSubtotal: 800, mergedTables: [1, 2], table: 2, createdAt: day + 5000, items },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("keeps a single-table bill even when it carries a one-element mergedTables", () => {
    const rows = collapseBillSiblings([
      { id: "a", status: "paid", billTotal: 400, mergedTables: [7], table: 7, createdAt: 1, items },
      { id: "b", status: "paid", billTotal: 400, mergedTables: [7], table: 7, createdAt: 2, items },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("preserves the order it was given", () => {
    const rows = collapseBillSiblings([
      { id: "x", status: "pending", createdAt: 1, items },
      { id: "a", status: "paid", billId: "b1", billTotal: 100, createdAt: 2, items },
      { id: "b", status: "paid", billId: "b1", billTotal: 100, createdAt: 3, items },
      { id: "y", status: "cancelled", createdAt: 4, items },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["x", "a", "y"]);
  });
});
