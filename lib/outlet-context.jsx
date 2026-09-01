"use client";

// One subscription set per outlet, shared by every reception screen.
//
// Without this, splitting reception into routes would mean each route opening
// its own copy of the same fourteen listeners — so navigating from Orders to
// Menu would tear them all down and re-open them, paying the read cost again on
// every click. The provider sits in the layout, above the routes, so the
// subscriptions outlive navigation between them.

import { createContext, useContext, useMemo } from "react";
import { useAuth } from "./auth-context";
import {
  useOrders, useMenuItems, useCategories, useTables, useFloors,
  useOfferBanners, useBundleRules, useWaiterCalls, useCustomers,
  useStaff, useBillCustomers, useOutletInfo,
} from "./use-outlet-data";

const OutletContext = createContext(null);

export function OutletDataProvider({ children }) {
  const { restaurantId } = useAuth();

  const { orders, ordersLoaded } = useOrders(restaurantId);
  const menuItems = useMenuItems(restaurantId);
  const categories = useCategories(restaurantId);
  const tables = useTables(restaurantId);
  const floors = useFloors(restaurantId);
  const offerBanners = useOfferBanners(restaurantId);
  const bundleRules = useBundleRules(restaurantId);
  const waiterCalls = useWaiterCalls(restaurantId);
  const customers = useCustomers(restaurantId);
  const staffList = useStaff(restaurantId);
  const billCustomers = useBillCustomers(restaurantId);
  const { profile, billing, settings } = useOutletInfo(restaurantId);

  // Defaults applied once here rather than at every read site, so a restaurant
  // that has never opened Settings still has sane badge thresholds.
  const siteSettings = useMemo(() => ({
    hasBar: !!settings?.hasBar,
    pureVeg: !!settings?.pureVeg,
    googleReviewLink: settings?.googleReviewLink || "",
    thresholdMostLoved: settings?.thresholdMostLoved ?? 4.5,
    thresholdMostOrdered: settings?.thresholdMostOrdered ?? 100,
    thresholdMostRated: settings?.thresholdMostRated ?? 50,
  }), [settings]);

  const value = useMemo(() => ({
    outletId: restaurantId,
    orders, ordersLoaded, menuItems, categories, tables, floors,
    offerBanners, bundleRules, waiterCalls, customers, staffList,
    billCustomers, profile, billing, siteSettings,
  }), [
    restaurantId, orders, ordersLoaded, menuItems, categories, tables, floors,
    offerBanners, bundleRules, waiterCalls, customers, staffList,
    billCustomers, profile, billing, siteSettings,
  ]);

  return <OutletContext.Provider value={value}>{children}</OutletContext.Provider>;
}

export function useOutlet() {
  const ctx = useContext(OutletContext);
  if (!ctx) throw new Error("useOutlet must be used inside OutletDataProvider");
  return ctx;
}
