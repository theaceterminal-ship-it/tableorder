import { describe, it, expect } from "vitest";
import {
  hourlyDistribution, topItems, sumBills, paymentBreakdown,
  computeAnalytics, buildTodayReport, filterLabel, salesByOrderType,
} from "./analytics";

const MENU = [
  { id: "dal", name: "Dal Makhani", price: 320 },
  { id: "naan", name: "Butter Naan", price: 60 },
  { id: "paneer", name: "Paneer Tikka", price: 280 },
];

const at = (h, m = 0) => new Date(2026, 8, 1, h, m).getTime();
const NOW = at(20);

const bill = (id, total, opts = {}) => ({
  id, status: "paid", billTotal: total, createdAt: at(13),
  items: [{ itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 }],
  ...opts,
});

describe("hourlyDistribution", () => {
  it("buckets orders by the hour they were placed", () => {
    const { buckets, peakHour } = hourlyDistribution([
      { createdAt: at(13) }, { createdAt: at(13, 30) }, { createdAt: at(20) },
    ]);
    expect(buckets[13]).toBe(2);
    expect(buckets[20]).toBe(1);
    expect(peakHour).toBe(13);
  });

  it("reports no peak rather than claiming midnight when there are no orders", () => {
    // indexOf(0) on an all-zero array returns 0, which reads as "busiest at 12am".
    expect(hourlyDistribution([]).peakHour).toBeNull();
  });
});

describe("topItems", () => {
  it("ranks by quantity and resolves ids to names", () => {
    const orders = [{
      id: "a", status: "paid", billTotal: 700, createdAt: at(13),
      items: [
        { itemId: "naan", name: "Butter Naan", qty: 4, price: 60 },
        { itemId: "dal", name: "Dal Makhani", qty: 1, price: 320 },
      ],
    }];
    expect(topItems(orders, MENU)).toEqual([["Butter Naan", 4], ["Dal Makhani", 1]]);
  });

  it("respects the limit", () => {
    const orders = [{
      id: "a", status: "paid", billTotal: 1, createdAt: at(13),
      items: MENU.map((m, i) => ({ itemId: m.id, name: m.name, qty: 10 - i, price: 1 })),
    }];
    expect(topItems(orders, MENU, 2)).toHaveLength(2);
  });
});

describe("sumBills", () => {
  it("adds up totals, tax, service and discounts", () => {
    const rows = [
      bill("a", 500, { billTaxAmount: 25, billServiceAmount: 50, billDiscountTotal: 40 }),
      bill("b", 300, { billTaxAmount: 15, billServiceAmount: 30, billDiscountTotal: 0 }),
    ];
    const t = sumBills(rows);
    expect(t.totalSales).toBe(800);
    expect(t.totalTax).toBe(40);
    expect(t.totalService).toBe(80);
    expect(t.totalDiscounts).toBe(40);
    expect(t.avg).toBe(400);
  });

  it("falls back to the discount lines when no total was stored", () => {
    const rows = [bill("a", 500, { billDiscounts: [{ name: "BOGO", amount: 120 }] })];
    expect(sumBills(rows).totalDiscounts).toBe(120);
  });

  it("does not divide by zero on an empty day", () => {
    expect(sumBills([])).toMatchObject({ totalSales: 0, orderCount: 0, avg: 0 });
  });
});

describe("paymentBreakdown", () => {
  it("splits collected money by method", () => {
    expect(paymentBreakdown([
      bill("a", 500, { paymentMethod: "cash" }),
      bill("b", 300, { paymentMethod: "upi" }),
      bill("c", 200, { paymentMethod: "cash" }),
    ])).toEqual({ cash: 700, upi: 300 });
  });

  it("buckets a missing method rather than dropping the money", () => {
    expect(paymentBreakdown([bill("a", 500, { paymentMethod: null })])).toEqual({ unspecified: 500 });
  });

  it("counts only what was actually paid, not what is merely billed", () => {
    expect(paymentBreakdown([bill("a", 500, { status: "billed", paymentMethod: "cash" })])).toEqual({});
  });
});

