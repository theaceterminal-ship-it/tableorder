"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth, db, googleProvider } from "@/lib/firebase";
import { signInWithPopup, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { HOTEL_STATUS } from "@/lib/plans";
import { fetchInvite, acceptInvite } from "@/lib/invites";
import { ROLES, ROLE_LABELS, homeRouteFor } from "@/lib/tenancy";

function LoginPageInner() {
  const [phase, setPhase] = useState("login");
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [invite, setInvite] = useState(null); // the invitation addressed to this email
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);


  const router = useRouter();
  const searchParams = useSearchParams();
  const { user: authUser, role, loading: authLoading, homeRoute, refresh } = useAuth();

  useEffect(() => {
    if (searchParams.get("blocked") === "1") setPhase("subscription-blocked");
  }, [searchParams]);

  // Route by the person's ACTUAL role, not the legacy reception/kitchen shim.
  // An owner or manager belongs in the brand console; only floor staff should
  // land in a single outlet's POS.
  useEffect(() => {
    if (!authLoading && authUser && homeRoute && phase !== "subscription-blocked") {
      router.replace(homeRoute);
    }
  }, [authUser, homeRoute, authLoading, router, phase]);

  // Subscription state lives on the brand now. hotels/{id} is still read as a
  // fallback so an account that has not run /setup/migrate yet still routes
  // correctly instead of being locked out.
  async function checkSubscriptionAndProceed(brandId, legacyRestaurantId, targetRole) {
    let sub = null;
    try {
      if (brandId) {
        const brandSnap = await getDoc(doc(db, "brands", brandId));
        if (brandSnap.exists()) sub = brandSnap.data().subscription || null;
      }
      if (!sub && legacyRestaurantId) {
        const hotelSnap = await getDoc(doc(db, "hotels", legacyRestaurantId));
        if (hotelSnap.exists()) sub = hotelSnap.data();
      }
    } catch {
      // Unreadable subscription means unapproved or unmigrated — fall through
      // to the pending screen rather than guessing.
    }

    if (sub) {
      const expired = sub.planEndDate && sub.planEndDate < Date.now();
      if (sub.status === HOTEL_STATUS.PENDING_PAYMENT || sub.status === HOTEL_STATUS.PENDING_APPROVAL) {
        router.replace("/pending");
        setLoading(false);
        return false;
      }
      if (sub.status === HOTEL_STATUS.SUSPENDED || sub.status === HOTEL_STATUS.REJECTED || expired) {
        setPhase("subscription-blocked");
        setLoading(false);
        return false;
      }
    }

    router.replace(homeRouteFor(targetRole) || "/receptionist");
    return true;
  }

  async function handleGoogleLogin() {
    setError("");
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const fUser = result.user;
      setFirebaseUser(fUser);

      const userDoc = await getDoc(doc(db, "users", fUser.uid));
      if (userDoc.exists()) {
        const data = userDoc.data();
        const ok = await checkSubscriptionAndProceed(data.brandId, data.restaurantId || fUser.uid, null);
        if (!ok) return;
        return;
      }

      // No account yet — is there an invitation waiting for this address?
      const pending = await fetchInvite(fUser.email);
      if (pending?.active) {
        setInvite(pending);
        setPhase("accept-invite");
        setLoading(false);
        return;
      }

      // Neither an account nor an invitation. Signing up is a separate flow
      // now, because it has to choose an organisation type and a plan.
      setPhase("no-account");
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // The invitee is not asked what role they want. The previous flow let them
  // pick, which meant an invited dishwasher could elect to be reception. The
  // role and the outlets come from the invitation, verbatim.
  async function handleAcceptInvite() {
    setLoading(true);
    setError("");
    try {
      const { brandId, role } = await acceptInvite(invite, firebaseUser);

      // Re-resolve who this person is BEFORE navigating anywhere.
      //
      // The auth context resolved at sign-in, when the membership document did
      // not exist yet, so it still believes this account has no role at all.
      // Navigating on that stale state sends them to a guarded page, the guard
      // sees no role and bounces them back to login, and login has no home
      // route to move them on with — they land back where they started having
      // apparently done nothing.
      await refresh();

      const ok = await checkSubscriptionAndProceed(brandId, null, role);
      if (!ok) return;
    } catch (err) {
      setError(err?.code === "permission-denied"
        ? "This invitation could not be verified. Ask whoever invited you to send it again."
        : err.message);
      setLoading(false);
    }
  }

  const containerStyle = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)" };

  // Signed in, resolved, and holding no role anywhere.
  //
  // Without this the page falls through to the sign-in button, so a guard that
  // bounced someone here shows them a "sign in" screen they are already signed
  // in to — which reads as the app silently doing nothing. Name the state and
  // give them a way out.
  if (!authLoading && authUser && !role && phase !== "invite" && phase !== "subscription-blocked") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#fff7ed", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔑</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1a1a2e", marginBottom: 10 }}>No access yet</h1>
          <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.6, marginBottom: 8 }}>
            You are signed in as <strong>{authUser.email}</strong>, but this account is not a
            member of any restaurant.
          </p>
          <p style={{ color: "#6b6b7b", fontSize: 13.5, lineHeight: 1.6, marginBottom: 24 }}>
            If you were invited, the invitation must be sent to this exact email address.
            Ask whoever invited you to check it, or sign in with a different account.
          </p>
          <button onClick={() => signOut(auth)} style={{ background: "#1a1a2e", border: "none", color: "#fff", padding: "12px 22px", borderRadius: 12, cursor: "pointer", fontSize: 14, fontWeight: 700 }}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (phase === "subscription-blocked") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔒</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1a1a2e", marginBottom: 10 }}>Subscription inactive</h1>
          <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.6 }}>
            This restaurant&rsquo;s Cabadra subscription has expired or been paused.
            Please contact your administrator to renew access.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "login") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 400, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🍽️</div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Cabadra</h1>
          <p style={{ color: "#6b6b7b", marginBottom: 32, fontSize: 15 }}>Sign in to manage your restaurant</p>

          {error && <div style={{ background: "#fef2f2", color: "#dc2626", padding: 12, borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{error}</div>}

          <button onClick={handleGoogleLogin} disabled={loading} className="tap-btn"
            style={{ width: "100%", padding: 14, borderRadius: 12, border: "1px solid #e6e1d6", background: "#fff", color: "#1a1a2e", fontSize: 15, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.04)", opacity: loading ? 0.6 : 1 }}>
            {loading ? <span>Signing in...</span> : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                Sign in with Google
              </>
            )}
          </button>

          <p style={{ marginTop: 24, fontSize: 12, color: "#aaa" }}>
            New restaurant? <a href="/signup" style={{ color: "#e8a33d", fontWeight: 700, textDecoration: "none" }}>Sign up here</a>
          </p>
          <p style={{ marginTop: 12, fontSize: 12, color: "#aaa" }}>By signing in, you agree to our Terms of Service</p>
        </div>
      </div>
    );
  }

  if (phase === "accept-invite" && invite) {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#e8a33d20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>👋</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>You&rsquo;ve been invited</h1>
          <p style={{ color: "#6b6b7b", marginBottom: 24, fontSize: 15 }}>
            Joining as <strong style={{ color: "#1a1a2e" }}>{ROLE_LABELS[invite.role] || invite.role}</strong>
            {(invite.outletIds || []).length > 1 ? ` across ${invite.outletIds.length} outlets` : ""}.
          </p>
          <div style={{ background: "#fff", border: "1px solid #e6e1d6", borderRadius: 14, padding: 18, textAlign: "left", marginBottom: 22 }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#6b6b7b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Your access</div>
            <div style={{ fontSize: 14, color: "#1a1a2e", lineHeight: 1.7 }}>
              <div>{ROLE_LABELS[invite.role] || invite.role}</div>
              <div style={{ fontSize: 12.5, color: "#6b6b7b" }}>{firebaseUser?.email}</div>
            </div>
            <p style={{ fontSize: 11.5, color: "#999", marginTop: 10, marginBottom: 0 }}>
              Set by whoever invited you. If this looks wrong, ask them to send a new invitation.
            </p>
          </div>
          {error && <div style={{ background: "#fef2f2", color: "#dc2626", padding: 12, borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{error}</div>}
          <button onClick={handleAcceptInvite} disabled={loading} className="tap-btn"
            style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Setting up…" : "Accept and continue"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "no-account") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f3f4f6", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔍</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>No account found</h1>
          <p style={{ color: "#6b6b7b", marginBottom: 28, fontSize: 15, lineHeight: 1.6 }}>
            <strong style={{ color: "#1a1a2e" }}>{firebaseUser?.email}</strong> is not linked to any
            restaurant, and there is no invitation waiting for it.
          </p>
          <button onClick={() => router.push("/signup")} className="tap-btn"
            style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: "#1a1a2e", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer", marginBottom: 12 }}>
            Set up a new restaurant
          </button>
          <p style={{ fontSize: 13, color: "#888", lineHeight: 1.6 }}>
            Joining an existing team? Ask them to invite this email address, then sign in again.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#1a1a2e", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28 }}>🍽️</div>
      </div>
    }>
      <LoginPageInner />
    </Suspense>
  );
}