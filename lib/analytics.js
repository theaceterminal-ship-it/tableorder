// lib/analytics.js
//
// Every number reception reports. Pure functions over orders and menu items —
// no Firestore, no React — so the figures a restaurant runs its business on can
// be tested rather than eyeballed.
//
// Everything here counts through revenueOrders(), which keeps exactly one row
// per bill. A merged party's bill is written onto each of its tables so every
// table's device can display it, and summing those rows directly is how a
// three-table party came to report three times its revenue.

import { revenueOrders, soldQtyByItem, filterRangeStart, isToday } from "./orders";

/** Which hour of the day was busiest, and the 24 counts behind it. */
export function hourlyDistribution(orders) {
  const buckets = Array(24).fill(0);
  (orders || []).forEach((o) => {
    if (o.createdAt) buckets[new Date(o.createdAt).getHours()]++;
  });
  const max = Math.max(...buckets);
  // No orders means no peak. indexOf(0) would otherwise claim midnight.
  return { buckets, peakHour: max > 0 ? buckets.indexOf(max) : null };
}

/** Best sellers by quantity, resolved to menu names. */
export function topItems(revenue, menuItems, limit = 8) {
  const qtyById = soldQtyByItem(revenue, menuItems);
  return Object.entries(qtyById)
    .map(([key, qty]) => [menuItems.find((m) => m.id === key)?.name || key, qty])
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

export function sumBills(revenue) {
  const totalSales = revenue.reduce((s, o) => s + (o.billTotal || 0), 0);
  return {
    totalSales,
    orderCount: revenue.length,
    avg: revenue.length ? Math.round(totalSales / revenue.length) : 0,
    totalDiscounts: revenue.reduce(
      (s, o) => s + (o.billDiscountTotal || (o.billDiscounts || []).reduce((x, d) => x + d.amount, 0)), 0),
    totalTax: revenue.reduce((s, o) => s + (o.billTaxAmount || 0), 0),
    totalService: revenue.reduce((s, o) => s + (o.billServiceAmount || 0), 0),
    itemsSold: revenue.reduce((s, o) => s + (o.items || []).reduce((n, it) => n + (it.qty || 0), 0), 0),
  };
}

/** What was actually collected, split by how it was paid. */
export function paymentBreakdown(revenue) {
  const out = {};
  revenue.filter((o) => o.status === "paid").forEach((o) => {
    const method = o.paymentMethod || "unspecified";
    out[method] = (out[method] || 0) + (o.billTotal || 0);
  });
  return out;
}

/**
 * Revenue split by how the order reached the kitchen.
 *
 * Worth its own line because the three have different economics: delivery
 * carries a fee and a rider, takeaway uses no table, and dine-in occupies one.
 * A single "total sales" number hides whether delivery is actually earning its
 * keep.
 */
export function salesByOrderType(revenue) {
  const out = { dinein: { sales: 0, count: 0 }, takeaway: { sales: 0, count: 0 }, delivery: { sales: 0, count: 0 } };
  (revenue || []).forEach((o) => {
    const key = out[o.orderType] ? o.orderType : "dinein";
    out[key].sales += o.billTotal || 0;
    out[key].count += 1;
  });
  Object.values(out).forEach((v) => { v.avg = v.count ? Math.round(v.sales / v.count) : 0; });
  return out;
}

/** Sales analytics for one of the dashboard's date ranges. */
export function computeAnalytics({ orders, menuItems, filterKey, now = Date.now() }) {
  const start = filterRangeStart(filterKey, now);
  const inRange = revenueOrders((orders || []).filter((o) => o.createdAt >= start));
  const { buckets, peakHour } = hourlyDistribution(inRange);
  return {
    ...sumBills(inRange),
    hourBuckets: buckets,
    peakHour,
    topItems: topItems(inRange, menuItems, 8),
    byOrderType: salesByOrderType(inRange),
    inRange,
  };
}

/** The daily report. `todays` is every order; `billedToday` only the bills. */
export function buildTodayReport({ orders, menuItems, now = Date.now() }) {
  const todays = (orders || []).filter((o) => isToday(o.createdAt, now));
  const billedToday = revenueOrders(todays);
  const totals = sumBills(billedToday);
  // Peak hour comes from ALL of today's orders, not just billed ones — the
  // kitchen's busiest hour is about when food was ordered, not when it was paid.
  const { buckets, peakHour } = hourlyDistribution(todays);
  return {
    todays,
    billedToday,
    ...totals,
    avgOrderValue: totals.avg,
    hourBuckets: buckets,
    peakHour,
    topItems: topItems(billedToday, menuItems, 10),
    paymentBreakdown: paymentBreakdown(billedToday),
    byOrderType: salesByOrderType(billedToday),
  };
}

export function filterLabel(filterKey) {
  return { today: "Today", "3days": "Last 3 Days", week: "Last Week", month: "Last Month" }[filterKey] || "All Time";
}
