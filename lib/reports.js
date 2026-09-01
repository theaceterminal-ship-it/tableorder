// lib/reports.js
//
// Turns orders into the rows of a CSV. Pure — it builds arrays and strings and
// never touches the DOM, so the contents of a report a restaurant hands to its
// accountant can be tested. Downloading is the component's job; see
// downloadCsv in lib/download.js.

import { collapseBillSiblings, revenueOrders, filterRangeStart } from "./orders";
import { buildTodayReport, filterLabel } from "./analytics";

/**
 * Serialize rows to CSV text.
 *
 * Every field is quoted and embedded quotes are doubled, so a dish described as
 * `Rich, creamy, 12" pan` survives instead of shifting every later column.
 */
export function toCSV(rows) {
  return (rows || [])
    .map((r) => (r || []).map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function itemSummary(o) {
  return (o.items || []).map((it) => `${it.name} x${it.qty}`).join("; ");
}

/**
 * Every order in a range, one row per BILL.
 *
 * collapseBillSiblings is what stops a merged party appearing once per table
 * with the full total on each row — which would have anyone totalling the
 * column counting the money twice.
 */
export function ordersHistoryRows({ orders, filterKey, restaurantName = "", now = Date.now() }) {
  const start = filterRangeStart(filterKey, now);
  const list = collapseBillSiblings((orders || []).filter((o) => o.createdAt >= start))
    .sort((a, b) => b.createdAt - a.createdAt);

  const statusCounts = {};
  list.forEach((o) => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });

  return {
    list,
    rows: [
      ["Order History Report", restaurantName, filterLabel(filterKey), new Date(now).toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Orders", list.length],
      ...Object.entries(statusCounts).map(([s, c]) => [`  · ${s.replace("_", " ")}`, c]),
      [],
      ["ORDER LOG"],
      ["Table", "Date/Time", "Status", "Type", "Items", "Total"],
      ...list.map((o) => [
        o.table,
        new Date(o.createdAt).toLocaleString(),
        String(o.status || "").replace("_", " "),
        o.orderType || "dinein",
        itemSummary(o),
        o.billTotal || "",
      ]),
    ],
  };
}

/** What sold, by quantity, over a range. */
export function itemsSoldRows({ orders, menuItems, filterKey, restaurantName = "", now = Date.now() }) {
  const start = filterRangeStart(filterKey, now);
  const inRange = revenueOrders((orders || []).filter((o) => o.createdAt >= start));

  const counts = {};
  inRange.forEach((o) => (o.items || []).forEach((it) => {
    const key = it.itemId || it.name;
    if (!counts[key]) counts[key] = { name: it.name, qty: 0, revenue: 0 };
    counts[key].qty += it.qty || 0;
    counts[key].revenue += (it.price || 0) * (it.qty || 0);
  }));

  const sorted = Object.values(counts).sort((a, b) => b.qty - a.qty);
  const totalQty = sorted.reduce((s, i) => s + i.qty, 0);

  return {
    sorted,
    totalQty,
    rows: [
      ["Items Sold Report", restaurantName, filterLabel(filterKey), new Date(now).toLocaleDateString()], [],
      ["SUMMARY"],
      ["Distinct Items", sorted.length],
      ["Total Units Sold", totalQty],
      [],
      ["ITEMS"],
      ["#", "Item", "Qty Sold", "Revenue", "Share"],
      ...sorted.map((i, n) => [
        n + 1, i.name, i.qty, i.revenue,
        totalQty ? `${((i.qty / totalQty) * 100).toFixed(1)}%` : "0%",
      ]),
    ],
  };
}

/** The end-of-day report: what was sold, what was collected, and how. */
export function dailyReportRows({ orders, menuItems, restaurantName = "", now = Date.now() }) {
  const d = buildTodayReport({ orders, menuItems, now });

  return {
    data: d,
    rows: [
      ["Daily Report", restaurantName, new Date(now).toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Sales", d.totalSales],
      ["Bills", d.billedToday.length],
      ["Orders", d.todays.length],
      ["Average Order Value", d.avgOrderValue],
      ["Discounts Given", d.totalDiscounts],
      ["Tax Collected", d.totalTax],
      ["Service Charge", d.totalService],
      ["Peak Hour", d.peakHour == null ? "—" : `${d.peakHour}:00`],
      [],
      ["PAYMENTS"],
      ...Object.entries(d.paymentBreakdown).map(([m, amt]) => [m, amt]),
      [],
      ["TOP ITEMS"],
      ["Item", "Qty"],
      ...d.topItems.map(([name, qty]) => [name, qty]),
      [],
      ["BILLS"],
      ["Table", "Time", "Items", "Payment", "Total"],
      ...d.billedToday.map((o) => [
        o.table,
        new Date(o.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        itemSummary(o),
        o.paymentMethod || "",
        o.billTotal || "",
      ]),
    ],
  };
}

/** The CRM export: who came back, how often, and what they spent. */
export function crmRows({ customers, restaurantName = "", now = Date.now() }) {
  const list = [...(customers || [])].sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0));
  return {
    list,
    rows: [
      ["Customer Report", restaurantName, new Date(now).toLocaleDateString()], [],
      ["SUMMARY"],
      ["Total Customers", list.length],
      ["Repeat Customers", list.filter((c) => (c.orderCount || 0) > 1).length],
      ["Lifetime Value", list.reduce((s, c) => s + (c.totalSpent || 0), 0)],
      [],
      ["CUSTOMERS"],
      ["Name", "Phone", "Visits", "Total Spent", "First Seen", "Last Seen"],
      ...list.map((c) => [
        c.name || "",
        c.phone || "",
        c.orderCount || 0,
        c.totalSpent || 0,
        c.firstSeen ? new Date(c.firstSeen).toLocaleDateString() : "",
        c.lastSeen ? new Date(c.lastSeen).toLocaleDateString() : "",
      ]),
    ],
  };
}

export function reportFilename(prefix, filterKey, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10);
  return filterKey ? `${prefix}-${filterKey}-${date}.csv` : `${prefix}-${date}.csv`;
}
