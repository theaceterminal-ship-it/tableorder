import { describe, it, expect } from "vitest";
import {
  toCSV, ordersHistoryRows, itemsSoldRows, dailyReportRows, crmRows, reportFilename,
} from "./reports";

const MENU = [
  { id: "dal", name: "Dal Makhani", price: 320 },
  { id: "naan", name: "Butter Naan", price: 60 },
];

const at = (h) => new Date(2026, 8, 1, h).getTime();
const NOW = at(21);

const line = (itemId, name, qty, price) => ({ itemId, name, qty, price });

describe("toCSV", () => {
  it("quotes every field", () => {
    expect(toCSV([["a", "b"]])).toBe('"a","b"');
  });

  it("survives a value containing a comma", () => {
    expect(toCSV([["Rich, creamy", 280]])).toBe('"Rich, creamy","280"');
  });

  it("doubles embedded quotes, so a 12\" pan does not shift every later column", () => {
    expect(toCSV([['12" pan', 1]])).toBe('"12"" pan","1"');
  });

  it("renders null and undefined as empty rather than the words", () => {
    expect(toCSV([[null, undefined]])).toBe('"",""');
  });

  it("handles no rows", () => {
    expect(toCSV([])).toBe("");
    expect(toCSV(null)).toBe("");
  });
});

describe("ordersHistoryRows", () => {
  const merged = [
    { id: "a", status: "paid", billId: "b1", billTotal: 1250, table: 1, createdAt: at(13), items: [line("dal", "Dal Makhani", 1, 320)] },
    { id: "b", status: "paid", billId: "b1", billTotal: 1250, table: 2, createdAt: at(13), items: [line("dal", "Dal Makhani", 1, 320)] },
  ];

  it("lists a merged party's bill once, not once per table", () => {
    const { list } = ordersHistoryRows({ orders: merged, filterKey: "today", now: NOW });
    expect(list).toHaveLength(1);
  });

  it("keeps unbilled orders as separate rows", () => {
    const orders = [
      { id: "a", status: "pending", table: 1, createdAt: at(13), items: [] },
      { id: "b", status: "preparing", table: 2, createdAt: at(14), items: [] },
    ];
    expect(ordersHistoryRows({ orders, filterKey: "today", now: NOW }).list).toHaveLength(2);
  });

  it("counts each status in the summary", () => {
    const orders = [
      { id: "a", status: "paid", billTotal: 100, table: 1, createdAt: at(13), items: [] },
      { id: "b", status: "cancelled", table: 2, createdAt: at(14), items: [] },
    ];
    const csv = toCSV(ordersHistoryRows({ orders, filterKey: "today", now: NOW }).rows);
    expect(csv).toContain("Total Orders");
    expect(csv).toContain("paid");
    expect(csv).toContain("cancelled");
  });

  it("lists newest first", () => {
    const orders = [
      { id: "old", status: "paid", billTotal: 1, table: 1, createdAt: at(10), items: [] },
      { id: "new", status: "paid", billTotal: 1, table: 2, createdAt: at(19), items: [] },
    ];
    expect(ordersHistoryRows({ orders, filterKey: "today", now: NOW }).list[0].id).toBe("new");
  });

  it("excludes orders outside the range", () => {
    const orders = [
      { id: "today", status: "paid", billTotal: 1, table: 1, createdAt: at(13), items: [] },
      { id: "old", status: "paid", billTotal: 1, table: 1, createdAt: new Date(2026, 6, 1).getTime(), items: [] },
    ];
    expect(ordersHistoryRows({ orders, filterKey: "today", now: NOW }).list).toHaveLength(1);
  });
});

