"use client";

// lib/use-outlet-data.js
//
// One place per Firestore collection an outlet owns.
//
// Reception previously opened fourteen onSnapshot listeners inline, each with
// its own effect, its own state, and its own idea of how much history to load.
// That is how one of them ended up unbounded — re-reading every order ever
// written on each page load — while its neighbours were fine.
//
// Bounding, ordering and cleanup now live in one place. It also means a route
// segment can subscribe to only what it renders, instead of every screen paying
// for every collection.

import { useEffect, useState, useMemo } from "react";
import { db } from "./firebase";
import { collection, doc, onSnapshot, query, orderBy, where } from "firebase/firestore";
import { receptionOrderWindowStart } from "./orders";

/**
 * Subscribe to a collection under an outlet.
 *
 * `constraints` must be a STABLE array — build it with useMemo in the caller,
 * or pass a literal that never changes. An array literal recreated on every
 * render tears the listener down and re-opens it on every render, which is both
 * a render loop and a bill.
 */
export function useOutletCollection(outletId, name, constraints = [], { enabled = true } = {}) {
  const [docs, setDocs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);

  // Serialised so the effect depends on the constraints' VALUE, not the array's
  // identity. Firestore constraints have no stable public shape, so this leans
  // on their JSON form, which is stable for the shapes used here.
  const key = useMemo(() => JSON.stringify(constraints.map((c) => c?.type ?? String(c))), [constraints]);

  useEffect(() => {
    if (!outletId || !enabled) {
      setDocs([]);
      setLoaded(false);
      return;
    }
    const q = constraints.length
      ? query(collection(db, "restaurants", outletId, name), ...constraints)
      : collection(db, "restaurants", outletId, name);

    const unsub = onSnapshot(
      q,
      (snap) => {
        setDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoaded(true);
        setError(null);
      },
      (err) => {
        // A listener that fails must not leave the screen showing stale data as
        // though it were current.
        console.error(`Listener failed for ${name}:`, err?.code || err?.message);
        setError(err);
        setLoaded(true);
      }
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outletId, name, key, enabled]);

  return { docs, loaded, error };
}

/** Subscribe to a single document under an outlet. */
export function useOutletDoc(outletId, ...segments) {
  const [data, setData] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const path = segments.join("/");

  useEffect(() => {
    if (!outletId) { setData(null); setLoaded(false); return; }
    const unsub = onSnapshot(
      doc(db, "restaurants", outletId, ...path.split("/")),
      (snap) => { setData(snap.exists() ? snap.data() : null); setLoaded(true); },
      (err) => { console.error(`Listener failed for ${path}:`, err?.code || err?.message); setLoaded(true); }
    );
    return () => unsub();
  }, [outletId, path]);

  return { data, loaded };
}

// ---------------------------------------------------------------------------
// The collections, with their bounds and ordering fixed in one place
// ---------------------------------------------------------------------------

/**
 * Orders, bounded to the reception window.
 *
 * The bound is the point: this listener once subscribed to every order ever
 * written, so a device re-read the restaurant's entire history on each load and
 * the cost grew forever. The window covers the longest analytics range the UI
 * offers; anything older comes from rollups.
 */
export function useOrders(outletId) {
  const constraints = useMemo(
    () => [where("createdAt", ">=", receptionOrderWindowStart()), orderBy("createdAt", "asc")],
    // Re-computed once per mount rather than per render: the window start moves
    // with the clock, and recomputing it every render would reopen the listener
    // continuously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const { docs, loaded, error } = useOutletCollection(outletId, "orders", constraints);
  return { orders: docs, ordersLoaded: loaded, ordersError: error };
}

const BY_CREATED_ASC = [orderBy("createdAt", "asc")];
const BY_CREATED_DESC = [orderBy("createdAt", "desc")];
const BY_ORDER_ASC = [orderBy("order", "asc")];
const BY_NUMBER_ASC = [orderBy("number", "asc")];
const BY_LAST_SEEN_DESC = [orderBy("lastSeen", "desc")];
const NO_CONSTRAINTS = [];

export function useMenuItems(outletId) {
  return useOutletCollection(outletId, "menuItems", BY_CREATED_ASC).docs;
}
export function useCategories(outletId) {
  return useOutletCollection(outletId, "categories", BY_ORDER_ASC).docs;
}
export function useTables(outletId) {
  return useOutletCollection(outletId, "tables", BY_NUMBER_ASC).docs;
}
export function useFloors(outletId) {
  return useOutletCollection(outletId, "floors", BY_ORDER_ASC).docs;
}
export function useOfferBanners(outletId) {
  return useOutletCollection(outletId, "offerBanners", BY_ORDER_ASC).docs;
}
export function useBundleRules(outletId) {
  return useOutletCollection(outletId, "bundleRules", BY_CREATED_DESC).docs;
}
export function useWaiterCalls(outletId) {
  return useOutletCollection(outletId, "waiterCalls", BY_CREATED_DESC).docs;
}
export function useCustomers(outletId) {
  return useOutletCollection(outletId, "customers", BY_LAST_SEEN_DESC).docs;
}
export function useStaff(outletId) {
  return useOutletCollection(outletId, "staff", NO_CONSTRAINTS).docs;
}
export function useRiders(outletId) {
  return useOutletCollection(outletId, "riders", BY_CREATED_ASC).docs;
}

/**
 * Bill-time customer details, bounded like orders.
 *
 * Staff-only by rule. Returned as a map keyed by billId, which is how order
 * rows join to it — the PII deliberately does not live on the order document,
 * because the diner's unauthenticated client can read those.
 */
export function useBillCustomers(outletId) {
  const constraints = useMemo(
    () => [where("createdAt", ">=", receptionOrderWindowStart())],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const { docs } = useOutletCollection(outletId, "billCustomers", constraints);
  return useMemo(() => Object.fromEntries(docs.map((d) => [d.id, d])), [docs]);
}

/** profile, billing and settings — three documents under info/. */
export function useOutletInfo(outletId) {
  const profile = useOutletDoc(outletId, "info", "profile");
  const billing = useOutletDoc(outletId, "info", "billing");
  const settings = useOutletDoc(outletId, "info", "settings");
  return {
    profile: profile.data,
    profileLoaded: profile.loaded,
    billing: billing.data,
    billingLoaded: billing.loaded,
    settings: settings.data,
    settingsLoaded: settings.loaded,
  };
}

/**
 * Where each delivery order is going, keyed by order id.
 *
 * A separate collection because orders are publicly readable so a customer can
 * follow their own — if the address lived on the order, a guessed id would be a
 * lookup for somebody's home. Staff-only by rule.
 */
export function useDeliveryDetails(outletId) {
  const constraints = useMemo(
    () => [where("createdAt", ">=", receptionOrderWindowStart())],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const { docs } = useOutletCollection(outletId, "deliveryDetails", constraints);
  return useMemo(() => Object.fromEntries(docs.map((d) => [d.id, d])), [docs]);
}

/**
 * Which tables are currently seated, keyed by table number.
 *
 * Publicly readable by rule: it holds nothing secret, and a diner whose order is
 * refused deserves to be told their table is closed rather than shown a bare
 * error. The token that actually authorises an order lives in tableSecrets,
 * which no client can read at all.
 */
export function useTableSessions(outletId) {
  const { docs } = useOutletCollection(outletId, "tableSessions", NO_CONSTRAINTS);
  return useMemo(() => Object.fromEntries(docs.map((d) => [d.id, d])), [docs]);
}
