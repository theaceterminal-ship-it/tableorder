"use client";

// One-time migration screen. The account holder signs in normally and runs this
// once; it converts the old "a restaurant IS a user account" model into a brand
// that owns outlets. See lib/migrate-to-brands.js for what it actually writes.
//
// Deliberately not behind AuthGuard: AuthGuard redirects on subscription state,
// and an account mid-migration can legitimately be in a state it does not like.
// This page does its own, narrower check — signed in, and that is all.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { migrateAccountToBrand } from "@/lib/migrate-to-brands";

const card = {
  background: "#fff",
  border: "1px solid #e6e1d6",
  borderRadius: 16,
  padding: 28,
  maxWidth: 560,
  width: "100%",
  boxShadow: "0 8px 32px rgba(26,26,46,0.08)",
};

export default function MigratePage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [state, setState] = useState("idle"); // idle | running | done | error
  const [steps, setSteps] = useState([]);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  async function run() {
    setState("running");
    setSteps([]);
    setError("");
    try {
      const res = await migrateAccountToBrand(user.uid, (step, detail) => {
        setSteps((prev) => [...prev, { step, detail }]);
      });
      setResult(res);
      setState("done");
    } catch (e) {
      // Surface the Firestore error code — "permission-denied" here almost
      // always means the new rules have not been deployed yet, and saying so
      // saves a long debugging detour.
      setError(e?.code ? `${e.code}: ${e.message}` : e.message || String(e));
      setState("error");
    }
  }

  if (loading || !user) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#faf9f7" }}>
        <p style={{ color: "#888" }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#faf9f7", padding: 20 }}>
      <div style={card}>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>
          Upgrade to multi-outlet
        </h1>
        <p style={{ fontSize: 14.5, color: "#666", lineHeight: 1.6, margin: "0 0 20px" }}>
          Your account was created when one login could own exactly one restaurant.
          This adds a <strong>brand</strong> above your outlet so you can add more
          later, invite managers, and see every branch in one place.
        </p>

        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: "#166534", marginBottom: 6 }}>
            Nothing is moved or deleted
          </div>
          <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.55 }}>
            Your menu, tables, orders, and printed QR codes keep working exactly as they
            are. Your outlet keeps its existing address, so nothing needs reprinting.
          </div>
        </div>

        <div style={{ fontSize: 12.5, color: "#888", marginBottom: 18, fontFamily: "monospace" }}>
          Signed in as {user.email}
        </div>

        {state === "idle" && (
          <button
            onClick={run}
            style={{ width: "100%", padding: "14px 20px", borderRadius: 12, border: "none", background: "#1a1a2e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}
          >
            Run upgrade
          </button>
        )}

        {(state === "running" || state === "done" || state === "error") && steps.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "6px 0", borderBottom: "1px solid #f4f1ea" }}>
                <span style={{ color: "#16a34a", fontSize: 13 }}>✓</span>
                <span style={{ fontSize: 13.5, color: "#444" }}>{s.detail}</span>
              </div>
            ))}
          </div>
        )}

        {state === "running" && (
          <div style={{ fontSize: 13.5, color: "#888" }}>Working…</div>
        )}

        {state === "done" && result && (
          <div>
            <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#166534", marginBottom: 6 }}>
                {result.status === "already-migrated" ? "Already upgraded" : "Upgrade complete"}
              </div>
              <div style={{ fontSize: 13, color: "#166534", lineHeight: 1.55 }}>{result.message}</div>
              <div style={{ fontSize: 11.5, color: "#166534", marginTop: 8, fontFamily: "monospace" }}>
                brand: {result.brandId}<br />outlet: {result.outletId}
              </div>
            </div>
            <button
              onClick={() => router.replace("/receptionist")}
              style={{ width: "100%", padding: "14px 20px", borderRadius: 12, border: "none", background: "#1a1a2e", color: "#fff", fontWeight: 800, fontSize: 15, cursor: "pointer" }}
            >
              Go to dashboard
            </button>
          </div>
        )}

        {state === "error" && (
          <div>
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: "#b91c1c", marginBottom: 6 }}>Upgrade failed</div>
              <div style={{ fontSize: 12.5, color: "#b91c1c", lineHeight: 1.55, fontFamily: "monospace", wordBreak: "break-word" }}>{error}</div>
              {error.includes("permission-denied") && (
                <div style={{ fontSize: 12.5, color: "#b91c1c", marginTop: 10, lineHeight: 1.55 }}>
                  This usually means the updated security rules have not been deployed yet.
                  Run <code>firebase deploy --only firestore:rules</code> and try again.
                </div>
              )}
            </div>
            <button
              onClick={run}
              style={{ width: "100%", padding: "14px 20px", borderRadius: 12, border: "1px solid #e6e1d6", background: "#fff", color: "#1a1a2e", fontWeight: 700, fontSize: 15, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