describe("itemsSoldRows", () => {
  const orders = [{
    id: "a", status: "paid", billTotal: 700, createdAt: at(13),
    items: [line("naan", "Butter Naan", 4, 60), line("dal", "Dal Makhani", 1, 320)],
  }];

  it("ranks by quantity and totals revenue per item", () => {
    const { sorted } = itemsSoldRows({ orders, menuItems: MENU, filterKey: "today", now: NOW });
    expect(sorted[0]).toMatchObject({ name: "Butter Naan", qty: 4, revenue: 240 });
    expect(sorted[1]).toMatchObject({ name: "Dal Makhani", qty: 1, revenue: 320 });
  });

  it("gives each item its share of units sold", () => {
    const csv = toCSV(itemsSoldRows({ orders, menuItems: MENU, filterKey: "today", now: NOW }).rows);
    expect(csv).toContain("80.0%"); // 4 of 5 units
  });

  it("counts a merged bill's items once", () => {
    const items = [line("dal", "Dal Makhani", 2, 320)];
    const mergedOrders = [
      { id: "a", status: "paid", billTotal: 640, isBillPrimary: true, mergedTables: [1, 2], createdAt: at(13), items },
      { id: "b", status: "paid", billTotal: 640, isBillPrimary: false, mergedTables: [1, 2], createdAt: at(13), items },
    ];
    expect(itemsSoldRows({ orders: mergedOrders, menuItems: MENU, filterKey: "today", now: NOW }).totalQty).toBe(2);
  });

  it("does not divide by zero when nothing sold", () => {
    const r = itemsSoldRows({ orders: [], menuItems: MENU, filterKey: "today", now: NOW });
    expect(r.totalQty).toBe(0);
    expect(r.sorted).toEqual([]);
  });
});

describe("dailyReportRows", () => {
  const orders = [
    { id: "a", status: "paid", billTotal: 500, paymentMethod: "cash", billTaxAmount: 25, createdAt: at(13), items: [line("dal", "Dal Makhani", 1, 320)] },
    { id: "b", status: "paid", billTotal: 300, paymentMethod: "upi", billTaxAmount: 15, createdAt: at(19), items: [line("naan", "Butter Naan", 2, 60)] },
    { id: "c", status: "pending", createdAt: at(19), items: [] },
  ];

  it("summarises sales, tax and payment split", () => {
    const csv = toCSV(dailyReportRows({ orders, menuItems: MENU, now: NOW }).rows);
    expect(csv).toContain('"Total Sales","800"');
    expect(csv).toContain('"Tax Collected","40"');
    expect(csv).toContain('"cash","500"');
    expect(csv).toContain('"upi","300"');
  });

  it("separates bills from orders", () => {
    const { data } = dailyReportRows({ orders, menuItems: MENU, now: NOW });
    expect(data.billedToday).toHaveLength(2);
    expect(data.todays).toHaveLength(3);
  });

  it("prints an em dash rather than 0:00 when there is no peak hour", () => {
    const csv = toCSV(dailyReportRows({ orders: [], menuItems: MENU, now: NOW }).rows);
    expect(csv).toContain('"Peak Hour","—"');
  });
});

describe("crmRows", () => {
  const customers = [
    { name: "Asha", phone: "1", orderCount: 5, totalSpent: 6000, firstSeen: at(9), lastSeen: at(19) },
    { name: "Bala", phone: "2", orderCount: 1, totalSpent: 900, firstSeen: at(10), lastSeen: at(10) },
  ];

  it("sorts by lifetime spend", () => {
    expect(crmRows({ customers, now: NOW }).list[0].name).toBe("Asha");
  });

  it("counts repeat customers and lifetime value", () => {
    const csv = toCSV(crmRows({ customers, now: NOW }).rows);
    expect(csv).toContain('"Repeat Customers","1"');
    expect(csv).toContain('"Lifetime Value","6900"');
  });

  it("survives an empty CRM", () => {
    expect(crmRows({ customers: [], now: NOW }).list).toEqual([]);
  });
});

describe("reportFilename", () => {
  it("includes the range and the date", () => {
    expect(reportFilename("order-history", "week", NOW)).toBe("order-history-week-2026-09-01.csv");
  });

  it("omits the range when there isn't one", () => {
    expect(reportFilename("daily", null, NOW)).toBe("daily-2026-09-01.csv");
  });
});
