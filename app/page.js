"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [leaving, setLeaving] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), 2000);
    const t2 = setTimeout(() => router.push("/login"), 2600);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [router]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "linear-gradient(135deg, #1a1a2e 0%, #241f3d 55%, #2d1b1b 100%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: leaving ? 0 : 1,
        transition: "opacity 0.6s ease",
      }}
    >
      <style>{`
        @keyframes splashPop { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
        @keyframes splashLine { from { width: 0; } to { width: 50px; } }
        @keyframes splashFade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
      <div style={{ animation: "splashPop 0.9s cubic-bezier(0.22, 1, 0.36, 1)", textAlign: "center", padding: 20 }}>
        <div style={{ fontSize: 52, marginBottom: 20, animation: "splashFade 0.8s ease 0.3s both" }}>🍽️</div>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 42, fontWeight: 700, color: "#fff", letterSpacing: 0.5, animation: "splashFade 0.8s ease 0.5s both" }}>
          Cabadra
        </div>
        <div style={{ width: 50, height: 2, background: "#e8a33d", margin: "18px auto", animation: "splashLine 0.7s ease 0.7s both" }} />
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", letterSpacing: 2, textTransform: "uppercase", animation: "splashFade 0.8s ease 0.9s both" }}>
          QR Based Ordering
        </div>
      </div>
    </div>
  );
}