describe("computeAnalytics", () => {
  it("counts a merged party's bill once, not once per table", () => {
    // The 3x revenue bug, guarded at the reporting layer.
    const orders = [
      { id: "a", status: "paid", billTotal: 3000, isBillPrimary: true, mergedTables: [1, 2, 3], createdAt: at(13), items: [] },
      { id: "b", status: "paid", billTotal: 3000, isBillPrimary: false, mergedTables: [1, 2, 3], createdAt: at(13), items: [] },
      { id: "c", status: "paid", billTotal: 3000, isBillPrimary: false, mergedTables: [1, 2, 3], createdAt: at(13), items: [] },
    ];
    const a = computeAnalytics({ orders, menuItems: MENU, filterKey: "today", now: NOW });
    expect(a.totalSales).toBe(3000);
    expect(a.orderCount).toBe(1);
  });

  it("ignores orders that were never billed", () => {
    const orders = [
      bill("a", 500),
      { id: "b", status: "pending", createdAt: at(13), items: [] },
      { id: "c", status: "cancelled", createdAt: at(13), items: [] },
    ];
    expect(computeAnalytics({ orders, menuItems: MENU, filterKey: "today", now: NOW }).orderCount).toBe(1);
  });

  it("excludes orders outside the range", () => {
    const lastWeek = new Date(2026, 7, 20, 13).getTime();
    const orders = [bill("a", 500), bill("old", 900, { createdAt: lastWeek })];
    expect(computeAnalytics({ orders, menuItems: MENU, filterKey: "today", now: NOW }).totalSales).toBe(500);
    expect(computeAnalytics({ orders, menuItems: MENU, filterKey: "month", now: NOW }).totalSales).toBe(1400);
  });

  it("survives an empty restaurant", () => {
    const a = computeAnalytics({ orders: [], menuItems: MENU, filterKey: "today", now: NOW });
    expect(a).toMatchObject({ totalSales: 0, orderCount: 0, avg: 0, peakHour: null });
    expect(a.topItems).toEqual([]);
  });
});

describe("buildTodayReport", () => {
  it("separates today's orders from today's bills", () => {
    const orders = [
      bill("a", 500),
      { id: "b", status: "pending", createdAt: at(14), items: [] },
    ];
    const r = buildTodayReport({ orders, menuItems: MENU, now: NOW });
    expect(r.todays).toHaveLength(2);
    expect(r.billedToday).toHaveLength(1);
    expect(r.totalSales).toBe(500);
  });

  it("takes peak hour from all orders, not only the paid ones", () => {
    // The kitchen's busiest hour is about when food was ordered.
    const orders = [
      bill("a", 500, { createdAt: at(13) }),
      { id: "b", status: "pending", createdAt: at(19), items: [] },
      { id: "c", status: "preparing", createdAt: at(19), items: [] },
    ];
    expect(buildTodayReport({ orders, menuItems: MENU, now: NOW }).peakHour).toBe(19);
  });

  it("leaves out yesterday", () => {
    const yesterday = new Date(2026, 7, 31, 13).getTime();
    const orders = [bill("a", 500), bill("y", 900, { createdAt: yesterday })];
    expect(buildTodayReport({ orders, menuItems: MENU, now: NOW }).totalSales).toBe(500);
  });
});

describe("filterLabel", () => {
  it("names the ranges the UI offers", () => {
    expect(filterLabel("today")).toBe("Today");
    expect(filterLabel("month")).toBe("Last Month");
    expect(filterLabel("nonsense")).toBe("All Time");
  });
});

describe("salesByOrderType", () => {
  const row = (type, total) => ({
    id: type + total, status: "paid", orderType: type, billTotal: total,
    createdAt: at(13), items: [],
  });

  it("splits revenue by how the order reached the kitchen", () => {
    // A single "total sales" number hides whether delivery earns its keep.
    const r = salesByOrderType([row("dinein", 500), row("delivery", 300), row("delivery", 200), row("takeaway", 100)]);
    expect(r.dinein).toMatchObject({ sales: 500, count: 1, avg: 500 });
    expect(r.delivery).toMatchObject({ sales: 500, count: 2, avg: 250 });
    expect(r.takeaway).toMatchObject({ sales: 100, count: 1, avg: 100 });
  });

  it("counts an order with no type as dine-in, since that is what it was before the field existed", () => {
    const r = salesByOrderType([{ id: "a", status: "paid", billTotal: 200, createdAt: at(13), items: [] }]);
    expect(r.dinein.count).toBe(1);
  });

  it("returns every type even when one has no orders", () => {
    const r = salesByOrderType([]);
    expect(Object.keys(r).sort()).toEqual(["delivery", "dinein", "takeaway"]);
    expect(r.delivery.avg).toBe(0);
  });

  it("appears in the range analytics and the daily report", () => {
    const orders = [row("delivery", 300)];
    expect(computeAnalytics({ orders, menuItems: MENU, filterKey: "today", now: NOW }).byOrderType.delivery.sales).toBe(300);
    expect(buildTodayReport({ orders, menuItems: MENU, now: NOW }).byOrderType.delivery.sales).toBe(300);
  });
});
