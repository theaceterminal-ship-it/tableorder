"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { auth, db, googleProvider, uploadToCloudinary } from "@/lib/firebase";
import { signInWithPopup } from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { HOTEL_STATUS } from "@/lib/plans";

function LoginPageInner() {
  const [phase, setPhase] = useState("login");
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [invitedRestaurantId, setInvitedRestaurantId] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [password, setPassword] = useState("");
  const [restaurantForm, setRestaurantForm] = useState({ name: "", tagline: "", address: "", logoUrl: "" });
  const [logoUploading, setLogoUploading] = useState(false);

  const router = useRouter();
  const searchParams = useSearchParams();
  const { user: authUser, role, loading: authLoading } = useAuth();

  useEffect(() => {
    if (searchParams.get("blocked") === "1") setPhase("subscription-blocked");
  }, [searchParams]);

  useEffect(() => {
    if (!authLoading && authUser && role && phase !== "subscription-blocked") {
      if (role === "reception") router.replace("/receptionist");
      else if (role === "kitchen") router.replace("/kitchen");
    }
  }, [authUser, role, authLoading, router, phase]);

  async function checkSubscriptionAndProceed(restaurantId, targetRole) {
    const hotelDoc = await getDoc(doc(db, "hotels", restaurantId));
    if (hotelDoc.exists()) {
      const h = hotelDoc.data();
      const expired = h.planEndDate && h.planEndDate < Date.now();

      if (h.status === HOTEL_STATUS.PENDING_PAYMENT || h.status === HOTEL_STATUS.PENDING_APPROVAL) {
        router.replace("/pending");
        setLoading(false);
        return false;
      }
      if (h.status === HOTEL_STATUS.SUSPENDED || h.status === HOTEL_STATUS.REJECTED || expired) {
        setPhase("subscription-blocked");
        setLoading(false);
        return false;
      }
    }
    if (targetRole === "reception") router.replace("/receptionist");
    else router.replace("/kitchen");
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
        const ok = await checkSubscriptionAndProceed(data.restaurantId, data.role);
        if (!ok) return;
        return;
      }

      const emailKey = fUser.email.toLowerCase().replace(/\./g, "_");
      const inviteDoc = await getDoc(doc(db, "staffEmails", emailKey));
      if (inviteDoc.exists()) {
        setInvitedRestaurantId(inviteDoc.data().restaurantId);
        setPhase("choose-role");
        setLoading(false);
        return;
      }

      setPhase("create-restaurant");
      setLoading(false);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function handleChooseRole(selectedRole) {
    if (selectedRole === "reception") { setPhase("set-password"); return; }
    await finishStaffSetup("kitchen");
  }

  async function handleSetPassword() {
    if (!password || password.length < 4) { setError("Password must be at least 4 characters"); return; }
    await finishStaffSetup("reception", password);
  }

  async function finishStaffSetup(selectedRole, pwd = null) {
    setLoading(true);
    try {
      await setDoc(doc(db, "users", firebaseUser.uid), {
        restaurantId: invitedRestaurantId, role: selectedRole, email: firebaseUser.email,
        name: firebaseUser.displayName || "", password: pwd, addedAt: serverTimestamp(),
      });
      await setDoc(doc(db, "restaurants", invitedRestaurantId, "staff", firebaseUser.uid), {
        email: firebaseUser.email, name: firebaseUser.displayName || "", role: selectedRole,
        uid: firebaseUser.uid, status: "active", addedAt: serverTimestamp(),
      }, { merge: true });

      const ok = await checkSubscriptionAndProceed(invitedRestaurantId, selectedRole);
      if (!ok) return;
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  async function handleLogoUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("Please select an image");
    if (file.size > 5 * 1024 * 1024) return alert("Image must be under 5MB");
    setLogoUploading(true);
    try {
      const url = await uploadToCloudinary(file);
      setRestaurantForm((p) => ({ ...p, logoUrl: url }));
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleCreateRestaurant() {
    if (!restaurantForm.name.trim()) { setError("Restaurant name is required"); return; }
    setLoading(true);
    try {
      const restaurantId = firebaseUser.uid;

      await setDoc(doc(db, "restaurants", restaurantId, "info", "profile"), {
        name: restaurantForm.name.trim(), tagline: restaurantForm.tagline, address: restaurantForm.address,
        logoUrl: restaurantForm.logoUrl, email: firebaseUser.email, createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, "restaurants", restaurantId, "info", "billing"), {
        taxPercent: 5, servicePercent: 0, upiId: "",
      });
      await setDoc(doc(db, "users", firebaseUser.uid), {
        restaurantId, role: "reception", email: firebaseUser.email, name: firebaseUser.displayName || "",
        isCreator: true, addedAt: serverTimestamp(),
      });
      await setDoc(doc(db, "restaurants", restaurantId, "staff", firebaseUser.uid), {
        email: firebaseUser.email, name: firebaseUser.displayName || "", role: "reception",
        uid: firebaseUser.uid, status: "active", addedAt: serverTimestamp(),
      });
      await setDoc(doc(db, "hotels", restaurantId), {
        status: HOTEL_STATUS.PENDING_APPROVAL,
        plan: "base",
        ownerEmail: firebaseUser.email,
        createdAt: Date.now(),
      });

      router.replace("/pending");
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  const containerStyle = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)" };

  if (phase === "subscription-blocked") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#fef2f2", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔒</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: "#1a1a2e", marginBottom: 10 }}>Subscription inactive</h1>
          <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.6 }}>
            This restaurant's Cabadra subscription has expired or been paused.
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

  if (phase === "choose-role") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 400, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#e8a33d20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>👋</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Welcome aboard!</h1>
          <p style={{ color: "#6b6b7b", marginBottom: 32, fontSize: 15 }}>You've been invited to join the team. Choose your role:</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <button onClick={() => handleChooseRole("kitchen")} className="tap-btn" style={{ padding: 20, borderRadius: 16, border: "2px solid #e6e1d6", background: "#fff", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "#dcfce7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>👨‍🍳</div>
              <div><div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>Kitchen Staff</div><div style={{ fontSize: 13, color: "#6b6b7b" }}>Manage orders and cooking times</div></div>
            </button>
            <button onClick={() => handleChooseRole("reception")} className="tap-btn" style={{ padding: 20, borderRadius: 16, border: "2px solid #e6e1d6", background: "#fff", cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🖥️</div>
              <div><div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a2e" }}>Reception / Manager</div><div style={{ fontSize: 13, color: "#6b6b7b" }}>Manage menu, tables, billing & staff</div></div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "set-password") {
    return (
      <div style={containerStyle}>
        <div style={{ width: "100%", maxWidth: 400, textAlign: "center" }}>
          <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#dbeafe", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🔐</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Set a password</h1>
          <p style={{ color: "#6b6b7b", marginBottom: 32, fontSize: 15 }}>This helps keep your manager account secure</p>
          {error && <div style={{ background: "#fef2f2", color: "#dc2626", padding: 12, borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{error}</div>}
          <input type="password" placeholder="Enter password (min 4 chars)" value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #e6e1d6", fontSize: 15, marginBottom: 16, outline: "none" }} />
          <button onClick={handleSetPassword} disabled={loading} className="tap-btn"
            style={{ width: "100%", padding: 14, borderRadius: 12, border: "none", background: "#e8a33d", color: "#fff", fontSize: 15, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Setting up..." : "Continue"}
          </button>
          <button onClick={() => { setPhase("choose-role"); setError(""); }} style={{ marginTop: 16, background: "none", border: "none", color: "#6b6b7b", fontSize: 14, cursor: "pointer" }}>← Go back</button>
        </div>
      </div>
    );
  }

  if (phase === "create-restaurant") {
    return (
      <div style={{ ...containerStyle, alignItems: "flex-start", paddingTop: 40 }}>
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#e8a33d20", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: 28 }}>🏪</div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", marginBottom: 8 }}>Create your restaurant</h1>
            <p style={{ color: "#6b6b7b", fontSize: 15 }}>Let's get your place set up in seconds</p>
          </div>
          {error && <div style={{ background: "#fef2f2", color: "#dc2626", padding: 12, borderRadius: 10, fontSize: 13, fontWeight: 600, marginBottom: 16 }}>{error}</div>}
          <div style={{ background: "#fff", borderRadius: 20, padding: 28, boxShadow: "0 4px 20px rgba(0,0,0,0.06)" }}>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6b6b7b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Restaurant Name *</label>
              <input placeholder="e.g. Spice Garden" value={restaurantForm.name} onChange={(e) => setRestaurantForm((p) => ({ ...p, name: e.target.value }))}
                style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #e6e1d6", fontSize: 15, outline: "none" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6b6b7b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Tagline</label>
              <input placeholder="e.g. Authentic North Indian Cuisine" value={restaurantForm.tagline} onChange={(e) => setRestaurantForm((p) => ({ ...p, tagline: e.target.value }))}
                style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #e6e1d6", fontSize: 15, outline: "none" }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6b6b7b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Address</label>
              <input placeholder="Restaurant address" value={restaurantForm.address} onChange={(e) => setRestaurantForm((p) => ({ ...p, address: e.target.value }))}
                style={{ width: "100%", padding: "14px 16px", borderRadius: 12, border: "1px solid #e6e1d6", fontSize: 15, outline: "none" }} />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "#6b6b7b", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>Logo</label>
              <input type="file" accept="image/*" onChange={(e) => handleLogoUpload(e.target.files[0])} style={{ display: "none" }} id="logo-upload" />
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <label htmlFor="logo-upload" style={{ padding: "12px 20px", borderRadius: 12, border: "2px dashed #e6e1d6", background: "#faf8f5", cursor: "pointer", fontSize: 14, color: "#6b6b7b", fontWeight: 600 }}>
                  {logoUploading ? "Uploading..." : "📷 Upload Logo"}
                </label>
                {restaurantForm.logoUrl && !logoUploading && <img src={restaurantForm.logoUrl} alt="Preview" style={{ width: 48, height: 48, borderRadius: 10, objectFit: "cover" }} />}
              </div>
            </div>
            <button onClick={handleCreateRestaurant} disabled={loading} className="tap-btn"
              style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", background: "#e8a33d", color: "#fff", fontSize: 16, fontWeight: 700, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}>
              {loading ? "Creating..." : "Create Restaurant →"}
            </button>
          </div>
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