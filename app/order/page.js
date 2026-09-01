"use client";

// The public ordering site — the link a restaurant puts on its Google profile.
//
// Deliberately the SAME screen as the in-restaurant menu, in delivery mode. The
// menu, cart, offers, Buy-1-Get-1 preview and recommendations are the parts a
// customer actually judges you on, and maintaining two versions of them is how
// they drift apart. Only the last step differs: where a table number would have
// been, there is an address.
//
// This route also exists as a security measure. Before it, the only way to order
// without being in the restaurant was to abuse a table's QR code, so every such
// attempt looked like an attack. Giving people a legitimate route removes the
// motive and lets the QR path be locked down properly.

import { Suspense } from "react";
import { TableContent, GLOBAL_ANIMATION_CSS } from "../table/page";

export default function OrderPage() {
  return (
    <>
      <style>{GLOBAL_ANIMATION_CSS}</style>
      <Suspense fallback={
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif", color: "#888" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 40, height: 40, border: "3px solid #eee", borderTopColor: "#e8a33d", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
            Loading menu...
          </div>
        </div>
      }>
        <TableContent mode="delivery" />
      </Suspense>
    </>
  );
}
