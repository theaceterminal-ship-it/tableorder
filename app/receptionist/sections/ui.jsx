"use client";

// Small presentational pieces shared across reception's sections. Extracted so
// each section file is about its own screen rather than re-declaring chrome.

export const glassCard = {
  background: "rgba(255,255,255,0.55)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.5)",
};

export const inputStyle = { width: "100%", padding: "11px 14px", border: "1px solid var(--border, #e6e1d6)", borderRadius: 10, fontSize: 14, marginBottom: 12, background: "var(--surface, #ffffff)", fontFamily: "inherit", boxSizing: "border-box" };
export const labelStyle = { fontSize: 12, color: "var(--text-secondary, #6b6b7b)", fontWeight: 700, display: "block", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 };

export function StatCard({ label, value, color, sub, onClick }) {
  return (
    <div onClick={onClick} style={{ ...glassCard, padding: 20, display: "flex", alignItems: "center", gap: 16, borderRadius: 18, cursor: onClick ? "pointer" : "default", boxShadow: `0 8px 24px ${color}22` }}>
      <div style={{ width: 8, alignSelf: "stretch", borderRadius: 4, background: color, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, color: "#1a1a2e" }}>{value}</div>
        <div style={{ fontSize: 12.5, color: "#555", marginTop: 4, fontWeight: 700 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>{sub}</div>}
      </div>
    </div>
  );
}

export function SectionHeader({ title, subtitle, children }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 20 }}>
      <div>
        <h2 style={{ fontSize: 24, fontWeight: 800, margin: 0, fontFamily: "'Fraunces', serif" }}>{title}</h2>
        {subtitle && <p style={{ fontSize: 13, color: "var(--text-secondary, #6b6b7b)", margin: "4px 0 0" }}>{subtitle}</p>}
      </div>
      {children && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{children}</div>}
    </div>
  );
}

export function EmptyState({ icon, message }) {
  return (
    <div style={{ padding: 44, textAlign: "center", color: "var(--text-secondary, #6b6b7b)" }}>
      <div style={{ fontSize: 38, marginBottom: 10 }}>{icon}</div>
      <p style={{ margin: 0, fontSize: 14 }}>{message}</p>
    </div>
  );
}
