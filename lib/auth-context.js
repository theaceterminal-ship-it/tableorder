"use client";

// Resolves who the signed-in user is under the brand/outlet model.
//
// Authorization is read from documents the SUBJECT CANNOT WRITE:
//   brands/{brandId}/members/{uid}      brand_owner | brand_manager | outlet_manager
//   restaurants/{outletId}/staff/{uid}  reception | kitchen
//
// users/{uid} is read only for routing — which brand and outlet to open — and
// is never consulted for permissions, because its subject can edit it. See the
// matching test in lib/tenancy.test.js.

import { createContext, useContext, useState, useEffect, useCallback, useMemo } from "react";
import { auth, db } from "./firebase";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, collection, query, where, getDocs } from "firebase/firestore";
import { getPlanFeatures } from "./plans";
import { resolveAccess, ROLES } from "./tenancy";

const AuthContext = createContext(null);

const EMPTY = {
  user: null,
  access: { role: null, scope: "none", brandId: null, outletIds: [], allOutlets: false },
  brand: null,
  brandId: null,
  outletId: null,
  subscription: null,
  features: getPlanFeatures("base"),
};

// Legacy page components read `role` expecting "reception" or "kitchen" and
// route on it. Brand-level roles map onto the reception surface, since that is
// where the POS and management screens live today.
function legacyRoleFor(role) {
  if (role === ROLES.KITCHEN) return "kitchen";
  if (role === ROLES.RECEPTION) return "reception";
  if (role === ROLES.BRAND_OWNER || role === ROLES.OUTLET_MANAGER) return "reception";
  if (role === ROLES.BRAND_MANAGER) return "reception";
  return null;
}

export function AuthProvider({ children }) {
  const [state, setState] = useState(EMPTY);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (firebaseUser) => {
    if (!firebaseUser) {
      setState(EMPTY);
      setLoading(false);
      return;
    }

    const uid = firebaseUser.uid;
    let brandId = null;
    let outletId = null;

    try {
      const userSnap = await getDoc(doc(db, "users", uid));
      if (userSnap.exists()) {
        const u = userSnap.data();
        brandId = u.brandId || null;
        outletId = u.defaultOutletId || null;
      }

      // An account that predates the restructure has neither pointer. Its
      // outlet id is its own uid, which is exactly what /setup/migrate fixes.
      if (!brandId && !outletId) {
        const legacySnap = await getDoc(doc(db, "restaurants", uid));
        if (legacySnap.exists()) {
          outletId = uid;
          brandId = legacySnap.data().brandId || null;
        }
      }

      const isPlatformAdmin = (await getDoc(doc(db, "platformAdmins", uid))).exists();

      let brandMember = null;
      let brand = null;
      if (brandId) {
        const [memberSnap, brandSnap] = await Promise.all([
          getDoc(doc(db, "brands", brandId, "members", uid)),
          getDoc(doc(db, "brands", brandId)),
        ]);
        if (memberSnap.exists()) brandMember = memberSnap.data();
        if (brandSnap.exists()) brand = brandSnap.data();
      }

      // Floor staff are rostered on outlets, not on the brand. Only look for
      // that when there is no brand membership to find.
      let outletStaff = [];
      if (!brandMember && outletId) {
        const staffSnap = await getDoc(doc(db, "restaurants", outletId, "staff", uid));
        if (staffSnap.exists()) outletStaff = [{ outletId, role: staffSnap.data().role }];
      }

      const access = resolveAccess({ isPlatformAdmin, brandId, brandMember, outletStaff });

      // Which outlet to open: the stored default when it is reachable,
      // otherwise the first one this person actually has.
      let activeOutlet = outletId;
      if (!activeOutlet || (!access.allOutlets && !access.outletIds.includes(activeOutlet))) {
        activeOutlet = access.outletIds[0] || (brand?.outletIds || [])[0] || outletId || null;
      }

      const subscription = brand?.subscription || null;

      setState({
        user: firebaseUser,
        access,
        brand,
        brandId,
        outletId: activeOutlet,
        subscription,
        features: getPlanFeatures(subscription?.plan),
      });
    } catch (err) {
      // A read failure here means an unauthorized or half-migrated account.
      // Fall back to no access rather than guessing, so AuthGuard sends them
      // somewhere safe instead of rendering a dashboard they cannot use.
      console.error("Auth resolution failed:", err?.code || err?.message);
      setState({ ...EMPTY, user: firebaseUser });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => onAuthStateChanged(auth, load), [load]);

  async function logout() {
    await signOut(auth);
    setState(EMPTY);
  }

  // Switch which outlet is being operated. Only outlets this person can reach
  // are accepted, so a stale link or a hand-edited value cannot move someone
  // into a branch they have no membership for.
  function setActiveOutlet(outletId) {
    setState((prev) => {
      if (!outletId) return prev;
      const reachable = prev.access.allOutlets || prev.access.outletIds.includes(outletId);
      return reachable ? { ...prev, outletId } : prev;
    });
  }

  // Memoized: without this the context value is a new object on every render,
  // so every consumer re-renders every time, which amplifies any accidental
  // state-set-in-effect into a runaway loop.
  const value = useMemo(() => ({
    ...state,
    loading,
    logout,
    setActiveOutlet,
    refresh: () => load(auth.currentUser),
    // Compatibility shims for pages written against the single-restaurant
    // model. `restaurantId` is now whichever outlet is active.
    restaurantId: state.outletId,
    role: legacyRoleFor(state.access.role),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [state, loading, load]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
