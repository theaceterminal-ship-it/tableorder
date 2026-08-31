"use client";

// Signup, rebuilt for the brand/outlet model.
//
// Flow: choose organisation type -> brand & outlet details -> sign in ->
// choose plan -> pay -> submitted for approval.
//
// THE WRITE ORDER BELOW IS LOad-BEARING. Security rules grant each step on the
// basis of the previous one, so it must run brand -> membership -> outlet ->
// outlet documents -> user. Reordering it breaks account creation outright,
// which is exactly what happened before. See firestore.rules.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { auth, db, googleProvider, uploadToCloudinary } from "@/lib/firebase";
import { signInWithPopup } from "firebase/auth";
import { doc, setDoc, collection, serverTimestamp } from "firebase/firestore";
import {
  PLAN_FEATURES, PLAN_PRICING, PLAN_LABELS, HOTEL_STATUS,
  PLATFORM_UPI_ID, PLATFORM_PAYEE_NAME,
} from "@/lib/plans";
import { TIERS, TIER_LABELS, ROLES, tierLimits } from "@/lib/tenancy";

const FEATURE_LABELS = {
  floors: "Multiple floors", vipTables: "VIP tables", combos: "Combo packs",
  customization: "Spice level & notes", splitBill: "Split bill", upiQr: "UPI payment QR",
  brandColor: "Custom branding", promoBanner: "Promo banner", rating: "Guest ratings",
};

// Which feature plans each organisation type may buy. Multi-outlet needs the
// brand console, which base does not include, so it starts at mid.
const PLANS_FOR_TIER = {
  [TIERS.SINGLE]: ["base", "mid", "pro"],
  [TIERS.MULTI]: ["mid", "pro"],
  [TIERS.ENTERPRISE]: [],
};

const ORG_TYPES = [
  {
    tier: TIERS.SINGLE,
    icon: "🍽️",
    blurb: "One restaurant, one dashboard.",
    points: ["A single outlet", "POS, billing, kitchen board", "Reception and kitchen staff"],
  },
  {
    tier: TIERS.MULTI,
    icon: "🏢",
    blurb: "A brand with several branches.",
    points: ["Up to 25 outlets", "One master menu, local prices", "Managers across many outlets", "All branches in one view"],
  },
  {
    tier: TIERS.ENTERPRISE,
    icon: "🏛️",
    blurb: "Several brands, or something bespoke.",
    points: ["Unlimited outlets", "Multiple brands in one group", "White-label and integrations", "Priced per agreement"],
  },
];

const wrap = { minHeight: "100vh", background: "linear-gradient(135deg, #faf8f5 0%, #f5f3ef 100%)", padding: "40px 20px" };
const card = { maxWidth: 640, margin: "0 auto", background: "#fff", border: "1px solid #e6e1d6", borderRadius: 20, padding: 32, boxShadow: "0 8px 32px rgba(26,26,46,0.07)" };
const input = { width: "100%", padding: "12px 14px", border: "1px solid #e6e1d6", borderRadius: 10, fontSize: 14.5, marginBottom: 14, boxSizing: "border-box", fontFamily: "inherit" };
const label = { fontSize: 12, fontWeight: 800, color: "#6b6b7b", textTransform: "uppercase", letterSpacing: 0.4, display: "block", marginBottom: 6 };
const primaryBtn = { width: "100%", padding: "14px 20px", borderRadius: 12, border: "none", background: "#1a1a2e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" };
const ghostBtn = { background: "none", border: "none", color: "#6b6b7b", fontSize: 13.5, cursor: "pointer", textDecoration: "underline", marginTop: 14 };

