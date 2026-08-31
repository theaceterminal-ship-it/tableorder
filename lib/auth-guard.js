"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-context";
import { HOTEL_STATUS } from "./plans";

// Where an authenticated-but-not-permitted user should be sent. Computed as a
// pure function of primitives so the redirect effect below can depend on a
// single string and re-run only when the answer actually changes.
function redirectFor({ user, role, allowedKey, status, expired }) {
  if (!user) return "/login";
  if (allowedKey && !allowedKey.split(",").includes(String(role))) return "/login";
  if (status === HOTEL_STATUS.PENDING_PAYMENT || status === HOTEL_STATUS.PENDING_APPROVAL) return "/pending";
  if (status === HOTEL_STATUS.SUSPENDED || status === HOTEL_STATUS.REJECTED || expired) return "/login?blocked=1";
  return null;
}

export function AuthGuard({ allowedRoles, children }) {
  const { user, role, loading, subscription } = useAuth();
  const router = useRouter();

  // Callers write <AuthGuard allowedRoles={["reception"]}> — a NEW array on
  // every render. Putting that array (or the subscription object) straight into
  // a dependency list re-runs the effect on every render, and when the effect
  // calls router.replace() the navigation re-renders, which runs it again:
  // an infinite redirect loop that presents as a page stuck rendering.
  //
  // Everything the effect depends on is reduced to a primitive first.
  const allowedKey = allowedRoles ? allowedRoles.join(",") : "";
  const status = subscription?.status ?? "";
  const planEndDate = subscription?.planEndDate ?? 0;

  // Date.now() is read once per evaluation rather than during render, so this
  // stays a pure function of its inputs.
  const target = useMemo(
    () => redirectFor({
      user,
      role,
      allowedKey,
      status,
      expired: planEndDate ? planEndDate < Date.now() : false,
    }),
    [user, role, allowedKey, status, planEndDate]
  );

  useEffect(() => {
    if (loading || !target) return;
    router.replace(target);
  }, [loading, target, router]);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: "3px solid #eee", borderTopColor: "#e8a33d", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <p style={{ color: "#888" }}>Loading...</p>
        </div>
      </div>
    );
  }

  // A redirect is pending — render nothing rather than flashing a dashboard the
  // user is about to be moved away from.
  if (target) return null;

  return children;
}