export default function SignupPage() {
  const [step, setStep] = useState("orgType"); // orgType -> details -> signin -> plan -> payment -> done
  const [tier, setTier] = useState(null);
  const [form, setForm] = useState({ brandName: "", outletName: "", tagline: "", address: "", logoUrl: "" });
  const [logoUploading, setLogoUploading] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState(null);
  const [selectedPlan, setSelectedPlan] = useState("mid");
  const [txnRef, setTxnRef] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(null);
  const router = useRouter();

  const isEnterprise = tier === TIERS.ENTERPRISE;

  async function handleLogoUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("Please select an image");
    if (file.size > 5 * 1024 * 1024) return alert("Image must be under 5MB");
    setLogoUploading(true);
    try {
      const url = await uploadToCloudinary(file);
      setForm((p) => ({ ...p, logoUrl: url }));
    } catch (err) {
      alert("Upload failed: " + err.message);
    } finally {
      setLogoUploading(false);
    }
  }

  function chooseTier(t) {
    setTier(t);
    setSelectedPlan(PLANS_FOR_TIER[t][0] || "pro");
    setError("");
    setStep("details");
  }

  function goToSignIn() {
    if (!form.brandName.trim()) { setError(isEnterprise || tier === TIERS.MULTI ? "Brand name is required" : "Restaurant name is required"); return; }
    setError("");
    setStep("signin");
  }

  async function handleGoogleSignIn() {
    setLoading(true);
    setError("");
    try {
      const result = await signInWithPopup(auth, googleProvider);
      setFirebaseUser(result.user);
      // Enterprise is priced per agreement, so there is nothing to pay yet —
      // it goes straight to the approvals queue for a human conversation.
      setStep(isEnterprise ? "payment" : "plan");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitForApproval() {
    if (!isEnterprise && !txnRef.trim()) {
      setError("Please enter your transaction reference / UTR number");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const uid = firebaseUser.uid;
      const brandId = doc(collection(db, "brands")).id;
      const outletId = doc(collection(db, "restaurants")).id;
      const now = Date.now();

      // 1. The brand. Must name its creator as owner and may only be submitted
      //    into a pending state — no client can activate its own subscription.
      await setDoc(doc(db, "brands", brandId), {
        ownerUid: uid,
        orgId: null, // Enterprise multi-brand hook; unused for now
        name: form.brandName.trim(),
        tier,
        subscription: {
          status: HOTEL_STATUS.PENDING_APPROVAL,
          plan: isEnterprise ? "pro" : selectedPlan,
          planAmount: isEnterprise ? null : PLAN_PRICING[selectedPlan].amount,
          txnRef: isEnterprise ? null : txnRef.trim(),
          ownerEmail: firebaseUser.email,
          submittedAt: now,
        },
        outletIds: [outletId],
        createdAt: now,
        updatedAt: serverTimestamp(),
      });

      // 2. Ownership. Allowed because we just created the brand naming this uid.
      await setDoc(doc(db, "brands", brandId, "members", uid), {
        role: ROLES.BRAND_OWNER,
        outletIds: [outletId],
        addedAt: now,
      });

      // 3. The first outlet. Its id is generated, not the owner's uid — that
      //    coupling is what made chains impossible.
      await setDoc(doc(db, "restaurants", outletId), {
        brandId,
        name: form.outletName.trim() || form.brandName.trim(),
        createdAt: now,
      });

      // 4. Outlet documents. Permitted now that the outlet carries its brandId.
      await setDoc(doc(db, "restaurants", outletId, "info", "profile"), {
        name: form.outletName.trim() || form.brandName.trim(),
        tagline: form.tagline, address: form.address, logoUrl: form.logoUrl,
        email: firebaseUser.email, createdAt: serverTimestamp(),
      });
      await setDoc(doc(db, "restaurants", outletId, "info", "billing"), {
        taxPercent: 5, servicePercent: 0, upiId: "",
      });

      // 5. Routing hints only. Never read for authorization.
      await setDoc(doc(db, "users", uid), {
        brandId, defaultOutletId: outletId,
        email: firebaseUser.email, name: firebaseUser.displayName || "",
        isCreator: true, addedAt: serverTimestamp(),
      }, { merge: true });

      setSubmitted({ brandId, outletId });
      setStep("done");
    } catch (err) {
      setError(err?.code ? `${err.code}: ${err.message}` : err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={wrap}>
      <div style={card}>
        {/* ---------------------------------------------------- org type */}
        {step === "orgType" && (
          <>
            <h1 style={{ fontSize: 26, fontWeight: 800, color: "#1a1a2e", margin: "0 0 6px" }}>What are you setting up?</h1>
            <p style={{ color: "#6b6b7b", fontSize: 14.5, margin: "0 0 24px" }}>
              You can move up a tier later without starting over.
            </p>
            <div style={{ display: "grid", gap: 12 }}>
              {ORG_TYPES.map((o) => (
                <button
                  key={o.tier}
                  onClick={() => chooseTier(o.tier)}
                  style={{
                    textAlign: "left", padding: 20, borderRadius: 14, cursor: "pointer",
                    border: "1.5px solid #e6e1d6", background: "#fff", fontFamily: "inherit",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontSize: 22 }}>{o.icon}</span>
                    <span style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>{TIER_LABELS[o.tier]}</span>
                    {o.tier === TIERS.ENTERPRISE && (
                      <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 800, color: "#92400e", background: "#fef3c7", padding: "3px 8px", borderRadius: 6 }}>
                        CONTACT SALES
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13.5, color: "#6b6b7b", marginBottom: 10 }}>{o.blurb}</div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#555" }}>
                    {o.points.map((p) => <li key={p} style={{ marginBottom: 3 }}>{p}</li>)}
                  </ul>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ----------------------------------------------------- details */}
        {step === "details" && (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "#e8a33d", letterSpacing: 0.6, textTransform: "uppercase", marginBottom: 8 }}>
              {TIER_LABELS[tier]}
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 20px" }}>
              {tier === TIERS.SINGLE ? "Tell us about your restaurant" : "Tell us about your brand"}
            </h1>

            <label style={label}>{tier === TIERS.SINGLE ? "Restaurant name" : "Brand name"} *</label>
            <input style={input} value={form.brandName} onChange={(e) => setForm((p) => ({ ...p, brandName: e.target.value }))}
              placeholder={tier === TIERS.SINGLE ? "Spice Garden" : "Spice Garden Group"} />

            {tier !== TIERS.SINGLE && (
              <>
                <label style={label}>Your first outlet</label>
                <input style={input} value={form.outletName} onChange={(e) => setForm((p) => ({ ...p, outletName: e.target.value }))}
                  placeholder="Bandra West" />
                <p style={{ fontSize: 12.5, color: "#888", margin: "-6px 0 14px" }}>
                  You can add up to {tierLimits(tier).maxOutlets === Infinity ? "unlimited" : tierLimits(tier).maxOutlets} outlets once you are approved.
                </p>
              </>
            )}

            <label style={label}>Tagline</label>
            <input style={input} value={form.tagline} onChange={(e) => setForm((p) => ({ ...p, tagline: e.target.value }))} placeholder="Authentic North Indian" />

            <label style={label}>Address</label>
            <input style={input} value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} />

            <label style={label}>Logo</label>
            <input type="file" accept="image/*" onChange={(e) => handleLogoUpload(e.target.files?.[0])} style={{ ...input, padding: 10 }} />
            {logoUploading && <p style={{ fontSize: 13, color: "#888", marginTop: -8 }}>Uploading…</p>}
            {form.logoUrl && <img src={form.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: "cover", marginBottom: 14 }} />}

            {error && <p style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{error}</p>}
            <button style={primaryBtn} onClick={goToSignIn}>Continue</button>
            <button style={ghostBtn} onClick={() => setStep("orgType")}>← Change type</button>
          </>
        )}

        {/* ------------------------------------------------------ signin */}
        {step === "signin" && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>Create your owner account</h1>
            <p style={{ color: "#6b6b7b", fontSize: 14.5, margin: "0 0 22px" }}>
              This Google account becomes the owner of {form.brandName || "your brand"} — it controls billing,
              outlets, and who else gets access.
            </p>
            {error && <p style={{ color: "#b91c1c", fontSize: 13.5, marginBottom: 12 }}>{error}</p>}
            <button style={primaryBtn} onClick={handleGoogleSignIn} disabled={loading}>
              {loading ? "Signing in…" : "Sign in with Google"}
            </button>
            <button style={ghostBtn} onClick={() => setStep("details")}>← Back</button>
          </>
        )}

        {/* -------------------------------------------------------- plan */}
        {step === "plan" && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 20px" }}>Choose your plan</h1>
            <div style={{ display: "grid", gap: 12, marginBottom: 20 }}>
              {PLANS_FOR_TIER[tier].map((key) => {
                const active = selectedPlan === key;
                return (
                  <button key={key} onClick={() => setSelectedPlan(key)}
                    style={{ textAlign: "left", padding: 18, borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
                      border: active ? "2px solid #1a1a2e" : "1.5px solid #e6e1d6", background: active ? "#faf8f5" : "#fff" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 17, fontWeight: 800, color: "#1a1a2e" }}>{PLAN_LABELS[key]}</span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: "#e8a33d" }}>{PLAN_PRICING[key].label}</span>
                    </div>
                    <div style={{ fontSize: 12.5, color: "#6b6b7b" }}>
                      {Object.entries(PLAN_FEATURES[key]).filter(([, v]) => v === true).map(([k]) => FEATURE_LABELS[k]).filter(Boolean).join(" · ")}
                    </div>
                  </button>
                );
              })}
            </div>
            {tier === TIERS.MULTI && (
              <p style={{ fontSize: 12.5, color: "#888", marginBottom: 16 }}>
                Multi-outlet is billed per outlet. You will be invoiced for additional outlets as you add them.
              </p>
            )}
            <button style={primaryBtn} onClick={() => setStep("payment")}>Continue to payment</button>
          </>
        )}

        {/* ----------------------------------------------------- payment */}
        {step === "payment" && (
          <>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>
              {isEnterprise ? "Request a call" : "Complete your payment"}
            </h1>

            {isEnterprise ? (
              <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.6, margin: "0 0 22px" }}>
                Enterprise is priced per agreement. Submit your request and we will get in touch to
                understand what you need — number of brands, outlets, and any integrations — before
                anything is set up or charged.
              </p>
            ) : (
              <>
                <p style={{ color: "#6b6b7b", fontSize: 14.5, margin: "0 0 18px" }}>
                  Pay <strong style={{ color: "#1a1a2e" }}>₹{PLAN_PRICING[selectedPlan].amount.toLocaleString("en-IN")}</strong> to
                  the UPI ID below, then enter your transaction reference.
                </p>
                <div style={{ background: "#faf8f5", border: "1px solid #e6e1d6", borderRadius: 12, padding: 16, marginBottom: 18 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 800, color: "#6b6b7b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Pay to</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#1a1a2e", fontFamily: "monospace" }}>{PLATFORM_UPI_ID}</div>
                  <div style={{ fontSize: 13, color: "#6b6b7b", marginTop: 2 }}>{PLATFORM_PAYEE_NAME}</div>
                </div>
                <label style={label}>Transaction reference / UTR *</label>
                <input style={input} value={txnRef} onChange={(e) => setTxnRef(e.target.value)} placeholder="e.g. 412345678901" />
              </>
            )}

            {error && (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ fontSize: 13, color: "#b91c1c", fontFamily: "monospace", wordBreak: "break-word" }}>{error}</div>
                {error.includes("permission-denied") && (
                  <div style={{ fontSize: 12.5, color: "#b91c1c", marginTop: 8, lineHeight: 1.5 }}>
                    The current security rules do not match this signup flow. Run
                    <code> firebase deploy --only firestore:rules</code> and try again.
                  </div>
                )}
              </div>
            )}

            <button style={primaryBtn} onClick={submitForApproval} disabled={loading}>
              {loading ? "Submitting…" : "Submit for approval"}
            </button>
          </>
        )}

        {/* -------------------------------------------------------- done */}
        {step === "done" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "#f0fdf4", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 30 }}>
              ✅
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 10px" }}>
              Sent for approval
            </h1>
            <p style={{ color: "#6b6b7b", fontSize: 14.5, lineHeight: 1.65, margin: "0 0 20px" }}>
              Your request has gone to the Cabadra team.
              {isEnterprise
                ? " We'll reach out to discuss your setup, usually within one working day."
                : " We'll confirm your payment and activate your account — usually within a few hours."}
              <br /><br />
              <strong style={{ color: "#1a1a2e" }}>You&rsquo;ll be able to sign in as soon as it&rsquo;s approved.</strong>
              {" "}Nothing else is needed from you right now, and you can close this page.
            </p>

            <div style={{ background: "#faf8f5", border: "1px solid #e6e1d6", borderRadius: 12, padding: 16, textAlign: "left", marginBottom: 20 }}>
              <div style={{ fontSize: 11.5, fontWeight: 800, color: "#6b6b7b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>
                Your request
              </div>
              <div style={{ fontSize: 13.5, color: "#1a1a2e", lineHeight: 1.7 }}>
                <div><strong>{form.brandName}</strong> · {TIER_LABELS[tier]}</div>
                {!isEnterprise && <div>{PLAN_LABELS[selectedPlan]} — ₹{PLAN_PRICING[selectedPlan].amount.toLocaleString("en-IN")}</div>}
                {!isEnterprise && txnRef && <div style={{ fontFamily: "monospace", fontSize: 12.5, color: "#6b6b7b" }}>UTR {txnRef}</div>}
                <div style={{ fontSize: 12, color: "#888", marginTop: 6 }}>{firebaseUser?.email}</div>
              </div>
            </div>

            <button style={primaryBtn} onClick={() => router.replace("/pending")}>Check status</button>
          </div>
        )}
      </div>
    </div>
  );
}
